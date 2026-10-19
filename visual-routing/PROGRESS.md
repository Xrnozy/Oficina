# Visual agent-routing builder — progress

Order: 1 → 2 → 3 → 3b → 4 → 5. Baseline before Phase 1: `npm run typecheck -w daemon` clean, `npm test -w daemon` 85/85, `npm run build -w ui` clean.

## Phase 1 — Workflow graph model (backend, no behavior change) — DONE

- **Schema (additive, `db.ts` `CREATE TABLE IF NOT EXISTS` + `addColumn` — same convention as `message_deliveries`, no migrate.ts data change needed):**
  - `workflows (id, workspace_id, name, description, builtin, latest_version_id, created_at, updated_at)` + `idx_workflows_ws`.
  - `workflow_versions (id, workflow_id, n, graph JSON, note, created_by, created_at)` + `idx_wfver` — immutable; `PUT` only ever inserts a new `n`.
  - `runs.workflow_version_id TEXT` (nullable) — each run records the version it follows.
  - `work_items.workflow_node_id` / `work_items.workflow_edge_id TEXT` — added now so Phase 2's step recording needs no further schema change.
- **`daemon/src/services/workflow.ts` (new):**
  - Types: `WfNode {id,type(start|agent|condition|merge|human|end),agentId?,role?,label,config,position}`, `WfEdge {id,from,to,kind(next|on-success|on-failure|on-reject|message),label?,condition?,else?,maxLoops?,waitForReply?,timeoutMin?}`, `WfCondition` (field/op/value leaf + and/or/not), `NodeConfig` (purpose→WorkItemKind|custom, scope run|task, instructions, modelTier, budgetChars, timeoutMin, writable, inputs, mergeMode, skill switches for 3b).
  - `validateWorkflow(graph, wsId)` → node/edge-level errors+warnings: exactly one start; ≥1 end with a start→end path; all nodes reachable over flow edges (message edges excluded); condition nodes need exactly one `else` edge + conditions on the rest; DFS back-edges legal only as `on-failure`/`on-reject` (`maxLoops` default 3); referenced agents exist (+workspace membership warning) and roles exist; SoD — same pinned agent cannot be the only writer and reviewer; merge <2 in-edges warns; end has no out-edges.
  - `defaultWorkflowGraph()` mirrors today's pipeline: start → pm plan (run scope) → prompt-creator draft → pm prompt-review (on-reject→draft, 3) → developer implement → qa (on-failure→analyst→fixer→on-reject→qa, 3) → reviewer (on-reject→dev, 3) → pm accept (on-reject→dev, 2) → end.
  - CRUD: `ensureBuiltinWorkflow` (lazy, per-workspace `wf-builtin-<ws>`, builtin=1 read-only), `listWorkflows`, `getWorkflow`, `getWorkflowVersion`, `createWorkflow` (validates, blocks on errors), `saveWorkflowVersion` (refuses builtin; new version only), `cloneWorkflow`, `deleteWorkflow` (refuses builtin / active / used-by-a-run), `setActiveWorkflow` + `activeWorkflowFor` (active pointer = `workspaces.settings.activeWorkflowId`, same pattern as approvalMode). Audit `workflow.saved`/`workflow.activated`/`workflow.deleted` events emitted now (Phase 4 requirement).
- **`rows.ts`/`types.ts`**: `Run.workflowVersionId?: string|null` mapped.
- **REST (`server.ts`)**: `GET /api/workflows?workspaceId` · `POST /api/workflows/validate` · `GET /api/workflows/:id` (+live issues) · `GET /api/workflows/:id/versions/:n` · `POST /api/workflows` · `PUT /api/workflows/:id` (new version) · `POST /api/workflows/:id/clone` · `DELETE` · `POST .../activate|deactivate`.
- **Tests `daemon/tests/workflow-graph.test.js`** (9): default graph validates + mirrors pipeline roles/purposes; start-count/reachability/end-path; condition else rule; loop-kind rule; agent/role refs; SoD; builtin read-only+clone; immutable versioning + activate resolution + invalid-graph refusal; used-by-run delete refusal.
- Results: 9/9 new tests pass; typecheck clean; full suite run confirms no regression (85 → 94).
- Engine untouched — zero behavior change.

