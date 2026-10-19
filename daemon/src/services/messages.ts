import { q, q1, run } from '../db.ts';
import { emit } from '../bus.ts';
import { now, ulid } from '../util.ts';
import { redact } from '../config.ts';
import type { AgentMessage, MessageKind, WorkItemResult } from '../types.ts';

// Agent-to-agent messages (spec 1). Agents address a teammate by name, a role
// ("reviewer"), everyone on the run ("all") or the owner. Messages are stored,
// shown in the UI, and delivered into the recipient's next prompt — no extra
// model call is made just to deliver a message.

const KINDS: MessageKind[] = ['question', 'finding', 'help', 'challenge', 'handoff', 'decision', 'note'];

export function rowToMessage(r: Record<string, unknown>): AgentMessage {
  return {
    id: r.id as string, runId: r.run_id as string | null, taskId: r.task_id as string | null,
    workItemId: r.work_item_id as string | null, fromAgent: r.from_agent as string,
    toAgent: r.to_agent as string | null, toRole: r.to_role as string | null,
    kind: r.kind as MessageKind, text: r.text as string, createdAt: r.created_at as string, readAt: r.read_at as string | null,
  };
}

// "to" may be an agent id, an agent name, a role name, "all" or "owner".
function resolveRecipient(to: string): { toAgent: string | null; toRole: string | null } {
  const t = to.trim();
  if (!t || t === 'all') return { toAgent: null, toRole: 'all' };
  if (t === 'owner' || t === 'human' || t === 'user') return { toAgent: null, toRole: 'owner' };
  const byId = q1('SELECT id FROM agents WHERE id = ?', t);
  if (byId) return { toAgent: byId.id as string, toRole: null };
  const byName = q1('SELECT id FROM agents WHERE lower(name) = lower(?) OR lower(name) LIKE lower(?)', t, `${t} (%`);
  if (byName) return { toAgent: byName.id as string, toRole: null };
  const role = q1('SELECT name FROM roles WHERE lower(name) = lower(?)', t.replace(/s$/, ''));
  if (role) return { toAgent: null, toRole: role.name as string };
  return { toAgent: null, toRole: 'all' };
}

// Normalized token-set similarity — used to drop a new message that nearly
// repeats an unread one from the same sender to the same recipient.
function normTokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean));
}
function similarity(a: string, b: string): number {
  const ta = normTokens(a), tb = normTokens(b);
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.max(ta.size, tb.size);
}

export function postMessage(m: {
  runId: string | null; taskId?: string | null; workItemId?: string | null;
  from: string; to: string; kind: MessageKind; text: string;
}): AgentMessage | null {
  const text = redact(String(m.text ?? '').trim()).slice(0, 4000);
  if (!text) return null;
  const { toAgent, toRole } = resolveRecipient(m.to);
  const kind = KINDS.includes(m.kind) ? m.kind : 'note';
  // dedupe: drop near-identical unread messages to the same recipient
  const pending = q(`SELECT text FROM agent_messages
                     WHERE run_id IS ? AND from_agent = ? AND read_at IS NULL
                       AND to_agent IS ? AND to_role IS ?
                     ORDER BY created_at DESC LIMIT 30`, m.runId, m.from, toAgent, toRole);
  for (const p of pending) {
    if (similarity(text, String(p.text)) >= 0.9) {
      emit('agent.msg.dropped', 'engine', { from: m.from, to: toAgent ?? toRole, kind, reason: 'duplicate of an unread message' }, m.runId);
      return null;
    }
  }
  const id = ulid();
  run(`INSERT INTO agent_messages (id, run_id, task_id, work_item_id, from_agent, to_agent, to_role, kind, text, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`, id, m.runId, m.taskId ?? null, m.workItemId ?? null, m.from, toAgent, toRole, kind, text, now());
  const fromName = (q1('SELECT name FROM agents WHERE id = ?', m.from)?.name as string) ?? m.from;
  const toName = toAgent ? (q1('SELECT name FROM agents WHERE id = ?', toAgent)?.name as string) : toRole;
  emit('agent.msg', fromName, { messageId: id, from: m.from, fromName, to: toAgent ?? toRole, toName, kind, text: text.slice(0, 600), taskId: m.taskId ?? null }, m.runId, id);
  return rowToMessage(q1('SELECT * FROM agent_messages WHERE id = ?', id)!);
}

