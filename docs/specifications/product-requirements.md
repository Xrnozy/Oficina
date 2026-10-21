# Product requirements

## 1. Overview

Oficina is a local, multi-agent software office. The owner states a request. AI agents plan, build, test and review it inside the owner's own repository. The owner approves or rejects. Nothing is kept without a yes, and every change can be undone. **[V]** `README.md`, `ABOUT.md`

## 2. Goals

| Goal | Meaning | Label |
|---|---|---|
| G1. Reliable | Work survives crashes, stops, bad providers and bad model output without the owner babysitting it. | **[C]** |
| G2. Token efficient | Fewer model calls, less repeated context, less repeated work, with no loss in output quality or reliability. | **[C]** |
| G3. Flexible | The owner can change the flow, the agents and the providers while work is running, without losing that work. | **[C]** |
| G4. In the owner's control | Every change is visible, approved by the owner, and reversible. | **[V]** a founding principle in `ABOUT.md` and the original spec |
| G5. Understandable | Another person or another AI agent can learn the project from these documents alone. | **[C]** |

## 3. Scope

**In scope**
- The Oficina daemon, its API, the web UI, the tray, and the launchers.
- Agent backends, the router, workflows, runs, tasks, approvals, checkpoints, the repository timeline, token and cost tracking.
- The review panel that appears on the app under test.
- Documentation in this folder.

**Out of scope for now** **[A]**
- Several human users, accounts and permissions between people.
- Running Oficina as a hosted service.
- Mobile apps for Oficina itself.
- Rewriting the engine.

## 4. Roles of people

| Person | What they do | Label |
|---|---|---|
| Owner | The one human. Starts runs, edits workflows, approves, rejects, stops. | **[V]** |
| Agent | An AI worker with a role (PM, developer, QA, reviewer, analyst, docs, prompt creator). | **[V]** |
| Maintainer (human or AI) | Changes the code. Uses these specifications. | **[C]** goal G5 |

## 5. Requirements

IDs are stable. Never reuse one. The v-level is the owner's bucket: v0, v1 or v2+. "class?" means the level is uncertain and the reason is in [roadmap-v0-v1-v2.md](roadmap-v0-v1-v2.md). The status says how much exists today.

### 5.1 Providers and agents (PRV)

| ID | Requirement | Label | Level | Status today |
|---|---|---|---|---|
| REQ-PRV-01 | An agent with no usable provider must never dead-end a task silently, crash the run, or block unrelated work. | **[C]** | v0 | Not met. A step that names such an agent blocks its task. |
| REQ-PRV-02 | The problem is reported at the earliest point: when the agent is saved, when it is added to an office, when a workflow is saved or activated, and before a run starts. | **[P]** | v0 (warn) / v1 (prevent) class? | Partly. Workflow validation does not check providers. **[V]** `workflow.ts` `validateWorkflow` has no provider check. |
| REQ-PRV-03 | At dispatch, when the chosen agent has no usable provider, the engine tries another agent of the same role, then the step's fallback, and if none exists pauses only that task with one clear Needs-you item that names the fix. | **[P]** | v0 | Not met for pinned-agent steps. Met for role steps. |
| REQ-PRV-04 | The Agents page shows which agents cannot work and why ("no provider", "provider disabled", "quota exhausted", "circuit open"). | **[P]** | v1 | Not verified. |
| REQ-PRV-05 | A provider that fails (rate limit, auth, outage) moves the call to the next option and never loops. | **[V]** | done | `router.ts` `dispatchThroughAdapter` tries each option once. |

### 5.2 Workflow execution and rerouting (WFL)

| ID | Requirement | Label | Level | Status today |
|---|---|---|---|---|
| REQ-WFL-01 | The owner can edit a workflow while tasks run, without stopping or restarting them. | **[C]** | v0 | Mostly met. **[V]** `adoptWorkflowVersion`, `workflow-live-edit.test.js` |
| REQ-WFL-02 | Later steps follow the updated workflow. Tasks already running continue wherever possible. | **[C]** | v0 | Met for edits that keep working steps. Rules for the rest are undefined. |
| REQ-WFL-03 | Every situation a live edit can create has a written rule: a working step removed, a step changed kind, a task waiting at a removed gate, a task inside a loop that was removed, a changed edge target, a changed agent. | **[P]** | v0 class? | Partly. Two cases are coded (removed, kind changed). |
| REQ-WFL-04 | Before an edit is applied, the owner sees what it will do to each running task. | **[P]** | v1 | Not met. The save reports the result afterwards. |
| REQ-WFL-05 | A run records which workflow version each work item used. Edits are in the audit log. | **[V]** | done | `workflow.adopted`, `workflow.pending` events; version pinned on the run. |
| REQ-WFL-06 | A task never runs on a half-applied workflow. The switch is one step. | **[P]** | v0 | Verify. The adopt is one SQL update plus a cache clear. **[V]** `engine.ts` line 368 |

### 5.3 Agent lifecycle and stopping (STP)

