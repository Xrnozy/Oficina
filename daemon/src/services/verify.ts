import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import db, { q, q1, run, DATA_DIR } from '../db.ts';
import { emit } from '../bus.ts';
import { excerptLines, head, now, parseJson, sha256, tail, ulid } from '../util.ts';
import type { Check, CheckRun } from '../types.ts';

// Verification service (spec: "verification is code; analysis is AI").
// A check's pass/fail is NEVER set by a model. Command checks run in the
// task worktree; non-command checks (doc:*, errors:open, review:*) are
// evaluated against the DB/filesystem deterministically.

const FAIL_NEEDLES = [/fail/i, /error/i, /✗|✖|×/, /not ok/i, /assert/i, /expected/i];

export function getCheck(checkId: string): Check | undefined {
  const r = q1('SELECT * FROM checks WHERE id = ?', checkId);
  return r ? rowToCheck(r) : undefined;
}

export function checkByName(repoId: string, name: string): Check | undefined {
  const r = q1('SELECT * FROM checks WHERE repo_id = ? AND name = ?', repoId, name);
  return r ? rowToCheck(r) : undefined;
}

export function repoChecks(repoId: string): Check[] {
  return q('SELECT * FROM checks WHERE repo_id = ?', repoId).map(rowToCheck);
}

function rowToCheck(r: Record<string, unknown>): Check {
  return {
    id: r.id as string, repoId: r.repo_id as string, name: r.name as string, kind: r.kind as Check['kind'],
    command: r.command as string, parser: r.parser as string, passRule: r.pass_rule as string,
    timeoutSec: r.timeout_sec as number, affectedPaths: parseJson(r.affected_paths as string, []),
    protected: r.protected as number,
  };
}

function storeBlob(content: string): string {
  const h = sha256(content).slice(0, 24);
  const p = path.join(DATA_DIR, 'blobs', `${h}.log`);
  if (!fs.existsSync(p)) fs.writeFileSync(p, content);
  return `blob:${h}`;
}

