import { q, q1, run } from '../db.ts';
import { emit } from '../bus.ts';
import { normalizeErrorText, now, parseJson, sha256, ulid } from '../util.ts';
import type { CheckRun, ErrorReport, ErrorSeverity, Task } from '../types.ts';
import { logExcerptFor } from './verify.ts';

// Error documentation (spec 4.5, 6.2): the engine fills facts; the Analyst
// agent fills title / suspectedCause / reproduction / suggestedFix. Dedupe by
// signature; resolutions feed the error knowledge base.

export function computeSignature(checkName: string, failures: { name: string; message?: string }[], log: string): string {
  const first = failures[0];
  const basis = `${checkName}|${normalizeErrorText(first?.name ?? '')}|${normalizeErrorText(first?.message ?? log.slice(0, 300))}`;
  return sha256(basis).slice(0, 20);
}

export function rowToError(r: Record<string, unknown>): ErrorReport {
  return {
    id: r.id as string, seqNo: r.seq_no as number, runId: r.run_id as string, cycleN: r.cycle_n as number,
    taskId: r.task_id as string | null, workItemId: r.work_item_id as string | null,
    severity: r.severity as ErrorSeverity, status: r.status as ErrorReport['status'],
    failingCheck: parseJson(r.failing_check as string, { checkId: '', checkRunId: '', commitSha: null, command: '', exitCode: null }),
    title: r.title as string,
    evidence: parseJson(r.evidence as string, { logExcerpt: '' }),
    reproduction: parseJson(r.reproduction as string, { steps: [], command: '', env: {} }),
    affectedFiles: parseJson(r.affected_files as string, []),
    suspectedCause: parseJson(r.suspected_cause as string, { summary: '', confidence: 'low' as const, reasoningSource: 'rules' as const }),
    signature: r.signature as string, relatedErrors: parseJson(r.related_errors as string, []),
    suggestedFix: parseJson(r.suggested_fix as string, { approach: '', difficulty: 1, suggestedRole: 'developer' }),
    assignment: parseJson(r.assignment as string, { fixerAgentId: null, assignedAt: null, attempt: 0, maxAttempts: 3 }),
    history: parseJson(r.history as string, []), escalation: r.escalation ? parseJson(r.escalation as string, null) : null,
    resolution: r.resolution ? parseJson(r.resolution as string, null) : null,
    createdAt: r.created_at as string | null, updatedAt: r.updated_at as string | null,
  } as ErrorReport & { createdAt: string | null; updatedAt: string | null };
}

export function getError(id: string): ErrorReport | undefined {
  const r = q1('SELECT * FROM error_reports WHERE id = ?', id);
  return r ? rowToError(r) : undefined;
}

export function openErrorBySignature(signature: string, runId: string): ErrorReport | undefined {
  const r = q1(
    `SELECT * FROM error_reports WHERE signature = ? AND run_id = ? AND status NOT IN ('resolved','wontfix') ORDER BY created_at DESC LIMIT 1`,
    signature, runId
  );
  return r ? rowToError(r) : undefined;
}

export function kbSearch(workspaceId: string, signature: string, text: string): { id: string; similarity: number; resolution?: string }[] {
  const out: { id: string; similarity: number; resolution?: string }[] = [];
  const exact = q('SELECT * FROM error_kb WHERE signature = ? AND (workspace_id = ? OR workspace_id = ?)', signature, workspaceId, '__global__');
  for (const r of exact) out.push({ id: r.id as string, similarity: 1, resolution: r.fix_summary as string });
  const norm = normalizeErrorText(text);
  const terms = norm.split(' ').filter((w) => w.length > 5).slice(0, 4);
  for (const t of terms) {
    const rows = q(`SELECT * FROM error_kb WHERE error_text LIKE ? AND (workspace_id = ? OR workspace_id = '__global__') LIMIT 3`, `%${t}%`, workspaceId);
    for (const r of rows) if (!out.some((o) => o.id === r.id)) out.push({ id: r.id as string, similarity: 0.5, resolution: r.fix_summary as string });
  }
  return out.slice(0, 5);
}