// Messages not yet delivered to this agent: direct/role mail it has not read,
// and broadcasts this agent has never received (per-agent delivery tracking in
// message_deliveries — every agent gets each broadcast at most once instead
// of re-sending the latest 8 into every prompt). Messages belonging to
// finished tasks are never delivered.
export function takeInbox(agentId: string, roleName: string | null, runId: string, taskId: string | null): AgentMessage[] {
  const rows = q(`SELECT m.* FROM agent_messages m
                  LEFT JOIN tasks t ON t.id = m.task_id
                  WHERE m.run_id = ? AND m.from_agent != ?
                    AND (m.task_id IS NULL OR t.status NOT IN ('done','failed','cancelled'))
                    AND (
                      (m.to_agent = ? AND m.read_at IS NULL)
                      OR ((m.task_id IS NULL OR ? IS NULL OR m.task_id = ?) AND (
                        (m.to_agent IS NULL AND m.to_role = ? AND m.read_at IS NULL)
                        OR (m.to_agent IS NULL AND m.to_role = 'all' AND NOT EXISTS
                            (SELECT 1 FROM message_deliveries d WHERE d.message_id = m.id AND d.agent_id = ?))
                      ))
                    )
                  ORDER BY m.created_at LIMIT 20`, runId, agentId, agentId, taskId, taskId, roleName ?? '', agentId).map(rowToMessage);
  const ts = now();
  for (const r of rows) {
    if (r.toRole === 'all') run('INSERT OR IGNORE INTO message_deliveries (message_id, agent_id, delivered_at) VALUES (?,?,?)', r.id, agentId, ts);
    else run('UPDATE agent_messages SET read_at = ? WHERE id = ?', ts, r.id);
  }
  return rows;
}

export function formatInbox(msgs: AgentMessage[]): string {
  if (!msgs.length) return '';
  const name = (id: string) => (q1('SELECT name FROM agents WHERE id = ?', id)?.name as string) ?? id;
  return msgs.map((m) => `[${m.kind}] from ${name(m.fromAgent)}${m.toRole === 'all' ? ' (to everyone)' : ''}: ${m.text}`).join('\n');
}

// Pull messages out of an agent's reply: a "messages" array in its JSON, or
// ===== MESSAGE to=<who> kind=<kind> ===== … ===== END ===== blocks.
export function extractMessages(result: WorkItemResult): { to: string; kind: MessageKind; text: string }[] {
  const raw = (result.raw ?? {}) as Record<string, any>;
  const out: { to: string; kind: MessageKind; text: string }[] = [];
  const arr = (raw.json?.messages ?? raw.messages) as unknown;
  if (Array.isArray(arr)) {
    for (const m of arr) if (m && typeof m.text === 'string') out.push({ to: String(m.to ?? 'all'), kind: (m.kind ?? 'note') as MessageKind, text: m.text });
  }
  const text = typeof raw.text === 'string' ? raw.text : '';
  const re = /={3,}\s*MESSAGE\s+to=(\S+)(?:\s+kind=(\S+))?\s*={3,}\r?\n([\s\S]*?)={3,}\s*END\s*={3,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ to: m[1], kind: (m[2] ?? 'note') as MessageKind, text: m[3].trim() });
  return out.slice(0, 10);
}

export function messagesForRun(runId: string, limit = 500): (AgentMessage & { fromName: string; toName: string | null })[] {
  const names = new Map(q('SELECT id, name FROM agents').map((a) => [a.id as string, a.name as string]));
  return q('SELECT * FROM agent_messages WHERE run_id = ? ORDER BY created_at LIMIT ?', runId, limit).map(rowToMessage)
    .map((m) => ({ ...m, fromName: names.get(m.fromAgent) ?? m.fromAgent, toName: m.toAgent ? (names.get(m.toAgent) ?? m.toAgent) : m.toRole }));
}

export function unreadCountFor(agentId: string): number {
  // only messages that can still be delivered — finished runs never prompt again
  return (q1(`SELECT COUNT(*) c FROM agent_messages m LEFT JOIN runs r ON r.id = m.run_id
              WHERE m.read_at IS NULL AND m.to_agent = ? AND (r.status IS NULL OR r.status NOT IN ('done','stopped'))`, agentId)?.c as number) ?? 0;
}
