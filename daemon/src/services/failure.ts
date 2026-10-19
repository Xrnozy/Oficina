import { q1 } from '../db.ts';
import { requestApproval } from './policy.ts';

// Failure classification (spec stage 4): every work-item failure lands in one
// of three classes and each class has one policy —
//   transient     rate limit / network / timeout / CLI crash → back off with
//                 jitter, retry, then fail over to the next routing option.
//   model-quality invalid or empty output → one repair retry (engine), then
//                 escalate to a stronger tier.
//   fatal         auth, missing CLI, repo conflict → pause the run and raise
//                 exactly one "Needs you" item with the concrete fix.

export type FailureClass = 'transient' | 'model-quality' | 'fatal';

const FATAL = [
  /\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid api.?key|api.?key (missing|invalid|expired)|permission denied|login required|not logged in|authentication/i,
  /not installed|enoent|cannot find|no such file|spawn \S+ failed|missing cli|command not found|executable .* not found/i,
  /repo.?conflict|checkout failed|worktree .*missing|not a git repo|dubious ownership/i,
  // engine-side misuse (bad argument, null path) is deterministic — retrying
  // can only loop, so it surfaces as fatal with a Needs-you, not a backoff
  /\bmust be of type\b|argument must be|cannot read propert|is not a function|received (null|undefined)\b/i,
];
const MODEL_QUALITY = [
  /^bad-response/i, /invalid (output|json|reply)|unparseable|failed validation|empty (output|reply|response)|malformed/i,
];
const TRANSIENT = [
  /rate.?limit|quota|overload|\b429\b|\b5\d\d\b|server/i,
  /timeout|timed? ?out|econnreset|etimedout|econnrefused|network|socket|dns|fetch failed/i,
  /cli (crash|exit)|exit(ed|ing)? (code|with) -|killed|sigterm|sigkill|no output from the agent/i,
];

export function classifyFailure(msg: string): FailureClass {
  if (FATAL.some((re) => re.test(msg))) return 'fatal';
  if (MODEL_QUALITY.some((re) => re.test(msg))) return 'model-quality';
  if (TRANSIENT.some((re) => re.test(msg))) return 'transient';
  // an unknown error is safest as transient: it may simply recur; bounded
  // attempts stop a loop, and the PM diagnosis step decides what happens next
  return 'transient';
}

// Exponential backoff with jitter: 2s, 4s, 8s… capped at a minute, plus a
// random 0–50% so several waiting tasks do not retry in lockstep.
export function backoffDelayMs(attempt: number): number {
  const base = Math.min(60_000, 2000 * 2 ** Math.max(0, attempt - 1));
  return base + Math.floor(Math.random() * base * 0.5);
}

// The concrete fix line for the "Needs you" item — one sentence, actionable.
export function fixHintFor(msg: string): string {
  const m = msg.toLowerCase();
  if (/api.?key|unauthori[sz]ed|\b401\b|authentication|login required|not logged in/.test(m))
    return 'Check the provider account: the API key is missing, invalid or expired — set it under Providers, then resume the run.';
  if (/permission denied|\b403\b|forbidden/.test(m))
    return 'The provider refused access — check the account plan/permissions under Providers, then resume the run.';
  if (/enoent|not installed|missing cli|command not found|executable .* not found|cannot find/.test(m))
    return 'The agent CLI is not installed or not on PATH — install it or fix the command under Providers → CLI, then resume the run.';
  if (/repo.?conflict|checkout failed|worktree|not a git repo|dubious ownership/.test(m))
    return 'The repository is in a state the office cannot use — resolve the conflict/ownership issue in the repo, then resume the run.';
  return 'Fix the cause shown, then resume the run.';
}

// Raise a single Needs-you item per (run, action, task) — repeated failures
// of the same task must not spam the inbox, but a different task failing
// still gets its own item.
export function notifyOnce(runId: string | null, action: string, taskId: string | null, summary: string, extra: Record<string, unknown> = {}): boolean {
  const dup = q1(`SELECT id FROM approvals WHERE run_id IS ? AND action = ? AND task_id IS ? AND status = 'pending'`, runId, action, taskId);
  if (dup) return false;
  requestApproval({ action, taskId, runId, requestedBy: 'engine', payload: { summary, ...extra } });
  return true;
}