export function fileErrorReport(opts: {
  runId: string; cycleN: number; task: Task | null; workItemId: string | null;
  checkRun: CheckRun; checkName: string; checkCommand: string; affectedFiles: string[];
  workspaceId: string; analyst?: { title?: string; suspectedCause?: { summary: string; confidence: 'low' | 'medium' | 'high' }; steps?: string[]; suggestedFix?: { approach: string; difficulty: number; suggestedRole: string; avoid?: string[] } };
}): { report: ErrorReport; deduped: boolean } {
  const { checkRun } = opts;
  const log = logExcerptFor(checkRun);
  const signature = computeSignature(opts.checkName, checkRun.failures, log);
  const existing = openErrorBySignature(signature, opts.runId);
  if (existing) {
    const history = existing.history;
    const ev = { ...existing.evidence, logExcerpt: log };
    run(`UPDATE error_reports SET evidence = ?, work_item_id = ?, updated_at = ?, status = CASE WHEN status = 'resolved' THEN 'reopened' ELSE status END WHERE id = ?`,
      JSON.stringify(ev), opts.workItemId, now(), existing.id);
    emit('error.updated', 'analyst', { errorId: existing.id, signature, deduped: true }, opts.runId, existing.id);
    return { report: { ...existing, evidence: ev, history }, deduped: true };
  }

  const maxSeq = (q1('SELECT MAX(seq_no) m FROM error_reports')?.m as number) ?? 0;
  const id = `ERR-${new Date().getFullYear()}-${String(maxSeq + 1).padStart(4, '0')}`;
  const severity: ErrorSeverity =
    opts.checkName.startsWith('build') ? 'critical'
    : ['unit', 'integration', 'e2e'].some((k) => opts.checkName.startsWith(k)) ? 'high'
    : opts.checkName.startsWith('lint') ? 'low' : 'medium';

  const related = kbSearch(opts.workspaceId, signature, log);

  const report: ErrorReport = {
    id, seqNo: maxSeq + 1, runId: opts.runId, cycleN: opts.cycleN,
    taskId: opts.task?.id ?? null, workItemId: opts.workItemId,
    severity, status: 'open',
    failingCheck: { checkId: checkRun.checkId, checkRunId: checkRun.id, commitSha: checkRun.commitSha, command: opts.checkCommand, exitCode: null },
    title: opts.analyst?.title ?? `${opts.checkName} failed on task ${opts.task?.title ?? '?'}`,
    evidence: {
      logExcerpt: log,
      fullLogRef: checkRun.evidenceRefs[0],
      failingTests: checkRun.failures.map((f) => ({ name: f.name, file: f.file, message: f.message })),
    },
    reproduction: {
      steps: opts.analyst?.steps ?? [`Run \`${opts.checkCommand}\` in the task worktree.`],
      command: opts.checkCommand, env: { os: process.platform, node: process.version },
    },
    affectedFiles: opts.affectedFiles.map((p) => ({ path: p })),
    suspectedCause: opts.analyst?.suspectedCause
      ? { ...opts.analyst.suspectedCause, reasoningSource: 'analyst' }
      : { summary: checkRun.failures[0]?.message ?? checkRun.summary, confidence: 'low', reasoningSource: 'rules' },
    signature, relatedErrors: related,
    suggestedFix: opts.analyst?.suggestedFix ?? { approach: 'Inspect the log excerpt and fix the failing check.', difficulty: 2, suggestedRole: 'developer' },
    assignment: { fixerAgentId: opts.task?.ownerAgentId ?? null, assignedAt: null, attempt: 0, maxAttempts: 3 },
    history: [], escalation: null, resolution: null,
  };

  run(`INSERT INTO error_reports (id, seq_no, run_id, cycle_n, task_id, work_item_id, severity, status, failing_check, title, evidence, reproduction, affected_files, suspected_cause, signature, related_errors, suggested_fix, assignment, history, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    report.id, report.seqNo, report.runId, report.cycleN, report.taskId, report.workItemId, report.severity, report.status,
    JSON.stringify(report.failingCheck), report.title, JSON.stringify(report.evidence), JSON.stringify(report.reproduction),
    JSON.stringify(report.affectedFiles), JSON.stringify(report.suspectedCause), report.signature,
    JSON.stringify(report.relatedErrors), JSON.stringify(report.suggestedFix), JSON.stringify(report.assignment),
    '[]', now(), now());
  emit('error.reported', 'analyst', { errorId: id, signature, severity, title: report.title }, opts.runId, id);
  return { report, deduped: false };
}

export function resolveError(errorId: string, commitSha: string | null, checkRunId: string, summary: string, workspaceId: string): void {
  const r = getError(errorId);
  if (!r) return;
  const kbId = ulid();
  const repoId = q1('SELECT repo_id FROM runs WHERE id = ?', r.runId)?.repo_id as string | null;
  run(`INSERT INTO error_kb (id, workspace_id, repo_id, signature, error_text, root_cause, fix_summary, diff_excerpt, files, tags, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    kbId, workspaceId, repoId, r.signature, normalizeErrorText(r.evidence.logExcerpt ?? ''),
    r.suspectedCause?.summary ?? '', summary, (r.evidence.logExcerpt ?? '').slice(0, 1500),
    JSON.stringify(r.affectedFiles.map((f) => f.path)), JSON.stringify([r.severity]), now());
  run(`UPDATE error_reports SET status = 'resolved', resolution = ?, updated_at = ? WHERE id = ?`,
    JSON.stringify({ commitSha, summary, verifiedByCheckRunId: checkRunId, resolvedAt: now(), kbEntryId: kbId }), now(), errorId);
  emit('error.resolved', 'engine', { errorId, kbEntryId: kbId }, r.runId, errorId);
}

// ---- per-repo lessons (spec 6.5) ------------------------------------------
// The error_kb row *is* the lesson store — no parallel memory. A resolved
// error teaches signature→fix; a reviewer flag seen repeatedly becomes an
// "avoid" lesson. Injection is keyword/path matched, capped at 3 lessons /
// ~300 tokens (1200 chars) of fix text — no embeddings.

function lessonTokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s./_-]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
}

