# Requirement reconciliation matrix

This file traces each of the owner's ideas to what exists, where it is specified, and how it relates to the older documents. It is how the specifications stay consistent with the rest of the project.

Labels are in the [README](README.md).

## 1. The owner's ideas

| # | Idea (owner's words, shortened) | Exists today? | Requirements | Where specified | Task | Level (proposed) | Differences from older documents |
|---|---|---|---|---|---|---|---|
| 1 | Fix agents without a configured provider interrupting the workflow | **Not fixed.** Cause found. | PRV-01 to 04 | [agent-lifecycle.md](agent-lifecycle.md) section 3 | T-002, 003, 004, 101, 102 | v0, with v1 parts | `docs/guide.md` does not mention the case. The original spec section 6 and 8 do not either. |
| 2 | Change a workflow while a task runs and reroute later steps without stopping | **Mostly built.** | WFL-01 to 06 | [orchestration.md](orchestration.md) section 2 | T-010, 103, 201 | v0 (rules), v1 (preview), v2+ (prediction) | The original spec 5.8 describes safe points; the code switches at once unless a working step is removed. `docs/guide.md` "Visual workflow" says a run pins its version and editing never changes a run in flight. **That sentence is out of date**: commit `54d9a28` made saving switch running requests to the new version. |
| 3 | Fix agent stopping controls | **Partly.** Run stop fixed earlier. Agent stop written, uncommitted. API cancel and manual cancel missing. | STP-01 to 07 | [agent-lifecycle.md](agent-lifecycle.md) section 5 | T-001, 005, 006, 007 | v0 | `PROGRESS.md` stage 8 records the earlier fixes. |
| 4 | Fix the checkpoint system. Define creation, recovery and resumption. | **Built, with suspected problems.** No symptoms recorded. | CKP-01 to 07 | [checkpoints.md](checkpoints.md) | T-008, 009, 104, 105 | v0 (find and test), v1 (deep fixes) class? | `docs/guide.md` says retention keeps the newest 500. It is never run. The original spec 5.8 calls run snapshots "checkpoints" too; they are a different thing (`checkpoints` table against `repo_checkpoints`). |
| 5 | Add a repository timeline | **Built.** | TML-01 to 03 | [repository-timeline.md](repository-timeline.md) | T-106, 107 | v0 (exists), v1 (additions) | `docs/guide.md` "Repository timeline" matches the code. |
| 6 | Integrate Omni Router | **Not built. Name ambiguous.** | OMR-01 to 07 | [omni-router-integration.md](omni-router-integration.md) | T-011, 108, 202 | v0 (decision), v1 (build) class? | The original spec 8.4 describes a built-in router and says no third-party router. Neither is quite what exists. See section 3. |
| 7 | Improve token efficiency | **Much built. Not measured with real providers.** | TOK-01 to 07 | [token-efficiency.md](token-efficiency.md) | T-012, 013, 014, 109 | v0 (measure), v1 (view, ranking) | The original spec 5.9 lists strategies; most were built (see section 2). |
| 8 | Master specifications and documents | **This folder.** | DOC-01 to 03 | [README.md](README.md) | none | v0 | none |
| 9 | Questioning agent for the Claude web chatbot | **Written.** | DOC-01 | [claude-questioning-agent.md](claude-questioning-agent.md) | none | v0 | none |
| 10 | Human approval widget (earlier request, same session) | **Built, uncommitted.** | SEC-03, 04 | [reliability-security-privacy.md](reliability-security-privacy.md) 3.1 | T-001 | v0 | `docs/guide.md` "Human approval" describes the Needs-you flow and does not mention the floating panel. Update after the owner approves. |

## 2. The original spec's efficiency strategies against what was built

`spec/AI-Agent-Office-Spec.md` section 5.9.

| Strategy in the spec | Built? | Evidence |
|---|---|---|
| Minimal context, hard budget per role | Yes, as a character budget per prompt | `prompts.ts`, `context.ts` |
| Symbol index and embeddings for file slices | No (scaffolded) | `docs/guide.md` |
| Stable prefix for prompt caching | Yes | `prompts.ts` |
| Local cache of repo summaries by tree hash | Partly: a memoized summary | `repo-map.ts` |
| Cycle summaries for the PM | **[?]** not checked | |
| Capped logs | Yes | `compactLog` |
| Test-impact map for incremental verification | No | a search found nothing |
| Error dedupe by signature | Yes | `error_kb`, `errors.ts` |
| Difficulty-based routing | Yes | `routing.ts` |
| Parallelism | Partly: read-only lane; writers one at a time | `PROGRESS.md` stage 6 |
| Review economy: lightweight review for small safe diffs | No | a search found nothing |
| Early abort of hosted sessions | Partly: Devin stops polling and stops the session; API calls are not cancelled | [agent-lifecycle.md](agent-lifecycle.md) |

## 3. Other differences between the original spec and the code

| Topic | Spec | Code | Action |
|---|---|---|---|
| Built-in router endpoint (`POST /v1/chat/completions` on the daemon, per-agent virtual keys) | Section 8.4 | Not built. The daemon only calls out. **[V]** a search for `/v1/chat` found no route. | Record. Decide if wanted (v2+ class?). |
| Vault for secrets | Section 10.1 | `secrets.json` with redaction of known values | Record. See S1 in the security document. |
| Sandboxed execution | Section 10.2 | Scaffolded | v2+. |
| Egress allowlist | Section 8.4 | Not built | Record. |
| Run snapshots every 5 minutes | Section 5.8 | Every 15 seconds, only on change, 20 kept | Code is newer. Keep. |
| Prompt and reply retention of 30 days | Section 8.4 | No setting found | REQ-PRIV-01. |
| Owner edit modes | Section 5.8 | All three exist (`finish`, `abort`, `handoff`) with two differences | See [orchestration.md](orchestration.md) section 3. |
| `abandoned/` branch on abort | Section 5.8 | Only in isolated mode | Record. |

## 4. Documents that need an update **after the owner approves**

They are not changed now (D-003).

| Document | What is out of date |
|---|---|
| `docs/guide.md` "Visual workflow" | Says a run pins its version and edits never change a run in flight. Since `54d9a28`, saving switches running requests. |
| `docs/guide.md` "Checkpoints" | Says retention keeps the newest 500. It is never run. |
| `docs/guide.md` "Human approval" | Does not describe the floating review panel or the agent suggesting a start command. |
| `docs/guide.md` "Model routing" | Says reasoning effort `auto` applies to API backends only. Claude Code now takes an explicit effort (uncommitted). |
| `README.md` | Does not mention the review panel. |
| `PROGRESS.md` | Has no stage for today's work. |

## 5. Requirements not traced to an owner idea

These came from the review, not from the owner. They need the owner's confirmation.

| Requirement | Origin |
|---|---|
| STP-03 (cancel API calls) | Found by reading `llm.ts` |
| STP-04 (one state list, no `failed` mismatch) | Found by reading `types.ts` |
| CKP-04, CKP-06 | Found by reading `checkpoints.ts` and `engine.ts` |
| REL-04 to 07, SEC-05 to 08, PRIV-01 to 03 | Proposed from gaps against the original spec |
