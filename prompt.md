# Oficina improvement plan (instructions for Devin)

You are improving this project (Oficina: TypeScript daemon in `daemon/`, React UI in `ui/`). Goals: better performance, a smoother workflow, better agent-to-agent communication, fewer wasted tokens, fewer manual interventions, and the missing reliability features.

## Operating rules

1. Work through the stages below **in order**. Do one stage at a time.
2. Track progress in `PROGRESS.md` at the project root. Create it if missing. After each stage, record: stage number, status (done / partial / skipped), files changed, tests added, test results, and anything you chose not to do. On start, read `PROGRESS.md` and resume at the first unfinished stage.
3. Before each stage, read the code involved. Verify a problem actually exists before fixing it. If a feature already exists, extend it instead of duplicating it.
4. After each change run `npm run typecheck -w daemon` and `npm test -w daemon`. Never leave either failing. If you cannot fix a failure, revert that change and note it in `PROGRESS.md`.
5. Make one git commit per stage (after Stage 0 creates the repo). Keep changes small and focused.
6. Do not read, print, edit or commit `daemon/data/` (live SQLite database and `secrets.json`). Do not add dependencies; if one is truly needed, stop and ask.
7. Match the surrounding code style: terse, comments only where non-obvious.
8. Do not run `git reset --hard`, `git clean`, force-push, or delete anything outside what a stage names.
9. If a stage needs a database schema migration, stop after describing it in `PROGRESS.md` and ask before applying it.
10. Do not ask questions you can answer from the code. Stop only for rule 6 or rule 9, or if a stage is blocked.
11. When all stages are done (or you are blocked), finish with a short summary: what was done, what was skipped, remaining risks, and the three highest-value next steps.

## Stage 0: Safety net

1. This directory is not a git repo. Run `git init`, add a `.gitignore` (node_modules, ui/dist, daemon/data/, daemon/daemon.log, .office/, nul, *.log, PROGRESS.md is NOT ignored), and make one baseline commit.
2. Delete the stray Windows files `nul` (project root) and `daemon/nul`. `nul` is a reserved device name, so use the extended path form, for example in cmd: `del "\\?\<absolute path>\nul"`. Do not recreate them. Never redirect output to `nul`; use `/dev/null` in bash or `$null` in PowerShell.
3. Run typecheck and tests. Record the baseline pass/fail counts in `PROGRESS.md`. Fix nothing yet.

## Stage 1: Measure token use

1. Read `daemon/src/services/usage.ts` and how `daemon/src/engine/engine.ts` records tokens per work item.
2. Add `GET /api/runs/:id/token-report` returning, per work item kind (plan, prompt-draft, pm-review, dev, qa, review, fix, accept): count, total prompt chars, total reported tokens, average per call, plus the top 5 most expensive work items. Reuse existing tables.
3. Show it as a "Token report" table on the run page in `ui/`.
4. Add a test for the aggregation.
5. Run the demo and record which stage uses the most tokens in `PROGRESS.md`. No behavior change in this stage.

## Stage 2: Cut prompt size

Work in `daemon/src/engine/prompts.ts`, `daemon/src/services/context.ts`, `daemon/src/services/messages.ts` and the `packFor` / `inboxText` helpers in `engine.ts`.

1. `context.ts` sends the repo file list and README excerpt on every work item. Send them only for the first item of a task (plan, prompt-draft). Later items (qa, review, fix, accept) get only the task's changed files and the approved prompt.
2. Build a stable task brief (title, acceptance criteria, approved prompt, fixed order) at the **start** of each prompt, with volatile content (inbox, logs, diffs) after it, so providers with prompt caching can reuse the prefix. Test that the prefix is byte-identical across calls for the same task.
3. Cap and de-duplicate check logs and error excerpts (collapse repeated lines, keep the first failure and the tail). Add a helper in `util.ts` with a test.
4. Give reviewer and QA the size-capped diff instead of full files when the diff is smaller, with an "N more files omitted" note.
5. When over the token budget, drop the lowest-value sections first (skills, repo summary, README, old messages, errors, in that order) and record dropped sections on the `prompt_versions` record.
6. Re-run the token report on the same scenario. Record before/after numbers. Keep only changes that reduce tokens and keep tests green.

## Stage 3: Structured agent-to-agent hand-offs

