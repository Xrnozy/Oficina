import { q, q1 } from '../db.ts';
import { listEvents } from '../bus.ts';
import { parseJson } from '../util.ts';
import { rowToRun, rowToTask } from '../rows.ts';
import type { DodItem } from '../types.ts';

// Project documentation (spec 2): plan, requirements, assignments, progress,
// decisions and open issues. The content is the PM's own output (plan notes,
// prompt reviews) plus engine records of everything else, assembled on
// request, so keeping it current costs no model calls.

export interface ProjectDoc {
  runId: string; generatedAt: string; markdown: string;
  sections: { requirements: number; tasks: number; decisions: number; openIssues: number };
}

export function projectDoc(runId: string): ProjectDoc | null {
  const row = q1('SELECT * FROM runs WHERE id = ?', runId);
  if (!row) return null;
  const r = rowToRun(row);
  const dod = q1('SELECT * FROM dod WHERE id = ?', r.dodId);
  const items = parseJson<DodItem[]>(dod?.items as string, []);
  const tasks = q('SELECT * FROM tasks WHERE run_id = ? ORDER BY priority, rowid', runId).map(rowToTask);
  const names = new Map(q('SELECT id, name FROM agents').map((a) => [a.id as string, a.name as string]));
  const who = (id: string | null) => (id ? names.get(id) ?? id : 'unassigned');
  const events = listEvents({ runId, limit: 20000 });

  const L: string[] = [];
  L.push(`# Project record — ${r.goal}`);
  L.push(`Status **${r.status}**${r.stopReason ? ` (${r.stopReason})` : ''} · cycle ${r.currentCycle}/${r.limits.maxCycles} · spend $${r.spentUsd.toFixed(2)} of $${r.budget.runUsd} · DoD v${dod?.version ?? 1} (${dod?.status ?? 'draft'})`);

  L.push('', '## Requirements (Definition of Done)');
  if (!items.length) L.push('_No requirements drafted yet._');
  for (const i of items) {
    const mark = i.status === 'pass' ? '[x]' : '[ ]';
    L.push(`- ${mark} **${i.id}** ${i.text}${i.optional ? ' _(optional)_' : ''} — checks: ${i.checks.map((c) => `\`${c}\``).join(', ') || 'none'}${i.status === 'fail' ? ' — **failing**' : ''}`);
  }

  L.push('', '## Plan and assignments');
  if (!tasks.length) L.push('_No tasks yet._');
  for (const t of tasks) {
    const stage = t.meta?.promptStage ? ` · prompt ${t.meta.promptStage}` : '';
    L.push(`- **${t.title}** — ${t.status} · owner ${who(t.ownerAgentId)}${t.reviewerAgentId ? ` · reviewer ${who(t.reviewerAgentId)}` : ''}${stage} · covers ${t.dodItemIds.join(', ') || '—'}${t.dependsOn.length ? ` · after ${t.dependsOn.map((d) => tasks.find((x) => x.id === d)?.title ?? d).join(', ')}` : ''}`);
  }

  const done = tasks.filter((t) => t.status === 'done').length;
  const passing = items.filter((i) => !i.optional && i.status === 'pass').length;
  const required = items.filter((i) => !i.optional).length;
  L.push('', '## Progress');
  L.push(`- ${done}/${tasks.length} tasks merged · ${passing}/${required} required DoD items passing`);
  for (const c of q('SELECT n, summary FROM cycles WHERE run_id = ? AND summary != \'\' ORDER BY n', runId)) L.push(`- ${c.summary as string}`);

  // decisions: plan notes, prompt reviews, code reviews, requirement changes, model switches, owner calls
  const decisionTypes = new Set(['plan.applied', 'plan.rejected', 'prompt.reviewed', 'review.decided', 'requirements.changed', 'model.switched', 'approval.decided', 'dod.auto_approved', 'run.status']);
  const decisions = events.filter((e) => decisionTypes.has(e.type) && !(e.type === 'run.status' && !['done', 'stopped', 'paused'].includes(String(e.payload.status))));
  L.push('', '## Decision log');
  if (!decisions.length) L.push('_No decisions recorded yet._');
  for (const e of decisions.slice(-60)) L.push(`- ${e.ts.slice(0, 16).replace('T', ' ')} · ${e.actor} · ${describe(e.type, e.payload, (id) => tasks.find((t) => t.id === id)?.title ?? id)}`);

  const openErrors = q(`SELECT id, title, severity, status FROM error_reports WHERE run_id = ? AND status NOT IN ('resolved','wontfix')`, runId);
  const blocked = tasks.filter((t) => ['blocked', 'blocked-quota', 'waiting-input', 'failed'].includes(t.status));
  const approvals = q(`SELECT action, payload FROM approvals WHERE run_id = ? AND status = 'pending'`, runId);
  const failing = items.filter((i) => !i.optional && i.status !== 'pass');
  L.push('', '## Outstanding issues');
  const issues = [
    ...failing.map((i) => `Requirement **${i.id}** not yet met: ${i.text}`),
    ...openErrors.map((e) => `Error ${e.id as string} (${e.severity as string}, ${e.status as string}): ${e.title as string}`),
    ...blocked.map((t) => `Task **${t.title}** is ${t.status}`),
    ...approvals.map((a) => `Waiting on you: ${(parseJson<Record<string, unknown>>(a.payload as string, {}).summary as string) ?? a.action}`),
  ];
  if (!issues.length) L.push('_None._');
  for (const i of issues) L.push(`- ${i}`);

  return {
    runId, generatedAt: new Date().toISOString(), markdown: L.join('\n'),
    sections: { requirements: items.length, tasks: tasks.length, decisions: decisions.length, openIssues: issues.length },
  };
}

function describe(type: string, p: Record<string, unknown>, title: (id: string) => string): string {
  switch (type) {
    case 'plan.applied': return `Plan applied: +${p.added ?? 0} tasks, ${p.cancelled ?? 0} cancelled${p.notes ? ` — ${p.notes}` : ''}`;
    case 'plan.rejected': return `Plan rejected by validation: ${(p.problems as string[] ?? []).join('; ')}`;
    case 'prompt.reviewed': return `Prompt for "${title(String(p.taskId))}" ${p.decision === 'approve' ? 'approved' : `sent back: ${p.notes}`}`;
    case 'review.decided': return `Code review on "${title(String(p.taskId))}": ${p.decision}${p.notes ? ` — ${p.notes}` : ''}`;
    case 'requirements.changed': return `Requirements changed: +${(p.added as string[]).length} / −${(p.removed as string[]).length} / ~${(p.changed as string[]).length}; ${(p.affected as unknown[]).length} task(s) affected`;
    case 'model.switched': return `${p.agent} switched ${p.from} → ${p.to} (${p.reason})`;
    case 'approval.decided': return `Owner ${p.approved ? 'approved' : 'rejected'} ${p.action}${p.reason ? ` — ${p.reason}` : ''}`;
    case 'dod.auto_approved': return 'DoD auto-approved (one-shot run)';
    case 'run.status': return `Run ${p.status}${p.stopReason ? ` (${p.stopReason})` : ''}`;
    default: return type;
  }
}
