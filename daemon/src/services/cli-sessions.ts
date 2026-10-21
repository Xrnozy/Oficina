// CLI sessions. A headless CLI run (`claude -p`, `agent -p`, `devin -p`) starts a brand-new conversation unless it
// is told to continue one, so without this every work item left another session behind.
//
// The rule: one workflow node, one persistent session — per agent, so two agents never share a conversation. The
// node's agent keeps that session across tasks, retries, loop iterations and runs; another node (PM and PM1, two
// nodes on the same provider) has its own. In the standard pipeline every agent is its own node. A new session is
// started only for a new node or agent, when the owner resets one, when the CLI no longer has it, or when the work
// moves to another backend or folder (a CLI can continue only its own conversations, from the folder that started
// them). A busy session is waited for, never duplicated: one process at a time drives it, including a terminal the
// owner opened on it. Per-agent overrides:
//   reuse   the node session above (default)
//   new     a fresh, untracked session for every work item
//   pinned  one specific session, which then belongs to this agent and node only
// Per-task worktrees (isolated mode) are a different folder for every task, so they cannot continue a session.
import path from 'node:path';
import crypto from 'node:crypto';
import { q, q1, run } from '../db.ts';
import { emit } from '../bus.ts';
import { now, parseJson, ulid } from '../util.ts';
import { cliExecutable, cliPresetOf, cliSessionSupport, effectiveCliCommand, prepareCliCommand, spawnShell, type CliSessionSupport } from '../adapters/cli-resolve.ts';
import { cliSessionSettings } from './models.ts';
import type { Account, Agent } from '../types.ts';

export interface CliSessionRow {
  id: string; accountId: string | null; preset: string; agentId: string | null; label: string; cwd: string;
  externalId: string | null; started: boolean; status: 'active' | 'archived'; busyItem: string | null;
  uses: number; createdAt: string; lastUsedAt: string | null; lastItemId: string | null; note: string;
  ownerKey: string | null;            // set: this session belongs to one thing (a request draft) and is never lent out
  nodeKey: string | null;             // the workflow node it serves ('pipeline' = the standard pipeline; null = from before nodes were tracked)
  nodeLabel: string | null;
}

/** The workflow node a work item runs for: `wf:<workflow>:<node>` in a custom workflow, null in the standard pipeline. */
export function nodeFor(wi: { id: string; runId: string; workflowNodeId?: string | null }, agentId?: string): { key: string; label: string } | null {
  // from the row: the engine tags an item with its node right after creating it, so the object in hand may predate that
  const nodeId = (q1('SELECT workflow_node_id FROM work_items WHERE id = ?', wi.id)?.workflow_node_id as string | null) ?? wi.workflowNodeId ?? null;
  const v = q1('SELECT v.workflow_id, v.graph FROM runs r JOIN workflow_versions v ON v.id = r.workflow_version_id WHERE r.id = ?', wi.runId);
  if (!v) return null;
  if (!nodeId) {
    // work a graph run makes outside any node (a repair retry, the PM's diagnosis) continues the agent's node session
    const last = agentId ? q1(`SELECT node_key, node_label FROM cli_sessions WHERE agent_id = ? AND status = 'active' AND node_key LIKE ? ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT 1`, agentId, `wf:${v.workflow_id as string}:%`) : null;
    return last ? { key: last.node_key as string, label: (last.node_label as string) ?? (last.node_key as string) } : null;
  }
  const node = parseJson<{ nodes?: { id: string; label?: string }[] }>(v.graph as string, {}).nodes?.find((n) => n.id === nodeId);
  // keyed by workflow and node id: saving a new version of the workflow keeps every node's session
  return { key: `wf:${v.workflow_id as string}:${nodeId}`, label: node?.label || nodeId };
}

const toRow = (r: Record<string, unknown>): CliSessionRow => ({
  id: r.id as string, accountId: (r.account_id as string | null) ?? null, preset: r.preset as string, agentId: (r.agent_id as string | null) ?? null,
  label: (r.label as string) ?? '', cwd: r.cwd as string, externalId: (r.external_id as string | null) ?? null,
  started: !!r.started, status: (r.status as 'active' | 'archived') ?? 'active', busyItem: (r.busy_item as string | null) ?? null,
  uses: (r.uses as number) ?? 0, createdAt: r.created_at as string, lastUsedAt: (r.last_used_at as string | null) ?? null,
  lastItemId: (r.last_item_id as string | null) ?? null, note: (r.note as string) ?? '',
  ownerKey: (r.owner_key as string | null) ?? null,
  nodeKey: (r.node_key as string | null) ?? null, nodeLabel: (r.node_label as string | null) ?? null,
});

