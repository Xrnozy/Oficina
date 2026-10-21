# Preliminary questions and answers

The questions below were asked before writing the specifications. Each one was answered from the repository and its documents where the evidence is enough. The owner should not be asked again about anything marked answered. Anything marked **open** goes to the questioning agent.

Evidence labels are explained in the [README](README.md).

## A. Purpose and users

| # | Question | Answer | Status |
|---|---|---|---|
| A1 | What is Oficina? | A local, multi-agent software office. The owner states a request. Agents (planner, coder, tester, reviewer) plan, build and check it inside the owner's own repository. Nothing is kept without the owner's yes. **[V]** `README.md`, `ABOUT.md` | answered |
| A2 | Who is it for? | The owner, working alone, on their own machine. Teams are mentioned in `ABOUT.md` as an audience but nothing in the code supports several human users. **[V]** the API has no accounts or logins; only a localhost check. `daemon/src/api/server.ts` | answered |
| A3 | Why was it made? | The README and ABOUT give the design reasons (control, facts over promises, local). The owner's personal story is not recorded anywhere. | **open** (Q-01) |
| A4 | Which operating system matters? | Windows first. Launchers are `.bat` and PowerShell, the tray is PowerShell, and many fixes target Windows (process-tree kill, console windows). macOS and Linux are best effort. **[V]** `PROGRESS.md` stages 4, 8, 10; `start-office.bat` | answered |
| A5 | Is it a hackathon project? | The folder is named "Hackathon testing", but no document says so. | **open** (Q-02) |

## B. Existing functionality

| # | Question | Answer | Status |
|---|---|---|---|
| B1 | What stack does it use? | Node 22.5+, TypeScript run by tsx, Express, SQLite through `node:sqlite`. UI is React, Vite, Tailwind, ReactFlow. Port 4780. **[V]** `README.md`, `docs/guide.md` "Layout" | answered |
| B2 | Which agent backends exist? | Adapters: `scripted` (pretend), `openai-compatible`, `anthropic`, `cli` (Claude Code, cursor-agent, others), `devin`, `manual`. **[V]** `daemon/src/adapters/index.ts` | answered |
| B3 | What is the normal flow? | Request, PM plan, optional prompt drafting and review, developer, QA checks, reviewer, PM acceptance, commit. A custom visual workflow can replace it. **[V]** `docs/guide.md` | answered |
| B4 | Is there a human approval step? | Yes, two. The approval system (commit, escalations) and the Human approval node, which starts the app and now adds a floating review panel to the app's pages. **[V]** `daemon/src/engine/engine.ts`, `daemon/src/services/review-proxy.ts` (uncommitted as of this writing) | answered |
| B5 | Does a repository timeline exist? | Yes. It shows commits from every branch (including ones made outside the app), checkpoints, undo and redo, branch changes and approvals, with filters and a diff view. **[V]** `docs/guide.md` "Repository timeline"; `daemon/src/api/history.ts`, `daemon/src/services/repo-watch.ts`, `daemon/tests/repo-timeline.test.js` | answered |
| B6 | Do checkpoints exist? | Yes: General (per task), Agent (per work item) and Manual. Undo, redo and restore apply file by file after a dry run. **[V]** `daemon/src/services/checkpoints.ts` | answered |
| B7 | Can a workflow be edited while a task runs? | Partly. Saving a workflow moves running requests to the new version at once if no step that is working is removed or changes kind. Otherwise the switch waits until that step finishes. **[V]** `engine.ts` `adoptWorkflowVersion`, `adoptBlockers`; commit `54d9a28`; `daemon/tests/workflow-live-edit.test.js` | answered |
| B8 | Can a single agent be stopped? | Yes, in the working tree. `POST /api/agents/:id/stop` cancels the agent's work, kills its CLI, frees its session and puts its task on hold. It is **not committed** yet. **[V]** `engine.ts` `stopAgent`, `daemon/tests/stop-agent.test.js` | answered |
| B9 | Is there any Omni Router code? | No. Nothing in the repo mentions it. **[V]** a search of all source and Markdown files found no match. | answered |
| B10 | Does the app measure tokens? | Yes, per work-item kind, with a cache-hit report. The scripted adapter reports zero tokens, so the measured baseline used prompt characters. No baseline with real providers is recorded. **[V]** `PROGRESS.md` stage 1; `daemon/src/services/usage.ts` | answered |

## C. Known problems the owner reported

