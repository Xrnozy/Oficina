# Visual agent-routing builder for officeChain (instructions for Devin)

Build an n8n-style visual workflow editor. The owner drags agents onto a canvas, connects them, inserts new agents between existing ones, reorders the flow, adds conditional branches, and sets up direct agent-to-agent hand-offs. The engine then follows that graph. **The existing workflow and every existing feature must keep working unchanged when no custom graph is defined.**

**Design reference:** read `visual-routing/design.md` before Phase 3. It defines the layout, drag-and-drop behavior (n8n style: drag agents from a palette, move nodes, connect handles, drop an agent onto a line to insert it, branches, message lines), node and line styles, keyboard shortcuts, live view and a 10-point acceptance checklist. Phase 3 and 3b are complete only when that checklist passes in the browser.

## Starting facts (verify them in the code before relying on them)

- The flow today is fixed in code: request, then `pm` (plan), `prompt-creator` (draft), `pm` (review), `developer`, `qa`/`reviewer`, `pm` (accept). Role selection is in `roleNameFor()` in `daemon/src/engine/engine.ts`. The prompt pipeline is in `startPromptDraft`, `startPromptReview`, `dispatchApprovedPrompt`; QA/review/accept in `dispatchQa`, `dispatchReview`, `dispatchAccept`; failures in `handleWorkItemFailure` and `dispatchFix`.
- `WorkItemKind` is a closed union in `daemon/src/types.ts`. Agents, roles and memberships are in `daemon/src/db.ts`. Agent-to-agent messages are in `daemon/src/services/messages.ts`. Routing of models is in `services/router.ts`.
- `reactflow` (^11.11.4) is already in `ui/package.json` but not yet used in `ui/src`. Existing pages that relate: `ui/src/pages/Office.tsx` (drag agents between role slots), `Team.tsx`, `Routing.tsx`, `TaskRecord.tsx`.
- UI style follows `spec/DESIGN-figma.md`. Node version >= 22.5.

## Operating rules

1. Work through the phases below in order. Track progress in `visual-routing/PROGRESS.md` (phase, status, files changed, tests, decisions, what you skipped). On start, read it and resume at the first unfinished phase.
2. Read the relevant code before each phase. Extend what exists; do not duplicate.
3. After every change run `npm run typecheck -w daemon`, `npm test -w daemon`, and for UI work `npm run build -w ui`. Never leave them failing. If you cannot fix a failure, revert that change and record it.
4. One git commit per phase. If the repo has no git history yet, run `git init` plus a baseline commit first (ignore `daemon/data/`, `node_modules`, `ui/dist`, `*.log`, `nul`).
5. **Backward compatibility is mandatory.** With no custom workflow saved, the engine must behave exactly as it does today. Add a test that runs the default flow and asserts the same sequence of work item kinds and roles as before your changes.
6. Do not read, print, edit or commit `daemon/data/` (live database and secrets). Do not use `git reset --hard`, `git clean` or force-push. Never redirect output to `nul`.
7. Prefer no new dependencies. If one is truly needed (for example a layout library), stop and ask. A schema change must be additive (new tables or nullable columns) through `daemon/src/migrate.ts`; describe it in the progress file first.
8. Match surrounding code style: terse, comments only where non-obvious.
9. Do not ask questions you can answer from the code. Stop only for rule 7 or if blocked. Finish with a summary: what works, what is skipped, risks, next steps.

## Phase 1: Workflow graph model (backend, no behavior change)

Add a `workflow` concept: a directed graph stored per workspace (and optionally overridable per run).

- **Nodes**: `{ id, type, agentId | role, label, config, position {x,y} }`. Node types: `start` (the request), `agent` (an agent or a role such as pm / prompt-creator / developer / qa / reviewer / analyst / docs), `condition` (branch), `merge` (join parallel branches), `human` (owner approval), `end` (accept/commit).
- **Edges**: `{ id, from, to, label, condition? , kind }`. Edge kinds: `next` (normal flow), `on-success`, `on-failure`, `on-reject` (send back), `message` (direct agent-to-agent message, not a flow step).
- **Conditions** evaluated deterministically by the engine, not by a model: previous step status, checks passed/failed, files changed matches a glob, task type or difficulty, attempt count, reviewer verdict (approve / changes-requested), a field in the hand-off envelope or reply JSON, and simple `and`/`or`/`not` combinations. A fallback `else` edge is required on every condition node.
- Store as JSON in new tables `workflows` and `workflow_versions` (immutable versions; each run records the version it used, so editing a workflow never changes a run in progress).
- **Validation service** `daemon/src/services/workflow.ts`: exactly one start; every node reachable from start; at least one path to end; no unbounded cycles (a cycle is allowed only through an `on-reject` / `on-failure` edge and must carry a `maxLoops`, default 3); every condition has an else edge; referenced agents and roles exist; separation of duties preserved (an author cannot be the only reviewer of its own work, matching existing policy). Return clear, node-level error messages.
- **Default workflow**: generate a graph that reproduces today's pipeline (pm, prompt-creator, pm review, developer, qa, reviewer, pm accept, with the existing retry and fix loops) and mark it `builtin`. It is read-only; the owner clones it to edit.
- REST endpoints (follow the style of `daemon/src/api/server.ts`): list, get, create, update (creates a new version), clone, delete, validate, set active for a workspace.
- Tests for validation rules and the default-graph generation. Do not change the engine yet.

