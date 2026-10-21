# Token efficiency and resource management

Labels are in the [README](README.md). Requirements: REQ-TOK-01 to 07.

Token efficiency is a project goal: **fewer model calls, less repeated context, less repeated work, and no loss in output quality or reliability.** The last part is a condition, not a wish. A change that saves tokens but lowers the pass rate is a regression.

## 1. What "efficient" has to mean

The owner has not given numbers (Q-08). Until they do, these measures are **proposed** so the goal can be tested.

| Measure | Definition | Why |
|---|---|---|
| Tokens per accepted task | Input plus output tokens of every work item on a task that ended accepted. | The headline number. |
| Cost per run | Money spent, with the source of each price labelled. | What the owner pays. |
| Calls per accepted task | Work items that reached a model. | A call has fixed overhead. |
| Wasted share | Tokens in items that were cancelled, failed, superseded or discarded, divided by all tokens. | Shows spend that bought nothing. |
| Repeated-context share | Characters sent more than once in the same task, divided by all characters sent. | Shows duplicated context. |
| Cache hit rate | Work items answered from the result cache. | A hit costs no call. |
| Retries per task | Attempts beyond the first. | Retries are where tokens leak. |
| Quality gate | The fixed benchmark scenario still ends with every Definition-of-Done item passing and the same count of failures caught. | Savings must not lower quality. |

**[?]** A target is needed for at least one of the first two. Q-08.

## 2. What already saves tokens **[V]**

Source: `PROGRESS.md` stages 1 to 6, `docs/guide.md` "State of the implementation".

| Mechanism | How it saves | Source |
|---|---|---|
| Stable prompt prefix | The role, goal, task brief and contract come first and stay identical, so providers with prompt caching can reuse them. Changing content follows. | `engine/prompts.ts` |
| Budgeted prompts | Each prompt has a character budget. Over budget, parts are dropped in a fixed order: skills, repo summary, file excerpts, team inbox, errors, then the rest is trimmed. What was dropped is recorded. | `prompts.ts`, `db.ts` `prompt_versions.dropped` |
| Task-scoped context | The repository tour and README go only to planning, drafting and implementing. QA, review, fix and analysis get the task's changed files and the capped diff. | `services/context.ts` |
| Capped diffs and logs | Diffs cut at file boundaries with a note of what was omitted. Logs keep the first failure and the tail, with repeated lines collapsed. | `util.ts` `capDiff`, `compactLog` |
| Typed hand-offs | The next agent gets a short envelope (at most 400 characters of summary, files, checks, open questions) instead of the previous full answer. | `services/handoffs.ts` |
| Messages delivered once | Each broadcast reaches an agent at most once. Near-duplicate messages are dropped. | `services/messages.ts` |
| Result cache | A work item with the same kind, prompt, context and model reuses the earlier result with no call. | `work_items.cache_key`, `engine.ts` |
| One CLI session per workflow node | The agent keeps its understanding of the project across tasks instead of starting over. | `services/cli-sessions.ts` |
| Tiered routing | Cheaper models for easy work. Plan-billed accounts before metered ones. Risky work is never put on the lightest tier. | `services/routing.ts` |
| Reasoning effort follows tier | `auto` sets low, medium or high from the tier (API backends). For Claude Code the owner can now set it directly. | `services/models.ts`, `adapters/cli-resolve.ts` (uncommitted) |
| Repair instead of redo | A malformed reply gets one short repair call containing only the error and the bad output. | `engine.ts` `repairReply` |
| Read-only lane | Prompt drafting for the next task overlaps with the current writer, so the run is not idle. This saves time more than tokens. | `engine.ts` |
| Per-repo lessons | At most three short lessons (about 300 tokens) are added to implement and fix prompts, so known mistakes are not repeated. | `services/errors.ts` |
| Ceilings that pause | Run, task and time ceilings pause the work and ask. They never kill it. | `engine.ts` |
| Token report | Per work-item kind: calls, prompt characters, reported tokens, average per call, cost, top five items, and cache savings. | `services/usage.ts`, Dashboard panel |

## 3. What has been measured, and what has not

**Measured [V]** (scripted agents only, from `PROGRESS.md`):

- Stage 1 baseline: about 55,965 prompt characters for a two-task run. The prompt-review stage was the largest (11,828 characters, 4 calls).
- Stage 2: for a one-task run, review prompts fell 42 percent and fix prompts 7.6 percent. The structural win was that later stages stopped repeating the repository tour.
- Stage 7 benchmark: 23 work items, 310 events, all 6 Definition-of-Done items pass, finished in 27 seconds.
- Stage 9: a repository tour fell from 5,736 to 1,446 characters on one real repository and from 2,674 to 1,090 on another.

**Not measured [V]:**

