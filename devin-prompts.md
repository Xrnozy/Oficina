# Devin prompt sequence for officeChain

Paste one prompt at a time, in order. Wait for Devin to finish and report before the next one.
Each prompt is self-contained and ends with a verification step, so a bad change is caught early.

---

## Prompt 0 — Safety net and baseline (do first)

```
You are improving the project in the current directory (officeChain: a TypeScript daemon in daemon/, React UI in ui/). Read README.md and daemon/src/engine/engine.ts, engine/prompts.ts, services/context.ts, services/messages.ts, services/router.ts, services/verify.ts before changing anything.

Rules for this whole session:
- Keep each change small and focused. After each change run `npm run typecheck -w daemon` and `npm test -w daemon`. Never leave either red.
- Do not delete or rewrite daemon/data/ (it holds a live SQLite db and secrets.json). Do not print or commit secrets.
- Match the surrounding code style (terse, comments only where non-obvious). No new dependencies unless I approve them.
- Report at the end of each task: files changed, tests added, and anything you chose not to do.

Task 0:
1. This directory is not a git repo. Run `git init`, add a .gitignore (node_modules, ui/dist, daemon/data/, daemon/daemon.log, .office/, nul, *.log) and make one baseline commit so every later change is diffable and undoable.
2. Delete the stray Windows artifacts `nul` in the project root and `daemon/nul` (created by "> nul" redirects). Confirm they are not tracked/needed.
3. Run typecheck and tests and tell me the baseline result (pass/fail counts). Do not fix anything yet.
```

---

## Prompt 1 — Measure token use before optimizing

```
Goal: find out where tokens are actually spent so we optimize the right things.

1. Read daemon/src/services/usage.ts and how engine.ts records tokens per work item (the CLI adapters report cost/tokens/turns in the final result).
2. Add a small report, GET /api/runs/:id/token-report, that returns per work item kind (plan, prompt-draft, pm-review, dev, qa, review, fix, accept): count, total prompt chars, total reported tokens, and average per call; plus the top 5 most expensive work items with their kind and task. Reuse existing tables; add a column/migration only if truly needed (see daemon/src/migrate.ts).
3. Add a "Token report" section to the run page in ui/ showing that table.
4. Add a test for the aggregation.
5. Run the demo (npm run seed, then a scripted run) and paste me the report output so I can see which stage dominates.

Do not change behavior yet. This task is measurement only.
```

---

## Prompt 2 — Cut prompt size (biggest token win)

```
Goal: reduce tokens sent per work item without losing information. Work in daemon/src/engine/prompts.ts, services/context.ts, services/messages.ts and the packFor/inboxText helpers in engine.ts.

Problems I want fixed (verify each in the code first, then fix):
1. context.ts builds the repo summary from a raw file list (up to 120 names) and the first 60 lines of README on EVERY work item. Make this adaptive: include the README excerpt and file list only for the first work item of a task (plan/prompt-draft); for later items (qa, review, fix, accept) send only the files the task actually changed plus the approved prompt.
2. The approved prompt is re-sent in full to the correction prompt, review, QA and accept steps. Add a stable "task brief" (title, acceptance criteria, approved prompt, in a fixed order at the START of the prompt) so providers with prompt caching (Anthropic API, etc.) can cache the prefix. Put volatile content (inbox, check logs, diffs) AFTER the stable prefix. Add a test asserting the prefix is byte-identical across calls for the same task.
3. Check logs and error excerpts: cap and de-duplicate (collapse repeated lines, keep first failure + tail). Add a helper in util.ts and test it.
4. Reviewer/QA should receive the diff (git diff of the task's files, size-capped, with a "N more files omitted" note) instead of full file contents when the diff is smaller.
5. The token estimate uses chars/4 everywhere. Keep it, but make the budget enforcement drop the LOWEST-value sections first in a defined order (skills > repo summary > README > old messages > errors) and record which sections were dropped in the prompt_versions record.

After the change, re-run the token report from the previous task on the same demo scenario and show before/after numbers. Only keep changes that reduce tokens without failing tests.
```

---

## Prompt 3 — Structured agent-to-agent hand-offs

```
Goal: make communication between agents structured and cheap, not free text.

Currently messages (services/messages.ts) are free text up to 4000 chars, parsed from "===== MESSAGE =====" blocks, and takeInbox re-includes the latest 8 broadcast findings in every prompt.

Implement:
1. A typed hand-off envelope stored on each task, written by the engine (not by the model) at each stage transition: { fromRole, toRole, taskId, status, summary (<= 400 chars), filesChanged[], checksRun[], openQuestions[], decisions[], blockers[] }. The next agent's prompt receives this envelope instead of the previous agent's full output. Full output stays viewable in the UI and is only included when the recipient explicitly needs it (e.g. a reviewer on a failed QA).
2. Make agent replies for pm / prompt-creator / reviewer / qa strict JSON validated against a schema (zod is not installed — write a tiny validator, or ask me before adding a dependency). On invalid JSON, do ONE automatic repair retry that sends only the validation error and the bad output, not the whole prompt again. Count these retries in the token report.
3. Broadcast findings: deliver each broadcast to each agent at most once (track per-agent delivery), instead of re-sending the latest 8 every time. Messages older than the current task and already acted on are not re-sent.
4. Add message de-duplication: if a new message from the same agent to the same recipient has a >90% similar text (normalized) to a prior unread one, drop it and bump a counter.
5. Tests for: envelope generation at each stage, single-delivery of broadcasts, repair retry, dedupe.

Update the README "Flow" section to describe the envelope. Run typecheck and tests.
```

---

## Prompt 4 — Reliability: retries, timeouts, resume, idempotency