| ID | Requirement | Label | Level | Status today |
|---|---|---|---|---|
| REQ-STP-01 | The owner can stop any single agent, any task and any run, and it stops. | **[C]** | v0 | Partly. Run stop and agent stop exist. Agent stop is uncommitted. |
| REQ-STP-02 | Stopped work never starts a fallback backend, never delivers a late result, and never restarts by itself. | **[V]** for CLI | done for CLI | `router.ts` `cancelled()` check; `executeWorkItem` records a result only while running. |
| REQ-STP-03 | Stopping an API-based agent cancels the HTTP request, so no more tokens are spent. | **[P]** | v0 class? | Not met. **[V]** `llm.ts` lines 47 and 83 use only a timeout signal. |
| REQ-STP-04 | Every work item and every agent is always in exactly one defined state, and no state can stay "running" after its process is gone. | **[C]** | v0 | Partly. Stuck detector and boot reconcile exist. |
| REQ-STP-05 | The UI shows a stop result at once and says what happened to the task. | **[P]** | v0 | Done for the new stop button, not exercised against a live agent. |
| REQ-STP-06 | A held task can be released from one obvious place. | **[V]** | done | Tasks board "On hold". |
| REQ-STP-07 | Stop covers every adapter: CLI, API, Devin, manual. | **[P]** | v0 | CLI yes. Devin has cancel handling. API no. Manual not examined. |

### 5.4 Checkpoints (CKP)

| ID | Requirement | Label | Level | Status today |
|---|---|---|---|---|
| REQ-CKP-01 | Creating a checkpoint is proven: the saved state can be read back, or the checkpoint is refused. | **[V]** | done | `reliableSnapshot` in `checkpoints.ts`. |
| REQ-CKP-02 | Every checkpoint bug the owner has seen is written down with steps to reproduce, then fixed. | **[C]** | v0 | Not started. No symptoms recorded. |
| REQ-CKP-03 | After a crash or a stop, checkpoints record only work the task did, not edits the owner made in between. | **[P]** | v1 class? | Not met. Recovery uses the disk at restart. |
| REQ-CKP-04 | "Undo task" means the whole task, even if it was stopped and resumed, and always matches what the board shows. | **[P]** | v0 class? | Suspect. A task can have several General checkpoints after stops and resumes, and "undo last" undoes only the newest. **[V]** `openTaskCheckpoint`, `lastUndoable` |
| REQ-CKP-05 | Resuming a task after a stop or crash continues from a known good state and tells the owner what that state is. | **[C]** | v1 | Partly. A "Resumed:" checkpoint exists. |
| REQ-CKP-06 | Retention never deletes the owner's manual save points and never leaves a parent without its children or the reverse. | **[P]** | v0 class? | Not met. **[V]** retention (`pruneCheckpoints`) is never called, and if it were it ignores kind and parent. See [checkpoints.md](checkpoints.md) P1, P2. |
| REQ-CKP-07 | Undo, redo and restore never lose the owner's edits. | **[V]** | done | Dry run, per-file plan, backups, read-back. |

### 5.5 Repository timeline (TML)

| ID | Requirement | Label | Level | Status today |
|---|---|---|---|---|
| REQ-TML-01 | A timeline shows repository changes and the development history, including changes made outside the app. | **[C]** | v0 | Met. **[V]** `repo-watch.ts`, `history.ts`, `repo-timeline.test.js` |
| REQ-TML-02 | Whatever the owner finds missing in the current timeline is listed and specified. | **[?]** | v1 class? | Waiting on Q-06. |
| REQ-TML-03 | The timeline stays fast on large histories. | **[P]** | v1 | Not measured. |

### 5.6 Omni Router (OMR)

| ID | Requirement | Label | Level | Status today |
|---|---|---|---|---|
| REQ-OMR-01 | The owner decides which Omni Router is meant. | **[?]** | v0 (the decision) | Open. Q-07. |
| REQ-OMR-02 | Oficina can use the chosen router as a backend without changing the engine. | **[P]** | v1 class? | Feasible for a gateway: the OpenAI-compatible adapter already posts to a base URL. |
| REQ-OMR-03 | Using it is optional per agent. If it is down, the call falls back to a direct provider. | **[P]** | v1 | Not built. |
| REQ-OMR-04 | Cost and token use still show per agent, even when calls go through the router. | **[P]** | v1 | Not built. |
| REQ-OMR-05 | The owner knows that prompts and code pass through the router and approves that per repository. | **[P]** | v1 | Not built. |
| REQ-OMR-06 | Oficina checks the gateway's health before use and shows its state on the Providers page. | **[P]** | v1 | Not built. |
| REQ-OMR-07 | The gateway version is pinned and recorded. | **[P]** | v1 | Not built. |

### 5.7 Token efficiency (TOK)