/** Directories compare equal regardless of case (Windows) and separators. */
export function normalizeCwd(p: string): string {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

export function getSession(id: string): CliSessionRow | null {
  const r = q1('SELECT * FROM cli_sessions WHERE id = ?', id);
  return r ? toRow(r) : null;
}

export function listSessions(f: { accountId?: string; agentId?: string; includeArchived?: boolean } = {}): (CliSessionRow & { agentName: string | null })[] {
  const where: string[] = []; const args: unknown[] = [];
  if (f.accountId) { where.push('account_id = ?'); args.push(f.accountId); }
  if (f.agentId) { where.push('agent_id = ?'); args.push(f.agentId); }
  if (!f.includeArchived) where.push("status = 'active'");
  const rows = q(`SELECT * FROM cli_sessions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY COALESCE(last_used_at, created_at) DESC`, ...args);
  return rows.map((r) => ({ ...toRow(r), agentName: r.agent_id ? ((q1('SELECT name FROM agents WHERE id = ?', r.agent_id as string)?.name as string) ?? null) : null }));
}

export function createSession(o: { accountId: string | null; preset: string; agentId?: string | null; cwd: string; label?: string; externalId?: string | null; started?: boolean; note?: string; ownerKey?: string | null; nodeKey?: string | null; nodeLabel?: string | null }): CliSessionRow {
  const id = ulid();
  const agentName = o.agentId ? (q1('SELECT name FROM agents WHERE id = ?', o.agentId)?.name as string | undefined) : undefined;
  const n = (q1('SELECT COUNT(*) c FROM cli_sessions WHERE agent_id IS ? AND preset = ?', o.agentId ?? null, o.preset)?.c as number) + 1;
  const label = (o.label ?? '').trim() || (o.nodeLabel ? `${agentName ?? 'Shared'} · ${o.nodeLabel}` : `${agentName ?? 'Shared'} · ${o.preset} #${n}`);
  run(`INSERT INTO cli_sessions (id, account_id, preset, agent_id, label, cwd, external_id, started, status, uses, created_at, note, owner_key, node_key, node_label)
       VALUES (?,?,?,?,?,?,?,?, 'active', 0, ?, ?, ?, ?, ?)`, id, o.accountId, o.preset, o.agentId ?? null, label, path.resolve(o.cwd), o.externalId ?? null, o.started ? 1 : 0, now(), o.note ?? '', o.ownerKey ?? null, o.nodeKey ?? null, o.nodeLabel ?? null);
  emit('cli.session.created', 'owner', { sessionId: id, agentId: o.agentId ?? null, preset: o.preset, label, node: o.nodeLabel ?? null });
  return getSession(id)!;
}

export function updateSession(id: string, patch: { agentId?: string | null; label?: string; status?: 'active' | 'archived' }): CliSessionRow | { error: string } {
  const s = getSession(id);
  if (!s) return { error: 'session not found' };
  if (patch.agentId !== undefined) {
    if (patch.agentId && !q1('SELECT id FROM agents WHERE id = ?', patch.agentId)) return { error: 'agent not found' };
    if (s.busyItem) return { error: 'this session is in use right now — try again when its work item has finished' };
    run('UPDATE cli_sessions SET agent_id = ? WHERE id = ?', patch.agentId ?? null, id);
  }
  if (typeof patch.label === 'string') run('UPDATE cli_sessions SET label = ? WHERE id = ?', patch.label.trim().slice(0, 80), id);
  if (patch.status === 'active' || patch.status === 'archived') {
    if (patch.status === 'archived' && s.busyItem) return { error: 'this session is in use right now — try again when its work item has finished' };
    run('UPDATE cli_sessions SET status = ? WHERE id = ?', patch.status, id);
  }
  emit('cli.session.updated', 'owner', { sessionId: id, ...patch });
  return getSession(id)!;
}

/** Forget a session in Oficina. The CLI's own copy of the conversation is left alone. */
export function deleteSession(id: string): { ok: true } | { error: string } {
  const s = getSession(id);
  if (!s) return { error: 'session not found' };
  if (s.busyItem) return { error: 'this session is in use right now — try again when its work item has finished' };
  run('DELETE FROM cli_sessions WHERE id = ?', id);
  emit('cli.session.removed', 'owner', { sessionId: id, label: s.label });
  return { ok: true };
}

/** A daemon that died mid-run leaves busy flags behind; nothing is running after a restart. */
export function clearBusySessions(): void {
  // …except a session the owner still has open in a terminal (marker terminal:<session>:<pid>, that process alive)
  for (const r of q(`SELECT id, busy_item FROM cli_sessions WHERE busy_item IS NOT NULL`)) {
    const pid = Number(String(r.busy_item).match(/^terminal:[^:]+:(\d+)$/)?.[1]);
    let alive = false;
    if (pid) { try { process.kill(pid, 0); alive = true; } catch { /* gone */ } }
    if (!alive) run('UPDATE cli_sessions SET busy_item = NULL WHERE id = ?', r.id as string);
  }
}

/** A terminal that was open across a restart: nobody is watching its exit any more, so check now and then whether it closed. */
export function releaseClosedTerminals(): void {
  for (const r of q(`SELECT id, busy_item FROM cli_sessions WHERE busy_item LIKE 'terminal:%'`)) {
    const pid = Number(String(r.busy_item).match(/^terminal:[^:]+:(\d+)$/)?.[1]);
    if (!pid) continue;
    try { process.kill(pid, 0); } catch { run('UPDATE cli_sessions SET busy_item = NULL WHERE id = ? AND busy_item = ?', r.id as string, r.busy_item as string); }
  }
}

// ---------- choosing a session for a work item ----------

export interface Acquired {
  session: CliSessionRow | null;      // null: run without tracking (a fresh, unrecorded session)
  resumed: boolean;                   // the CLI will be told to continue an existing conversation
  note: string;                       // why, in a sentence — shown in the activity feed
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_WAIT_MS = 10 * 60_000;

function claim(row: CliSessionRow, itemId: string): CliSessionRow {
  run('UPDATE cli_sessions SET busy_item = ? WHERE id = ? AND busy_item IS NULL', itemId, row.id);
  return getSession(row.id)!;
}

export async function acquireSession(o: {
  agent: Agent; account: Account | null; preset: string; cwd: string; itemId: string;
  support: CliSessionSupport | null; stable: boolean; forceNew?: boolean;
  /** this work has a session of its own (request intake): continued every time, never shared with the agent's other work */
  dedicated?: { key: string; label: string };
  /** the workflow node the work runs for (null: the standard pipeline, or work no node produced) */
  node?: { key: string; label: string } | null;
  /** called while waiting for the session to come free: a note the first time, null after (keep-alive) */
  onWait?: (note: string | null) => void;
}): Promise<Acquired> {
  // a session still marked busy by a work item that is no longer running (killed, stopped, daemon lost it) is free again
  const freeStale = () => {
    run(`UPDATE cli_sessions SET busy_item = NULL WHERE busy_item IS NOT NULL AND owner_key IS NULL
         AND busy_item IN (SELECT id FROM work_items WHERE status NOT IN ('running','queued','waiting'))`);
    releaseClosedTerminals();
  };
  freeStale();
  const st = cliSessionSettings(o.agent.settings);
  if (!o.support) return { session: null, resumed: false, note: 'this CLI has no session support configured, so every work item starts fresh' };
  if (!o.stable) return { session: null, resumed: false, note: "this work item runs in its own worktree, which can't continue an earlier session" };
  if (st.mode === 'new' && !o.forceNew && !o.dedicated) return { session: null, resumed: false, note: 'this agent is set to start a new session each time' };

  const cwdKey = normalizeCwd(o.cwd);
  const accountId = o.account?.id ?? null;
  const fresh = (why: string, extra: Partial<Parameters<typeof createSession>[0]> = {}): Acquired => {
    // an 'assign' CLI gets its id from us right away; the others tell us after the first run
    const ext = o.support!.idFrom === 'assign' ? crypto.randomUUID() : null;
    const row = createSession({ accountId, preset: o.preset, agentId: o.agent.id, cwd: o.cwd, externalId: ext, ...extra });
    return { session: claim(row, o.itemId), resumed: false, note: why };
  };
  const usable = (r: CliSessionRow) => r.status === 'active' && r.accountId === accountId && r.preset === o.preset && normalizeCwd(r.cwd) === cwdKey;
  const fits = (r: CliSessionRow) => st.rotateAfter === 0 || r.uses < st.rotateAfter;
  const use = (row: CliSessionRow, why: string): Acquired => {
    const claimed = claim(row, o.itemId);
    return { session: claimed, resumed: claimed.started && !!claimed.externalId, note: why };
  };

  if (o.dedicated) {
    const own = { ownerKey: o.dedicated.key, label: o.dedicated.label };
    if (o.forceNew) return fresh('the previous session could not be continued', own);
    const wait = Date.now() + MAX_WAIT_MS;
    for (;;) {
      const row = q1("SELECT * FROM cli_sessions WHERE owner_key = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1", o.dedicated.key);
      const cur = row ? toRow(row) : null;
      if (!cur || !usable(cur)) return fresh('first analysis of this request, so it got a session of its own', own);
      if (!cur.busyItem) return use(cur, `continuing this request's own session (${cur.uses} earlier analys${cur.uses === 1 ? 'is' : 'es'})`);
      if (Date.now() > wait) return fresh('this request\'s session stayed busy, so an additional one was started', own);
      await sleep(500);
    }
  }
  // the node's session: a new node's first work creates it, everything after continues it
  const nodeKey = o.node?.key ?? 'pipeline';
  const nodeLabel = o.node?.label ?? 'standard pipeline';
  const mine = { nodeKey, nodeLabel, label: `${o.agent.name} · ${nodeLabel}` };
  if (o.forceNew) return fresh('the previous session could not be continued, so this node got a new one', mine);

  // one process at a time: a busy session is waited for (keeping the work item alive), never duplicated
  const stillWanted = () => {
    const status = q1('SELECT status FROM work_items WHERE id = ?', o.itemId)?.status as string | undefined;
    return status === undefined || ['running', 'queued', 'waiting'].includes(status);
  };
  const waitFor = async (row: CliSessionRow, why: (s: CliSessionRow) => string): Promise<Acquired> => {
    let told = false;
    for (;;) {
      freeStale();
      const cur = getSession(row.id);
      // reset or removed by the owner while we waited: that was a deliberate new start
      if (!cur || cur.status !== 'active') return fresh('the session was reset, so this node started a new one', mine);
      if (!cur.busyItem) return use(cur, why(cur));
      if (!stillWanted()) throw new Error('cancelled: the work item stopped while waiting for its session');
      o.onWait?.(told ? null : `waiting for session “${cur.label}” — ${cur.busyItem.startsWith('terminal:') ? 'it is open in a terminal; close the terminal to let the agent continue' : 'it is finishing another work item'}`);
      told = true;
      await sleep(500);
    }
  };
  const continuing = (s: CliSessionRow) => (s.uses > 0 ? `continuing session “${s.label}” (${s.uses} earlier work item${s.uses === 1 ? '' : 's'})` : `using session “${s.label}”`);

  if (st.mode === 'pinned') {
    const pin = st.pinnedId ? getSession(st.pinnedId) : null;
    // a pinned session belongs to this agent and node alone: one that another agent or node uses is never shared
    const why = !pin || pin.status !== 'active' ? 'the pinned session is gone'
      : !usable(pin) ? `the pinned session belongs to another folder or backend (${pin.cwd})`
        : (pin.agentId && pin.agentId !== o.agent.id) || pin.ownerKey ? 'the pinned session belongs to another agent'
          : pin.nodeKey && pin.nodeKey !== nodeKey ? `the pinned session belongs to the node “${pin.nodeLabel ?? pin.nodeKey}”` : '';
    if (!why) {
      run('UPDATE cli_sessions SET agent_id = ?, node_key = ?, node_label = ? WHERE id = ?', o.agent.id, nodeKey, nodeLabel, pin!.id);
      return waitFor(pin!, (s) => `continuing pinned session “${s.label}”`);
    }
    o.onWait?.(`${why}, so this node uses its own session`);
  }

  const forNode = () => q(`SELECT * FROM cli_sessions WHERE agent_id = ? AND node_key = ? AND owner_key IS NULL AND status = 'active' ORDER BY COALESCE(last_used_at, created_at) DESC`, o.agent.id, nodeKey)
    .map(toRow).filter(usable);
  let rows = forNode();
  if (!rows.length) {
    // this agent's session from before nodes were tracked, or one imported and not assigned yet: it becomes the node's
    const legacy = q(`SELECT * FROM cli_sessions WHERE (agent_id = ? OR agent_id IS NULL) AND node_key IS NULL AND owner_key IS NULL AND status = 'active' ORDER BY (agent_id IS NULL), COALESCE(last_used_at, created_at) DESC`, o.agent.id)
      .map(toRow).filter(usable)[0];
    if (legacy) run('UPDATE cli_sessions SET agent_id = ?, node_key = ?, node_label = ? WHERE id = ? AND node_key IS NULL', o.agent.id, nodeKey, nodeLabel, legacy.id);
    rows = forNode();
  }
  if (!rows.length) return fresh(o.node ? `first work for the node “${nodeLabel}”, so its session was created` : 'first work item for this agent, so its session was created', mine);
  const s = rows[0];
  // retired only when the owner asked for it (Start a fresh session after N tasks); never by default
  if (st.rotateAfter > 0 && !fits(s) && !s.busyItem) {
    archiveSession(s.id, `rotated after ${st.rotateAfter} work items (agent setting)`);
    return fresh(`the session reached the limit of ${st.rotateAfter} work items set on this agent, so a new one was started`, mine);
  }
  return waitFor(s, continuing);
}

/** The owner starts a node's conversation over: the session is archived and the node's next work creates a new one. */
export function resetSession(id: string): CliSessionRow | { error: string } {
  const s = getSession(id);
  if (!s) return { error: 'session not found' };
  if (s.busyItem) return { error: s.busyItem.startsWith('terminal:') ? 'this session is open in a terminal — close it first' : 'this session is in use right now — try again when its work item has finished' };
  archiveSession(id, 'reset by the owner');
  return getSession(id)!;
}

export function releaseSession(id: string, r: { externalId?: string | null; itemId: string; ok: boolean; started?: boolean }): void {
  const s = getSession(id);
  if (!s) return;
  run(`UPDATE cli_sessions SET busy_item = NULL, last_item_id = ?, last_used_at = ?, uses = uses + ?, external_id = COALESCE(?, external_id), started = CASE WHEN ? THEN 1 ELSE started END WHERE id = ?`,
    r.itemId, now(), r.ok ? 1 : 0, r.externalId ?? null, r.started ? 1 : 0, id);
}

/** The CLI told us its id for this session while it was still running: remember it (and that the session exists) at once. */
export function setSessionExternalId(id: string, externalId: string): void {
  run('UPDATE cli_sessions SET external_id = ?, started = 1 WHERE id = ? AND external_id IS NULL', externalId, id);
}

/** A resumed session the CLI no longer knows: retire it (kept for the record) so it is not tried again. */
export function archiveSession(id: string, why: string): void {
  run(`UPDATE cli_sessions SET status = 'archived', busy_item = NULL, note = ? WHERE id = ?`, why.slice(0, 200), id);
  emit('cli.session.archived', 'router', { sessionId: id, why });
}

/** The CLI ran but never told us its session id, so it can never be continued: do not keep a row that would pile up. */
export function dropSession(id: string): void { run('DELETE FROM cli_sessions WHERE id = ?', id); }

// ---------- finding a session id after a run ----------

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** The first session id a CLI printed in its JSON output (Claude Code, cursor-agent: system/init and result events). */
export function sessionIdFromOutput(output: string, pattern?: string): string | null {
  if (pattern) {
    try { const m = output.replace(ANSI, '').match(new RegExp(pattern)); if (m) return (m[1] ?? m[0]).trim() || null; } catch { /* bad pattern */ }
    return null;
  }
  for (const line of output.split('\n')) {
    if (!line.startsWith('{') || !/session_?id|chat_?id/i.test(line)) continue;
    try {
      const ev = JSON.parse(line);
      const id = ev.session_id ?? ev.sessionId ?? ev.chat_id ?? ev.chatId;
      if (typeof id === 'string' && id) return id;
    } catch { /* not a json line */ }
  }
  return null;
}

export interface ListedSession { id: string; cwd: string; lastAt: number; title: string }

/** `devin list --format json` → sessions (the output may carry terminal escape codes around the JSON). */
export function parseSessionList(text: string): ListedSession[] {
  const clean = text.replace(ANSI, '');
  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  const arr = parseJson<unknown[]>(clean.slice(start, end + 1), []);
  const out: ListedSession[] = [];
  for (const it of Array.isArray(arr) ? arr : []) {
    const r = it as Record<string, unknown>;
    const id = String(r.id ?? r.short_id ?? '');
    if (id) out.push({ id, cwd: String(r.working_directory ?? ''), lastAt: Number(r.last_activity_at) || 0, title: String(r.title ?? '') });
  }
  return out;
}

/** Ask a CLI that can list its sessions (Devin) for the ones in a directory. Empty on any failure. */
export function listCliSessions(template: string, listArgs: string, cwd: string, timeoutMs = 10_000): Promise<ListedSession[]> {
  return new Promise((resolve) => {
    const { cmd, env } = prepareCliCommand(`${cliExecutable(template).token} ${listArgs}`);
    let out = '';
    let done = false;
    const finish = (v: ListedSession[]) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const child = spawnShell(cmd, { cwd, env });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish([]); }, timeoutMs);
    child.stdout?.on('data', (d) => { out += String(d); });
    child.on('error', () => finish([]));
    child.on('close', () => finish(parseSessionList(out)));
  });
}

