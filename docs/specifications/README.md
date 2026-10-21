# Oficina master specifications

This folder is the main source of truth for what Oficina is, what it does today, and what the owner wants it to become. It is documentation only. Nothing here changes the application.

Written on 2026-10-21 from the owner's ideas and a review of the repository at commit `27d91de` plus the uncommitted working tree.

## How to read this

Read in this order. Each file covers one area, so you can also read just the one you need.

1. [preliminary-questions.md](preliminary-questions.md): the questions asked before writing specs, answered from evidence where the repo allows it, and the ones only the owner can answer.
2. [claude-questioning-agent.md](claude-questioning-agent.md): the text to paste into the Claude web chatbot so it can interview the owner and finish the specs.
3. [product-requirements.md](product-requirements.md): purpose, goals, scope and every requirement with an ID.
4. [roadmap-v0-v1-v2.md](roadmap-v0-v1-v2.md): all requirements sorted into the owner's own v0, v1 and v2+ buckets.
5. [architecture.md](architecture.md): how the app is built today and what each part is responsible for.
6. [orchestration.md](orchestration.md): workflow execution, changing a workflow while work is running, and task continuity.
7. [agent-lifecycle.md](agent-lifecycle.md): agent states, provider setup, agents with no provider, and stopping.
8. [checkpoints.md](checkpoints.md): how checkpoints work, the suspected problems, and the expected behavior.
9. [repository-timeline.md](repository-timeline.md): the repository timeline as it exists and what is still open.
10. [omni-router-integration.md](omni-router-integration.md): what "Omni Router" could mean, what each option needs, and how it would fit.
11. [token-efficiency.md](token-efficiency.md): what already saves tokens, what is not measured yet, and the targets.
12. [reliability-security-privacy.md](reliability-security-privacy.md): error handling, security rules and privacy.
13. [testing-and-acceptance.md](testing-and-acceptance.md): how each requirement is proven.
14. [dependencies-constraints-decisions.md](dependencies-constraints-decisions.md): dependencies, hard limits, unresolved decisions and future ideas.
15. [tasks.md](tasks.md): the task registry, one row per piece of work, with its v-level.
16. [requirement-reconciliation-matrix.md](requirement-reconciliation-matrix.md): each owner idea traced to what exists today and where it is specified.
17. [decision-log.md](decision-log.md): confirmed decisions, assumptions and rejected options.
18. [sops.md](sops.md): how to keep these documents correct as the project changes.
19. [glossary.md](glossary.md): plain-language definitions.

## The evidence labels

Every statement that matters carries one of these labels, so you can tell a fact from a plan.

| Label | Meaning |
|---|---|
| **[V]** | **Verified current behavior.** Checked in the code or the tests on 2026-10-21. A source file is named. |
| **[C]** | **Confirmed requirement.** The owner said it, or approved it. |
| **[P]** | **Proposed.** A suggested solution. Needs the owner's approval before it counts. |
| **[A]** | **Assumption.** Believed true, not checked. Listed in the decision log. |
| **[F]** | **Future idea.** Wanted someday, no plan. |
| **[?]** | **Open question.** Needs a decision or more information. |

Where a requirement's v-level is uncertain, the document says so. It does not pick one quietly.

## The owner's versioning

These categories keep the owner's meaning. They are not a normal release plan.

| Level | Meaning |
|---|---|
| **v0** | Wanted right now, and possible to do right now. |
| **v1** | Wanted before the project can be called a polished product. |
| **v2+** | Left for the future self, or wanted no matter how impossible it is. |

## Source of truth rules

- These specifications are the main source of truth. Where they disagree with older documents, they win once the owner has confirmed the change. Until then, the older document stands and the difference is listed in the [reconciliation matrix](requirement-reconciliation-matrix.md).
- Older documents are kept as they are: `spec/AI-Agent-Office-Spec.md` (the original design), `spec/DESIGN-figma.md` (the visual design), `docs/guide.md` (the user guide), `PROGRESS.md` (the improvement log), `README.md` and `ABOUT.md`.
- Nothing in this folder may be edited to say something is verified unless it was checked. See [sops.md](sops.md).

## What this folder was modeled on

The structure follows the idea behind the WhiskerFrame specifications: one index with a reading order, one file per area, requirement IDs, a task registry, a reconciliation matrix and a standard-procedures file. The parts that do not fit Oficina were left out, and the content is all Oficina's own. WhiskerFrame is a hardware project, so its display, storage and terminal documents have no counterpart here.

## Current status in one paragraph

Oficina works end to end. 292 daemon tests pass and the type check is clean (2026-10-20). Much of what the owner asked for already exists in some form: live workflow edits, stop controls, checkpoints, a repository timeline and many token savings. What is missing is mostly proof, polish and a few gaps: agents with no provider can still dead-end a task, checkpoint behavior has reported bugs that are not yet reproduced, Omni Router is not integrated and its meaning is not settled, and real token use is not measured with real providers. The owner's own questions are in [preliminary-questions.md](preliminary-questions.md).
