# officeChain — AI agent router

A local-first orchestrator where a **deterministic workflow engine owns the build loop** and AI agents do the work inside it. Git + a local verification runner are the ground truth; "done" is measured by machine-checkable Definition-of-Done criteria, not model judgement. See `spec/AI-Agent-Office-Spec.md`.

## Quick start

```bash
npm install
npm run build -w ui     # build the React UI into ui/dist
npm run dev             # start the daemon on http://localhost:4780 (serves API + UI + WebSocket)
```

Then open http://localhost:4780 — the Dashboard has a "new run goal" box. The seeded **Demo Office** workspace comes with five scripted agents (PM, Developer, Reviewer, Analyst, Docs) and a demo repo; create a run, approve the DoD in the Approvals inbox, and watch the loop run plan → assign → build → verify → review → merge → done.

```bash
npm run seed            # re-seed the demo workspace (idempotent — skips if data exists)
npm run dev:ui          # optional: Vite dev server with HMR (proxying to :4780)
```

## Windows launchers

- `start-office.bat` — double-click: starts the daemon in a console window and opens the UI.
- `start-office-tray.bat` — double-click: runs the daemon hidden and puts an icon in the system tray. Right-click the tray icon → **Open officeChain** or **Quit officeChain** (Quit stops the daemon).

## Adding a backend (Providers page)

