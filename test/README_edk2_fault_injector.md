# EDK2 Fault Injector

This is a small Python CLI for ListAgent repair testing. It randomly injects
explicit build-breaking edits into EDK2 files. By default it first prefers files
from the latest EmulatorPkg IA32 build output Makefiles, then files referenced
by the active platform build graph:

```powershell
Build\EmulatorIA32\DEBUG_VS2026\IA32
EmulatorPkg\EmulatorPkg.dsc
```

- `.c`
- `.h`
- `.dec`
- `.dsc`
- `.inf`
- `.fdf`

Default target:

```powershell
D:\BIOS\edk2
```

The tool is dry-run by default. It will not modify files unless `--apply` is
provided.

## Usage

Scan candidate files:

```powershell
python .\edk2_fault_injector.py scan
```

Preview five random mutations:

```powershell
python .\edk2_fault_injector.py inject --seed 1234
```

Apply five random mutations:

```powershell
python .\edk2_fault_injector.py inject --seed 1234 --apply
```

Backups and a manifest are written under:

```powershell
.\edk2_fault_backups\<run_id>\
```

Restore from a manifest:

```powershell
python .\edk2_fault_injector.py restore --manifest .\edk2_fault_backups\<run_id>\manifest.json
```

Use another EDK2 tree:

```powershell
python .\edk2_fault_injector.py inject --root D:\Other\edk2 --count 5 --apply
```

Scan the active platform build graph without using latest build output:

```powershell
python .\edk2_fault_injector.py inject --build-output none --seed 1234
```

Scan the whole tree instead of latest build output or the active platform build graph:

```powershell
python .\edk2_fault_injector.py inject --build-output none --active-platform none --seed 1234
```
