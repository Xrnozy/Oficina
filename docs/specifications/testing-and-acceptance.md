# Testing strategy, acceptance criteria and validation

Labels are in the [README](README.md).

## 1. How testing works today **[V]**

- Daemon tests use Node's built-in runner: `npm test -w daemon`. 292 tests passed on 2026-10-20 across 45 files in `daemon/tests/`. The type check is `npm run typecheck -w daemon`. The UI build is `npm run build -w ui`.
- Agents in tests are mostly **scripted**: a pretend adapter that returns planned replies, so no model is called and no tokens are spent.
- Tests that need a repository create a temporary one. Tests that need a database set `OFFICE_DATA_DIR` to a temporary folder. They never touch `daemon/data/`.
- `daemon/scripts/bench.mjs` runs one fixed end-to-end scenario (23 work items, all 6 Definition-of-Done items pass). `daemon/scripts/demo-workflow.mjs` runs a custom graph.
- Known flaky test: `request-intake` "iterations keep…" fails about one run in four because of a timing race. It is not a regression. **[V]** the owner's note. Do not hide it. List it as known when it fails, and fix it in its own task.
- A transient failure was seen once in `cli-stream.test.js` under load. It passed twice alone. **[V]**

## 2. Principles **[P]**

1. **Failing test first.** Every fix starts with a test that fails on the current code and passes after.
2. **One behavior per test.** Name it by the behavior, as the existing tests do.
3. **Facts over claims.** A test asserts what the engine did, not what an agent said.
4. **No live provider in the suite.** Suites stay free and fast. Live checks are a separate, manual protocol (section 5).
5. **Never touch the live database.** Use temporary folders or a copy.
6. **A passing suite is necessary, not sufficient.** The acceptance criteria below also need the manual checks in section 5 where noted.

## 3. Acceptance criteria

Format: **Given** a state, **when** an action, **then** the result. "Auto" means it should be an automated test. "Manual" needs a person or a live provider. Each links to the requirement and the task.

### 3.1 Providers and agents

| ID | Criterion | Req | Task | Kind |
|---|---|---|---|---|
| AC-PRV-01 | Given an office where one agent has no account, when a workflow with a role step runs, then the other agents of the role do the work and no Needs-you item is raised. | PRV-01 | T-003 | auto |
| AC-PRV-02 | Given a workflow with a step pinned to an agent that has no provider, when the workflow is saved or activated, then a warning names the step, the agent and the reason. Saving still works. | PRV-02 | T-002, T-004 | auto |
| AC-PRV-03 | Given a pinned step whose agent has no provider and another agent of the same role who can work, when the step is dispatched, then the other agent runs it, the event says why, and the task is not blocked. | PRV-03 | T-003 | auto |
| AC-PRV-03b | Given no agent can run the step, when it is dispatched, then only that task pauses, exactly one Needs-you item names the agent, the reason and the fix, and unrelated tasks keep running. | PRV-03 | T-003 | auto |
| AC-PRV-03c | Given a paused task as in 03b, when the owner sets a provider, then the task resumes without further action. | PRV-03 | T-003 | auto |
| AC-PRV-03d | Given `no provider` or `no usable backend`, then the failure is classified fatal and not retried with backoff. | PRV-03 | T-003 | auto |
| AC-PRV-04 | Given any agent, the Agents page shows ready or the reason it cannot work. | PRV-04 | T-101 | manual (UI) |

### 3.2 Workflow rerouting

| ID | Criterion | Req | Task | Kind |
|---|---|---|---|---|
| AC-WFL-01 | Given a running task, when a step not in flight is added, then the run switches at once, the task keeps its place and no work item is restarted. | WFL-01 | T-010 | auto (exists) |
| AC-WFL-02 | Given a task working on step X, when X is removed, then the switch waits, the save says which task holds it, and it applies when X finishes. | WFL-02 | T-010 | auto (exists) |
| AC-WFL-03 | For each situation in [orchestration.md](orchestration.md) section 2.4 there is a test that shows the chosen rule. | WFL-03 | T-010 | auto |
| AC-WFL-04 | Before applying an edit, the owner sees per running task one of: continues, moves, waits for a step, needs a decision. | WFL-04 | T-103 | auto and manual |
| AC-WFL-05 | Every adoption and every pending switch is an event, and the audit log names the version. | WFL-05 | none | auto (exists) |
| AC-WFL-06 | Given a switch in progress, no dispatch reads a half-applied graph. | WFL-06 | T-010 | auto |

