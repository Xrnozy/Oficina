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
