# Checkpoints: creation, recovery and resumption

Labels are in the [README](README.md). Requirements: REQ-CKP-01 to 07.

The owner reports that checkpoints are "buggy". **No specific symptom has been recorded** (Q-05). This document therefore does three things: it states how checkpoints work today, lists the problems found by reading the code (each marked as verified in the code or suspected), and defines the behavior that would count as reliable. Nothing here claims a bug was reproduced.

## 1. How checkpoints work today

**[V]** `daemon/src/services/checkpoints.ts`, `snapshot.ts`, `apply-tree.ts`, `daemon/src/api/history.ts`, `daemon/src/engine/engine.ts` (lines 205 to 245, 941 to 1040), `docs/guide.md` "Checkpoints, undo and redo".

### 1.1 Kinds

| Kind | Covers | Made by |
|---|---|---|
| General | The whole result of a task: all its agents. | The engine, when a task first holds the repository. |
| Agent | One work item of one agent, inside a task. Its parent is the task's General checkpoint. | The engine, around each writing work item. |
| Manual | A save point of the working tree. | The owner (Checkpoints, Save), and automatically before a restore. |

### 1.2 What a snapshot is

A git tree object of the working tree (tracked, untracked and deleted files; not ignored files). It is built in a private index and pinned under `refs/officechain/cp/<id>/<before|after>`. The owner's index, branch and stash are never touched. Files git cannot index and very large untracked files are recorded as skipped and never changed by undo or restore.

### 1.3 Creation

1. `beginCheckpoint` takes a "before" snapshot and proves it: the tree must read back from git and the pinned ref must resolve to the same tree. One retry from a fresh index. If it still fails, no checkpoint is made and an error is raised. It also records HEAD, the branch, the file count and the skipped files.
2. When the work ends, `endCheckpoint` takes the "after" snapshot the same way and records the changed files.
3. If the "after" snapshot cannot be proven, the checkpoint is set to `interrupted` with no after-state, an event `checkpoint.error` is raised, and the repository is released.

### 1.4 States

`open` (work running), `applied` (its changes are in the tree), `undone`, `interrupted` (closed by a crash, a failure to record, or a stop).

### 1.5 Undo, redo and restore

A dry run plans every file as `replace`, `merge`, `blocked` or `already done`. If anything is blocked, nothing changes, unless the owner chooses "safe files only". Every write keeps a backup and is read back. A failed step puts every file back. Restore first saves the current state as a Manual checkpoint. Undo and redo are refused while any checkpoint in the repository is open. Undoing a task takes its agents' checkpoints with it. Undoing one agent leaves the rest.

### 1.6 Recovery after a crash

At boot, `recoverInterruptedCheckpoints` closes every open checkpoint by snapshotting the working tree **as it is at that moment** and marking it `interrupted`. An interrupted checkpoint with an after-state can still be undone. **[V]** test `checkpoints.test.js` line 173.

### 1.7 What the tests cover **[V]**

20 tests across `checkpoints.test.js` and `checkpoints-robust.test.js`: general and agent undo, overlapping edits, redo after later edits, multiple tasks, manual restore, folders created and removed, merge of nearby edits, binary and deleted files, failed writes rolling back, restore guard, proven snapshots, crash recovery, unindexable files, a failed after-snapshot.

## 2. Problems found by reading the code

Not one of these was reproduced. Each says how sure the finding is.

| # | Finding | Sure? | Effect | Requirement |
|---|---|---|---|---|
| P1 | **Retention is never run.** `pruneCheckpoints` is exported and documented ("the newest 500 per repository") but no code and no test calls it. | **[V]** a search of `daemon/src`, `daemon/tests` and `ui/src` found no call. | Checkpoints and their pinned git refs grow without limit. The documentation says otherwise. | CKP-06 |
| P2 | **If retention were wired in as written**, it would delete by count only. It ignores kind and parent, so it could delete the owner's Manual save points and leave an Agent checkpoint without its parent or the reverse. | **[V]** `pruneCheckpoints` query and delete. | Silent loss of save points, broken links. | CKP-06 |
| P3 | **A task can have several General checkpoints.** After it is stopped, held, blocked or waits on the owner, its checkpoint is closed. The next dispatch opens a new "Resumed:" one and the task now points to the newest. | **[V]** `openTaskCheckpoint`, `closeTaskCheckpoint`, `taskCheckpoint`. | "Undo the last task" (`lastUndoable`) undoes only the newest segment, not the whole task. The task diff spans first "before" to last "after", so the board and the undo can disagree. | CKP-04 |
| P4 | **Crash recovery attributes whatever is on disk to the task.** The "after" snapshot is taken at restart. Edits the owner made while the daemon was down become part of the interrupted task's changes. | **[V]** `recoverInterruptedCheckpoints`. | A later undo of that task reverts the owner's own edits, or is blocked by them. | CKP-03 |
| P5 | **Owner edits made during a task are part of its snapshots.** In direct mode the whole tree is snapshotted. The code records the files the owner had changed before the task (`dirtyAtStart`) and keeps them out of commits, but the checkpoint "after" includes later owner edits. | **[?]** suspected from the design; the tests cover edits before and after, not during. | Undo of a task may revert an edit the owner made while it ran, or conflict with it. | CKP-03 |
| P6 | **"Last undoable" can offer an undo that is then refused.** It selects General checkpoints in `applied` or `interrupted`. An `interrupted` checkpoint whose after-state could not be recorded has no after-tree, and the plan denies it. | **[V]** `lastUndoable` and `plan`. | The Undo button appears and then fails with "the state after this work could not be recorded". | CKP-04 |
| P7 | **Undo is refused while any checkpoint in the repository is open**, even one that belongs to a task on hold or waiting for the owner, if it is still open. | **[?]** a held or waiting task closes its checkpoint, so this should be rare. Not tested. | An owner told to "pause the run first" when nothing is running. | CKP-04 |
| P8 | **Ignored files are not covered.** A change an agent makes to an ignored file (for example `.env` or build output) is not in any snapshot. | **[V]** documented in the guide. | Not a bug, but a limit the owner may not expect after "undo". | CKP-07 |
| P9 | **The stopped-agent path closes the task checkpoint with whatever is in the tree.** A stopped CLI may have left a half-written file. | **[V]** `stopAgent` calls `closeTaskCheckpoint`. | The checkpoint is "applied" with a partial result. Correct, but the label does not say "stopped". | CKP-05 |
| P10 | **The "files" filter** searches the stored JSON text with LIKE. | **[V]** `listCheckpoints`. | May match unintended paths. Minor. | none |
| P11 | **No test crosses these paths**: stop then resume then undo; crash then owner edit then undo; retention. | **[V]** from the test list. | The suspects above have no safety net. | CKP-02 |

