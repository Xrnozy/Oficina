import { q, q1, run } from '../db.ts';
import { now, parseJson } from '../util.ts';
import { tokenReport } from './usage.ts';

// Run summary (spec 6.6): generated from stored data only — no model call.
// Written once when a run reaches a terminal state; the API re-derives it for
// still-running runs.

export interface RunSummary {
  runId: string; goal: string; status: string; generatedAt: string;
  tasks: { id: string; title: string; status: string; owner: string | null }[];
  commits: { taskId: string | null; sha: string; title: string }[];
  checks: { name: string; total: number; passed: number; failed: number; ms: number };
  stages: { kind: string; workItems: number; promptChars: number; tokens: number; costUsd: number; cacheHits: number; tokensSaved: number }[];
  totals: { workItems: number; tokens: number; promptChars: number; costUsd: number; cacheHits: number; tokensSaved: number };
  retries: { retriedWorkItems: number; repairRetries: number };
  humanInterventions: { approvalsDecided: number; ownerMessages: number; items: { action: string; taskId: string | null; decision: string }[] };
}

export function buildRunSummary(runId: string): RunSummary | null {
  const r = q1('SELECT * FROM runs WHERE id = ?', runId);
  if (!r) return null;

  const tasks = q(`SELECT t.id, t.title, t.status, a.name AS owner
                   FROM tasks t LEFT JOIN agents a ON a.id = t.owner_agent_id
                   WHERE t.run_id = ? ORDER BY t.id`, runId)
    .map((t) => ({ id: t.id as string, title: t.title as string, status: t.status as string, owner: (t.owner as string | null) ?? null }));

  const commits = q(`SELECT entity_id, payload FROM events WHERE run_id = ? AND type = 'commit.created' ORDER BY seq`, runId)
    .map((e) => { const d = parseJson<{ sha?: string; title?: string; taskId?: string }>(e.payload as string, {}); return { taskId: (d.taskId ?? e.entity_id) as string | null, sha: (d.sha ?? '').slice(0, 10), title: d.title ?? '' }; })
    .filter((c) => c.sha);

  const cr = q1(`SELECT COUNT(*) total, SUM(CASE WHEN status='pass' THEN 1 ELSE 0 END) passed,
                        SUM(CASE WHEN status IN ('fail','error') THEN 1 ELSE 0 END) failed,
                        COALESCE(SUM(duration_ms),0) ms
                 FROM check_runs WHERE run_id = ?`, runId);
  const checks = { name: 'all', total: (cr?.total as number) ?? 0, passed: (cr?.passed as number) ?? 0, failed: (cr?.failed as number) ?? 0, ms: (cr?.ms as number) ?? 0 };

  const tr = tokenReport(runId);
  const stages = (tr?.byKind ?? []).map((s) => ({
    kind: s.kind, workItems: s.calls, promptChars: s.promptChars,
    tokens: s.reportedTokens, costUsd: s.costUsd, cacheHits: 0, tokensSaved: 0,
  }));
  const totals = {
    workItems: stages.reduce((a, s) => a + s.workItems, 0),
    tokens: stages.reduce((a, s) => a + s.tokens, 0),
    promptChars: stages.reduce((a, s) => a + s.promptChars, 0),
    costUsd: stages.reduce((a, s) => a + s.costUsd, 0),
    cacheHits: tr?.cache.hits ?? 0,
    tokensSaved: tr?.cache.savedTokens ?? 0,
  };

  const retried = (q1(`SELECT COUNT(*) c FROM work_items WHERE run_id = ? AND attempt > 1`, runId)?.c as number) ?? 0;
  const repairs = (q1(`SELECT COUNT(*) c FROM events WHERE run_id = ? AND type = 'workitem.repair'`, runId)?.c as number) ?? 0;

  // decided-by-a-human = not pending and not an auto-approval (reason prefix)
  const interventions = q(`SELECT action, task_id, status, reason FROM approvals
                           WHERE run_id = ? AND status != 'pending' AND COALESCE(reason,'') NOT LIKE 'auto-approved%' ORDER BY created_at`, runId)
    .map((a) => ({ action: a.action as string, taskId: a.task_id as string | null, decision: a.status as string }));
  const ownerMessages = (q1(`SELECT COUNT(*) c FROM agent_messages WHERE run_id = ? AND from_agent = 'owner'`, runId)?.c as number) ?? 0;

  return {
    runId, goal: r.goal as string, status: r.status as string, generatedAt: now(),
    tasks, commits, checks, stages, totals,
    retries: { retriedWorkItems: retried, repairRetries: repairs },
    humanInterventions: { approvalsDecided: interventions.length, ownerMessages, items: interventions },
  };
}

export function summaryMarkdown(s: RunSummary): string {
  const done = s.tasks.filter((t) => t.status === 'done').length;
  const lines: string[] = [
    `# Run summary — ${s.runId}`, '',
    `**Goal:** ${s.goal}`,
    `**Status:** ${s.status} · generated ${s.generatedAt}`, '',
    `## Tasks (${done}/${s.tasks.length} done)`,
    ...s.tasks.map((t) => `- [${t.status}] ${t.id} — ${t.title}${t.owner ? ` (${t.owner})` : ''}`), '',
    `## Commits (${s.commits.length})`,
    ...(s.commits.length ? s.commits.map((c) => `- \`${c.sha}\` ${c.title}${c.taskId ? ` — ${c.taskId}` : ''}`) : ['- none']),
    '',
    `## Checks`,
    `- ${s.checks.passed}/${s.checks.total} passed, ${s.checks.failed} failed (${Math.round(s.checks.ms / 1000)}s total)`, '',
    `## Tokens & cost per stage`,
    `| stage | items | prompt chars | tokens | cost | cache hits | saved |`,
    `|---|---|---|---|---|---|---|`,
    ...s.stages.map((st) => `| ${st.kind} | ${st.workItems} | ${st.promptChars} | ${st.tokens} | $${st.costUsd.toFixed(4)} | ${st.cacheHits} | ${st.tokensSaved} |`),
    `| **total** | ${s.totals.workItems} | ${s.totals.promptChars} | ${s.totals.tokens} | $${s.totals.costUsd.toFixed(4)} | ${s.totals.cacheHits} | ${s.totals.tokensSaved} |`,
    '',
    `## Retries`,
    `- retried work items: ${s.retries.retriedWorkItems}`, `- repair retries: ${s.retries.repairRetries}`, '',
    `## Human interventions (${s.humanInterventions.approvalsDecided} approvals, ${s.humanInterventions.ownerMessages} messages)`,
    ...(s.humanInterventions.items.length
      ? s.humanInterventions.items.map((i) => `- ${i.action} → ${i.decision}${i.taskId ? ` (${i.taskId})` : ''}`)
      : ['- none — ran unattended']),
    '',
  ];
  return lines.join('\n');
}

// Called by the engine when a run reaches a terminal state.
export function finalizeRunSummary(runId: string): void {
  const s = buildRunSummary(runId);
  if (!s) return;
  run('UPDATE runs SET summary_md = ? WHERE id = ?', summaryMarkdown(s), runId);
}
