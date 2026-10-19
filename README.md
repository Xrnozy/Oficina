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

**Prompt preparation** (Routing → Workflow): `pipeline` (default, as above; the PM drafts itself if there is no Prompt Creator), `handoffs` (PM writes only the task prompt; rework and check failures go straight to the developer — fewest calls), `all`, `off`.

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

- `daemon/` — TypeScript daemon: SQLite state (`node:sqlite`, WAL), hash-chained event log, workflow engine (`src/engine/`), provider adapters (`src/adapters/` — scripted, openai-compatible, anthropic, cli, devin, manual), Git worktree manager, verification service, error-report KB, router (quota/circuit/SoD), approvals, usage accounting, REST + WebSocket API (`src/api/server.ts`).
- `ui/` — React + Vite + Tailwind, styled after `spec/DESIGN-figma.md` (monochrome editorial frame, pastel color-block surfaces): Dashboard, Office (drag agents between role slots with permission-diff preview), Live Activity, Timeline & replay, Tasks kanban, DoD editor, Error Reports, Approvals, Agents, Skills, Providers.
- `demo-repo/` — seeded git repository the demo run works on.
- `.office/` — runtime data (SQLite db, blobs).

## State of the implementation

Working end-to-end (verified): run lifecycle draft → dod-review → running → done, deterministic checks (`exit0` commands plus `errors:open`, `review:all-merged-approved`, `sections(README.md,…)` rule checks), error reports with signature dedupe and KB-backed fix hints, analyst-routed fixes, separation of duties (author can't self-review), merge handling, pause/stop controls, approval inbox, usage/quota windows and circuit breakers, audit-grade hash-chained events.

Partial/scaffolded: sandboxing, hosted-agent adapters, embeddings/code intelligence, Tauri shell (browser UI used instead).