## Phase 2 — Engine executes the graph — DONE

- **Types:** `WorkItemKind` gains `'custom'` (any node purpose not mappable to a pipeline kind); `EST_COST` gets a `custom` entry (`routing.ts`); `rows.ts` maps `workflow_node_id`/`workflow_edge_id` on `WorkItem`.
- **`workflow.ts`:** cycle validation relaxed to cycle-membership semantics — a directed cycle is legal iff at least one edge in it is `on-failure`/`on-reject` (which carries the loop bound); error names the offending cycle. Default graph edge kinds adjusted to fit the rule.
- **`engine.ts` — graph executor (~450 lines before `wireEngineEvents`):**
  - `graphFor(run)` resolves + memoizes the run's pinned workflow version; `createRun` stamps `workflow_version_id` from `activeWorkflowFor` (null → untouched legacy path).
  - `wfState`/`saveWfState` keep per-task traversal in `task.meta.wf`: in-flight `nodes`, completed `fired`, `loops` per bounded edge, `arrived` per merge node, `awaiting` gate, `queued` writers, `draft` for prompt loops, `lastOutcome`.
  - `graphTaskEntry` walks start→entry nodes (run-scope `plan` nodes execute once per run via `dispatchPlan`); `wfEntryNodes` exported for tests.
  - `dispatchAgentNode` builds the node's work item (`purpose`→kind, role/pinned-agent/agentId candidate, `modelTier`→difficulty, `instructions`→new `nodeInstructions` prompt block, `inputs` envelope|full|named-node outputs, `writable` default by kind, `budgetChars`), stamps `workflow_node_id`/`workflow_edge_id` on row + in-memory object, parks a second writer (`queued`), and dispatches through `executeWorkItem`.
  - `graphHandleDelivered` (hooked in `handleDelivered`) turns the result into a `WfOutcome` (status/verdict/checks/files/report), fires `message` edges (postMessage + optional `waitForReply` pause with a timer), and `graphAdvanceFrom` picks matching edges (condition eval via `wfFieldValue`/`wfEval`), falls back to `else`, applies `maxLoops` (default 3 on loop-kind edges) and emits `workflow.step`/`branch`/`loop`/`merge`/`deadend`/`human`.
  - Gates: `human` nodes → `workflow.human` approval; loop exhaustion → `workflow.loop`; dead end / starved merge / no eligible agent → `workflow.deadend`. The approval wiring resumes via `graphResume` (reject on a loop edge fails the task; approve grants one more pass; dead-end approve retries the node).
  - Parallel: multiple matching edges dispatch sibling nodes concurrently; merge nodes wait `all`/`any`; writer nodes serialize per task through the repo tree; `end` marks the task approved and proceeds to merge.
- **Two real bugs the loop tests exposed (Stage 6 cache interactions):**
  - Cross-task reuse: `cache.hit` replayed a *different* run's QA verdict because scripted plans produce identically-titled tasks → identical prompts. Cache lookup now requires `task_id IS wi.taskId` — a cached result can only serve the task it verified.
  - Retry poisoning: re-entering an already-`fired` node is a retry — the identical prompt would `cache.hit` and replay the failing verdict forever. Node re-entry NULLs `cache_key` on row **and** the in-memory `wi` (the lookup reads `wi.cacheKey`, not the row).
- **Tests `daemon/tests/workflow-graph-exec.test.js`** (6): compat (no active workflow → unchanged legacy `[plan, prompt, prompt-review, implement, qa, accept]`); linear custom graph stamps node+edge ids and reaches `done`; `on-failure` loop re-runs the writer until QA passes; exhausted `on-reject` edge (maxLoops=1) requests `workflow.loop`, owner decision resumes; deterministic condition eval; `wfEntryNodes` walk.
- Results: 6/6 new tests pass; typecheck clean; full suite 94 → **100**.
