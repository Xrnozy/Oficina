# Decision log

The record of what is decided, what is assumed, and what was turned down. Entries are never deleted. A changed decision gets a new entry that points to the old one.

Labels are in the [README](README.md).

## 1. Confirmed decisions (the owner decided)

| ID | Decision | Date | Source |
|---|---|---|---|
| D-001 | The specification work is documentation only. No code, no source changes, no features. | 2026-10-21 | The owner's request |
| D-002 | Requirements are sorted with the owner's own v0, v1 and v2+ meanings, not a normal release plan. Uncertain placement is documented, not decided arbitrarily. | 2026-10-21 | The owner's request |
| D-003 | Existing documents and specification files are preserved. Nothing is overwritten or deleted. Existing project decisions stand unless the owner approves a change. | 2026-10-21 | The owner's request |
| D-004 | These specifications become the main source of truth. Verified behavior, confirmed requirements, proposals, assumptions and future plans are always told apart. | 2026-10-21 | The owner's request |
| D-005 | A questioning agent in the Claude web chatbot interviews the owner before the master specifications are finalized. Questions already answered by the evidence are not asked again. | 2026-10-21 | The owner's request |
| D-006 | The WhiskerFrame specifications are an inspiration for organization, not a template to copy. | 2026-10-21 | The owner's request |
| D-007 | `daemon/data/` is the owner's live instance. It is read only through the API or a `VACUUM INTO` copy. | earlier session | The owner's standing rule |
| D-008 | The `request-intake` "iterations keep…" test is a known flaky test, not a regression. | earlier session | The owner's standing note |
| D-009 | A private copy of the project exists at `Xrnozy/oficina-private` (created 2026-10-21 from the working tree). | 2026-10-21 | The owner ran the creation; the push was done on request |

## 2. Open decisions (need the owner)

See [dependencies-constraints-decisions.md](dependencies-constraints-decisions.md) section 4 for the table with defaults. In short:

D-101 which Omni Router; D-102 a token target; D-103 no-provider behavior; D-104 crash-recovery attribution; D-105 live-edit rules; D-106 what a stop does to a task; D-107 checkpoint retention; D-108 gateway against the original spec's "no intermediary" rule; D-109 the v-levels; D-110 what to commit; D-111 timeline additions; D-112 per-task workflow pinning; D-113 prompt retention.

## 3. Assumptions

Each is believed, not checked. Each says what would confirm it.

| ID | Assumption | Would be confirmed by |
|---|---|---|
| A-001 | "Omni Router" means OmniRoute, the self-hosted gateway. | The owner (Q-07). |
| A-002 | Oficina has one human user, the owner. | The owner (Q-03). |
| A-003 | Windows 11 is the main platform. | The owner. The launchers and fixes point to it. |
| A-004 | Oficina sends no telemetry. | A code audit (REQ-SEC-08). None was found in the files read. |
| A-005 | Unencrypted local data (`daemon/data/`) is acceptable. | The owner. |
| A-006 | Facts about OmniRoute, OmniRouter and Lemonade are accurate as of 2026-10-21 and will change. | Re-checking on a pinned version. |
| A-007 | The checkpoint problems the owner saw are among those in [checkpoints.md](checkpoints.md) section 2. | The owner's symptoms (Q-05). |
| A-008 | The owner wants the review panel kept as built. | The owner. It is uncommitted. |
| A-009 | All findings marked [V] still hold at the commit named in the README, plus the working tree on 2026-10-21. | Re-running the checks in [sops.md](sops.md). |

## 4. Rejected options

| ID | Option | Reason |
|---|---|---|
| X-001 | Copy WhiskerFrame's documents as they are. | Owner's instruction (D-006). Its subject is hardware. |
| X-002 | Overwrite or merge `spec/AI-Agent-Office-Spec.md`, `docs/guide.md` or `PROGRESS.md`. | Owner's instruction (D-003). |
| X-003 | Put the classification of uncertain items to a vote by picking one level. | Owner's instruction (D-002). They are marked **class?**. |
| X-004 | Change code while writing the specifications. | Owner's instruction (D-001). |

## 5. Changes to earlier project decisions that are proposed, not approved

| Earlier decision | Where | Proposed change | Needs |
|---|---|---|---|
| "No intermediary proxy, telemetry or third-party router" | `spec/AI-Agent-Office-Spec.md` 8.4 | Allow a local gateway as an optional backend with per-repository consent | D-108 |
| Retention "newest 500 per repository" is documented | `docs/guide.md` | Make it true, and protect Manual checkpoints | D-107 |
| "Stop" puts a task on hold | the new `stopAgent` | Let the owner choose hold, hand over or cancel | D-106 |

## 6. How to add an entry

1. Pick the next free ID in the right section.
2. Write the decision in one sentence, the date, and who decided.
3. If it changes an older entry, add the new one and mark the old one "replaced by D-xxx". Do not delete it.
4. Update any requirement, task or document the decision touches, in the same sitting.
