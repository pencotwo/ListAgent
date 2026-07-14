#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fix_xlsx_dimension.py — Repair .xlsx files whose worksheets lack the
<dimension> (used-range) record.

Google Sheets exports omit <dimension>. Tools that trust it — notably
excel-mcp-server / excelize (`excel_describe_sheets` returns an empty
usedRange and `excel_read_sheet` fails with "no range available to read",
negokaz/excel-mcp-server#66) — then can't read the file at all.

This scans each worksheet's cell references, computes the real used range,
and inserts (or corrects) the <dimension> element, rewriting the file in
place. A sheet with no cells at all gets the minimal ref "A1:A1" — without
a dimension, excelize can't even WRITE to the sheet ("failed to update
dimension: invalid range format"). Everything else in the workbook is
preserved byte-for-byte.

Usage: py -3 fix_xlsx_dimension.py <file.xlsx> [more.xlsx ...]
Exit code: 0 on success (even if nothing needed fixing), 1 on error.
"""

import os
import re
import sys
import tempfile
import zipfile

# Writers differ in namespacing: Google Sheets emits <worksheet>/<c>, while
# OpenXML-SDK/ClosedXML-based tools emit <x:worksheet>/<x:c>. Match both.
CELL_RE = re.compile(rb'<(?:[A-Za-z0-9]+:)?c\b[^>]*?r="([A-Z]+)(\d+)"')
DIM_RE = re.compile(rb"<(?:[A-Za-z0-9]+:)?dimension\b[^>]*/>")
WS_OPEN_RE = re.compile(rb"<(?:([A-Za-z0-9]+):)?worksheet\b[^>]*>")


def col_to_num(col):
    n = 0
    for ch in col:
        n = n * 26 + (ch - ord("A") + 1)
    return n


def num_to_col(n):
    out = ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        out = chr(ord("A") + r) + out
    return out


def used_range(sheet_xml):
    """Compute 'A1:XN' style range from actual cell refs; None if no cells."""
    min_c = min_r = None
    max_c = max_r = 0
    for col, row in CELL_RE.findall(sheet_xml):
        c = col_to_num(col)
        r = int(row)
        min_c = c if min_c is None else min(min_c, c)
        min_r = r if min_r is None else min(min_r, r)
        max_c = max(max_c, c)
        max_r = max(max_r, r)
    if min_c is None:
        return None
    return "%s%d:%s%d" % (num_to_col(min_c), min_r, num_to_col(max_c), max_r)


def fix_sheet(sheet_xml):
    """Return (new_xml, action) where action is 'ok'|'fixed'."""
    w = WS_OPEN_RE.search(sheet_xml)
    if not w:
        return sheet_xml, "ok"  # not a worksheet we understand; don't touch
    # A cell-less sheet still needs a dimension or excelize refuses writes.
    rng = used_range(sheet_xml) or "A1:A1"
    # Mirror the document's namespace style (<dimension> vs <x:dimension>).
    prefix = w.group(1) + b":" if w.group(1) else b""
    dim = b"<" + prefix + b'dimension ref="' + rng.encode() + b'"/>'
    m = DIM_RE.search(sheet_xml)
    if m:
        if m.group(0) == dim:
            return sheet_xml, "ok"
        return sheet_xml[: m.start()] + dim + sheet_xml[m.end():], "fixed"
    return sheet_xml[: w.end()] + dim + sheet_xml[w.end():], "fixed"


def fix_file(path):
    zin = zipfile.ZipFile(path)
    changed = False
    entries = []
    for item in zin.infolist():
        data = zin.read(item.filename)
        if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", item.filename):
            new, action = fix_sheet(data)
            print("  %s: %s (%s)" % (
                item.filename, action, used_range(new) or "A1:A1 empty"))
            if action == "fixed":
                data = new
                changed = True
        entries.append((item, data))
    zin.close()

    if not changed:
        print("  no changes written")
        return

    fd, tmp = tempfile.mkstemp(suffix=".xlsx", dir=os.path.dirname(path) or ".")
    os.close(fd)
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
            for item, data in entries:
                zout.writestr(item, data)
        os.replace(tmp, path)
        print("  rewritten: %s" % path)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    for path in sys.argv[1:]:
        print(path)
        if not os.path.isfile(path):
            print("  ERROR: not found")
            return 1
        fix_file(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
