import db, { q1, run } from './db.ts';
import { now, sha256 } from './util.ts';
import { redact } from './config.ts';
import type { OfficeEvent } from './types.ts';

type Listener = (e: OfficeEvent) => void;
const listeners = new Set<Listener>();

export function onEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const GENESIS = '0'.repeat(64);

export function emit(type: string, actor: string, payload: Record<string, unknown> = {}, runId: string | null = null, entityId: string | null = null): OfficeEvent {
  const last = q1('SELECT hash FROM events ORDER BY seq DESC LIMIT 1');
  const prevHash = (last?.hash as string) ?? GENESIS;
  const ts = now();
  // scrub credentials before anything is persisted or broadcast
  const payloadStr = redact(JSON.stringify(payload));
  payload = JSON.parse(payloadStr);
  const hash = sha256(prevHash + ts + type + payloadStr);
  run(
    'INSERT INTO events (run_id, ts, actor, type, entity_id, payload, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?)',
    runId, ts, actor, type, entityId, payloadStr, prevHash, hash
  );
  const seq = (q1('SELECT last_insert_rowid() AS s')?.s as number) ?? 0;
  const ev: OfficeEvent = { seq, runId, ts, actor, type, entityId, payload, prevHash, hash };
  for (const fn of listeners) {
    try { fn(ev); } catch (err) { console.error('[bus] listener error', err); }
  }
  return ev;
}

export function listEvents(opts: { runId?: string; types?: string[]; sinceSeq?: number; limit?: number; latest?: boolean } = {}): OfficeEvent[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.runId) { where.push('run_id = ?'); params.push(opts.runId); }
  if (opts.sinceSeq != null) { where.push('seq > ?'); params.push(opts.sinceSeq); }
  if (opts.types?.length) { where.push(`type IN (${opts.types.map(() => '?').join(',')})`); params.push(...opts.types); }
  // latest: the newest N (still returned oldest-first)
  const sql = opts.latest
    ? `SELECT * FROM (SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC`
    : `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq ASC LIMIT ?`;
  params.push(opts.limit ?? 2000);
  const rows = db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
  return rows.map((r) => ({
    seq: r.seq as number, runId: r.run_id as string | null, ts: r.ts as string, actor: r.actor as string,
    type: r.type as string, entityId: r.entity_id as string | null,
    payload: JSON.parse((r.payload as string) || '{}'), prevHash: r.prev_hash as string, hash: r.hash as string,
  }));
}

// Verified prefix of the chain: events are append-only, so each check continues where the last one stopped instead of
// re-hashing the whole log (the health endpoint did that on every call — seconds on a long-lived database).
// A full pass still runs every FULL_PASS_MS, so an edit to an older, already verified row is caught too.
let verified = { seq: 0, hash: GENESIS, count: 0 };
let fullPassAt = 0;
const FULL_PASS_MS = 10 * 60_000;

export function verifyChain(): { ok: boolean; checked: number; brokenAt?: number } {
  // the row at the verified point changed or went missing, or a full pass is due: start over from the beginning
  const at = verified.seq ? q1('SELECT * FROM events WHERE seq = ?', verified.seq) : null;
  const atOk = !verified.seq || (!!at && at.hash === verified.hash
    && sha256(String(at.prev_hash) + String(at.ts) + String(at.type) + JSON.stringify(JSON.parse(String(at.payload || '{}')))) === verified.hash);
  if (Date.now() - fullPassAt > FULL_PASS_MS || !atOk) {
    verified = { seq: 0, hash: GENESIS, count: 0 };
    fullPassAt = Date.now();
  }
  let prev = verified.hash;
  let count = verified.count;
  for (;;) {
    const evs = listEvents({ sinceSeq: verified.seq, limit: 5000 });
    if (!evs.length) break;
    for (const ev of evs) {
      const expect = sha256(ev.prevHash + ev.ts + ev.type + JSON.stringify(ev.payload));
      if (ev.prevHash !== prev || ev.hash !== expect) return { ok: false, checked: ev.seq, brokenAt: ev.seq };
      prev = ev.hash;
      count++;
      verified = { seq: ev.seq, hash: ev.hash, count };
    }
  }
  return { ok: true, checked: count };
}