### 3.3 Stopping

| ID | Criterion | Req | Task | Kind |
|---|---|---|---|---|
| AC-STP-01 | Given a running CLI agent, when the owner stops it, then its process ends within a few seconds, its work item is cancelled, the agent is idle, its session is free, its task is on hold and no fallback backend starts. | STP-01, 02 | T-005 | auto (scripted) and manual (live CLI) |
| AC-STP-02 | Given a stopped agent, no late result is recorded and no task restarts by itself. | STP-02 | T-005 | auto (exists) |
| AC-STP-03 | Given a running API call, when stopped, then the request is aborted and no further tokens are billed. | STP-03 | T-006 | auto (fake server) and manual |
| AC-STP-04 | Given a work item whose process is gone, then it ends as failed or interrupted within a bounded time. | STP-04 | T-005 | auto |
| AC-STP-05 | After a stop the UI says what happened to the task. | STP-05 | T-005 | manual (UI) |
| AC-STP-07 | Each adapter honors the cancel contract: no more output, no more cost, prompt return. A manual item releases its wait. | STP-07 | T-006, T-007 | auto |

### 3.4 Checkpoints

| ID | Criterion | Req | Task | Kind |
|---|---|---|---|---|
| AC-CKP-01 | A snapshot that cannot be read back is refused. | CKP-01 | none | auto (exists) |
| AC-CKP-02 | Each bug the owner reports has a failing test that is recorded in the task before it is fixed. | CKP-02 | T-008 | auto |
| AC-CKP-03 | After a crash, the interrupted checkpoint holds only the task's changes, or states plainly that it may include the owner's. | CKP-03 | T-104 | auto |
| AC-CKP-04 | Given a task stopped and resumed, "undo the task" restores the pre-task state in one operation. The Undo offer never fails for a known reason. | CKP-04 | T-009 | auto |
| AC-CKP-05 | Resume tells the owner what changed since the stop, and continues from a known state. | CKP-05 | T-105 | auto and manual |
| AC-CKP-06 | Given more than the limit of checkpoints, retention removes whole groups oldest first and never a Manual checkpoint, an open one or a parent without its children. | CKP-06 | T-009 | auto |
| AC-CKP-07 | Undo, redo and restore never lose the owner's edits. | CKP-07 | none | auto (exists) |

### 3.5 Timeline

| ID | Criterion | Req | Task | Kind |
|---|---|---|---|---|
| AC-TML-01 | A commit made outside the app appears within seconds. | TML-01 | none | auto (exists) |
| AC-TML-02 | Each addition the owner confirms has a test and a screenshot. | TML-02 | T-106 | auto and manual |
| AC-TML-03 | On a repository with 10,000 commits the first page loads within a stated time (to set once measured). | TML-03 | T-107 | auto (benchmark) |

### 3.6 Omni Router

| ID | Criterion | Req | Task | Kind |
|---|---|---|---|---|
| AC-OMR-01 | The decision on which Omni Router is recorded in the [decision log](decision-log.md). | OMR-01 | T-011 | document |
| AC-OMR-02 | Given a gateway entry as a provider, an agent pointed at it completes a call and its tokens are recorded. | OMR-02 | T-108 | auto (fake gateway) and manual |
| AC-OMR-03 | Given the gateway is unreachable, the call falls back to a direct provider and the event says so. | OMR-03 | T-108 | auto |
| AC-OMR-04 | Cost shows per agent with its source labelled. | OMR-04 | T-108 | auto |
| AC-OMR-05 | A repository marked "direct only" refuses the gateway. | OMR-05 | T-110 | auto |
| AC-OMR-06 | The gateway's state shows on the Providers page and a failed health check is reported before use. | OMR-06, 07 | T-115 | auto and manual (UI) |

