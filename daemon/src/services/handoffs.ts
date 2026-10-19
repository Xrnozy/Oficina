import { q, q1, run } from '../db.ts';
import { emit } from '../bus.ts';
import { now, parseJson, ulid } from '../util.ts';
import type { Task, WorkItemKind } from '../types.ts';

// Typed hand-off envelopes (stage 3): the engine — not the model — writes one
// envelope on each stage transition and stores it in the handoffs table. The
// next agent's prompt gets the envelope instead of the previous agent's full
// output; full output stays in the UI and is attached only when the recipient
// needs it (a fixer gets the findings, a reviewer after a failed QA gets the
// report).

export interface HandoffEnvelope {
  fromRole: string; toRole: string; taskId: string; status: string;
  summary: string; filesChanged: string[]; checksRun: string[];
  openQuestions: string[]; decisions: string[]; blockers: string[];
}

const KIND_ROLE: Partial<Record<WorkItemKind, string>> = {
  plan: 'pm', prompt: 'prompt-creator', 'prompt-review': 'pm', accept: 'pm',
  review: 'reviewer', analyse: 'analyst', qa: 'qa', doc: 'docs',
};

// Build the envelope for the transition into `toRole`, persist it as a
// handoffs row and emit it as an event. `opts.blockers` carries the reason a
// fix/review was sent (check failures, reviewer notes).
export function handoffEnvelope(task: Task, toRole: string, opts: { blockers?: string[] } = {}): HandoffEnvelope {
  const last = q1(`SELECT * FROM work_items WHERE task_id = ? AND status = 'delivered' AND result IS NOT NULL
                   ORDER BY finished_at DESC LIMIT 1`, task.id);
  const res = parseJson<{ summary?: string; filesChanged?: string[] }>(last?.result as string, {});
  const checks = q(`SELECT c.name, cr.status FROM check_runs cr JOIN checks c ON c.id = cr.check_id
                    WHERE cr.task_id = ? ORDER BY cr.created_at DESC LIMIT 8`, task.id)
    .map((r) => `${r.name} ${r.status}`);
  const msgs = q(`SELECT kind, text FROM agent_messages WHERE task_id = ? AND kind IN ('question','decision')
                  ORDER BY created_at DESC LIMIT 8`, task.id);
  const blockers = [...(opts.blockers ?? []),
    ...q(`SELECT title FROM error_reports WHERE task_id = ? AND status NOT IN ('resolved','wontfix') LIMIT 4`, task.id)
      .map((r) => r.title as string)].slice(0, 6);

  const env: HandoffEnvelope = {
    fromRole: last ? (KIND_ROLE[last.kind as WorkItemKind] ?? (task.type === 'docs' ? 'docs' : 'developer')) : 'pm',
    toRole, taskId: task.id,
    status: String(last?.kind ?? task.status),
    summary: String(res.summary ?? '').slice(0, 400),
    filesChanged: (res.filesChanged ?? []).filter((f) => f !== 'HANDOFF.md').slice(0, 30),
    checksRun: checks,
    openQuestions: msgs.filter((m) => m.kind === 'question').slice(0, 4).map((m) => String(m.text).slice(0, 200)),
    decisions: msgs.filter((m) => m.kind === 'decision').slice(0, 4).map((m) => String(m.text).slice(0, 200)),
    blockers,
  };

  run(`INSERT INTO handoffs (id, run_id, task_id, from_agent, to_agent, kind, summary, artifacts, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ulid(), task.runId, task.id, (last?.agent_id as string) ?? 'engine', null, 'envelope',
    env.summary, JSON.stringify(env), now());
  emit('task.handoff', 'engine', { taskId: task.id, to: toRole, from: env.fromRole, summary: env.summary.slice(0, 200) }, task.runId, task.id);
  return env;
}

export function envelopeText(env: HandoffEnvelope): string {
  return JSON.stringify(env, null, 1);
}

// Strict reply shapes for the decision-making roles (pm, prompt-creator,
// reviewer, qa). A hand-written validator — small and easy to extend. Returns
// an error string when the reply is unusable; the engine then does one repair
// retry before falling back to lenient reading.
const REPLY_CHECKS: Partial<Record<WorkItemKind, (j: Record<string, any>) => string | null>> = {
  plan: (j) => (Array.isArray(j?.tasks) || Array.isArray(j?.planDiff?.add) ? null : 'expected JSON { tasks: [...] } or { planDiff: { add: [...] } }'),
  prompt: (j) => ((typeof j?.brief === 'string' && j.brief.trim()) || (typeof j?.prompt === 'string' && j.prompt.trim()) ? null : 'expected JSON { brief: "..." } or { prompt: "..." }'),
  'prompt-review': (j) => (['approve', 'revise'].includes(j?.decision) ? null : 'expected JSON { decision: "approve" | "revise", notes }'),
  review: (j) => (['approve', 'request-changes'].includes(j?.decision) ? null : 'expected JSON { decision: "approve" | "request-changes", notes }'),
  qa: (j) => (['pass', 'fail'].includes(j?.decision) && (j?.findings === undefined || Array.isArray(j.findings)) ? null : 'expected JSON { decision: "pass" | "fail", findings: [...], criteria: [...] }'),
  accept: (j) => (['accept', 'rework'].includes(j?.decision) ? null : 'expected JSON { decision: "accept" | "rework", notes, prompt?, commit? }'),
};

export const STRICT_REPLY_KINDS: WorkItemKind[] = Object.keys(REPLY_CHECKS) as WorkItemKind[];

export function validateReply(kind: WorkItemKind, j: Record<string, any>): string | null {
  return REPLY_CHECKS[kind]?.(j) ?? null;
}
