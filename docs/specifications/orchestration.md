# Workflow execution, rerouting and task continuity

Labels are in the [README](README.md). Requirements: REQ-WFL-01 to 06.

## 1. How a workflow runs today

**[V]** `daemon/src/engine/engine.ts`, `daemon/src/services/workflow.ts`, `docs/guide.md` "Visual workflow".

- A workflow is a graph. Nodes: `start`, `agent`, `condition`, `merge`, `human`, `approval`, `end`. Edges: `next`, `on-success`, `on-failure`, `on-reject`, `message`.
- Saving a workflow creates an immutable version. Activating it points the office at the latest version.
- A run pins the version it started on. The engine walks the graph once per task.
- Each task carries its own position in the graph, stored in `tasks.meta.wf`: the nodes working now, nodes waiting in a queue, the node it is waiting on, nodes that already fired, merge arrivals, and a dead-end marker.
- Loops are bounded. Only `on-failure` and `on-reject` edges may close a cycle, and they have a loop limit (default 3). After that the owner decides.
- Guardrails (step, cost and time ceilings) pause dispatching and raise a Needs-you item.
- Only one writer step runs at a time per repository in direct mode. Others wait in a queue.
- With no custom workflow active, the built-in fixed pipeline runs. A test asserts that it produces the same work-item sequence as before the graph existed.

## 2. Changing a workflow while work runs

### 2.1 What exists **[V]**

`adoptSavedVersion`, `adoptWorkflowVersion`, `adoptBlockers`, `nodesInFlight`, `retryPendingAdoption`. Commit `54d9a28`. Tests: `daemon/tests/workflow-live-edit.test.js` (3 tests).

The rule in the code:

1. When a new version is saved, every live run that follows that workflow is offered the new version.
2. A node counts as "in flight" if any open task has it as a working node, a queued node, the node it is waiting on, a held node, or a dead-end node.
3. The switch happens at once unless an in-flight node is **missing** in the new version, or **changed kind** (for example agent to condition).
4. If it is blocked, the run records `pending_workflow_version_id` and an event `workflow.pending` listing the reasons. When the work finishes, the switch is retried.
5. The switch is one database update plus a cache clear, then the engine is told to advance. Events: `workflow.adopted`, `workflow.pending`.
6. Runs that are done, stopped or failed, and runs on the built-in flow, are left alone.
7. Changing which workflow a run follows is a different action (`setRunWorkflow`). It needs the run paused and no task mid-flow. This is stricter and has not changed.

### 2.2 What this gives the owner

Added steps, rewired edges and reconfigured steps apply immediately to everything that has not yet reached them. Tasks already working are not touched. That matches the owner's wish for the common case.

### 2.3 Gaps **[?]**

These situations are not specified and not tested. They are where a task could stall or take an unexpected path.

| # | Situation | Today | Risk |
|---|---|---|---|
| G1 | A step that already finished is removed. | Allowed. Not in flight, so no block. | Merge nodes count arrivals from nodes that fired. A removed source may leave a merge waiting forever. **[?]** not verified |
| G2 | An edge the task already took is rewired. | Allowed. The task continues from its current node using the new edges. | Probably fine. Not tested. |
| G3 | A task waits at a human gate and the gate is removed. | Blocked by rule 3 (awaiting node is in flight). | The owner may not realise a gate holds the switch. The message names the step, which helps. |
| G4 | A loop edge is removed while a task is inside the loop. | Allowed if the node still exists. | The task may reach a node with no way out. Validation of the new graph catches dead ends at save time, but the task's own position is not re-checked. **[?]** |
| G5 | The agent pinned to a step changes. | Applies at the next dispatch of that step. | Work already running on the old agent continues on the old agent. Correct. A new agent may have no provider (see [agent-lifecycle.md](agent-lifecycle.md)). |
| G6 | The step's CLI session key changes. | Sessions are keyed by workflow and node id, so a new version keeps them. | Fine. **[V]** `docs/guide.md` |
| G7 | Two edits are saved quickly. | Each save is offered to every run. The second may replace a pending first. | Last write wins. Not tested. |
| G8 | The new version has a different guardrail. | Applies at the next check. | Fine. |
| G9 | A task is `held` (on hold) at a removed node. | `held` is part of in-flight. | Blocks the switch until the owner releases the task. |
| G10 | The owner wants a change to apply only to new tasks. | No option. | **[?]** Q-10 |

