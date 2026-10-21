# Architecture (as it is today)

Everything in this file describes the system as it exists, checked on 2026-10-21 against the code. Proposed changes live in the area documents, not here. Labels are in the [README](README.md).

## 1. Shape of the system

```
 Owner's browser (React UI, port 4780)      Windows tray (PowerShell)
            |   REST + WebSocket                     |  REST
            v                                        v
 +--------------------------------------------------------------+
 |  Daemon (Node + TypeScript, one process, 127.0.0.1 only)     |
 |                                                              |
 |  api/        REST + WebSocket, localhost and Origin checks   |
 |  engine/     runs, tasks, work items, workflow graphs        |
 |  services/   router, routing, checkpoints, timeline, verify, |
 |              policy, usage, messages, skills, review proxy   |
 |  adapters/   scripted, openai-compatible, anthropic, cli,    |
 |              devin, manual                                   |
 |  db.ts       SQLite (node:sqlite), hash-chained event log    |
 +------+---------------------+---------------------+-----------+
        |                     |                     |
        v                     v                     v
   Owner's repository   Agent processes /       App under review
   (git, direct mode)   provider APIs           (started by the engine,
                                                 shown through a proxy)
```

**[V]** `daemon/src/index.ts`, `daemon/src/api/server.ts`, `docs/guide.md` "Layout".

## 2. Components and what each is responsible for

| Component | Responsible for | Key files |
|---|---|---|
| API server | Accept requests from this machine only. Reject other web pages. Stream events over a WebSocket. Cap large event fields. | `api/server.ts` (134 routes), `api/history.ts` (15 routes) |
| Engine | Run lifecycle. Planning. Dispatching work items. Workflow graph walking. Failure handling. Stop and pause. Human approval. | `engine/engine.ts` (about 4,200 lines), `engine/prompts.ts` |
| Router | Pick an agent and a model for each work item. Skip blocked options. Fall back. Track quota windows and circuit breakers. | `services/router.ts`, `services/routing.ts`, `services/usage.ts` |
| Adapters | Talk to one kind of backend. One interface: send a prompt, get a result. | `adapters/*.ts` |
| Workflow service | Validate, version, template and estimate workflow graphs. | `services/workflow.ts` |
| Checkpoints | Snapshot the working tree before and after work. Undo, redo, restore. | `services/checkpoints.ts`, `snapshot.ts`, `apply-tree.ts` |
| Timeline | Read commits from git, watch for outside changes, merge with checkpoints and decisions. | `services/repo-watch.ts`, `commits.ts`, `api/history.ts` |
| Verification | Run the project's checks. Detect checks from the project type. Baseline them. | `services/verify.ts`, `project-profile.ts` |
| Policy | Approval modes, change-risk classifier, protected paths. | `services/policy.ts` |
| Messages and hand-offs | Short typed hand-offs between agents. Deliver each message once. | `services/handoffs.ts`, `messages.ts` |
| Context and prompts | Build budgeted prompts: stable first part, trimmed second part. | `services/context.ts`, `engine/prompts.ts`, `services/repo-map.ts` |
| CLI sessions | One persistent CLI conversation per workflow node. | `services/cli-sessions.ts`, `cli-session-view.ts` |
| App launcher and review proxy | Start the app under review and add the floating review panel to its pages. | `services/app-launcher.ts`, `review-proxy.ts`, `review-widget.js` (the last two are uncommitted) |
| UI | Dashboard, Tasks, Live activity, Timeline, Workflow editor, Routing, Agents, Providers, Skills, Approvals, Errors. | `ui/src/pages/*` |

## 3. Data

One SQLite database in `daemon/data/` (git-ignored; also holds blobs and `secrets.json`). **[V]** `db.ts`. about 43 tables. The important groups:

| Group | Tables |
|---|---|
| Who and where | `workspaces` (offices), `roles`, `agents`, `memberships`, `repos` |
| Backends | `providers`, `accounts`, `models`, `quota_windows`, `circuits` |
| Work | `runs`, `cycles`, `tasks`, `work_items`, `prompt_versions`, `check_runs`, `dod` |
| Decisions | `approvals`, `policies`, `error_reports`, `error_kb` |
| History | `events` (hash-chained), `repo_checkpoints`, `checkpoint_ops`, `repo_activity`, `repo_watch` |
| Flow | `workflows`, `workflow_versions` |
| Messages | `agent_messages`, `message_deliveries`, `handoffs` |
| Sessions and requests | `cli_sessions`, `request_queue`, `request_drafts`, `attachments`, `skills*` |

Rules: columns and tables are only ever added; an existing database upgrades in place. **[V]** `PROGRESS.md`, `db.ts` `addColumn`.

## 4. How a request becomes work

1. A **run** is created from a request. It pins a workflow version, or follows the built-in pipeline.
2. The **PM** produces a plan: a Definition of Done and tasks. The engine validates it.
3. Each **task** moves through states: backlog, ready, assigned, in-progress, waiting-input, blocked-quota, verifying, in-review, changes-requested, approved, done, failed, cancelled, blocked and held. A **run** is draft, dod-review, running, pausing, paused, verifying, done or stopped. A **work item** is queued, running, waiting, delivered, failed, cancelled or interrupted. **[V]** `types.ts`
4. Each step creates a **work item**: one prompt to one agent. The router picks the agent and model. An adapter runs it.
5. Results come back as a typed reply. The engine checks the shape, runs checks, and decides the next step.
6. A **commit** of only the task's files is proposed. The owner approves it, or it is automatic by setting.

**[V]** `engine/engine.ts`; `docs/guide.md` "Flow".

## 5. Events

Every engine decision writes an event first, then acts. Events are hash-chained, so tampering shows. The UI and tray read them. Large fields are capped on the wire at 2,000 characters; the full text is fetched on demand. **[V]** `bus.ts`, `server.ts` `slim()`.

## 6. Trust boundaries

| Boundary | Rule | Source |
|---|---|---|
| Browser to daemon | Host must be localhost. State-changing requests need an allowed Origin. WebSocket checks Origin. | `server.ts` `isLocalHostHeader`, `isAllowedOrigin` |
| Daemon to agent | The agent is a separate process or a provider API. Its output is data, never instructions. | `engine/prompts.ts` contracts |
| Daemon to app under review | The app runs as the owner's own user. The review proxy allows only a token-holding page to decide. | `review-proxy.ts` |
| Daemon to repository | Direct mode edits the owner's repository. The office never runs reset, checkout, clean or force-push. | `docs/guide.md` |

## 7. Technical choices that constrain the specs

- Windows is the main target; process handling uses `taskkill` and hidden consoles.
- SQLite through `node:sqlite` needs Node 22.5 or newer.
- The engine is one large file. Changes there need care and tests. **[V]**
- No new dependencies without the owner's approval. **[V]** `prompt.md` rule 6.

## 8. What is scaffolded or missing

From `docs/guide.md`: sandboxing, hosted-agent adapters beyond Devin, embeddings and code intelligence, and a desktop shell are partial or not built. **[V]**

## 9. Where the older documents fit

| Older document | Role now |
|---|---|
| `spec/AI-Agent-Office-Spec.md` | The original design. Still the reference for intended behavior. Some parts (the built-in `/v1` router endpoint, the vault, sandboxing) were not built as written. See the [reconciliation matrix](requirement-reconciliation-matrix.md). |
| `spec/DESIGN-figma.md` | The visual design. Unchanged. |
| `docs/guide.md` | The user guide and implementation state. Unchanged. |
| `PROGRESS.md` | The improvement log by stage. Unchanged. |
