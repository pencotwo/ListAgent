#!/usr/bin/env python3
"""
EDK2 fault injector for ListAgent repair testing.

By default this tool is dry-run only. It targets EDK2 source/config files and
can inject small random build-breaking edits while saving backups and a JSON
manifest for restoration.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import shutil
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable, Iterable


DEFAULT_TARGET = Path(r"D:\BIOS\edk2")
DEFAULT_EXTENSIONS = (".c", ".h", ".dec", ".dsc", ".inf", ".fdf")
DEFAULT_BACKUP_ROOT = Path(__file__).resolve().parent / "edk2_fault_backups"
MAX_FILE_BYTES = 2 * 1024 * 1024


@dataclass
class Candidate:
    path: Path
    text: str
    lines: list[str]


@dataclass
class Mutation:
    name: str
    line_number: int
    before: str
    after: str
    description: str


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def now_run_id() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def read_text_lossless(path: Path) -> str | None:
    data = path.read_bytes()
    if len(data) > MAX_FILE_BYTES:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        try:
            return data.decode("latin-1")
        except UnicodeDecodeError:
            return None


def iter_files(root: Path, extensions: Iterable[str]) -> Iterable[Path]:
    suffixes = {ext.lower() for ext in extensions}
    ignored_dirs = {".git", "Build", "Conf", "BaseTools/Source/C/bin"}
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel_parts = set(path.relative_to(root).parts)
        if rel_parts & ignored_dirs:
            continue
        if path.suffix.lower() in suffixes:
            yield path


def load_candidate(path: Path) -> Candidate | None:
    text = read_text_lossless(path)
    if text is None or not text.strip():
        return None
    return Candidate(path=path, text=text, lines=text.splitlines(keepends=True))


def choose_line(lines: list[str], predicate: Callable[[str], bool], rng: random.Random) -> int | None:
    indexes = [i for i, line in enumerate(lines) if predicate(line)]
    if not indexes:
        return None
    return rng.choice(indexes)


def mutate_comment_out_code(candidate: Candidate, rng: random.Random) -> Mutation | None:
    idx = choose_line(
        candidate.lines,
        lambda line: bool(line.strip())
        and not line.lstrip().startswith(("//", "/*", "*", "#", "[", ";"))
        and not line.strip().endswith(("{", "}")),
        rng,
    )
    if idx is None:
        return None
    before = candidate.lines[idx]
    after = "// LISTAGENT_FAULT: commented out\n"
    return Mutation("comment_out_line", idx + 1, before, after, "Replace one code/config line with a comment.")


def mutate_delete_line(candidate: Candidate, rng: random.Random) -> Mutation | None:
    idx = choose_line(candidate.lines, lambda line: bool(line.strip()) and not line.lstrip().startswith("//"), rng)
    if idx is None:
        return None
    before = candidate.lines[idx]
    return Mutation("delete_line", idx + 1, before, "", "Delete one non-empty line.")


def mutate_identifier_typo(candidate: Candidate, rng: random.Random) -> Mutation | None:
    pattern = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]{5,}\b")
    indexes = [i for i, line in enumerate(candidate.lines) if pattern.search(line) and not line.lstrip().startswith("//")]
    if not indexes:
        return None
    idx = rng.choice(indexes)
    before = candidate.lines[idx]
    matches = list(pattern.finditer(before))
    match = rng.choice(matches)
    replacement = match.group(0) + "_BROKEN"
    after = before[: match.start()] + replacement + before[match.end() :]
    return Mutation("identifier_typo", idx + 1, before, after, "Append _BROKEN to one identifier.")


def mutate_operator_flip(candidate: Candidate, rng: random.Random) -> Mutation | None:
    replacements = [("==", "!="), ("!=", "=="), ("&&", "||"), ("||", "&&"), (" TRUE", " FALSE"), (" FALSE", " TRUE")]
    possible: list[tuple[int, str, str]] = []
    for i, line in enumerate(candidate.lines):
        if line.lstrip().startswith("//"):
            continue
        for old, new in replacements:
            if old in line:
                possible.append((i, old, new))
    if not possible:
        return None
    idx, old, new = rng.choice(possible)
    before = candidate.lines[idx]
    after = before.replace(old, new, 1)
    return Mutation("operator_flip", idx + 1, before, after, f"Replace {old!r} with {new!r}.")


def mutate_insert_compile_error(candidate: Candidate, rng: random.Random) -> Mutation | None:
    idx = rng.randrange(0, len(candidate.lines) + 1)
    before = ""
    after = "LISTAGENT_FAULT_INJECTED_COMPILE_ERROR\n"
    return Mutation("insert_compile_error", idx + 1, before, after, "Insert an invalid token line.")


def mutate_section_header(candidate: Candidate, rng: random.Random) -> Mutation | None:
    if candidate.path.suffix.lower() not in {".dec", ".dsc", ".inf", ".fdf"}:
        return None
    idx = choose_line(candidate.lines, lambda line: line.strip().startswith("[") and line.strip().endswith("]"), rng)
    if idx is None:
        return None
    before = candidate.lines[idx]
    after = before.replace("[", "[BROKEN_", 1)
    return Mutation("section_header_typo", idx + 1, before, after, "Corrupt one EDK2 section header.")


MUTATORS = (
    mutate_comment_out_code,
    mutate_delete_line,
    mutate_identifier_typo,
    mutate_operator_flip,
    mutate_insert_compile_error,
    mutate_section_header,
)


def make_mutation(candidate: Candidate, rng: random.Random) -> Mutation | None:
    mutators = list(MUTATORS)
    rng.shuffle(mutators)
    for mutator in mutators:
        mutation = mutator(candidate, rng)
        if mutation is not None:
            return mutation
    return None


def apply_mutation(lines: list[str], mutation: Mutation) -> str:
    idx = mutation.line_number - 1
    edited = list(lines)
    if mutation.before == "":
        edited.insert(idx, mutation.after)
    elif mutation.after == "":
        del edited[idx]
    else:
        edited[idx] = mutation.after
    return "".join(edited)


def relative_to_root(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def backup_path_for(backup_dir: Path, rel_path: str) -> Path:
    return backup_dir / rel_path


def inject(args: argparse.Namespace) -> int:
    root = args.root.resolve()
    if not root.exists() or not root.is_dir():
        print(f"Target root does not exist or is not a directory: {root}", file=sys.stderr)
        return 2

    rng = random.Random(args.seed)
    files = list(iter_files(root, args.extensions))
    rng.shuffle(files)
    selected: list[tuple[Candidate, Mutation]] = []
    for path in files:
        candidate = load_candidate(path)
        if candidate is None:
            continue
        mutation = make_mutation(candidate, rng)
        if mutation is None:
            continue
        selected.append((candidate, mutation))
        if len(selected) >= args.count:
            break

    if not selected:
        print("No mutable files found.")
        return 1

    run_id = args.run_id or now_run_id()
    backup_dir = args.backup_root.resolve() / run_id
    manifest = {
        "run_id": run_id,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "root": str(root),
        "dry_run": not args.apply,
        "seed": args.seed,
        "files": [],
    }

    print(f"Run id: {run_id}")
    print(f"Target: {root}")
    print(f"Mode: {'APPLY' if args.apply else 'DRY-RUN'}")
    print("")

    for candidate, mutation in selected:
        rel = relative_to_root(candidate.path, root)
        original_bytes = candidate.path.read_bytes()
        edited_text = apply_mutation(candidate.lines, mutation)
        edited_bytes = edited_text.encode("utf-8")
        print(f"{rel}:{mutation.line_number} [{mutation.name}] {mutation.description}")
        print(f"  - {mutation.before.rstrip()}")
        print(f"  + {mutation.after.rstrip()}")
        manifest["files"].append(
            {
                "path": rel,
                "backup": rel,
                "mutation": mutation.name,
                "line": mutation.line_number,
                "description": mutation.description,
                "before": mutation.before,
                "after": mutation.after,
                "sha256_before": sha256_bytes(original_bytes),
                "sha256_after": sha256_bytes(edited_bytes),
            }
        )
        if args.apply:
            backup_path = backup_path_for(backup_dir, rel)
            backup_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(candidate.path, backup_path)
            candidate.path.write_bytes(edited_bytes)

    if args.apply:
        backup_dir.mkdir(parents=True, exist_ok=True)
        manifest_path = backup_dir / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        print("")
        print(f"Applied {len(selected)} mutation(s).")
        print(f"Manifest: {manifest_path}")
        print(f"Restore: python {Path(__file__).name} restore --manifest {manifest_path}")
    else:
        print("")
        print(f"Dry-run only. Re-run with --apply to modify {len(selected)} file(s).")
    return 0


def restore(args: argparse.Namespace) -> int:
    manifest_path = args.manifest.resolve()
    if not manifest_path.exists():
        print(f"Manifest not found: {manifest_path}", file=sys.stderr)
        return 2
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    root = Path(manifest["root"])
    backup_dir = manifest_path.parent
    restored = 0
    for item in manifest.get("files", []):
        target = root / item["path"]
        backup = backup_path_for(backup_dir, item["backup"])
        if not backup.exists():
            print(f"Missing backup: {backup}", file=sys.stderr)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(backup, target)
        restored += 1
        print(f"Restored {target}")
    print(f"Restored {restored} file(s).")
    return 0


def scan(args: argparse.Namespace) -> int:
    root = args.root.resolve()
    files = list(iter_files(root, args.extensions))
    print(f"Target: {root}")
    print(f"Extensions: {', '.join(args.extensions)}")
    print(f"Files: {len(files)}")
    for path in files[: args.limit]:
        print(relative_to_root(path, root))
    if len(files) > args.limit:
        print(f"... {len(files) - args.limit} more")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Randomly inject repair-test faults into EDK2 files.")
    sub = parser.add_subparsers(dest="command", required=True)

    def add_common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--root", type=Path, default=DEFAULT_TARGET, help=f"EDK2 root. Default: {DEFAULT_TARGET}")
        p.add_argument(
            "--extensions",
            nargs="+",
            default=list(DEFAULT_EXTENSIONS),
            help="File extensions to target.",
        )

    p_scan = sub.add_parser("scan", help="List targetable files.")
    add_common(p_scan)
    p_scan.add_argument("--limit", type=int, default=50)
    p_scan.set_defaults(func=scan)

    p_inject = sub.add_parser("inject", help="Inject random faults. Dry-run unless --apply is set.")
    add_common(p_inject)
    p_inject.add_argument("--count", type=int, default=3, help="Number of files to mutate.")
    p_inject.add_argument("--seed", type=int, default=None, help="Random seed for repeatable selection.")
    p_inject.add_argument("--run-id", default="", help="Optional backup run id.")
    p_inject.add_argument("--backup-root", type=Path, default=DEFAULT_BACKUP_ROOT)
    p_inject.add_argument("--apply", action="store_true", help="Actually modify files.")
    p_inject.set_defaults(func=inject)

    p_restore = sub.add_parser("restore", help="Restore files from a manifest.")
    p_restore.add_argument("--manifest", type=Path, required=True)
    p_restore.set_defaults(func=restore)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