```
Goal: tasks should flow from one agent to the next without a human unsticking them.

Review engine.ts (executeWorkItem, handleWorkItemFailure, timers 'heartbeat.missed' and 'timer.cycleMax') and router.ts, then:
1. Failure classification: classify failures as transient (rate limit, network, timeout, CLI crash), model-quality (invalid output, empty reply), or fatal (auth, missing CLI, repo conflict). Transient -> retry with exponential backoff + jitter on the same option, then fail over to the next routing option; model-quality -> one repair retry then escalate to a stronger tier; fatal -> pause the run and raise ONE Needs-you item with the exact fix. Put this in a new services/failure.ts with unit tests.
2. Daemon restart recovery: on startup, find work items stuck in 'running' with an old heartbeat, mark them interrupted, and requeue them idempotently (idempotency_key already exists; verify it prevents double-execution and double-commits). Add a test that simulates a crash mid-work item.
3. The loop limit is 3 attempts and then "you decide". Before escalating to the human, make the PM write a short "why this keeps failing" diagnosis and try ONE strategy change (stronger model tier, or split the task into smaller tasks). Only then ask the human. Log it as an event.
4. Add a per-task and per-run time and cost ceiling that pauses (not kills) the run and notifies once, with a clear reason. Check DEFAULT_LIMITS in engine.ts and make them configurable in Routing.
5. Check that a stuck CLI child process (Devin/Claude/cursor-agent via adapters/cli.ts) is killed with its whole process tree on timeout/stop on Windows (use taskkill /T /F) and add a test or manual verification note.

Run typecheck and tests; summarize the new failure paths in the README.
```

---

## Prompt 5 — Fewer manual interventions

```
Goal: reduce how often the human has to click.

1. Approvals: the DoD approval and per-task approvals currently always wait for the owner. Add a policy (Routing -> Approvals) with levels: always-ask, ask-when-risky, auto. "Risky" = touches files outside the task's declared affectedPaths, touches config/CI/secrets/lockfiles, deletes files, > N files or > M lines changed, or checks not run. Auto-approve non-risky items and log the decision with its reason as an event. Default stays always-ask. Tests for the risk classifier in services/policy.ts.
2. Batch the "Needs you" inbox: group by run, show one-click approve-all for low-risk items, and one summary line per item (what, why, risk).
3. Add desktop notification hooks (the existing office-tray.ps1) only for: needs-you, run done, run failed. No notifications for routine events.
4. Add a "resume where I left off" digest on the Dashboard: since last visit — tasks done, tasks blocked and why, tokens used, what needs me.

Keep the UI consistent with spec/DESIGN-figma.md. Typecheck, test, and build the UI (npm run build -w ui).
```

---

## Prompt 6 — Missing features that make the workflow safer and smarter

```
Goal: add the features that are missing from the agent workflow. Implement them one at a time, each with tests, each as a separate commit. Check what exists in the code first and skip anything already present.

1. Task dependency scheduling and parallelism: tasks already have a plan graph (validatePlanDiff checks cycles). Code tasks run one at a time. Allow read-only work (prompt drafting, review, QA, analysis, docs) to run in parallel with a code task on non-overlapping affected paths, bounded by a configurable concurrency (default 2). Never run two writers on overlapping paths.
2. Result cache: if a work item has the same (kind, prompt hash, context pack hash, model) as a prior successful one, reuse the result instead of calling the model. Show "cache hit" in Live activity and count saved tokens in the token report.
3. Acceptance-test-first: before the developer runs, have QA/Prompt Creator derive runnable checks from the acceptance criteria (the verify.ts check types) so "done" stays machine-checkable. If a criterion cannot be made checkable, flag it at DoD review rather than late.
4. Scope guard: after a developer finishes, compare files changed against the approved prompt's affectedPaths; unexpected files go to the PM as a question instead of silently flowing on.
5. Project memory: persist short, deduplicated "lessons" (error signature -> fix that worked, repo conventions the reviewer repeatedly flagged) per repo, inject only the 3 most relevant for a task (keyword/path match, no embeddings), and cap at ~300 tokens. The error KB in the db may already cover part of this; extend rather than duplicate.
6. Run summary: when a run finishes, auto-generate a one-page report from stored data (no model call): goal, tasks, commits, checks, tokens/cost per stage, retries, human interventions. Show it on the run page and make it exportable as Markdown.

After each feature: typecheck, tests, README update. Stop and report if any feature needs a schema migration so I can review it first.
```

---

## Prompt 7 — Performance and final audit

```
Goal: performance pass and a final review.

1. Profile the daemon with daemon/scripts/bench.mjs. Look for N+1 queries (messages.ts calls q1 per agent name inside loops; engine.ts event emission), missing SQLite indexes on work_items(task_id, status), agent_messages(run_id, read_at), events(run_id, created_at); synchronous git/exec calls on the event loop (child_process.execSync/spawnSync in git.ts, snapshot.ts, checkpoints.ts) that block WebSocket traffic during runs; and WebSocket broadcasting of large payloads (agent.activity detail up to 12000 chars) to every client. Fix what the profile shows, one at a time, with before/after numbers.
2. UI: paginate or virtualize long event/activity lists, and throttle WebSocket-driven re-renders.
3. Run the full suite plus a complete end-to-end scripted demo run. Report timing and any failures.
4. Final audit: list remaining risks, anything half-implemented, and the three highest-value next improvements. Update README "State of the implementation" to match reality.
```

---

### Tips while running these
- If Devin starts changing many unrelated files, tell it: "Stop. Revert to the last commit and redo only what the task asked."
- Prompts 1 and 2 are the highest token-saving; 3 and 4 are the highest workflow-reliability. If time is short, run 0 → 1 → 2 → 4 → 3.