| ID | Requirement | Label | Level | Status today |
|---|---|---|---|---|
| REQ-TOK-01 | Real token use is measured for every run with real providers, per stage. | **[P]** | v0 | Partly. The report exists; the baseline used prompt characters only. |
| REQ-TOK-02 | A numeric target exists for tokens per run or cost per run. | **[?]** | v0 (the decision) | Open. Q-08. |
| REQ-TOK-03 | No stage sends the same context twice in one task unless it changed. | **[V]** partly | v1 | Repo tour once per task; messages once per agent; envelopes instead of full outputs. |
| REQ-TOK-04 | An identical work item reuses its cached result. | **[V]** | done | `work_items.cache_key`. |
| REQ-TOK-05 | Savings never lower quality. A fixed benchmark must show the same pass rate before and after any token change. | **[P]** | v0 | `daemon/scripts/bench.mjs` exists with scripted agents only. |
| REQ-TOK-06 | The owner sees a per-run and per-day token and cost view, with limits that pause, not kill. | **[V]** partly | v1 | Ceilings exist. A view by day is not verified. |
| REQ-TOK-07 | The weakest points are found from data, then fixed in order of savings. | **[P]** | v1 | Not started. |

### 5.8 Reliability, security, privacy (REL, SEC)

| ID | Requirement | Label | Level | Status today |
|---|---|---|---|---|
| REQ-REL-01 | Failures are classified and handled by class: retry with backoff, repair once, escalate tier, or stop and ask. | **[V]** | done | `failure.ts` |
| REQ-REL-02 | A crash never loses work or duplicates it. | **[V]** | done | `reconcileOnBoot`, idempotency keys |
| REQ-REL-03 | The daemon never exits on a single bad request or bad process. | **[V]** | done | Guards for `uncaughtException` and stdin errors |
| REQ-SEC-01 | Only this machine can reach the API, and web pages cannot make it act. | **[V]** | done | `api-security.test.js` |
| REQ-SEC-02 | Provider keys never leave the data folder and are never committed. | **[V]** | done | `.gitignore` |
| REQ-SEC-03 | The review panel can only decide the review it belongs to. | **[V]** | done | token and origin check in `review-proxy.ts` (uncommitted) |
| REQ-SEC-04 | A shell command suggested by an agent runs only when it is needed and never overrides the owner's own setting. | **[V]** | done | `engine.ts` `approvalReported` (uncommitted) |
| REQ-SEC-05 | A gateway or router is used for a repository only after the owner approves it for that repository. | **[P]** | v1 | Not built. |
| REQ-SEC-06 | Every new route that changes state keeps the Host and Origin checks and has a test that a foreign origin is refused. | **[P]** | v0 (a rule for new work) | Met for current routes. |
| REQ-SEC-07 | Every new place that stores a secret is git-ignored and redacted in events. | **[P]** | v0 (a rule for new work) | Met for current stores. |
| REQ-SEC-08 | The agent-suggested command, the review proxy and the tray scripts are audited. | **[P]** | v1 | Not started. |
| REQ-REL-04 | Every state an engine object can be in is listed in one place with every allowed move. | **[P]** | v1 | Not met. States are spread across files. |
| REQ-REL-05 | Every wait has a bound and the owner is told when it passes: a work item, a checkpoint, a held task, a review app, a pending adoption. | **[P]** | v1 class? | Partly. Work items and CLI output have bounds. |
| REQ-REL-06 | Each fix in this specification ships with a test that fails before the fix and passes after. | **[P]** | v0 (a rule for new work) | The practice in `PROGRESS.md` stage 8. |
| REQ-REL-07 | Recovery tests cover a stop followed by a restart, and a restart during a review. | **[P]** | v1 | Not covered. |

### 5.9 Privacy (PRIV)

| ID | Requirement | Label | Level | Status today |
|---|---|---|---|---|
| REQ-PRIV-01 | A retention setting for prompts and replies, with an option to keep only metadata. | **[P]** | v1 class? | Not built. No such setting was found. |
| REQ-PRIV-02 | Per-repository rules: which providers and routers a repository may use, and "local only". | **[P]** | v1 | Not built. |
| REQ-PRIV-03 | The owner can see, for any run, which providers received which parts of the repository. | **[P]** | v1 class? | Not built. |

### 5.10 Documentation (DOC)

| ID | Requirement | Label | Level |
|---|---|---|---|
| REQ-DOC-01 | These specifications are the main source of truth. They stay consistent with one another. | **[C]** | v0 |
| REQ-DOC-02 | Existing documents are never overwritten or deleted without approval. | **[C]** | v0 |
| REQ-DOC-03 | Verified behavior, confirmed requirements, proposals, assumptions and future plans are always told apart. | **[C]** | v0 |

## 6. Non-functional requirements

| ID | Requirement | Label |
|---|---|---|
| NFR-01 | Works on Windows 11 first. Other systems best effort. | **[V]** |
| NFR-02 | Starts with `npm install`, `npm run build -w ui`, `npm start`. No account needed for the demo. | **[V]** |
| NFR-03 | The test suite passes before any change is called done. 292 tests as of 2026-10-20. | **[V]** |
| NFR-04 | The type check stays clean. | **[V]** |
| NFR-05 | Changes to the database add columns and tables only. They never rewrite data. | **[V]** `PROGRESS.md`, `db.ts` convention |

## 7. Constraints that shape every requirement

See [dependencies-constraints-decisions.md](dependencies-constraints-decisions.md).
