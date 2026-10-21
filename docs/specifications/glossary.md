# Glossary

Plain-language definitions. Labels are in the [README](README.md).

| Term | Meaning |
|---|---|
| **Acceptance criterion** | A test written as "given, when, then" that says when a requirement is met. See [testing-and-acceptance.md](testing-and-acceptance.md). |
| **Adapter** | The part that talks to one kind of agent backend. It sends a prompt and gets a result. |
| **Agent** | An AI worker with a name, a backend and one or more roles. |
| **Agent checkpoint** | A save of the repository before and after one agent's work item. |
| **Approval** | A question the engine puts to the owner, such as "commit this?". Shown under Needs you. |
| **Audit log** | The hash-chained record of engine decisions. Tampering shows. |
| **Backend** | The thing that actually runs an agent: a CLI, an API, Devin, a demo script, or a person. |
| **Bench** | A fixed end-to-end scenario used to compare before and after a change. |
| **Blocked (task)** | A task that cannot go on because something is missing, such as an agent. |
| **Cache hit** | A work item answered from an earlier identical one, with no model call. |
| **Checkpoint** | A saved state of the repository's working files that can be undone, redone or restored. Not the same as a run snapshot. |
| **CLI session** | A saved conversation of a command-line agent that can be continued. |
| **Circuit breaker** | A rule that stops using a backend for a while after repeated failures. |
| **class?** | A mark on an item whose v-level is uncertain. |
| **Condition node** | A workflow step that chooses a path by a rule, with no model call. |
| **Daemon** | The background program that runs Oficina. |
| **Definition of Done (DoD)** | The list of checks that must pass before a run counts as finished. |
| **Desk** | A role slot in an office, such as developer or reviewer. |
| **Direct mode** | Agents work inside the owner's own repository, one writer at a time. |
| **Envelope (hand-off)** | A short typed note passed from one agent to the next instead of the full previous answer. |
| **Fallback** | The next option tried when the first fails or is blocked. |
| **General checkpoint** | A save of the repository before and after a whole task. |
| **Gateway** | A service that sits in front of many model providers and offers one address. OmniRoute is one. |
| **Guardrail** | A limit on a workflow (steps, cost, time) that pauses and asks. |
| **Hand-off** | Passing work from one agent to another. |
| **Held (task)** | A task the owner parked. No agent picks it up. |
| **Human approval node** | A workflow step that starts the app, has an agent report on it and lets the owner approve or reject from a floating panel. |
| **Isolated mode** | Each task works in its own copy (a worktree) of the repository. |
| **Manual checkpoint** | A save point the owner makes, or one made before a restore. |
| **Needs you** | The list of things waiting for the owner. |
| **Node (workflow)** | One step in a workflow graph. |
| **Office** | A workspace with its own agents, desks, workflows and runs. |
| **Omni Router** | An unsettled name. Possibly OmniRoute (a gateway), OmniRouter (a research method) or Lemonade's tool router. See [omni-router-integration.md](omni-router-integration.md). |
| **Owner** | The one human who uses Oficina. |
| **PM** | The project manager agent. It plans and accepts. It never writes code. |
| **Pinned (step)** | A workflow step tied to one named agent rather than a role. |
| **Provider** | A kind of backend with its settings. An account belongs to a provider. |
| **Quota window** | A limit on use over time, such as requests per hour. |
| **Requirement ID** | A permanent label such as REQ-STP-03. |
| **Review panel** | The floating panel on the app under test where the owner approves or rejects. |
| **Role** | What an agent does in an office: PM, developer, QA, reviewer, analyst, docs, prompt creator. |
| **Router** | The part that picks an agent and a model for each piece of work. |
| **Run** | One request being worked on, from the owner's words to the result. |
| **Run snapshot** | A saved copy of a run's database rows. Used for recovery. Not a repository checkpoint. |
| **Safe point** | A moment when a change can take effect without breaking work in flight. |
| **Scripted agent** | A pretend agent that returns planned replies. Used in tests and demos. |
| **Stuck detector** | A timer that finds a work item with no sign of life and takes it over. |
| **Task** | One job of a plan. It moves through states from backlog to done. |
| **Tier** | How strong a model is: fast, standard or strong. |
| **Timeline** | The list of repository and project events, newest first. |
| **Token** | A piece of text a model reads or writes. Cost and limits are counted in them. |
| **v0, v1, v2+** | The owner's buckets: right now and possible, before polished, and the future or the impossible. |
| **Work item** | One prompt sent to one agent. |
| **Workflow** | The graph of steps a task follows. It has saved versions. |
| **Worktree** | A separate working copy of a repository made by git. |