export function readBlob(ref: string): string | null {
  if (!ref.startsWith('blob:')) return null;
  const p = path.join(DATA_DIR, 'blobs', `${ref.slice(5)}.log`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function runCommand(command: string, cwd: string, timeoutSec: number): Promise<{ code: number | null; output: string; timedOut: boolean; durationMs: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    // cwd is set via spawn options — embedding `cd /d "<path>"` into the
    // command line breaks on Windows when the path contains spaces.
    const child = execFile(isWin ? 'cmd.exe' : '/bin/sh', isWin ? ['/d', '/s', '/c', command] : ['-c', command], {
      cwd, timeout: timeoutSec * 1000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    }, (err, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ?? ''}`;
      const timedOut = !!err && (err as any).killed === true;
      resolve({ code: typeof child.exitCode === 'number' ? child.exitCode : (err ? 1 : 0), output, timedOut, durationMs: Date.now() - started });
    });
  });
}

interface ParsedFailures { name: string; file?: string; message?: string }

function parseFailures(output: string): ParsedFailures[] {
  const failures: ParsedFailures[] = [];
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m = l.match(/^\s*(?:not ok|FAIL|✗|✖|×)\s+(.+)/i);
    if (m) { failures.push({ name: m[1].trim().slice(0, 200), message: lines[i + 1]?.trim().slice(0, 300) }); continue; }
    m = l.match(/(?:Error|AssertionError|Expected)\b.*:?\s*(.{0,200})/);
    if (m && /test|spec|assert/i.test(output)) failures.push({ name: m[0].trim().slice(0, 200) });
  }
  return failures.slice(0, 20);
}

function evalPassRule(check: Check, code: number | null, output: string, worktree: string, runId: string): { pass: boolean; summary: string } {
  const rule = check.passRule || 'exit0';
  if (rule === 'exit0') {
    return { pass: code === 0, summary: code === 0 ? 'exit 0' : `exit ${code}` };
  }
  let m = rule.match(/^coverage>=(\d+(?:\.\d+)?)(?::(.+))?$/);
  if (m) {
    const need = parseFloat(m[1]);
    const covPath = path.join(worktree, 'coverage', 'coverage-summary.json');
    if (!fs.existsSync(covPath)) return { pass: false, summary: 'no coverage-summary.json found' };
    try {
      const cov = JSON.parse(fs.readFileSync(covPath, 'utf8'));
      const pct = cov?.total?.lines?.pct ?? 0;
      return { pass: pct >= need, summary: `coverage ${pct}% (need >= ${need}%)` };
    } catch { return { pass: false, summary: 'coverage file unreadable' }; }
  }
  if (rule === 'output-nonempty') {
    return { pass: output.trim().length > 0, summary: output.trim() ? 'output present' : 'no output — nothing changed' };
  }
  m = rule.match(/^file-exists\((.+)\)$/);
  if (m) {
    const ok = fs.existsSync(path.join(worktree, m[1].trim()));
    return { pass: ok, summary: ok ? `${m[1].trim()} exists` : `${m[1].trim()} missing` };
  }
  m = rule.match(/^sections\((.+),\[(.+)\]\)$/);
  if (m) {
    const p = path.join(worktree, m[1].trim());
    if (!fs.existsSync(p)) return { pass: false, summary: `${m[1].trim()} missing` };
    const text = fs.readFileSync(p, 'utf8').toLowerCase();
    const needed = m[2].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const missing = needed.filter((s) => !text.includes(s));
    return { pass: missing.length === 0, summary: missing.length ? `missing sections: ${missing.join(', ')}` : 'all sections present' };
  }
  m = rule.match(/^errors:open\(severity>=(\w+)\)==0$/);
  if (m) {
    const order = ['low', 'medium', 'high', 'critical'];
    const min = order.indexOf(m[1]);
    const sevs = order.slice(min);
    const r = q1(
      `SELECT COUNT(*) c FROM error_reports WHERE run_id = ? AND status IN ('open','assigned','fixing','verifying','reopened','escalated') AND severity IN (${sevs.map(() => '?').join(',')})`,
      runId, ...sevs
    );
    const c = (r?.c as number) ?? 0;
    return { pass: c === 0, summary: `${c} open error(s) severity>=${m[1]}` };
  }
  if (rule === 'review:all-merged-approved') {
    const r = q1(`SELECT COUNT(*) c FROM tasks WHERE run_id = ? AND status IN ('done','approved') AND reviewer_agent_id IS NULL`, runId);
    const c = (r?.c as number) ?? 0;
    return { pass: c === 0, summary: c === 0 ? 'all merged work approved' : `${c} merged task(s) lack approval` };
  }
  if (rule === 'junit' || rule === 'tests-pass') {
    const fails = parseFailures(output);
    const failCount = (() => {
      const mm = output.match(/(?:failures|failing|failed)["'=\s:]+(\d+)/i) ?? output.match(/#\s*fail\s+(\d+)/i);
      return mm ? parseInt(mm[1], 10) : fails.length;
    })();
    return { pass: code === 0 && failCount === 0, summary: `exit ${code}, ${failCount} failure(s)` };
  }
  return { pass: code === 0, summary: `exit ${code} (unknown rule '${rule}', treated as exit0)` };
}

export async function runCheck(opts: {
  check: Check; worktree: string; runId: string; taskId?: string | null;
  workItemId?: string | null; commitSha?: string | null; ref?: string;
}): Promise<CheckRun> {
  const { check, worktree, runId } = opts;
  emit('checkrun.started', 'engine', { check: check.name, kind: check.kind }, runId, check.id);

  let status: CheckRun['status'] = 'pass';
  let summary = '';
  let failures: ParsedFailures[] = [];
  let output = '';
  let code: number | null = 0;
  let durationMs = 0;

  if (check.command) {
    const r = await runCommand(check.command, worktree, check.timeoutSec);
    output = r.output; code = r.code; durationMs = r.durationMs;
    if (r.timedOut) { status = 'error'; summary = `timed out after ${check.timeoutSec}s`; }
    const ev = evalPassRule(check, code, output, worktree, runId);
    if (status !== 'error') { status = ev.pass ? 'pass' : 'fail'; summary = ev.summary; }
    if (status === 'fail') failures = parseFailures(output);
  } else {
    const ev = evalPassRule(check, 0, '', worktree, runId);
    status = ev.pass ? 'pass' : 'fail';
    summary = ev.summary;
  }

  // flaky detection: one automatic re-run for test-ish checks that failed
  if (status === 'fail' && check.command && ['unit', 'integration', 'e2e'].includes(check.kind)) {
    const r2 = await runCommand(check.command, worktree, check.timeoutSec);
    const ev2 = evalPassRule(check, r2.code, r2.output, worktree, runId);
    if (ev2.pass) {
      status = 'flaky';
      summary += ' — passed on automatic re-run (flaky)';
    }
  }

  const evidenceRef = storeBlob(`$ ${check.command}\n[exit ${code}]\n\n${output || summary}`);
  const id = ulid();
  run(
    `INSERT INTO check_runs (id, check_id, work_item_id, task_id, run_id, commit_sha, ref, status, duration_ms, evidence_refs, summary, failures, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, check.id, opts.workItemId ?? null, opts.taskId ?? null, runId, opts.commitSha ?? null,
    opts.ref ?? '', status, durationMs, JSON.stringify([evidenceRef]), summary, JSON.stringify(failures), now()
  );
  emit('checkrun.completed', 'engine', { checkId: check.id, check: check.name, status, summary, checkRunId: id }, runId, id);
  return {
    id, checkId: check.id, workItemId: opts.workItemId ?? null, taskId: opts.taskId ?? null, runId,
    commitSha: opts.commitSha ?? null, ref: opts.ref ?? '', status, durationMs,
    evidenceRefs: [evidenceRef], summary, failures, createdAt: now(),
  };
}

export function checkRunEvidence(cr: CheckRun | Record<string, unknown>): string {
  const rawRefs = (cr as Record<string, unknown>).evidenceRefs ?? (cr as Record<string, unknown>).evidence_refs;
  const refs: string[] = Array.isArray(rawRefs) ? rawRefs as string[] : parseJson(rawRefs as string, []);
  const parts = refs.map((r) => readBlob(r)).filter(Boolean) as string[];
  return parts.join('\n---\n');
}

export function logExcerptFor(cr: CheckRun): string {
  const full = checkRunEvidence(cr);
  return excerptLines(full, FAIL_NEEDLES, 5, 200);
}
