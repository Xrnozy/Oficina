# Task registry

One row per piece of future work. IDs are stable. Size is a rough relative size, not time: **S** is a small local change, **M** touches a few places, **L** is cross-cutting. Levels are proposed (see [roadmap-v0-v1-v2.md](roadmap-v0-v1-v2.md)). "Proof" points to the acceptance criterion in [testing-and-acceptance.md](testing-and-acceptance.md).

This file lists work. It does not do it. Implementation starts only after the owner approves these specifications.

## v0

| ID | Task | Requirement | Size | Depends on | Proof | Status |
|---|---|---|---|---|---|---|
| T-001 | Commit the per-agent stop, the review panel and the CLI effort settings (owner chooses which files) | STP-01, SEC-03, SEC-04 | S | owner decision | AC-STP-01 | not started |
| T-002 | Add a provider check to workflow validation (warn on any step whose pinned agent has no usable provider) | PRV-02 | S | none | AC-PRV-02 | not started |
| T-003 | At dispatch, when a pinned agent has no usable provider, try another agent of the same role, then pause only that task with one Needs-you item naming the fix | PRV-03 | M | Q-09 | AC-PRV-03 | not started |
| T-004 | Warn when an agent is saved or added to an office with no provider | PRV-02 | S | none | AC-PRV-02 | not started |
| T-005 | Live-test the per-agent stop against a real CLI agent and a real API agent | STP-01, 05 | S | T-001 | AC-STP-01 | not started |
| T-006 | Make API calls cancellable by a stop (abort the request, spend no more tokens) | STP-03 | S | none | AC-STP-03 | not started |
| T-007 | Check the manual and Devin adapters against the stop rules | STP-07 | S | none | AC-STP-07 | not started |
| T-008 | Record the checkpoint symptoms with the owner, then write a failing test for each | CKP-02 | M | Q-05 | AC-CKP-02 | not started |
| T-009 | Test the suspects: several General checkpoints per task, crash-recovery attribution, retention (it is never run today; test both that it runs and that it spares manual and parent-child checkpoints), "last undoable" offering a refused undo | CKP-03, 04, 06 | M | none | AC-CKP-04, 06 | not started |
| T-010 | Write the rule for every live-edit situation and a test for each | WFL-03 | M | Q-10 | AC-WFL-03 | not started |
| T-011 | Decide which Omni Router | OMR-01 | S | Q-07 | decision-log | not started |
| T-012 | Decide a token target (numbers) | TOK-02 | S | Q-08 | decision-log | not started |
| T-013 | Measure real token use on three real runs and record the baseline | TOK-01 | M | T-012 | AC-TOK-01 | not started |
| T-014 | Add a benchmark guard: a fixed scenario must keep the same pass result before and after any token change | TOK-05 | M | T-013 | AC-TOK-05 | not started |

## v1

| ID | Task | Requirement | Size | Depends on | Proof | Status |
|---|---|---|---|---|---|---|
| T-101 | Show each agent's readiness and the reason it cannot work | PRV-04 | S | T-003 | AC-PRV-04 | not started |
| T-102 | Block save or activate of a workflow that cannot run, if a warning proves too weak | PRV-02 | S | T-002 | AC-PRV-02 | not started |
| T-103 | Impact preview before applying a live workflow edit | WFL-04 | M | T-010 | AC-WFL-04 | not started |
| T-104 | Make checkpoint recovery record only the task's own changes | CKP-03 | L | T-009 | AC-CKP-03 | not started |
| T-105 | A clear "resume from checkpoint" action with the state shown | CKP-05 | M | T-104 | AC-CKP-05 | not started |
| T-106 | Timeline additions the owner asks for | TML-02 | M | Q-06 | AC-TML-02 | not started |
| T-107 | Timeline speed on large histories | TML-03 | M | none | AC-TML-03 | not started |
| T-108 | Omni Router as an optional backend: per-agent opt-in, fallback to direct, consent per repository, usage still counted | OMR-02 to 05 | L | T-011 | AC-OMR | not started |
| T-109 | Token view per run and per day; ranked list of the biggest savings | TOK-06, 07 | M | T-013 | AC-TOK-06 | not started |
| T-110 | Per-repository privacy rules (which providers and routers a repository may use) | PRIV-02, SEC-05 | M | Q-03 | AC-PRIV-02 | not started |
| T-111 | Write one list of every state and allowed move for runs, tasks, work items and checkpoints, and make the types and the checks agree (including the `failed` run state) | REL-04, STP-04 | M | none | AC-REL-03 | not started |
| T-112 | Audit the agent-suggested command, the review proxy and the tray scripts | SEC-08 | M | none | AC-SEC-03 | not started |
| T-113 | A retention setting for prompts and replies, and a per-run view of which providers saw what | PRIV-01, PRIV-03 | L | D-113 | AC-PRIV-01 | not started |
| T-114 | Bounds and owner notices for every wait; recovery tests for stop-then-restart and restart-during-review | REL-05, REL-07 | M | T-111 | AC-REL-02 | not started |
| T-115 | Gateway health check on the Providers page and a pinned version record | OMR-06, OMR-07 | S | T-108 | AC-OMR-06 | not started |

## v2+

| ID | Task | Label |
|---|---|---|
| T-201 | Predict the effect of a workflow edit on each running task | **[F]** |
| T-202 | Router features beyond a plain gateway | **[F]** |
| T-203 | Several users and permissions | **[F]** |
| T-204 | Hosted service | **[F]** |
| T-205 | Sandboxed agent execution | **[F]** |
| T-206 | Embeddings and code intelligence for context | **[F]** |
| T-207 | More hosted-agent adapters | **[F]** |
| T-208 | Desktop shell | **[F]** |
| T-209 | Whole-run token prediction | **[F]** |

Requirements already met and verified (for example REQ-PRV-05, REQ-REL-03, REQ-STP-06) have no task. They are guarded by the tests named in [product-requirements.md](product-requirements.md). Requirements that are rules for new work (REQ-REL-06, REQ-SEC-06, REQ-SEC-07) have no task of their own. They are enforced by the definition of done in [testing-and-acceptance.md](testing-and-acceptance.md) section 6.

## Rules for this file

- Never reuse an ID.
- Moving a task between levels needs the owner's approval, recorded in [decision-log.md](decision-log.md).
- When a task is done, set its status to done and add the commit and the test name. Do not delete it.