## Phase 2: Engine executes the graph

- Add a graph executor in `daemon/src/engine/` that, when a workspace has an active custom workflow, decides the next step after each work item from the graph instead of the hard-coded sequence. When there is no active custom workflow, the current code path runs untouched.
- Map each agent node to a work item. The work item kind comes from the node's configured purpose (plan, prompt, prompt-review, implement, qa, review, analyse, doc, accept, or a new generic `custom` kind). Add `custom` to `WorkItemKind` only if needed, and make sure every `switch` / lookup keyed by kind (for example `AGENT_STATE`, `roleNameFor`, UI labels) handles it.
- Node `config` per agent: instructions added to the prompt, model tier override, which skills apply (see Phase 3b), token budget, timeout, whether it may edit files (read-only vs writer; only one writer at a time on overlapping paths, as now), and which inputs it receives (full previous output, hand-off envelope only, or specific earlier nodes).
- Branching: evaluate conditions in order, take the first match, else the `else` edge. Support parallel branches (fan-out from one node, `merge` node waits for all or any, configurable). Parallel writers on overlapping paths must be serialized.
- Loops: enforce `maxLoops`; on exhaustion, follow the `on-failure` edge or raise a "Needs you" item.
- Direct agent-to-agent: an edge of kind `message` delivers a structured message (reusing `services/messages.ts`: `postMessage`, `takeInbox`, delivered once, no extra model call to deliver it) to the target agent's next prompt, optionally including the sender's output or envelope. A `message` edge with `waitForReply` makes the sender's step pause until the recipient replies, with a timeout.
- Record on each work item which node and edge led to it (node id, edge id, condition result and why) so the history shows the path taken. Emit events such as `workflow.step`, `workflow.branch`, `workflow.loop`.
- Keep all existing features working on a custom graph: checkpoints (general and agent), commits policy, approvals, error reports and fix routing, model routing and failover, skills, usage accounting, pause/stop/resume, crash recovery. Where a feature relies on a fixed role (for example accept requires a PM), the validator must require an equivalent node or auto-insert the default one and warn.
- Tests: linear graph equals default behavior; a branch on check failure; a loop with maxLoops; parallel fan-out and merge; a message edge delivered once; the run records the workflow version used; editing the workflow during a run does not change that run.

## Phase 3: Visual editor (UI)

Create a new page "Workflow" (route and nav entry consistent with the existing pages) using `reactflow`.

- **Canvas**: pan, zoom, minimap, grid snap, fit-to-view, undo/redo of edits, multi-select, copy/paste, delete, keyboard shortcuts, autosave of a draft.
- **Agent palette** (side panel): every agent in the workspace grouped by role, plus generic nodes (Condition, Merge, Human approval, End). Drag onto the canvas to add. Show agent name, role, backend/model, and status.
- **Insert between**: dropping a node onto an existing edge splits the edge and connects it in the middle; an "add node" (+) button on each edge does the same. Dragging a node out and dropping it elsewhere re-links neighbors. Reordering is done by dragging nodes and edges; an "auto-layout" button arranges the graph left to right without new dependencies if possible.
- **Edges**: draw by dragging from a node handle; click an edge to set its label, kind (next / on-success / on-failure / on-reject / message) and condition. Color/style edges by kind and show the label.
- **Condition builder**: a simple form (field, operator, value, add and/or) with plain-language preview ("If checks fail and attempts < 3"), not free-form code. Show the else path clearly.
- **Node inspector** (right panel): the node's config from Phase 2, with token/time limits and read-only vs writer.
- **Validation in the UI**: show the Phase 1 errors and warnings on the offending nodes and block Save/Activate until errors are fixed.
- **Versioning**: save, clone built-in, version history with restore, set active, import/export as JSON.
- **Live view**: when a run is active, highlight the current node, the path taken, completed nodes, failures and loops, and click a node to open its task and live activity. Past runs show the path they actually took.
- Follow `spec/DESIGN-figma.md`; keep the existing monochrome editorial look. Support dark/light if the app does. Make nodes readable at normal zoom, and keep the canvas smooth with 50+ nodes (memoize node components, avoid re-rendering on every WebSocket event).
- Do not break `Office.tsx`, `Team.tsx` or `Routing.tsx`. Link them to the Workflow page where it makes sense (for example, role slots on Office show the node role).