// Upsert by signature: a repeated flag bumps times_seen instead of duplicating.
export function recordLesson(opts: {
  workspaceId: string; repoId?: string | null; signature: string;
  errorText: string; fixSummary: string; files?: string[]; tags?: string[];
}): void {
  const existing = q1('SELECT id, times_seen FROM error_kb WHERE signature = ? AND workspace_id IS ?', opts.signature, opts.workspaceId);
  if (existing) {
    run(`UPDATE error_kb SET times_seen = times_seen + 1, fix_summary = ?, files = ? WHERE id = ?`,
      opts.fixSummary.slice(0, 800), JSON.stringify(opts.files ?? []), existing.id);
    return;
  }
  run(`INSERT INTO error_kb (id, workspace_id, repo_id, signature, error_text, fix_summary, files, tags, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ulid(), opts.workspaceId, opts.repoId ?? null, opts.signature,
    normalizeErrorText(opts.errorText).slice(0, 500), opts.fixSummary.slice(0, 800),
    JSON.stringify(opts.files ?? []), JSON.stringify(opts.tags ?? ['lesson']), now());
}

// A reviewer flag becomes a lesson keyed on its normalized text — the second
// time a reviewer flags the same thing it counts as repeated.
export function recordReviewerFlag(opts: { workspaceId: string; repoId?: string | null; flag: string; files?: string[] }): void {
  const norm = normalizeErrorText(opts.flag).slice(0, 300);
  if (norm.length < 12) return;
  recordLesson({
    workspaceId: opts.workspaceId, repoId: opts.repoId,
    signature: `revflag:${sha256(norm).slice(0, 16)}`,
    errorText: norm, fixSummary: `Avoid: ${opts.flag.slice(0, 300)}`,
    files: opts.files, tags: ['reviewer-flag'],
  });
}

export interface Lesson { signature: string; text: string; files: string[]; timesSeen: number }

export function lessonsFor(opts: {
  workspaceId: string; repoId?: string | null; files?: string[]; text?: string;
  limit?: number; maxChars?: number;
}): Lesson[] {
  const limit = opts.limit ?? 3;
  const maxChars = opts.maxChars ?? 1200; // ~300 tokens
  const rows = q(`SELECT signature, error_text, fix_summary, files, tags, times_seen
                  FROM error_kb WHERE workspace_id IN (?, '__global__')
                    AND (repo_id IS NULL OR repo_id = ?)
                  ORDER BY times_seen DESC, created_at DESC`,
    opts.workspaceId, opts.repoId ?? '__none__');
  const fileSet = (opts.files ?? []).map((f) => f.toLowerCase());
  const terms = lessonTokens(opts.text ?? '');
  const scored = rows.map((r) => {
    const files = parseJson<string[]>(r.files as string, []);
    const tags = parseJson<string[]>(r.tags as string, []);
    let score = 0;
    for (const f of files) {
      const fl = f.toLowerCase();
      if (fileSet.some((x) => x === fl || x.endsWith(fl) || fl.endsWith(x))) score += 4;
    }
    const content = lessonTokens(`${r.error_text ?? ''} ${tags.join(' ')}`);
    for (const t of terms) if (content.has(t)) score += 1;
    if (tags.includes('reviewer-flag')) score += 1;
    score += Math.min(3, ((r.times_seen as number) ?? 1) - 1); // repeated lessons rank up
    return { r, files, score };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  const out: Lesson[] = [];
  let chars = 0;
  for (const { r, files } of scored) {
    const times = (r.times_seen as number) ?? 1;
    const text = `${times > 1 ? `seen ×${times} — ` : ''}${String(r.fix_summary ?? r.error_text ?? '').slice(0, 350)}`;
    if (!text.trim() || chars + text.length > maxChars) continue;
    out.push({ signature: r.signature as string, text, files, timesSeen: times });
    chars += text.length;
    if (out.length >= limit) break;
  }
  return out;
}