/** Add the sessions a CLI already has in a directory to the registry, unassigned, so they can be handed to agents. */
export async function importSessions(o: { accountId: string; preset: string; template: string; support: CliSessionSupport | null; cwd: string }): Promise<{ added: number; skipped: number } | { error: string }> {
  if (!o.support?.list) return { error: "this CLI can't list its sessions, so there is nothing to import — Oficina learns a session the first time an agent uses it" };
  const listed = await listCliSessions(o.template, o.support.list, o.cwd);
  const known = new Set(q('SELECT external_id FROM cli_sessions WHERE account_id = ? AND external_id IS NOT NULL', o.accountId).map((r) => r.external_id as string));
  let added = 0; let skipped = 0;
  for (const s of listed) {
    if (known.has(s.id) || normalizeCwd(s.cwd || o.cwd) !== normalizeCwd(o.cwd)) { skipped++; continue; }
    createSession({ accountId: o.accountId, preset: o.preset, agentId: null, cwd: s.cwd || o.cwd, externalId: s.id, started: true, label: s.title.slice(0, 80) || s.id, note: 'imported' });
    added++;
  }
  return { added, skipped };
}

// ---------- what the API needs ----------


export interface CliBackend { accountId: string; label: string; preset: string; supported: boolean; canImport: boolean; idFrom: string | null }