| # | Problem | What the code shows | Status |
|---|---|---|---|
| C1 | Agents with no configured provider interrupt the workflow | An agent whose account is empty becomes a candidate marked `blocked: "no provider"`. When a workflow step names that exact agent, no candidate is found, the task is set to blocked and a "Needs you" item is raised. For a role pool, such an agent is skipped silently. **[V]** `router.ts` `blockReason`, `candidatesForRole`; `engine.ts` `wfCandidate`, `dispatchAgentNode` | cause found, fix open |
| C2 | Workflow edits should not interrupt running tasks | Already implemented for most edits (see B7). Gaps: a step that is working and is removed holds the switch until it finishes, and there is no rule for tasks sitting at a removed gate or loop. **[V]** + **[?]** | partly answered |
| C3 | Stopping agents is unreliable | Run stop and hard pause were fixed in earlier commits. A per-agent stop was added today but is uncommitted and untested against a live agent. Earlier causes recorded: fallback backend started after a stop, CLI left running after the stuck detector fired. **[V]** `PROGRESS.md` stage 8, commit `81e96ac` | partly answered |
| C4 | The checkpoint system is buggy | No specific bug is recorded. Code review found several suspect behaviors (see [checkpoints.md](checkpoints.md)). The owner has not said which symptoms they saw. | **open** (Q-05) |
| C5 | Add a repository timeline | One already exists (B5). It is unclear whether the owner wants more than this. | **open** (Q-06) |
| C6 | Integrate Omni Router | Three different projects use this name (see [omni-router-integration.md](omni-router-integration.md)). The owner has not said which one. | **open** (Q-07) |
| C7 | Improve token efficiency | Many savings exist (see [token-efficiency.md](token-efficiency.md)). The goal needs numbers to be testable. | **open** (Q-08) |

## D. Architecture and data

| # | Question | Answer | Status |
|---|---|---|---|
| D1 | Where does state live? | One SQLite database in `daemon/data/`, with blobs and a `secrets.json` file for provider keys. A hash-chained event log records every engine decision. **[V]** `daemon/src/db.ts`, `docs/guide.md` | answered |
| D2 | Where do agents work? | `direct` mode (default): inside the owner's repository, one writer at a time. `isolated` mode: a Git worktree per task. **[V]** `docs/guide.md` "Working in your repository" | answered |
| D3 | How is a model chosen for each call? | A router picks a tier from the work kind and task difficulty, then the cheapest usable option, with fallbacks and circuit breakers. **[V]** `daemon/src/services/router.ts`, `routing.ts` | answered |
| D4 | Can the app call a custom endpoint? | Yes. The `openai-compatible` adapter posts to `<baseUrl>/chat/completions` with an optional key. Any gateway that speaks that protocol can be added as a backend. **[V]** `daemon/src/adapters/llm.ts` | answered |
| D5 | Does it persist across restarts? | Yes. Interrupted work is requeued, open checkpoints are closed as interrupted, orphaned CLI processes are reaped at boot. **[V]** `PROGRESS.md` stages 4 and 8 | answered |

## E. Security and privacy

| # | Question | Answer | Status |
|---|---|---|---|
| E1 | Who can reach the API? | Only this machine. Host header, Origin and `Sec-Fetch-Site` checks block other web pages. **[V]** `server.ts`, `daemon/tests/api-security.test.js` | answered |
| E2 | Where are provider keys kept? | `daemon/data/secrets.json`, git-ignored. **[V]** `.gitignore` | answered |
| E3 | Is any code or prompt sent to a third party other than the chosen provider? | Not by Oficina. A gateway such as Omni Router would add a hop. See the Omni Router document. | answered, see Q-07 |
| E4 | Is there any telemetry? | None found. **[A]** based on the absence of any such code in the files reviewed. | assumption |

## F. Open questions for the owner

These go to the questioning agent. The IDs are used there.

| ID | Question | Why it matters |
|---|---|---|
| Q-01 | Why did you build Oficina, in your own words? | The "why" section of `ABOUT.md` is inferred. |
| Q-02 | Is this for a hackathon or competition? If so, what is the deadline and the judging focus? | Changes which version bucket things fall in. |
| Q-03 | Is Oficina only for you, or will others use it? | Decides how much security and multi-user work is needed. |
| Q-04 | Which providers do you actually use day to day, and which are just there to test? | Decides which adapters must be reliable first. |
| Q-05 | What exactly goes wrong with checkpoints? Which action, what you expected, what happened? | Without this, fixes are guesses. |
| Q-06 | What do you want from the repository timeline that the current one does not give? | The feature already exists. |
| Q-07 | Which "Omni Router" do you mean, and what do you want it to do for you? | Three candidates exist. |
| Q-08 | What does "token efficient" mean in numbers? A percentage cut, a cost per run, a limit per task? | Makes the goal testable. |
| Q-09 | When you say an agent has "no configured provider", what do you expect to happen instead? Skip it, use another agent, warn you, wait? | Decides the fix. |
| Q-10 | When you change a workflow mid-run, what should happen to a task already past the step you changed? | Decides the rerouting rules. |
| Q-11 | When you press Stop on an agent, should its task be put on hold, handed to someone else, or cancelled? | Today it is put on hold. |
| Q-12 | Do you want to keep every old document as is, or may some be merged later? | The rule so far is: keep all. |
