# EDK2 Fault Injector

This is a small Python CLI for ListAgent repair testing. It randomly injects
small build-breaking edits into EDK2 files:

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

Preview three random mutations:

```powershell
python .\edk2_fault_injector.py inject --count 3 --seed 1234
```

Apply three random mutations:

```powershell
python .\edk2_fault_injector.py inject --count 3 --seed 1234 --apply
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
