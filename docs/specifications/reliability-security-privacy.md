# Error handling, reliability, security and privacy

Labels are in the [README](README.md). Requirements: REQ-REL-01 to 03, REQ-SEC-01 to 04, plus the new ones below.

## 1. Error handling

### 1.1 Failure classes **[V]**

`daemon/src/services/failure.ts`. Every work-item failure lands in one class, and each class has one policy.

| Class | Examples | Policy |
|---|---|---|
| transient | Rate limit, network, timeout, server error, CLI crash, anything unknown | Exponential backoff with jitter (2 s up to 60 s plus up to half again). Retry. Then fail over to the next routing option. |
| model-quality | Empty, unparseable or malformed reply | One repair call with only the error and the bad output. Then one escalation to a stronger tier. |
| fatal | Authentication or permission errors, missing CLI, repository conflict, engine-side programming errors | Pause the run. Raise exactly one Needs-you item with a one-sentence fix. |

After a task exhausts its same-error attempts, the PM gets a diagnosis step (retry stronger, split into at most three subtasks, or escalate to the owner). It happens once per task.

### 1.2 Gaps **[V]** unless marked

| # | Gap | Where |
|---|---|---|
| E1 | "No provider" and "no usable backend" are not fatal. They take the default (transient) path, or end as a blocked task with a vague Needs-you. | [agent-lifecycle.md](agent-lifecycle.md) section 3 |
| E2 | The classifiers are pattern-based. Unusual provider error text degrades to transient retries, which are bounded. | `docs/guide.md` remaining risks |
| E3 | The risk classifier is pattern-based. A new risky change shape may pass the `auto` approval mode. | `docs/guide.md` remaining risks |
| E4 | The run status type has no `failed`, but the code tests for it. | `types.ts` against `engine.ts` |

## 2. Reliability

### 2.1 What exists **[V]** (`PROGRESS.md` stages 4 and 8, tests listed there)

- **Crash recovery.** At boot, stale running work items become `interrupted` and their tasks `ready`. Tasks waiting on in-memory retry timers are re-readied. Parked tasks and tasks waiting on the owner are not touched. Open checkpoints are closed as `interrupted`.
- **No duplicates.** Work items carry an idempotency key from the task, kind, length and a hash of the prompt. A live item with the same key is reused.
- **Orphans.** Live CLI process ids are stored and reaped at boot, matched by command line so a reused id is safe. Signal handlers stop all CLIs on exit.
- **Daemon never exits on one bad input.** Guards for unhandled rejections and exceptions log an event and carry on. A stdin error on a CLI no longer kills the daemon. Async routes reach a JSON error handler.
- **Stalled CLIs.** A no-output watchdog (300 s by default, paused while a tool call is open) kills the process and retries.
- **Stuck detector.** Kills the process, frees the agent and session, applies the failure policy, and re-arms itself.
- **Serialized advancing.** `maybeAdvanceRun` runs one cycle per run at a time.
- **Hash-chained events.** Tampering shows on an incremental check, with a full pass every 10 minutes.
- **Storage.** Run snapshots are written only on change and capped at 20 per run. A boot prune removes old ones.
- **Ceilings pause, never kill.** Cost, time, step and cycle ceilings stop new work and ask.

### 2.2 Gaps and risks

| # | Item | Label |
|---|---|---|
| R1 | `uncaughtException` keeps the daemon running instead of exiting. A corrupted state could continue unnoticed. | **[V]** `PROGRESS.md` stage 8 "Not done" |
| R2 | No automatic database `VACUUM`. It rewrites the file and needs the daemon stopped. | **[V]** |
| R3 | A tampered older event is caught by the 10-minute pass, not at once. | **[V]** |
| R4 | Isolated mode cannot continue CLI sessions, because each task has its own worktree. | **[V]** |
| R5 | Detection of checks runs at the first plan of a run, not mid-run. | **[V]** |
| R6 | The stop paths for API agents and manual work are incomplete. | [agent-lifecycle.md](agent-lifecycle.md) section 5.3 |
| R7 | One writer at a time per repository in direct mode. By design. | **[V]** |
| R8 | The engine is one very large file (about 4,200 lines). A change there is harder to review. | **[V]** |

### 2.3 Reliability requirements **[P]**

| ID | Requirement |
|---|---|
| REQ-REL-04 | Every state an engine object can be in is listed in one place, with every allowed move. Today they are spread across files. |
| REQ-REL-05 | A bounded time exists for every wait: a work item, a checkpoint, a held task, a review app, a pending adoption. After it, the owner is told. |
| REQ-REL-06 | Each fix in this specification ships with a test that fails before the fix and passes after. |
| REQ-REL-07 | The recovery tests cover a stop followed by a restart, and a restart during a review. |