### 2.4 Proposed rules **[P]**

One rule per situation, so nothing is left to chance. All need the owner's approval.

| Situation | Proposed rule |
|---|---|
| Added or reconfigured step | Apply now. |
| Rewired edge | Apply now. A task continues from its current node along the new edges. |
| Working step removed | Wait until it finishes, then apply. Show which task is holding the switch and offer "stop that task's step now". |
| Step changed kind under work | Same as removed. |
| Finished step removed | Apply now. Recompute merge expectations from the new graph, not from history. |
| Gate removed while a task waits at it | Ask the owner once: approve through, or hold the switch. Never decide silently. |
| Loop closed or removed under a task in it | Apply now if the task's current node still has a path to an end. If not, mark the task as needing a decision and keep the old version for that task. |
| Pinned agent changed | Apply at the next dispatch. Check the new agent's provider before saving. |
| Edit that only some tasks should see | Offer "new tasks only", by pinning the old version to tasks already started. Needs per-task version pinning, which does not exist. Level **class?** v1. |

### 2.5 Requirement for the engine **[P]**

- A switch is atomic: a task never sees half of a version. (REQ-WFL-06)
- The save result says, for each running task, one of: continues unchanged, moves to the new version, waits for a step, or needs a decision. This is the impact preview of REQ-WFL-04. The data for most of it exists (`adoptBlockers`); the per-task summary does not.

## 3. Task continuity

Continuity means a task keeps its work, its history and its place when something around it changes.

| Event | What survives today | Source |
|---|---|---|
| Daemon restart | Stale running items are marked interrupted and the tasks made ready again. Tasks waiting on in-memory timers are re-readied. Parked tasks and tasks waiting on the owner are untouched. | `reconcileOnBoot`, `PROGRESS.md` stage 8 |
| Provider failure | The same work item moves to the next option. The task keeps its attempt count. | `router.ts` |
| Agent stop | The task is put on hold. Its repository changes stay in the working tree. | `engine.ts` `stopAgent` (uncommitted) |
| Run stop | Work items are cancelled. Tasks keep their state. The run can be resumed. | `stopRun`, `resumeRun` |
| Workflow edit | See section 2. | |
| Owner edits a task | Three modes: `finish` (fields change now, work in flight continues), `abort` (work items cancelled, CLI killed, task back to ready, branch kept as `abandoned/...` in isolated mode) and `handoff` (current work cancelled, task given to another agent). | `engine.ts` `ownerEditTask` **[V]** |

The original spec (5.8) describes three choices when a task with work in progress is changed: finish then apply, abort and roll back, hand off. **[V]** all three exist in `ownerEditTask`. Two differences from the spec: `finish` applies the new fields at once instead of at the next safe point, and `abort` does not roll back files in direct mode (the changes stay in the working tree and the owner can undo from Checkpoints). **[?]** Whether `abort` frees the agent's status and the CLI session lock the way the new `stopAgent` does was not checked. See Q-10 and Q-11.

## 4. Dry run

A workflow can be simulated with mocked step outcomes and no model calls. It shows the path taken and an estimate of calls. **[V]** `simulateWorkflow`, `estimateWorkflowCalls`. A dry run of the effect of an edit on a running task does not exist. That is T-201, level v2+.

## 5. Acceptance

See AC-WFL-01 to AC-WFL-06 in [testing-and-acceptance.md](testing-and-acceptance.md).