## 3. Expected behavior (the definition of "reliable")

### 3.1 Creation

- A checkpoint exists only if its snapshot is proven readable. (Already true, REQ-CKP-01.)
- Every checkpoint says what it was taken against (branch, commit) and what it could not hold. (Already true.)
- A stopped, held or crashed task's checkpoint says so in its label and reason, so the owner knows the result is partial. **[P]**

### 3.2 Recovery

- After a crash, an open checkpoint is closed as `interrupted`. The after-state must be the working tree **limited to the files the task touched**, or the checkpoint must record the full tree and state plainly that owner edits may be included. **[P]** The choice is an open decision (D-104 in [decision-log.md](decision-log.md)).
- The owner is told, in the timeline and on the task, that recovery happened and what was recorded.
- No checkpoint stays `open` for more than a bounded time without a live process behind it. **[P]**

### 3.3 Resumption

"Resume" has to be defined before it is built. Proposed meaning **[P]**:

1. Resuming a task after a stop, a hold, a crash or an owner wait continues from the working tree as it is now.
2. The task keeps **one** logical General checkpoint. Segments are linked in order and shown as one entry with parts. Undo of the task undoes every part, newest first, with one dry run covering all of them.
3. Before resuming, the dry run tells the owner what changed since the task stopped (files edited by the owner or by other tasks).
4. If the owner's edits overlap the task's, the owner chooses: resume anyway, resume from the checkpoint state (restore), or leave it on hold.

**[?]** Q-05 and Q-10 decide whether this is wanted.

### 3.4 Undo, redo, restore

- Undo, redo and restore never lose the owner's edits. (Already true for edits made before or after a task.)
- "Undo" offered in the UI never fails for a reason known in advance. The Undo button appears only if a dry run would be allowed. **[P]**
- Refusal messages name the files and the fix.

### 3.5 Retention

- Retention runs on a schedule and after each task. **[P]**
- It never deletes a Manual checkpoint, never deletes an open one, and never splits a General checkpoint from its Agent children. It removes whole groups, oldest first.
- The limit is visible and set by the owner (default 500 per repository, as documented). **[P]** value to confirm.
- Deleting a checkpoint also deletes its pinned refs and its operation log. (The code does.) Git's own garbage collection may then free the objects.

### 3.6 Observability

- Each checkpoint operation is an event in the log. (Already true.)
- The checkpoint list shows kind, status, reason, file count, skipped files and whether it is part of a resumed task. **[P]**

## 4. Reproduction plan (no code yet)

When implementation is approved, each finding gets a failing test first.

| Finding | Test idea |
|---|---|
| P1 | Create 510 checkpoints. Assert the count after the retention step is at most 500. Today the test fails. |
| P2 | Same, with a Manual checkpoint older than the rest. Assert it survives. Assert no Agent checkpoint loses its parent. |
| P3 | Run a task. Stop its agent. Resume. Finish. Assert "undo the task" restores the pre-task state in one operation. |
| P4 | Make an open checkpoint. Edit an unrelated file. Run recovery. Assert the edit is not part of the checkpoint (or is flagged). |
| P5 | Start a task. Edit an unrelated file by hand mid-task. Finish. Undo the task. Assert the hand edit is untouched. |
| P6 | Make an interrupted checkpoint with no after-state. Assert the Undo offer does not appear. |
| P7 | Hold a task with an open checkpoint. Assert undo of another checkpoint is allowed or refused with an accurate message. |
| P9 | Stop an agent mid-write. Assert the checkpoint label says stopped. |

## 5. Acceptance

See AC-CKP-01 to AC-CKP-07 in [testing-and-acceptance.md](testing-and-acceptance.md).