## 3. Security

### 3.1 What exists **[V]**

| Area | Protection | Source |
|---|---|---|
| Network | Listens on 127.0.0.1 only. Requests must name localhost in the Host header. Browser requests that change state, and the event stream, must come from the app's own pages. Cross-site requests are refused. | `server.ts`, `api-security.test.js` |
| Blob paths | Path traversal with `..\` is rejected. | `PROGRESS.md` stage 8 |
| Commands | `{prompt}` is passed as one quoted argument. The check runner runs a command verbatim and kills the whole process tree on timeout. | stage 8 |
| Secrets | Provider keys live in `daemon/data/secrets.json`, git-ignored. Known secret values are replaced with `[redacted]` in events and prompts. | `config.ts` `redact`, `bus.ts`, `prompts.ts` |
| Changes | Protected paths (config, CI, secrets, lockfiles), dependency files and large diffs are treated as risky. Approval modes: always ask (default), ask when risky, auto. Decisions such as questions and escalations always stay with the owner. | `services/policy.ts` |
| Repository | The office never runs reset, checkout, clean, history rewrites or force-push in the owner's repository. | `docs/guide.md` |
| Review panel | The panel is served by a local proxy bound to 127.0.0.1. Its decision route needs a per-review token and rejects other origins. A rejection needs words. A decision is recorded once. | `review-proxy.ts`, `approval-node.test.js` (uncommitted) |
| Agent-suggested command | The app start command an agent proposes runs only when the engine could not start the app, and never over a command the owner set. | `engine.ts` (uncommitted) |
| Skills | Imported skills are scanned and need the owner's approval. | `docs/guide.md` |

### 3.2 Gaps **[?]**

| # | Gap |
|---|---|
| S1 | The original spec describes a vault, sandboxed execution, an egress allowlist, a prompt-injection defence at execution points and a redaction scanner for key patterns. The code redacts known secret values only. A sandbox is scaffolded, not built. **[V]** `docs/guide.md`. |
| S2 | An agent works as the owner's own user and can run commands in the repository. Its output is treated as data, but nothing stops a hostile repository file from steering an agent. **[?]** the extent of the prompt-injection handling was not audited. |
| S3 | The review panel token is visible to the page under test. A malicious page the owner chooses to test could decide its own review. Low risk for the owner's own app. **[V]** by design. |
| S4 | `daemon/data/` holds the database and `secrets.json`. Nothing encrypts the file at rest. **[A]** the owner accepts this for a local tool. |
| S5 | No audit of the Windows launchers and the tray scripts for privilege or path issues. **[?]** |

### 3.3 Security requirements **[P]**

| ID | Requirement |
|---|---|
| REQ-SEC-05 | A gateway or router (see [omni-router-integration.md](omni-router-integration.md)) is used for a repository only after the owner approves it for that repository. |
| REQ-SEC-06 | Any new route that changes state keeps the Host and Origin checks, and has a test that a foreign origin is refused. |
| REQ-SEC-07 | Any new place that stores a secret is git-ignored and redacted in events. |
| REQ-SEC-08 | An audit of the agent-suggested command, the review proxy and the tray scripts is done once the owner approves implementation. |

## 4. Privacy

| Topic | Today |
|---|---|
| Where data lives | On the owner's machine in `daemon/data/` and in the repository. **[V]** |
| What leaves the machine | Prompts and code go to the provider the owner chose for each agent. Nothing else was found. **[A]** no telemetry code was found in the files reviewed. |
| Prompt and reply retention | Stored in the database. The original spec proposed 30 days by default with a "metadata only" option. No such setting was found in the code. **[?]** |
| The live database | `daemon/data/` is the owner's real, running instance. It is only read through the API, or from a copy made with `VACUUM INTO`. Never open it directly while the daemon runs. **[V]** the owner's rule |
| A private copy of the project | A private repository exists (`Xrnozy/oficina-private`) with the working tree at the time it was made. It excludes `daemon/data`, `.env` files and `node_modules`. **[V]** |
| Documentation hygiene | These specifications contain no keys, tokens or personal data. Keep it so. |

### 4.1 Privacy requirements **[P]**

| ID | Requirement |
|---|---|
| REQ-PRIV-01 | A retention setting for prompts and replies, with an option to keep only metadata. Level **class?** v1. |
| REQ-PRIV-02 | Per-repository rules: which providers and routers it may use, and "local only". Level v1. |
| REQ-PRIV-03 | The owner can see, for any run, which providers received which parts of the repository. Level v1 **class?** |

## 5. Acceptance

See AC-REL and AC-SEC in [testing-and-acceptance.md](testing-and-acceptance.md).
