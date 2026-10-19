// The request queue: prompts typed somewhere quick (the system tray, the dashboard) wait here, per office,
// and the whole app sees them. Nothing runs until it is started, either by hand from the Dashboard or, if the
// office opted in (settings.autoStartQueue), automatically when the office has no run in progress.
import { q, q1, run } from '../db.ts';
import { emit } from '../bus.ts';
import { now, parseJson, ulid } from '../util.ts';
import { createRun } from '../engine/engine.ts';

export interface QueuedRequest {
  id: string; workspaceId: string; text: string; source: string;
  status: 'queued' | 'started' | 'removed'; runId: string | null; createdAt: string; startedAt: string | null;
}

const MAX_TEXT = 8000;
const MAX_QUEUED = 200;
const DEFAULT_BUDGET_USD = 50;
// a run in any of these is "the office is busy" — the same statuses the UI treats as ongoing
const ONGOING = ['draft', 'dod-review', 'running', 'pausing', 'paused', 'verifying'];

const toRow = (r: Record<string, unknown>): QueuedRequest => ({
  id: r.id as string, workspaceId: r.workspace_id as string, text: r.text as string, source: r.source as string,
  status: r.status as QueuedRequest['status'], runId: (r.run_id as string | null) ?? null,
  createdAt: r.created_at as string, startedAt: (r.started_at as string | null) ?? null,
});

export function enqueue(opts: { text: unknown; workspaceId?: string | null; source?: string }): QueuedRequest | { error: string } {
  const text = String(opts.text ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return { error: 'type a request first' };
  if (text.length > MAX_TEXT) return { error: `too long (${text.length} characters, the limit is ${MAX_TEXT})` };
  // no office given: the one most recently used, else the first
  const wsId = opts.workspaceId
    ?? (q1('SELECT workspace_id AS id FROM runs ORDER BY rowid DESC LIMIT 1')?.id as string | undefined)
    ?? (q1('SELECT id FROM workspaces ORDER BY rowid LIMIT 1')?.id as string | undefined);
  if (!wsId || !q1('SELECT id FROM workspaces WHERE id = ?', wsId)) return { error: 'office not found' };
  if ((q1(`SELECT COUNT(*) c FROM request_queue WHERE workspace_id = ? AND status = 'queued'`, wsId)?.c as number) >= MAX_QUEUED) {
    return { error: `this office already has ${MAX_QUEUED} queued requests — start or remove some first` };
  }
  const source = ['tray', 'app', 'api'].includes(String(opts.source)) ? String(opts.source) : 'api';
  const id = ulid();
  run(`INSERT INTO request_queue (id, workspace_id, text, source, status, created_at) VALUES (?,?,?,?, 'queued', ?)`, id, wsId, text, source, now());
  emit('queue.added', source === 'tray' ? 'tray' : 'owner', { queueId: id, workspaceId: wsId, source, text: text.slice(0, 140) });
  return toRow(q1('SELECT * FROM request_queue WHERE id = ?', id)!);
}

export function listQueue(workspaceId?: string | null, status: QueuedRequest['status'] = 'queued'): QueuedRequest[] {
  const rows = workspaceId
    ? q('SELECT * FROM request_queue WHERE workspace_id = ? AND status = ? ORDER BY rowid', workspaceId, status)
    : q('SELECT * FROM request_queue WHERE status = ? ORDER BY rowid', status);
  return rows.map(toRow);
}

export function removeQueued(id: string): { ok: true } | { error: string } {
  const r = q1('SELECT * FROM request_queue WHERE id = ?', id);
  if (!r) return { error: 'not found' };
  if (r.status !== 'queued') return { error: `already ${String(r.status)}` };
  run(`UPDATE request_queue SET status = 'removed' WHERE id = ?`, id);
  emit('queue.removed', 'owner', { queueId: id, workspaceId: r.workspace_id });
  return { ok: true };
}

export function markStarted(id: string, runId: string): void {
  const r = q1(`SELECT * FROM request_queue WHERE id = ? AND status = 'queued'`, id);
  if (!r) return;
  run(`UPDATE request_queue SET status = 'started', run_id = ?, started_at = ? WHERE id = ?`, runId, now(), id);
  emit('queue.started', 'owner', { queueId: id, workspaceId: r.workspace_id, runId }, runId);
}

export const officeBusy = (wsId: string): boolean =>
  !!q1(`SELECT id FROM runs WHERE workspace_id = ? AND status IN (${ONGOING.map(() => '?').join(',')}) LIMIT 1`, wsId, ...ONGOING);

/** Start the oldest queued request of an office, with its default repository and budget. */
export function startNextQueued(wsId: string): { runId: string; queueId: string } | { skipped: string } {
  const item = q1(`SELECT * FROM request_queue WHERE workspace_id = ? AND status = 'queued' ORDER BY rowid LIMIT 1`, wsId);
  if (!item) return { skipped: 'nothing queued' };
  const repo = q1('SELECT id FROM repos WHERE workspace_id = ? ORDER BY rowid LIMIT 1', wsId);
  if (!repo) return { skipped: 'the office has no repository yet' };
  const settings = parseJson<Record<string, unknown>>(q1('SELECT settings FROM workspaces WHERE id = ?', wsId)?.settings as string, {});
  const budget = Number(settings.queueBudgetUsd);
  const r = createRun({ workspaceId: wsId, goal: item.text as string, budgetUsd: budget > 0 ? budget : DEFAULT_BUDGET_USD, repoId: repo.id as string });
  markStarted(item.id as string, r.id);
  return { runId: r.id, queueId: item.id as string };
}

const backoff = new Map<string, number>();   // office id -> do not retry before (ms), after a failed start

/** Offices that opted in start their next queued request as soon as they are idle. */
export function autoStartTick(): void {
  for (const ws of q('SELECT id, settings FROM workspaces')) {
    const wsId = ws.id as string;
    if (parseJson<Record<string, unknown>>(ws.settings as string, {}).autoStartQueue !== true) continue;
    if ((backoff.get(wsId) ?? 0) > Date.now() || officeBusy(wsId)) continue;
    try {
      const r = startNextQueued(wsId);
      if ('runId' in r) console.log(`[queue] auto-started ${r.runId} in ${wsId}`);
    } catch (e) {
      backoff.set(wsId, Date.now() + 60_000);
      console.error('[queue] auto-start failed:', String(e));
    }
  }
}

export function startQueueLoop(): void {
  setInterval(() => { try { autoStartTick(); } catch (e) { console.error('[queue] tick error', e); } }, 5_000);
}
