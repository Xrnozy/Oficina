# Roadmap in the owner's v0, v1 and v2+ buckets

This is not a release plan. It sorts every requirement by the owner's own meaning.

| Level | Owner's meaning |
|---|---|
| **v0** | Wanted right now, and possible to do right now. |
| **v1** | Wanted before the project can be called a polished product. |
| **v2+** | Left for the future self, or wanted no matter how impossible. |

## How items were sorted

Each item was judged on four things: how urgent it is, how feasible it is with what exists, how much a polished product needs it, and how far-off the ambition is. **Every placement below is proposed.** The owner has not confirmed any of them. Where the level could reasonably be another one, the item is marked **class?** and the doubt is written next to it. Nothing was placed arbitrarily to make the list look tidy.

Feasibility was judged from the code. "Exists" means a verified feature, with the evidence in [product-requirements.md](product-requirements.md).

## v0: right now, and possible right now

| Item | Requirement | Why v0 | Doubt |
|---|---|---|---|
| Handle agents with no provider (report early, fall back, pause only that task) | REQ-PRV-01, 02 (warn), 03 | Owner asked. The cause is found. The fix touches one decision point and the validator. | None. |
| Finish and prove the stop controls: commit the per-agent stop, test it against a live CLI agent | REQ-STP-01, 04, 05 | Owner asked. Most of it is written. | Whether "prove" needs a live provider run, which costs tokens. |
| Make API agents cancellable on stop | REQ-STP-03, 07 | Spending tokens after a stop is the opposite of the goal. The change is small and local. | **class?** v0 or v1. Depends on how often the owner uses API agents (Q-04). |
| Write down and reproduce the checkpoint bugs | REQ-CKP-02 | Owner says it is buggy. Nothing can be fixed before the symptoms are known. | The fixes themselves may be v0 or v1 depending on what is found. |
| Settle the retention and "undo task" findings | REQ-CKP-04, 06 | Cheap to confirm with a test. Retention is documented but never runs, so checkpoints and git refs grow forever; wiring it in carelessly could delete manual save points. | **class?** Could be v1 if no real bug shows up. |
| Rules for every live workflow edit situation | REQ-WFL-03 | The owner asked for rerouting. The basic case works. The unclear cases are where tasks get stuck. | **class?** The full set of rules may be v1. The two cases coded today are v0. |
| Decide which Omni Router | REQ-OMR-01 | A decision, not work. Everything else depends on it. | None. |
| Decide a token target and measure real token use | REQ-TOK-01, 02, 05 | Without numbers the goal cannot be tested. A baseline is a few real runs. | The measurement spends real tokens. |
| Keep the documents consistent | REQ-DOC-01 to 03 | Owner asked. | None. |
| Commit the work already done (review panel, stop, effort settings) | task registry | It exists and passes tests. | The repo has many unrelated uncommitted changes, so the owner must choose what to include. |

## v1: before it is a polished product

| Item | Requirement | Why v1 | Doubt |
|---|---|---|---|
| Show which agents cannot work and why | REQ-PRV-04 | Polish. The data exists. | None. |
| Block saving or activating a workflow that cannot run | REQ-PRV-02 (prevent) | A stricter rule than a warning. | **class?** Could be v0 if the warning proves too easy to ignore. |
| Impact preview before a live workflow edit | REQ-WFL-04 | Polish. The engine can already list blockers. | Needs design. |
| Checkpoints record only the task's own work after a crash | REQ-CKP-03 | Correct, but a deep change to how recovery attributes edits. | **class?** v0 if reproduced as a real data problem. |
| Clear "resume from checkpoint" | REQ-CKP-05 | Polish on top of what exists. | None. |
| Timeline additions the owner asks for | REQ-TML-02, 03 | A timeline exists, so the rest is polish. | Waiting on Q-06. |
| Omni Router as an optional backend with fallback and per-repository consent | REQ-OMR-02 to 05 | A real feature, not urgent. | **class?** v0 if the owner already runs a gateway today. |
| Token view per run and per day; weakest-point analysis | REQ-TOK-06, 07 | Needs data from the v0 baseline first. | Depends on the v0 measurement. |
| Per-repository privacy rules and a retention setting | REQ-PRIV-01 to 03, REQ-SEC-05 | Polish for trust. | Waiting on Q-03. **class?** the retention setting could be v2+ if the owner is the only user. |
| One list of states and moves; bounds on every wait; recovery tests | REQ-REL-04, 05, 07 | Makes the stop and checkpoint fixes provable. | **class?** REL-05 could be v0 if stuck waits are common. |
| Audit of the agent-suggested command, the review proxy and the tray scripts | REQ-SEC-08 | New code that runs commands deserves a second look. | None. |
| Gateway health check and pinned version | REQ-OMR-06, 07 | Part of the Omni Router build. | Depends on the Omni Router decision. |

## v2+: for the future self, or no matter how impossible

| Item | Label | Note |
|---|---|---|
| Rerouting that predicts the impact of a workflow edit on each running task before it happens | **[F]** | Needs a way to simulate tasks. A dry run for workflows already exists, which is a start. |
| Omni Router features beyond a plain gateway: learned routing, budget-aware routing, tool routing | **[F]** | Only if the owner picks a project that has them. |
| Several human users and permissions | **[F]** | The design assumes one owner. |
| Run Oficina as a hosted service | **[F]** | Conflicts with "stays on your computer". |
| Sandboxed execution for agents | **[F]** | Listed as scaffolded in `docs/guide.md`. |
| Embeddings and code intelligence for context packs | **[F]** | Listed as scaffolded. Would cut tokens further. |
| Hosted-agent adapters beyond Devin | **[F]** | In the original spec. |
| A desktop shell instead of a browser UI | **[F]** | Listed as scaffolded (Tauri). |
| Agents that never need the owner to fix anything | **[F]** | The "impossible" bucket the owner described. Recorded so it is not lost. |
| Token use predicted before a run starts | **[F]** | An estimate exists per kind; a prediction for a whole run does not. |

## Uncertainty summary

| Item | Could be | Reason |
|---|---|---|
| API-agent cancel | v0 or v1 | Depends on how much the owner uses API agents. |
| Checkpoint fixes | v0 or v1 | Symptoms unknown. |
| Live-edit rules | v0 or v1 | Only two situations are coded. |
| Omni Router | v0 or v1 | Depends on whether a gateway is already in use. |
| Block saving a workflow with no-provider agents | v0 or v1 | A warning may be enough. |