- **Claude Code / cursor-agent / Devin CLI (no API key)** — kind `cli`; uses each CLI's own login. Add backend detects which of these is installed on this machine and fills the command (pick one if several are installed). The Model list is read from the CLI itself:

  | Preset | Command | Models from | Prompt via |
  |---|---|---|---|
  | Claude Code | `claude -p --verbose --dangerously-skip-permissions --output-format stream-json` | `claude -p /model` | stdin |
  | cursor-agent | `agent -p --output-format stream-json --force` | `agent --list-models` | stdin |
  | Devin CLI | `devin -p --prompt-file {promptFile} --permission-mode dangerous --respect-workspace-trust false` | `devin models list --format json` | `{promptFile}` (Devin doesn't read stdin) |

  An empty Command still falls back to the Claude Code command. The chosen model is passed as `--model` (or wherever `{model}` appears). Other placeholders: `{prompt}` (inline), `{worktree}`. The daemon adds `%LOCALAPPDATA%\cursor-agent`, `%LOCALAPPDATA%\devin\cli\bin`, `%USERPROFILE%\.local\bin` and `%APPDATA%\npm` to PATH when spawning; an explicit executable path in the command is used as written. Log in first: `claude auth login`, `agent login`, `devin auth login`.
- **Devin** — kind `devin`. No CLI exists; Devin runs in Cognition's cloud over the REST API. Get a key at app.devin.ai → Settings → API Keys (starts with `cog_`). Devin returns work by pushing a `devin/…` branch to the repo's `origin` remote, so code delivery needs a remote Devin can reach (e.g. GitHub); for local-only repos you get its report but not files.
- **Model APIs** — kind `openai-compatible` (OpenAI/Ollama/LM Studio) or `anthropic` (API key). Keys are stored in `.office/secrets.json` — never in the repo.

Then point an agent at the new backend on the **Agents** page (backend dropdown on each card).

## Flow: request → PM ⇄ Prompt Creator → developer → reviewer → PM

Send a feature request from **Requests**; every hand-off after that is automatic — prompts, change notes and findings travel between agents as structured messages and shared task context, never by copy-paste. Assign agents to roles on **Roles**, and pick their models on **Routing**.

| Step | Role | Does | Never |
|---|---|---|---|
| 1 | `pm` | turns the request into tasks + acceptance criteria | write, review or test code |
| 2 | `prompt-creator` | drafts the implementation-ready prompt | — |
| 3 | `pm` | reviews the draft (correct, complete, clear, aligned) — approves or sends it back | — |
| 4 | `developer` | edits the repository, self-checks, writes change notes (with a `Commit:` line) | — |
| 5 | `qa` / `reviewer` | checks the work against the **approved prompt**, the criteria and the tests; reports to the PM | edit code |
| 6 | `pm` | accepts (→ commit per policy) or reworks: the Prompt Creator drafts a **correction prompt**, the PM reviews it, the developer fixes | read code |

Check failures (build/tests) also become a correction prompt. The approved prompt stays the authoritative requirements: every correction, review and acceptance gets it, and it changes only when you edit the requirements. Loops are bounded (3 attempts, then you decide). The PM runs only when a decision is needed — planning, prompt approval, acceptance — never continuously. Each task keeps its full record (request → drafts → PM reviews → approved prompt → work → findings → corrections → checks → result) on its task page.

**Hand-offs are typed.** On every stage transition the engine writes a hand-off envelope (`{ fromRole, toRole, taskId, status, summary, filesChanged, checksRun, openQuestions, decisions, blockers }`, stored in `handoffs` and shown as `task.handoff` in Live activity). The next agent's prompt carries the envelope — not the previous agent's whole output. Full output is attached only when the recipient needs it (a fixer gets the findings; a reviewer gets the QA report when QA could not run or the accept step needs it).

**Decision roles answer in strict JSON.** The pm, prompt-creator, reviewer and qa replies are validated before they are acted on; a reply that fails validation gets exactly one automatic repair retry that sends back only the validation error and the bad output (the retry is a normal work item, so it shows up in the token report).

**Messages are delivered, not repeated.** Broadcasts reach each agent at most once (per-agent delivery tracking), messages on finished tasks are never delivered, and a message that is ≥90% the same as an unread one to the same recipient is dropped instead of re-sent.

**Prompt preparation** (Routing → Workflow): `pipeline` (default, as above; the PM drafts itself if there is no Prompt Creator), `handoffs` (PM writes only the task prompt; rework and check failures go straight to the developer — fewest calls), `all`, `off`.

## Visual workflow

The **Workflow** page draws the pipeline above as an editable graph — and lets you replace it. The built-in graph is a read-only mirror of the fixed pipeline; **Clone** makes your own copy, and **Set active** routes every new task in the workspace through it. Runs pin the workflow version they started on, so editing a graph never changes a run in flight. With no custom workflow active, nothing about the flow above changes (a suite test asserts the identical work-item sequence).

**Concepts.** The canvas holds *nodes* connected by *edges*; the engine walks the graph per task instead of following the fixed sequence. Saving creates an immutable version; activation points the workspace at the latest one. Each node can carry extra instructions, a model tier, a budget and per-node **skill attachments** (they take budget priority over the agent's and role's skills, and are frozen into the version they were saved with).

| Node | Purpose |
|---|---|
| `start` / `end` | entry and finish; every reachable path must reach an end |
| `agent` | a desk: role (or a pinned agent), purpose (plan/implement/qa/review/accept/analyse/doc/custom), scope (`run` — once per run — or `task`), instructions, budget, timeout, writable vs read-only, skill refs |
| `condition` | deterministic branch on outcome/task fields — no model call |
| `merge` | join parallel branches (`all` or `any` of its in-edges) |
| `human` | pause for an owner decision, then continue |

Edges: `next` (positive outcomes), `on-success`, `on-failure`, `on-reject` (the only kinds allowed to close a cycle — they carry a `maxLoops` bound, default 3, after which you decide), `message` (a structured note to the target node's agent — no model call; optionally `waitForReply`). Condition-node edges get a condition builder with a plain-language preview and exactly one `else` edge.

**Editing.** Drag agents (grouped by role) or Condition/Merge/Human/End from the palette onto the canvas. To insert an agent between two nodes, drop it onto the edge between them (or drag an existing node onto an edge, or click the edge's hover "+") — the edge splits and the first half keeps its kind and condition. Deleting a mid-chain node re-links its neighbours. Undo/redo, copy/paste, autosaved drafts, JSON import/export, version history with restore-as-draft. Validation badges mark the offending nodes; you can't save or activate a graph with errors.

**Safety.** The inspector shows a worst-case estimate (agent calls incl. loop bodies, human gates, skill chars) and **guardrails** — step, cost and time ceilings that pause dispatching on a *Needs you* item when hit. **Dry run** simulates the draft with mocked per-node outcomes — no model, no tokens — and highlights the taken path on the canvas. Templates (default, fast, strict, docs, bug-fix, parallel-review) give you a working starting point. Firing, editing or moving an agent that a graph references warns which workflow nodes are affected, and every edit lands in the hash-chained audit log on the version's page.

**While it runs.** Pick a run and the canvas lights up: rings show each node's step state and taken edges stay highlighted (from `workflow.step`/`branch` events, live over WebSocket or replayed for finished runs). Tasks record which node and edge produced each work item; a task stalled at a gate — human, exhausted loop, dead end, guardrail — appears under *Needs you* and resumes on your decision.

**Limits.** One active workflow per workspace; a run pins its starting version; conditions are deterministic (fields/operators, no free-form code); a `message` edge delivers to the target's next prompt rather than interrupting it; the run-scope `plan` node still runs through the engine's planning cadence, so re-planning on DoD review is unchanged.

## Working in your repository (direct mode)

By default (**Routing → Where agents work → direct**) agents work inside the repository you selected, on the branch you have checked out, like a coding CLI — no copies of the project. `isolated` keeps the older worktree-per-task flow.

- Code tasks run one at a time, so every change is attributed to exactly one task and one agent.
- Uncommitted changes you already had are detected before a task starts (`repo.dirty`), preserved, and never included in the task's changes or commits.
- The developer's change notes go to `.office/handoff/<task>.md`; `.office/` is ignored through `.git/info/exclude` (your `.gitignore` is not edited).
- The office never runs `reset`, `checkout`, `clean`, history rewrites or force-pushes.

### Checkpoints, undo and redo

- **General Checkpoint** — the whole result of a task (all its agents), recorded before and after the task.
- **Agent Checkpoint** — one agent's work item inside a task, recorded before and after it ran.
- **Manual Checkpoint** — a save point you create (Checkpoints → Save).

Undo / Redo / Restore apply the recorded change to the current working tree as a patch, after a dry run that shows the exact files and lines and any conflicts. Nothing is re-run and no model is called. Your other edits and other agents' work are kept; when they overlap the change, the operation is refused and nothing changes. Later work touching the same files is listed as a dependency. Undoing a task takes its agents' checkpoints with it; undoing one agent leaves the rest. Restore first saves the current state, so it is reversible too. Snapshots are git tree objects (tracked, untracked and deleted files; not ignored ones) built in a private index and pinned under `refs/officechain/`, so `git gc` keeps them; your index, branch and stash are never touched. Checkpoints left open by a crash are closed as `interrupted` on restart and stay undoable. Retention: the newest 500 per repository (`pruneCheckpoints`).

### Repository timeline

**Repo timeline** lists, newest first and page by page: your commits and the AI's (linked to their task and agents), General and Agent Checkpoints, undo/redo/restore operations, task starts and results, reviews and acceptance decisions, and recovery events. Click an entry to see the actual diff. Commits can be reverted or reapplied (as new commits) after a dry run; two commits or two checkpoints can be compared.

### Commits

When the PM accepts a task, a commit containing **only that task's files** is prepared (`git commit --only -- <paths>`, so your hooks, signing and identity apply and anything you have staged stays staged). The message comes from the developer's `Commit:` line or the PM's acceptance — no extra model call. Generic titles are replaced with one derived from the task. Conventional Commits are used when the repository's history does. A trailer states only the verification that actually ran (`Checks: unit:all pass`, or `NOT VERIFIED` when something failed).

**Routing → Commits**: `approve` (default — the proposal waits under **Needs you**; edit the message on the task page), `auto` (committed when checks and review passed and only the task's files are involved; otherwise it asks), `manual`. A file you had already modified before the task, or edited after it finished, is never committed without your decision.

## Live activity

**Live activity** shows what each agent's CLI actually reports, parsed locally with no extra model calls:
- the prompt the agent received, and its messages;
- file reads, edits and searches, commands and test runs with their results;
- the CLI's own plan/todo updates, errors and the final result (cost, tokens, turns);
- hand-offs between agents.

Claude Code and cursor-agent `stream-json` are parsed; other CLIs (e.g. Devin) show their text lines. Reasoning appears only when the CLI emits it, labelled as such. Init records, heartbeats and rate-limit notices are kept in the **Technical log** tab. While a developer works in the repository, **Changes so far** shows its files with +/− counts, refreshed only when the working tree actually changes. **View diff** opens the green/red diff.

## Skills

Write general skills (reusable by any role) or role-specific ones on **Skills**, or import `SKILL.md` folders. Imported skills are scanned and need your approval; your own skills don't. Attach a skill to a role or to one agent. Unpinned attachments follow your edits. Each skill can be limited to kinds of work and/or task keywords, so it is sent only where relevant, within a per-prompt budget. Skills travel in the prompt, which works for every provider. Each work item records which skills were applied or skipped and why (`skill.applied`), and the Skills page shows when each was last actually delivered. Skills imported before content was stored are relinked by exact content hash from `~/.claude/skills` and similar folders (or re-import the folder; your approval is kept).

## Model routing

Each agent has an ordered list of **model options** (Routing page; any backend from Providers, mixed freely). For every work item the router picks one:

1. Skip options that are unavailable: circuit open, quota window exhausted, or the account's monthly budget reached.
2. Work out the tier the work needs: `fast` (docs, failure analysis, difficulty-1 tasks), `standard` (most implementation, testing, PM prompts and acceptance), `strong` (difficulty 4–5).
3. Among options at or above that tier, take the cheapest: plan-billed first (CLI logins, subscription/credit accounts — no per-call cost), then the lowest metered price; ties go to the least over-powered model, then list order. If nothing is strong enough, the strongest available.
4. If that call fails, the next option is tried, then other agents in the same role.

Synced models get a tier from their name (haiku/mini/flash/lite → fast, opus/max/high/ultra → strong, else standard); set it per model on Routing and the sync keeps your choice. Reasoning effort `auto` sets low/medium/high from the tier (API backends only). **Routing → fixed** turns per-task routing off: the first option is always tried first. Every choice is logged as a `model.routed` event and listed under **Recent routing decisions**.

## Layout

- `daemon/` — TypeScript daemon: SQLite state (`node:sqlite`, WAL), hash-chained event log, workflow engine (`src/engine/` — fixed pipeline + the graph executor), workflow graph service (`src/services/workflow.ts` — validation, versioning, templates, estimates, audit), provider adapters (`src/adapters/` — scripted, openai-compatible, anthropic, cli, devin, manual), Git worktree manager, verification service, error-report KB, router (quota/circuit/SoD), approvals, usage accounting, REST + WebSocket API (`src/api/server.ts`). E2E demos: `npm run bench` (default pipeline), `node scripts/demo-workflow.mjs` (custom graph).
- `ui/` — React + Vite + Tailwind, styled after `spec/DESIGN-figma.md` (monochrome editorial frame, pastel color-block surfaces): Dashboard, Office (drag agents between role slots with permission-diff preview), Workflow (ReactFlow graph editor with live run overlay), Live Activity, Timeline & replay, Tasks kanban, DoD editor, Error Reports, Approvals, Agents, Skills, Providers.
- `demo-repo/` — seeded git repository the demo run works on.
- `.office/` — runtime data (SQLite db, blobs).

## State of the implementation

Working end-to-end (verified): run lifecycle draft → dod-review → running → done, deterministic checks (`exit0` commands plus `errors:open`, `review:all-merged-approved`, `sections(README.md,…)` rule checks), error reports with signature dedupe and KB-backed fix hints, analyst-routed fixes, separation of duties (author can't self-review), merge handling, pause/stop controls, usage/quota windows and circuit breakers, audit-grade hash-chained events.

Efficiency: per-kind token report (`GET /api/runs/:id/token-report`, Dashboard panel) with cache-hit savings; budgeted prompts — stable prefix first, task-scoped context packs (the repo tour ships once per task), capped diffs/logs, low-value sections dropped and recorded on `prompt_versions`; result cache keyed on (kind, prompt, pack hash, model) reuses identical work items with zero adapter calls.

Communication: engine-built hand-off envelopes at every stage transition (the next agent gets the envelope, not the previous full output), strict-shape replies for PM/Prompt-Creator/reviewer/QA with one repair retry, broadcasts delivered to each agent at most once, near-duplicate messages dropped.

Reliability: failures classified transient / model-quality / fatal — backoff with jitter and provider failover, one repair retry then tier escalation, fatal pauses the run with one "Needs you" and a concrete fix; PM diagnosis step before human escalation (retry-stronger or split); per-task and per-run time/cost ceilings that pause, never kill; crash recovery requeues stale `running` items idempotently; timed-out CLI children are killed as a process tree on Windows.

Interventions: approval modes `always-ask` | `ask-when-risky` | `auto` with a change-risk classifier (out-of-scope files, config/secrets/lockfiles, deletions, large diffs, missing checks, user-owned edits); Needs-you grouped by run with approve-all-low-risk; tray notifications for needs-you/run-done/run-failed only; Dashboard digest "since your last visit".

Workflow: read-only lane — non-overlapping tasks draft/PM-review prompts on a desk while a writer holds the repo (`limits.maxReadOnly`, default 2; writers still never overlap); checks derived from acceptance criteria, non-checkable ones flagged at DoD; scope guard reports out-of-declared-path files to the PM; per-repo lessons memory (≤3, ~300 tokens, keyword/path match) injected into implement/fix prompts; model-free run summary on the run page with Markdown export.

Performance: benchmark `daemon/scripts/bench.mjs` — the scripted end-to-end scenario completes in ~27s (23 work items, 310 events, all 6 DoD items pass). Indexes on the hot lookups (`work_items(task_id,status)`, `agent_messages(run_id,read_at)`, `events(run_id,seq/ts)`, `work_items(cache_key,status)`, `error_reports(signature,status)`); agent names preloaded instead of per-message lookups; WebSocket broadcasts cap string fields at 2000 chars with lazy full detail via `GET /api/events/:seq`; recent-tree memoization + async git helpers keep snapshot/diff work off hot paths; Activity and Timeline cap rendered events and throttle WS-driven updates.

Remaining risks: the risk classifier and failure classifier are pattern-based — unusual provider error text degrades to transient retries (bounded, then PM diagnosis), and a novel risky change shape may pass `auto`; scope guard is advisory — the PM decides whether extra files belong; lessons match by keyword/path only, so relevant lessons can be missed; the read-only lane trusts `affectedPaths` for overlap — a task that under-declares its paths can draft against a stale tree; benchmarks use scripted agents, so real-provider latency dominates in production and the index/memoization wins matter most at scale.

Partial/scaffolded: sandboxing, hosted-agent adapters, embeddings/code intelligence, Tauri shell (browser UI used instead).
