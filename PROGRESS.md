# officeChain improvement progress

## Stage 0 — Safety net — DONE

- `git init` done; `.gitignore` added (node_modules, ui/dist, daemon/data/, daemon/daemon.log, .office/, nul, *.log).
- Deleted stray `nul` (root) and `daemon/nul` via `del "\\?\<abs path>\nul"` from a batch file. Note: MSYS/Git Bash mangles the `\\?\` prefix when passed through `cmd //c` or PowerShell args — running a `.bat` file worked.
- Baseline: `npm run typecheck -w daemon` PASS; `npm test -w daemon` 52 pass / 0 fail (24.8s).
- Files changed: `.gitignore` (new), `PROGRESS.md` (new). Deleted: `nul`, `daemon/nul`.