### 3.7 Token efficiency

| ID | Criterion | Req | Task | Kind |
|---|---|---|---|---|
| AC-TOK-01 | A baseline of three real runs exists, in dated files, with the measures from [token-efficiency.md](token-efficiency.md) section 1. | TOK-01 | T-013 | manual |
| AC-TOK-02 | A numeric target is recorded in the decision log. | TOK-02 | T-012 | document |
| AC-TOK-03 | In one task, no stage resends unchanged context beyond what is documented. | TOK-03 | T-109 | auto |
| AC-TOK-04 | An identical work item uses the cache and makes no call. | TOK-04 | none | auto (exists) |
| AC-TOK-05 | The benchmark ends with the same Definition-of-Done result before and after a token change. | TOK-05 | T-014 | auto |
| AC-TOK-06 | The owner can see tokens, cost, waste and cache savings per run and per day. | TOK-06 | T-109 | manual (UI) |
| AC-TOK-07 | The ranked list of leaks is based on data and updated after each fix. | TOK-07 | T-109 | document |

### 3.8 Reliability, security, documentation

| ID | Criterion | Req | Kind |
|---|---|---|---|
| AC-REL-01 | A restart during a review, and a stop followed by a restart, leave no `running` item without a process and no open checkpoint. | REL-07 | auto |
| AC-REL-02 | Every wait has a bound and the owner is told when it passes. | REL-05, REL-07 | auto |
| AC-REL-03 | One list of states and moves exists, and the types and the checks agree. | REL-04 | auto and review |
| AC-SEC-01 | A request from a foreign origin to any state-changing route is refused. | SEC-06 | auto (exists for current routes) |
| AC-SEC-02 | The review panel cannot decide a review it does not own. | SEC-03 | auto (exists) |
| AC-SEC-03 | An audit report exists for the agent-suggested command, the review proxy and the tray scripts, with every finding fixed or accepted by the owner. | SEC-08 | document |
| AC-PRIV-01 | A retention setting exists and a run shows which providers saw which parts of the repository. | PRIV-01, 03 | auto and manual (UI) |
| AC-PRIV-02 | A repository marked "local only" refuses every remote provider and gateway. | PRIV-02 | auto |
| AC-DOC-01 | Every statement in these documents has a label and a link to its evidence. | DOC-03 | review |
| AC-DOC-02 | No older document was changed without approval. | DOC-02 | review |

## 4. Validation of the documents themselves

| Check | How |
|---|---|
| Links resolve | Open each link in each file. |
| Every requirement has a task and a criterion | Compare [product-requirements.md](product-requirements.md), [tasks.md](tasks.md) and this file. |
| Every owner idea appears | Compare against [requirement-reconciliation-matrix.md](requirement-reconciliation-matrix.md). |
| Labels are honest | A [V] must name a file or a test. |
| Numbers are dated | A count (tests, tables, routes) carries its date. |

## 5. Manual validation protocol (live providers)

Used for the criteria marked manual. It costs real tokens, so it is run on purpose and recorded.

1. Use a small throwaway repository, never the owner's main work.
2. Pick one cheap model. Set a low budget ceiling.
3. Run the scenario in the criterion. Record start time, what the UI showed, what the event log recorded and what the provider billed.
4. Save the record under `docs/specifications/measurements/` with the date.
5. A criterion passes only if the record matches the "then" part, including that no billing continued after a stop.

## 6. Definition of done for any task in [tasks.md](tasks.md)

1. The failing test existed first and now passes.
2. The whole suite and the type check pass, and the UI builds.
3. The acceptance criterion is met, including the manual part if marked.
4. The requirement status in [product-requirements.md](product-requirements.md) and the task status are updated, with the commit and test names.
5. The owner has approved anything that changes an earlier decision.
