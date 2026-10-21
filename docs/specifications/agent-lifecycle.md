# Agent lifecycle, provider configuration and stopping

Labels are in the [README](README.md). Requirements: REQ-PRV-01 to 05 and REQ-STP-01 to 07.

## 1. What an agent is

An agent is a named worker. It has a backend (an account and a model, both optional in the database), instructions, per-agent settings, an observability level, and one or more roles in an office. **[V]** `daemon/src/db.ts` table `agents` (`account_id` and `model_id` have no NOT NULL), `daemon/src/types.ts`.

An agent can be in several offices with different roles. It can run several work items only up to its `max_concurrent_tasks` per membership. **[V]** `router.ts` `pickAgent`.

## 2. States

### 2.1 Agent status **[V]**

`agents.status` is a free text label the engine sets while the agent works: `idle`, `planning`, `reviewing`, `testing`, `coding`, `working`. It is set when a work item starts and cleared to `idle` when the work ends or is stopped. **[V]** `engine.ts` `AGENT_STATE`, `setAgentStatus`.

This is a display label. It is not the same as "can this agent work at all". That second question is answered only when a work item is dispatched, by the router. **[V]** `router.ts` `candidatesForRole`, `blockReason`.

### 2.2 Why an agent cannot work **[V]**

`blockReason` returns the first reason in this order:

| Reason | Meaning |
|---|---|
| `no provider` | The agent has no account, or the account's provider no longer exists. |
| `provider disabled` | The provider is switched off. |
| `provider not allowed in workspace` | The office limits which providers it may use. |
| `account disabled` | The account is switched off. |
| `circuit open` | The backend failed too often and is cooling down. |
| `quota exhausted` | A rate or quota window is used up. |
| `monthly budget reached` | The account's monthly budget is spent. |

An agent is "blocked" only if its own backend and every fallback model are blocked. Otherwise it is substituted onto a usable fallback. **[V]** `candidatesForRole`.

### 2.3 Work item states **[V]**

`queued`, `running`, `waiting`, `delivered`, `failed`, `cancelled`, `interrupted`. A result is recorded only while the item is `running`. **[V]** `engine.ts` `executeWorkItem`.

## 3. Agents with no configured provider

### 3.1 What happens today **[V]**

| Where the agent is used | What happens |
|---|---|
| A role step (the step names a role) | `pickAgent` filters out blocked agents. A no-provider agent is skipped silently. If every agent of that role is blocked, no candidate exists. |
| A pinned step (the step names this exact agent) | `wfCandidate` looks for this agent only. Blocked means null. |
| No candidate for a graph step | The engine emits `workflow.deadend`, raises one Needs-you item "No agent can run <step>", and sets the task to `blocked`. `engine.ts` around `dispatchAgentNode`. |
| No candidate for the plan | `plan.unavailable`. If it is the first plan, a Needs-you item asks the owner to supply a plan by hand and the run goes to `dod-review`. |
| No candidate for a fix | The task is set to `blocked` with "no eligible fixer". |
| No eligible reviewer | A `review.unavailable` Needs-you item. |
| Every option of the chosen agent becomes blocked between the pick and the dispatch (rare) | The router lists why each option was passed over. If nothing works it throws `no usable backend: ...`. That text matches no failure pattern, so it counts as transient and the task is retried with backoff. |
| Human approval node | The node refuses to start the app if no agent is available and raises the usual dead-end item. |

### 3.2 The problems this causes **[V]** unless marked

1. A pinned step with a no-provider agent blocks the task even when other agents of the same role could do the work.
2. The failure is found late, at the moment of dispatch, not when the agent or workflow was saved. Workflow validation has no provider check. **[V]** `validateWorkflow`
3. `no usable backend` is retried as a transient error. It is not transient: retrying cannot create a provider. It wastes attempts and delays the Needs-you item. **[V]** by reading `failure.ts`: no pattern matches it, so the default (transient) applies. This path is rare, because blocked agents are filtered out before dispatch.
4. Imported agents start on "this machine's first enabled account". If there is none, they start with no provider. **[V]** `docs/guide.md` "Export and import"
5. The Needs-you item names the step and the role or the agent's internal id, not the agent's name, the reason or the fix. **[V]** `engine.ts` `dispatchAgentNode` summary text.

### 3.3 Required behavior **[P]**

| # | Behavior |
|---|---|
| 1 | Detect early. When an agent is saved, added to an office, or a workflow is saved or activated, say plainly which agents have no usable provider and which steps they hold. Do not block saving in v0 (warning only). |
| 2 | Before a run starts, check every step the workflow can reach. List the agents that cannot work. Let the owner continue anyway. |
| 3 | At dispatch, when the chosen agent is blocked, try in order: another agent of the same role in this office, the step's role pool, then the owner's fallback if any. Record why each was skipped (`model.switched` style event). |
| 4 | If nobody can do the step, pause only that task. Raise exactly one Needs-you item per step and task. It names the agent, the reason from the list in 2.2 and the one fix ("choose a provider for Dev 2 under Agents"). Other tasks and other steps keep running. |
| 5 | Treat `no usable backend` and `no provider` as fatal for that work item, not transient. No backoff retries. |
| 6 | When the owner fixes the provider, the paused task resumes by itself. |
| 7 | The Agents page shows readiness for every agent, with the reason. (v1, REQ-PRV-04) |
| 8 | Never crash. Never leave a task `running` with no process. |

