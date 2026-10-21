# Dependencies, technical constraints, unresolved decisions and future ideas

Labels are in the [README](README.md).

## 1. Dependencies

### 1.1 To run Oficina **[V]**

| Dependency | Needed for | Source |
|---|---|---|
| Node.js 22.5 or newer | The daemon. `node:sqlite` needs it. | `package.json` `engines` |
| Git | The repository, snapshots, checkpoints, the timeline. | `docs/guide.md` |
| npm | Install and run. | `README.md` |
| `express`, `ws`, `yaml` | The daemon's only runtime packages. | `daemon/package.json` |
| `tsx`, `typescript` and type packages | Run and check TypeScript. | `daemon/package.json` |
| React, Vite, Tailwind, ReactFlow | The UI. | `ui/package.json`, `docs/guide.md` |
| Windows PowerShell | The tray and the launchers. | `office-tray.ps1`, `start-office.bat` |

No new package may be added without the owner's approval. **[V]** `prompt.md` rule 6.

### 1.2 For agent backends **[V]** (each optional)

| Backend | Needs |
|---|---|
| Claude Code | The `claude` command, logged in or with a key. |
| cursor-agent | The `agent` command. |
| Devin | The `devin` command and an organization, or the Devin API. |
| OpenAI-compatible | A base URL and, usually, a key. |
| Anthropic API | A key. |
| Scripted | Nothing. Demo only. |
| Manual | A person. |

### 1.3 For the new work **[P]**

| Item | Depends on |
|---|---|
| Handling agents with no provider | Nothing external. |
| Cancelling API calls | Nothing external. |
| Checkpoint fixes | Git (already needed). |
| Omni Router | Which one is chosen (Q-07). For OmniRoute: Node or Docker, a free port, a connected upstream provider, and a pinned version. See [omni-router-integration.md](omni-router-integration.md). |
| Real token measurement | Real provider access and a small budget. |

## 2. Technical constraints

| # | Constraint | Label | Effect |
|---|---|---|---|
| C-1 | One process, one SQLite file. | **[V]** | No concurrent daemons on one data folder. |
| C-2 | Windows first. Console windows, process trees and paths shape the code. | **[V]** | New code that starts processes must hide consoles and kill trees. |
| C-3 | Direct mode: one writer at a time per repository. | **[V]** | Parallel writing needs isolated mode. |
| C-4 | A CLI can resume only its own sessions, from the folder that started them. | **[V]** | Isolated mode cannot reuse sessions. |
| C-5 | Database changes only add columns and tables. | **[V]** | Fixes cannot rewrite old data without a separate decision. |
| C-6 | The daemon listens on localhost only and refuses foreign origins. | **[V]** | A gateway or proxy must respect this. |
| C-7 | `engine.ts` is one very large file. | **[V]** | Changes need tests first and small steps. |
| C-8 | API adapters use plain `fetch` with a timeout only. | **[V]** | Cancel needs a code change. |
| C-9 | The scripted adapter reports zero tokens. | **[V]** | Real measurement needs real providers. |
| C-10 | `daemon/data/` is the owner's live data. | **[V]** | Never read or edit it directly. Use the API or a `VACUUM INTO` copy. |
| C-11 | Original spec choices not built as written: vault, sandbox, built-in `/v1` endpoint, egress allowlist. | **[V]** | Do not assume them. |

## 3. Process constraints (from the owner) **[C]**

1. This work is documentation only. No code, no source changes. (D-001)
2. The owner's v0, v1 and v2+ meanings are not changed. (D-002)
3. Existing documents and specifications are not overwritten or deleted. (D-003)
4. Existing project decisions stand unless the owner approves a change. (D-003)
5. Verified behavior, confirmed requirements, proposals, assumptions and future plans are kept apart. (D-004)

## 4. Unresolved decisions

Each has an ID in the [decision log](decision-log.md). They are ordered by how much they block.

| ID | Decision | Needed for | Question | Proposed default |
|---|---|---|---|---|
| D-101 | Which Omni Router | Everything under OMR | Q-07 | OmniRoute **[A]** |
| D-102 | A token target in numbers | TOK-02 and the benchmark | Q-08 | none; the owner chooses |
| D-103 | What happens when an agent has no provider | PRV-03 | Q-09 | Section 3.3 of [agent-lifecycle.md](agent-lifecycle.md) |
| D-104 | Whether crash recovery records the whole tree or only the task's files | CKP-03 | Q-05 | Only the task's files, and say so |
| D-105 | The rule for each live-edit situation | WFL-03 | Q-10 | Section 2.4 of [orchestration.md](orchestration.md) |
| D-106 | What a stop does to the task: hold, hand over or cancel | STP-01 | Q-11 | Hold, with a choice |
| D-107 | Checkpoint retention limit and what is protected | CKP-06 | none yet | 500 per repository; never Manual or open |
| D-108 | Whether a gateway is acceptable given the original spec's "no intermediary" rule | OMR-05 | Q-07 | Yes if local, per-repository consent |
| D-109 | Confirm or change every proposed v-level | the roadmap | all | the roadmap as written |
| D-110 | Which uncommitted work to commit, and when | T-001 | none yet | the owner chooses files |
| D-111 | What the owner wants from the timeline | TML-02 | Q-06 | none |
| D-112 | Whether per-task workflow version pinning ("new tasks only") is wanted | WFL-03 | Q-10 | not in v0 |
| D-113 | Whether prompt and reply retention needs a setting | PRIV-01 | Q-03 | v1 |

## 5. Assumptions in play **[A]**

Listed in full in the [decision log](decision-log.md). The ones that matter most: the owner means OmniRoute (A-001); Oficina has one human user (A-002); no telemetry exists (A-004); local unencrypted data is acceptable (A-005).

## 6. Future ideas **[F]**

These are in the v2+ bucket. They are kept here so they are not lost.

- Predict the effect of a workflow edit before applying it.
- Router features beyond a gateway: learned or budget-aware routing.
- Several users, hosted service, desktop shell.
- Sandboxed agent execution, embeddings for context, more hosted-agent adapters.
- Whole-run token prediction.
- "Agents that never need the owner to fix anything", recorded as the impossible wish.

The full list with notes is in [roadmap-v0-v1-v2.md](roadmap-v0-v1-v2.md).
