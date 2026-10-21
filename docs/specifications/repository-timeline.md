# Repository timeline

Labels are in the [README](README.md). Requirements: REQ-TML-01 to 03.

**The owner asked for a repository timeline. One already exists and works.** This document records what it does so the next step is a precise decision, not a rebuild. Whether the owner wants something the current one lacks is open (Q-06).

## 1. What exists **[V]**

Sources: `daemon/src/api/history.ts` (route `GET /api/repos/:id/timeline`), `daemon/src/services/repo-watch.ts`, `daemon/src/services/commits.ts`, `ui/src/pages/Timeline.tsx` and `History.tsx`, `docs/guide.md` "Repository timeline", tests in `daemon/tests/repo-timeline.test.js` (5 tests).

### 1.1 What it shows

One list, newest first, grouped by day. Entries come from five sources and are merged by timestamp:

| Source | Entry types |
|---|---|
| Git itself | Commits from every local branch and tag, by anyone (an agent, VS Code, a terminal). Each has branches, tags, merge and HEAD badges, lines added and removed, and the diff on click. Commits the office made keep an **AI** label and link to their task and agents. |
| Checkpoints | General, Agent and Manual checkpoints. Undo, redo and restore operations. |
| Repository activity | Branch switches, amends, resets, branches and tags created or deleted. |
| Engine events | Requests, task started or finished, QA, review and PM decisions, commits made and failed, uncommitted changes found before a task, recovery after a restart, read-only violations, the owner's Human approval decisions with their feedback. |
| The live state (first page only) | Current branch, HEAD, how far ahead or behind the remote, and how many files are uncommitted. |

### 1.2 How it stays current

- The daemon polls every registered repository every 3 seconds, and again when the page opens. **[V]** `POLL_MS = 3000`.
- What it saw last is stored per repository, so commits made while the daemon was off are found at the next start. Up to 50 commits are recorded per detected change. **[V]** `MAX_COMMITS_PER_CHANGE`.
- First sight of a repository records its state without inventing history. **[V]** test 1.

### 1.3 Controls

Search, an author menu, filters (Everything, Commits, AI, You, Checkpoints, Branches and history, Tasks and reviews), a side panel with commits per day (AI against yours) and the branches seen. Two commits or two checkpoints can be compared. A commit can be reverted or re-applied as a new commit after a dry run. History rewrites are shown as they are.

### 1.4 What it does not show **[V]** by reading the event whitelist

The timeline reads a fixed list of event types. These are not on it:

- Stopping an agent, putting a task on hold, a task cancelled by a stop (`workitem.cancelled`).
- Workflow changes (`workflow.adopted`, `workflow.pending`).
- Model or provider switches (`model.switched`) and fallbacks.
- Token and cost totals per task or commit.
- Why a change was made, beyond the task title (the prompt and review record is on a separate page, `GET /api/tasks/:id/record`).

## 2. Requirements

| ID | Requirement | Label | Status |
|---|---|---|---|
| REQ-TML-01 | A timeline shows repository changes and the development history, including changes made outside the app. | **[C]** | Met **[V]** |
| REQ-TML-02 | What the owner finds missing is listed and specified. | **[?]** | Waiting on Q-06 |
| REQ-TML-03 | The timeline stays fast and correct on a large history and with many entries. | **[P]** | Not measured |

## 3. Candidate additions **[P]** (none confirmed)

The owner picks from this list or adds to it. Each is small to medium and uses data that already exists.

| # | Addition | Data already stored | Level |
|---|---|---|---|
| TL-1 | Show stops, holds and cancellations as entries. | events `workitem.cancelled`, `task.status` held | v1 class? |
| TL-2 | Show workflow version changes and when a running request adopted them. | events `workflow.adopted`, `workflow.pending` | v1 class? |
| TL-3 | Show which provider and model produced a change, and any fallback. | events `model.routed`, `model.switched`; `work_items` | v1 |
| TL-4 | Show tokens and cost next to each task and commit. | `usage_records`, `work_items` | v1 |
| TL-5 | A history of one file: every change to it, by whom, in which task. | `repo_checkpoints.files`, git log | v1 |
| TL-6 | Export the timeline (Markdown or JSON) for a date range. | the same query | v2+ class? |
| TL-7 | Link each entry to the task record (request, prompts, reviews). | `GET /api/tasks/:id/record` | v1 |
| TL-8 | A "since I last looked" marker. | the Dashboard already has this idea (`oc:lastVisit`) | v1 class? |

## 4. Open technical questions **[?]**

| # | Question | Why it matters |
|---|---|---|
| TQ-1 | Each source returns its own newest N entries and the results are merged, then cut. Is paging exact when one source is much busier than the others? | A busy source could push quieter entries out of the page. Not tested. |
| TQ-2 | Time stamps from git (commit time) and from the app (ISO strings) are compared as text. Are all formats comparable? | A mixed format would misorder entries. Not checked. |
| TQ-3 | What is the cost on a repository with tens of thousands of commits? | `gitLog` runs with a limit, but `checkRepo` runs on every page load. Not measured. |
| TQ-4 | Repositories not registered in Oficina are not watched. | By design. Say so in the UI. |
| TQ-5 | A rebase that rewrites many commits shows as a rewrite; do all the replaced commits remain findable? | The reflog keeps them. The timeline says so. Not tested. |

## 5. Acceptance

See AC-TML-01 to AC-TML-03 in [testing-and-acceptance.md](testing-and-acceptance.md).
