# officeChain improvement progress

## Stage 0 — Safety net — DONE

- `git init` done; `.gitignore` added (node_modules, ui/dist, daemon/data/, daemon/daemon.log, .office/, nul, *.log).
- Deleted stray `nul` (root) and `daemon/nul` via `del "\\?\<abs path>\nul"` from a batch file. Note: MSYS/Git Bash mangles the `\\?\` prefix when passed through `cmd //c` or PowerShell args — running a `.bat` file worked.
- Baseline: `npm run typecheck -w daemon` PASS; `npm test -w daemon` 52 pass / 0 fail (24.8s).
- Files changed: `.gitignore` (new), `PROGRESS.md` (new). Deleted: `nul`, `daemon/nul`.

## Stage 1 — Measure token use — DONE

- Added `tokenReport(runId)` in `daemon/src/services/usage.ts`: per work-item kind → calls, prompt chars (from `prompt_versions.rendered_text`, exact), reported input/output/cache tokens (from `usage_records`), avg/call, cost. Top 5 most expensive work items included. Subqueries grouped pre-join so multi-row sides don't multiply each other; cancelled work items excluded.
- Route: `GET /api/runs/:id/token-report` in `daemon/src/api/server.ts`.
- UI: "Token report" panel + top-5 list on the Dashboard run page (`ui/src/pages/Dashboard.tsx`).
- Tests: `daemon/tests/token-report.test.js` (3 tests — aggregation, join fan-out, top-5/cancelled). 55/55 pass, typecheck clean.
- Demo baseline (scripted run `01M58XNEQCNZ5KB4PR5DJAB9H7`, scratch data dir): scripted adapter reports 0 tokens, so **prompt chars** is the measured metric:
  - prompt-review 4 calls / 11,828 chars — biggest stage by volume
  - prompt 4 / 9,165 · review 2 / 7,767 · accept 2 / 7,260 · implement 2 / 5,410 · fix 1 / 5,285 · plan 1 / 4,601 · analyse 1 / 2,449
  - total ≈ 55,965 prompt chars (~14k tokens est.); most expensive single item: `fix` (5,285 chars).