/** Every CLI-backed account and what Oficina can do with its sessions. */
export function cliBackends(): CliBackend[] {
  return q(`SELECT a.id, a.label, a.config FROM accounts a JOIN providers p ON p.id = a.provider_id WHERE p.adapter_id = 'cli'`).map((a) => {
    const cfg = parseJson<Record<string, unknown>>(a.config as string, {});
    const template = effectiveCliCommand(String(cfg.command ?? ''));
    const support = cliSessionSupport(template, cfg);
    return { accountId: a.id as string, label: (a.label as string) || (a.id as string), preset: cliPresetOf(template)?.id ?? 'custom', supported: !!support, canImport: !!support?.list, idFrom: support?.idFrom ?? null };
  });
}

/** The folder an agent's repository sessions live in: the first repository of its office. */
function agentRepoPath(agentId: string): string | null {
  const r = q1(`SELECT r.path FROM memberships m JOIN repos r ON r.workspace_id = m.workspace_id WHERE m.agent_id = ? AND m.active = 1 ORDER BY r.rowid LIMIT 1`, agentId);
  return (r?.path as string | undefined) ?? null;
}

/** A session made ahead of time (an "additional" one): it starts fresh the first time an agent uses it. */
export function createAdditionalSession(o: { agentId: string | null; accountId?: string | null; cwd?: string | null; label?: string }): CliSessionRow | { error: string } {
  const agent = o.agentId ? q1('SELECT * FROM agents WHERE id = ?', o.agentId) : null;
  if (o.agentId && !agent) return { error: 'agent not found' };
  const accountId = o.accountId ?? (agent?.account_id as string | null) ?? null;
  const backend = cliBackends().find((b) => b.accountId === accountId);
  if (!backend) return { error: 'choose a CLI backend (Claude Code, cursor-agent or Devin) for this session' };
  const cwd = o.cwd || (o.agentId ? agentRepoPath(o.agentId) : null);
  if (!cwd) return { error: "give the folder this session works in — the agent's office has no repository yet" };
  const cfg = parseJson<Record<string, unknown>>(q1('SELECT config FROM accounts WHERE id = ?', accountId!)?.config as string, {});
  const support = cliSessionSupport(effectiveCliCommand(String(cfg.command ?? '')), cfg);
  if (!support) return { error: "this backend has no way to continue a session. Add resume arguments to it on the Providers page" };
  return createSession({ accountId, preset: backend.preset, agentId: o.agentId, cwd, label: o.label, externalId: support.idFrom === 'assign' ? crypto.randomUUID() : null });
}