- Real token use with real providers. The scripted adapter reports zero tokens, so every baseline used prompt characters. Characters are not tokens, and cached tokens, output tokens and CLI-side reading are not counted.
- The cost of work done inside a CLI agent (what the CLI reads on its own).
- The wasted share and the repeated-context share, which the report does not compute.
- Day-level totals.

**Evidence from the live database, read-only, recorded in `PROGRESS.md` stage 9:** one run that cycled five times used 1.94 million of the 2.48 million prompt characters in the whole history. That run had only file-exists gates and no runnable checks. This points to repeated cycles as the largest known waste. **[?]** one run is one data point.

## 4. Where tokens can still leak

Each row is a place to examine. Some are **[V]** from the code, others are **[?]** hypotheses to test with data.

| # | Leak | Evidence | Fix direction |
|---|---|---|---|
| W1 | An API call cannot be cancelled. A stop discards the reply but the call finishes and is billed. | **[V]** `llm.ts` has only a timeout signal. | REQ-STP-03. |
| W2 | A work item that fails after finishing the model call is retried from scratch. | **[?]** | Keep the reply and retry only the step after it. |
| W3 | Fallback after a failure repeats the full prompt on the next backend. | **[V]** by design. | Acceptable. Count it as waste when the first call was billed. |
| W4 | A task that cannot run (no provider, no checks) still spends calls before it is found. | **[V]** found at dispatch, not earlier. | Preflight checks (REQ-PRV-02). |
| W5 | Plans that cycle (re-plan, rework, re-plan). | **[V]** one live run, see section 3. | Cycle limits exist (30 cycles, 3 no-progress). Check whether the default suits the owner. |
| W6 | The human approval loop. Each rejection sends the task back through the developer and a fresh review (up to 3 loops by default). | **[V]** workflow design. | The review report call repeats each round. Consider reusing unchanged parts of it. |
| W7 | Prompt drafting and PM review for small tasks. | **[V]** the largest stage in the stage 1 baseline. | Modes already exist (`handoffs`, `off`). Measure which the owner uses. |
| W8 | CLI agents re-read the repository themselves. | **[?]** | Session reuse helps. Measure with real runs. |
| W9 | Request analysis (intake) passes. | **[V]** the owner can iterate without limit. | Show the owner the count and cost per pass. |
| W10 | Reviews of small, safe diffs use the same model as large ones. | **[?]** the original spec proposes a lightweight review for small diffs with green checks. Not verified as built. | Verify. If absent, a candidate. |
| W11 | Full test suite after every small change. | **[?]** the original spec proposes impact-based test selection. Not verified as built. | Verify. Saves time more than tokens. |

## 5. Rules proposed for resource management **[P]**

1. **Do not spend where it cannot succeed.** Check readiness (provider, checks, repository state) before the first call of a task.
2. **Count before you send.** Estimate each prompt, warn above a size, and always record the real figure.
3. **Reuse before you call.** Cache first, then envelope, then call.
4. **Stop means stop.** A stop frees the agent and cancels the request.
5. **Small first.** Use the lowest tier that meets the risk floor. Raise it only on failure.
6. **One repair, one escalation.** Then ask the owner.
7. **Limits pause, never kill.** Per-run and per-day limits stop new calls, keep work, and ask.
8. **Show the owner.** A per-run and per-day view of tokens, cost, waste and cache savings.
9. **Never trade quality for tokens silently.** Every saving is checked against the benchmark.

## 6. Measurement plan **[P]**

1. Decide the target (Q-08, task T-012).
2. Run three real runs of different size on a real repository with the owner's real providers. Do not touch the live database `daemon/data/` directly: work from a copy made with `VACUUM INTO`, or read through the API. **[V]** the owner's rule.
3. For each run record the measures in section 1 per stage, from `GET /api/runs/:id/token-report` plus a new waste and repeated-context calculation.
4. Rank the leaks in section 4 by tokens spent.
5. Fix the top one, run the benchmark, and compare. Repeat.
6. Keep every baseline and result in a dated file under `docs/specifications/measurements/` (new folder, created when the first one exists).

## 7. Resource limits that exist today **[V]**

Run budget, per-task budget, wall-clock limit (2,880 minutes by default), cycle limit (30), no-progress limit (3 cycles), same-error attempts (3), a stuck-agent timeout (10 minutes for API agents, 45 for hosted ones), an optional per-task time limit, a monthly account budget, quota windows with a circuit breaker, and an idle timeout for streaming CLIs (300 seconds). **[V]** `engine.ts` `DEFAULT_LIMITS`, `PROGRESS.md` stages 4 and 8.

## 8. Acceptance

See AC-TOK-01 to AC-TOK-07 in [testing-and-acceptance.md](testing-and-acceptance.md).
