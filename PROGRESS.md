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

## Stage 2 — Cut prompt size — DONE

- `daemon/src/services/context.ts`: `buildContextPack` now takes `scope: 'repo' | 'task'`. Repo scope (plan, prompt drafting, implement) keeps the file list + README. Task scope (qa, review, fix, analyse) drops the repo tour entirely — only the task's changed files, with excerpts only for tool-less adapters when they beat the diff. `errors` now attach only in repo scope; every pack carries `budgetChars`.
- `daemon/src/engine/engine.ts`: `packFor(repo, task, c, wanted, kind?, { diffChars? })` picks the scope by work-item kind; `deskPack(c, wanted, hash)` gives prompt-pipeline/accept items a real budget with zero repo context. `dispatchQa`/`dispatchReview` compute the diff first so `packFor` can skip file excerpts when the capped diff is smaller.
- `daemon/src/engine/prompts.ts`: `renderPrompt` returns `{ text, dropped, budgetChars }` — stable prefix (header, role, goal, task brief, contract) first, volatile data blocks in fixed order after; over-budget → drop in order skills (exec-time) → repo summary → file excerpts → team inbox → errors, then mid-truncate remaining blocks. `finalizeApprovedPrompt` does the same budget fit for pipeline-approved prompts. Inbox capped to the newest 4 messages / 3k chars; diffs capped via `capDiff`, logs via `compactLog`.
- `daemon/src/util.ts`: `compactLog` (collapses repeated lines, keeps first failure block + tail) and `capDiff` (truncates at `diff --git` boundaries, reports omitted-file count).
- `daemon/src/db.ts`: additive `prompt_versions.dropped` + `prompt_versions.budget_chars` columns via the existing idempotent `addColumn` convention — no migration script, existing DBs upgrade in place on open. `createWorkItemRecord` stores them; `executeWorkItem` drops the skills block first and records it; `prompt.trimmed` events emitted.
- Tests: `daemon/tests/prompt-size.test.js` (8 tests — scope behavior, stable ordering, drop recording, inbox budget, capDiff, compactLog). 63/63 pass, typecheck clean.
- Demo (scripted run `01M58Y9QGSGRE1WFGWFWAQY9D6`, scratch data dir, 1 task): total 30,251 prompt chars across 10 items. Per-call vs Stage 1 baseline: review 2,236 (−42%), fix 4,881 (−7.6%), analyse 2,402 (−2%), prompt 2,225 (−3%); desk kinds flat as expected; implement 3,192 (+18%) now carries the approved brief + stable prefix inline. The run shape differed (1 task vs 2), so per-kind averages are the honest comparison — the structural win is that downstream stages no longer repeat the repo tour + README.
- Skipped: keeping file excerpts over messages for `fix` (spec's drop order wins: README/files before old messages); inbox messages marked read when their block is budget-dropped (documented, bounded to 4 newest).