## Phase 3b: Skills on workflow nodes

The owner must be able to give each agent node its own skills in the workflow editor. Skills already exist (`daemon/src/services/skills.ts`, tables `skills`, `skill_versions`, `skill_attachments`; the Skills page; skills are attached to a role or one agent and delivered inside the prompt through `skillsFor()` within a per-prompt character budget, with `skill.applied` events recording what was used or skipped). Build on that; do not create a second skills system.

- **Node-level attachment**: extend the attachment target so a skill can be attached to a workflow node (additive change: the target JSON in `skill_attachments` gains an optional `nodeId` plus `workflowId`, or a small new link table; no change to existing role/agent attachments). Resolution order when a node runs: skills attached to the node, then the agent, then the role, de-duplicated by skill id, node-level first so it wins under the budget.
- **`skillsFor()`** accepts the current node id. Keep its existing signature working for callers that pass no node. Keep the existing filters (kinds of work, task keywords, enabled flag, approval needed for imported skills, character budget) and keep recording applied/skipped skills with the reason, now also showing the source (`node`, `agent` or `role`).
- **Node inspector UI**: a "Skills" section showing attached skills with their source badges, an "Add skill" picker (search the existing skills, show description, size in characters, and whether approval is pending), remove, drag-to-reorder priority, and a live budget meter ("2,400 of 6,000 characters used"). Skills from the agent or role appear greyed with a note, so the owner sees everything that will be sent.
- **Create and import from the editor**: a button to create a new skill inline (name, description, instructions, limit to kinds of work / keywords) and to import a `SKILL.md` folder, reusing the existing import and scan endpoints. Imported skills still need owner approval before they can be used; the node shows "waiting for approval" and the validator warns.
- **Per-node override switches**: "inherit agent and role skills" (default on), and "skills only" (off means only node skills are sent). Provide "apply to all nodes with this role" as an explicit bulk action, not the default.
- **Palette shortcut**: dragging a skill from a skills side panel onto an agent node attaches it.
- **Token awareness**: show the estimated tokens added by each node's skills, include it in the graph's worst-case estimate (Phase 4), and never exceed the existing per-prompt budget. Skills that don't match the node's work kind are skipped, as today.
- **Workflow versions** store the node skill attachments, so a run uses the skills as they were when the workflow version was activated. Cloning or exporting a workflow includes node skill references by skill id and name; import reports any missing skills instead of failing.
- **Safety**: skill content is untrusted instructions; keep the existing scan findings and approval flow, and keep skills inside the delimited prompt section they use today.
- Tests: node skill beats agent/role skill under the budget; no node means old behavior; de-duplication; the `skill.applied` event shows the source; unapproved imported skill is not delivered; export/import with a missing skill.

## Phase 4: Templates and safety

- Provide ready templates: Default pipeline, Fast path (developer then reviewer only), Strict (extra security reviewer and QA before accept), Docs only, Bug-fix (analyse, fix, qa, accept), and Parallel review (two reviewers merge before accept).
- Dry-run simulation: given a sample task and mocked step outcomes (pass/fail), animate the path through the graph without calling any model, so the owner can test branches and loops. This costs no tokens.
- Guardrails: a global max steps per task and per run, a cost and time ceiling per workflow, and a clear "Needs you" item when a graph hits one. Show an estimated worst-case number of agent calls for the graph.
- Prevent deleting or editing an agent or role that an active workflow references without a warning listing the affected nodes.
- Audit: workflow edits go to the hash-chained event log with who and what changed.

## Phase 5: Tests, docs, final audit

- Run the full test suite and `npm run build -w ui`. Run an end-to-end scripted demo on (a) the default workflow, (b) a custom workflow with an inserted agent, a condition branch and a message edge. Record results.
- Update `README.md`: a "Visual workflow" section (concepts, node and edge types, conditions, how to insert an agent, how backward compatibility works, limits). Update the Layout section.
- Final audit in `visual-routing/PROGRESS.md`: what works, what is incomplete, known risks, and the three highest-value next steps.