1. Write a typed hand-off envelope on each task at every stage transition, produced by the engine, not the model: `{ fromRole, toRole, taskId, status, summary (<=400 chars), filesChanged[], checksRun[], openQuestions[], decisions[], blockers[] }`. The next agent's prompt gets the envelope instead of the previous agent's full output. Full output stays in the UI and is included only when the recipient needs it (for example a reviewer after a failed QA).
2. For pm, prompt-creator, reviewer and qa, require strict JSON replies validated by a small hand-written validator. On invalid output do one automatic repair retry that sends only the validation error and the bad output. Count these retries in the token report.
3. In `messages.ts`, deliver each broadcast message to each agent at most once (per-agent delivery tracking) instead of re-sending the latest 8 in every prompt. Do not re-send messages from finished tasks.
4. Drop a new message that is >90% similar (normalized) to an unread one from the same sender to the same recipient.
5. Tests: envelope per stage, single delivery of broadcasts, repair retry, dedupe. Update the README "Flow" section.

## Stage 4: Reliability

1. Add `daemon/src/services/failure.ts` classifying failures as transient (rate limit, network, timeout, CLI crash), model-quality (invalid or empty output) or fatal (auth, missing CLI, repo conflict). Transient: exponential backoff with jitter, then fail over to the next routing option. Model-quality: one repair retry, then escalate to a stronger tier. Fatal: pause the run and raise one "Needs you" item with the exact fix. Unit tests.
2. On daemon startup, find work items stuck in `running` with an old heartbeat, mark them interrupted, and requeue idempotently. Verify the idempotency key prevents double execution and double commits. Test a simulated crash.
3. After the 3-attempt limit and before escalating to the human, have the PM write a short diagnosis and try one strategy change (stronger tier, or split the task). Log it as an event.
4. Add configurable per-task and per-run time and cost ceilings that pause (not kill) the run and notify once with a clear reason.
5. Make sure a hung CLI child process (`adapters/cli.ts`) is killed with its whole process tree on timeout or stop on Windows (`taskkill /T /F`). Add a test or a written verification note.

## Stage 5: Fewer manual interventions

1. Add an approval policy (always-ask, ask-when-risky, auto), default always-ask. "Risky" means: files outside the task's declared paths, config/CI/secrets/lockfiles, deletions, large diffs, or checks not run. Auto-approved items log their reason as an event. Put the classifier in `services/policy.ts` with tests.
2. Group the "Needs you" inbox by run with one summary line per item (what, why, risk) and an approve-all for low-risk items.
3. Notify only for needs-you, run done and run failed (reuse `office-tray.ps1`).
4. Add a Dashboard digest "since your last visit": tasks done, blocked and why, tokens used, what needs the owner.
5. Follow `spec/DESIGN-figma.md`. Build the UI with `npm run build -w ui`.

## Stage 6: Missing workflow features

Implement each separately, with tests, checking first what already exists.

1. Run read-only work (prompt drafting, review, QA, analysis, docs) in parallel with a code task on non-overlapping paths, concurrency configurable (default 2). Never run two writers on overlapping paths.
2. Result cache keyed by (kind, prompt hash, context pack hash, model). Show "cache hit" in Live activity and count saved tokens in the token report.
3. Derive runnable checks from the acceptance criteria before the developer starts. Flag non-checkable criteria at DoD review.
4. Scope guard: compare files changed to the approved prompt's paths; unexpected files go to the PM as a question.
5. Per-repo lessons memory (error signature to fix, repeated reviewer flags). Inject at most 3 relevant lessons (keyword/path match, no embeddings), about 300 tokens max. Extend the existing error KB rather than duplicate it.
6. Auto-generate a run summary at the end of a run from stored data, with no model call: goal, tasks, commits, checks, tokens and cost per stage, retries, human interventions. Show it on the run page and export as Markdown.

## Stage 7: Performance and final audit

1. Profile with `daemon/scripts/bench.mjs`. Look for N+1 queries (per-agent lookups inside loops in `messages.ts`), missing indexes on `work_items(task_id, status)`, `agent_messages(run_id, read_at)` and `events(run_id, created_at)`, blocking sync git/exec calls in `git.ts`, `snapshot.ts`, `checkpoints.ts`, and large WebSocket payloads (activity detail up to 12000 chars sent to every client). Fix what the profile shows, with before/after numbers.
2. UI: paginate or virtualize long event and activity lists and throttle WebSocket-driven re-renders.
3. Run the full test suite and a complete scripted end-to-end demo. Record timings and failures.
4. Update the README "State of the implementation" to match reality and list remaining risks.
