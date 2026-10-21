# Standard procedures for these documents

How to keep the specifications correct as the project changes. Follow them whether you are the owner, another developer or an AI agent.

Labels are in the [README](README.md).

## SOP-1. Add or change a requirement

1. Find the right area in [product-requirements.md](product-requirements.md). Take the next free ID in that area. Never reuse an ID.
2. Write one sentence. Give it a label: **[C]** only if the owner said it, otherwise **[P]**.
3. Set its level (SOP-3) and its status today.
4. In the same sitting, add: a task in [tasks.md](tasks.md), an acceptance criterion in [testing-and-acceptance.md](testing-and-acceptance.md), and a row in [requirement-reconciliation-matrix.md](requirement-reconciliation-matrix.md) if it traces to an owner idea.
5. If it changes a recorded decision, add an entry to [decision-log.md](decision-log.md) (SOP-5).

## SOP-2. Verify a claim before labelling it [V]

A claim may carry **[V]** only if you checked it yourself.

1. Name the evidence: a file and a function, a test name, or a command and its result.
2. Open the file. Read the lines. Do not rely on memory or on another document.
3. For behavior, run the test or the command. For counts (tests, tables, routes), run the count.
4. Write the date next to a count. Counts go stale.
5. If you could not check it, use **[A]** or **[?]**. Do not soften a [V] into prose without a label.
6. When an older document and the code disagree, the code wins for [V]. Record the difference in the reconciliation matrix. Do not edit the older document without approval (SOP-5).

## SOP-3. Set a v-level

Use the owner's meanings exactly.

| Level | Test |
|---|---|
| v0 | Does the owner want it right now, and is it possible right now? Both must be yes. |
| v1 | Is it needed before the project is a polished product? |
| v2+ | Is it for the future self, or wanted however impossible? |

Rules:
- Do not turn the levels into a release plan or add time estimates.
- If two levels fit, mark the item **class?** and write the doubt in the roadmap. Do not pick quietly.
- The owner can change any level. Record it in the decision log (D-109).
- "Feasible" means judged from the code. If you have not read the code involved, say so.

## SOP-4. Run the interview and bring the results back

1. Paste Part 1, the extra rules and Part 2 from [claude-questioning-agent.md](claude-questioning-agent.md) into a new Claude chat.
2. Answer a few questions at a time. Paste the latest Record at the start of each sitting.
3. At the end, save the Record as `docs/specifications/interview-record.md`.
4. For each confirmed requirement: apply SOP-1 and change its label to **[C]**.
5. For each answered question: update [preliminary-questions.md](preliminary-questions.md) section F (mark answered, add the answer).
6. For each decision: add it to the decision log. For each assumption confirmed or rejected: update it.
7. Re-sort the roadmap if levels changed.
8. Ask the agent to produce the final master specifications. Review them against the existing files. Merge by hand. Do not overwrite older documents.

## SOP-5. Change an older document or a recorded decision

Older documents: `spec/AI-Agent-Office-Spec.md`, `spec/DESIGN-figma.md`, `docs/guide.md`, `PROGRESS.md`, `README.md`, `ABOUT.md`.

1. Get the owner's explicit approval, and record it as a decision.
2. Make the smallest change. Do not delete history.
3. Add a dated note to the matrix section 4 if a document was updated, and remove its row.
4. Never overwrite a whole file.

## SOP-6. Start implementing a task

Preconditions:

1. The owner approved these specifications, or the single requirement.
2. Every open decision the task depends on is settled. See the task's "Depends on".
3. The acceptance criterion exists and is understood.

Steps:

1. Read the area document and the code it names.
2. Write the failing test.
3. Make the smallest change.
4. Run the whole suite, the type check and the UI build. List any known flaky failure as such.
5. Update the task, the requirement status and any document row, with commit and test names.
6. Ask before committing, since the repository holds unrelated uncommitted changes. Stage only your own files.

## SOP-7. Read live data safely

`daemon/data/` is the owner's running instance.

1. Prefer the API on `http://localhost:4780`.
2. If you need the database, make a copy with `VACUUM INTO` while the daemon runs, and read the copy.
3. Never write to it, never open it directly with the daemon running, never copy `secrets.json` anywhere.
4. Never paste data from it into a document without the owner's say. Keys and prompts may be in it.

## SOP-8. Consistency check

Run before calling any change to these documents finished.

- Every requirement in [product-requirements.md](product-requirements.md) has a task and a criterion.
- Every task points to an existing requirement and criterion.
- Every owner idea in [preliminary-questions.md](preliminary-questions.md) section C appears in the matrix.
- Every open question has an ID and appears in section F or in an area document.
- Every decision ID used in a document exists in the decision log.
- Every link resolves.
- Counts carry a date.
- No label was changed without evidence.

## SOP-9. Refresh the verified facts

Do this before a hand-off, before the interview results are merged, and after any large change to the code.

1. Re-run the test suite and the type check. Update the counts and the date in the README and in [testing-and-acceptance.md](testing-and-acceptance.md).
2. Re-check each **[V]** that names a function that may have moved. A quick way: search for the name.
3. Re-check the gaps (P1 in checkpoints, the API cancel gap, the provider gap). A fixed gap becomes a [V] that says it is fixed, with the commit.
4. Re-check the external facts about Omni Router candidates. Update the date.

## SOP-10. Style

- Plain language. A word the owner would not use needs a one-line explanation, or the glossary.
- Short sentences. No filler openers or closers.
- No em dashes.
- State a fact once and link to it.
- Tables for lists of like things. Prose for reasons.
- Never write a number you did not measure.
- Keep personal and secret data out. No keys, no tokens.