**[?]** Q-09 asks what the owner expects. The table above is a proposal.

### 3.4 Edge cases to settle

| Case | Question |
|---|---|
| The only agent for a role has no provider | Block the task, or ask the owner to supply a result by hand (the manual adapter)? |
| The agent has a provider but no model | CLI agents work without a model. API agents may not. What is the rule per adapter? |
| A step's agent is deleted | The import code falls back to the step's role. Should live editing do the same? |
| A fallback agent is the author | Separation of duties may forbid it (an author cannot review their own work). Which rule wins? |
| A provider becomes available while a task waits | Resume at once, or wait for the owner? |

## 4. Provider configuration

### 4.1 The model **[V]**

- A **provider** is a kind of backend: its adapter, tier, whether it is enabled, and config.
- An **account** belongs to a provider. It holds the billing type, label, monthly budget and its own enabled flag. Keys live in `daemon/data/secrets.json`.
- A **model** belongs to a provider: name, context size, max output, prices, strength tier (fast, standard, strong).
- An **agent** points at one account and one model, and can list ordered fallback options.
- An **office** can limit the providers it may use.

Adapters: `scripted`, `openai-compatible`, `anthropic`, `cli`, `devin`, `manual`. **[V]** `adapters/index.ts`.

### 4.2 Settings per agent **[V]**

Reasoning effort, temperature, max output, context size, fallbacks, tier override, CLI session policy. Which of them a backend accepts is decided by `settingsSupport` in `services/models.ts`. For CLI agents, effort and max output now reach Claude Code only. **[V]** uncommitted change.

### 4.3 Gaps **[?]**

- There is no single "this agent is ready" check shared by the UI, the validator and the engine. Each asks in its own way.
- Whether the Providers page prevents deleting a provider that agents use was not verified. A `provider_tombstones` table exists. **[V]** its purpose was not examined.

## 5. Stopping

### 5.1 What stop means

Stop means: the work ends now, no more tokens are spent on it, nothing is delivered late, nothing restarts by itself, and the owner sees what happened.

### 5.2 What exists **[V]**

| Action | Effect | Source |
|---|---|---|
| Stop run | Run set to `stopped`. Open work items cancelled first. CLI children killed. Review apps stopped. Agents set idle. CLI session locks freed. | `engine.ts` `stopRun` |
| Hard pause | Same as stop for work items, but the run becomes `paused` and can resume. | `pauseRun(hard)` |
| Soft pause | No new work. Running work finishes. | `pauseRun` |
| Stop agent | The agent's open work items are cancelled and their CLI processes killed. Sessions freed. The task goes on hold, its checkpoint is closed. Work with no task pauses the run. | `stopAgent` (uncommitted), route `POST /api/agents/:id/stop` |
| Stuck detector | Kills the process, frees the session and agent, runs the failure policy, re-schedules itself. | `fireDueTimers`, `PROGRESS.md` stage 8 |
| After a stop | The router will not start a fallback backend for a cancelled item. | `router.ts` `cancelled()` |

### 5.3 Gaps **[V]** unless marked

1. **API agents cannot be cancelled mid-call.** The two fetches in `llm.ts` carry only `AbortSignal.timeout` (240 s and 300 s). A stop marks the item cancelled and the reply is discarded, but the request runs to the end and its tokens are billed.
2. **The manual adapter never settles on stop.** Its promise stays in a map until a human submits. The work item is cancelled, so the late result is dropped, but the waiting call and its map entry are never released.
3. **Agent stop is not yet proven** against a live CLI agent. The tests use scripted agents and a fake child. **[V]** `stop-agent.test.js`
4. **A held task has no "resume where it stopped" button on the agent.** It is released from the task board. **[V]** by design in the code comments.
5. **The `failed` run state** is compared in many places but is not part of the run status type. **[V]** `types.ts` `RunStatus` lacks it. Either the type or the checks are out of date.
6. **[?]** Whether the Devin session is cancelled on the Devin side when the item is cancelled. The polling stops; the earlier log says "stop on cancel". Not re-verified today.

### 5.4 Required behavior **[P]**

| # | Behavior | Requirement |
|---|---|---|
| 1 | Every adapter implements one cancel contract: after cancel, no more output, no more cost, and the call returns promptly. | STP-07 |
| 2 | API adapters abort the HTTP request on cancel. | STP-03 |
| 3 | The manual adapter releases its waiting call on cancel. | STP-07 |
| 4 | Stopping an agent says in the UI what happened to the task (held, paused, cancelled). | STP-05 |
| 5 | A stopped agent stays stopped until the owner releases its tasks. | STP-02 |
| 6 | A work item whose process died ends as `failed` or `interrupted` within a bounded time, never stays `running`. | STP-04 |
| 7 | The owner can choose what a stop does to the task (hold, hand to another agent, cancel). Today it is always hold. | Q-11 |
| 8 | The run status type and its checks agree on one list. | STP-04 |

## 6. Acceptance

See AC-PRV and AC-STP in [testing-and-acceptance.md](testing-and-acceptance.md).
