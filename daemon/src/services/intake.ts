// Request intake. Before a run exists, the agent the owner chose (the Request node's agent) turns what they typed and
// attached into a structured summary: features, technologies, issues to fix, references, and what is unclear. The owner
// reviews it, accepts or removes items, adds details and asks for another pass. The owner's decisions are enforced here,
// not left to the model: an accepted item is never changed by a later pass, and a removed one never comes back.
// The agent works in a CLI session of its own for the whole draft, and every pass still restates the decisions in its
// prompt, so nothing depends on the session remembering them. Approving starts a normal run whose goal is the result.
import { q, q1, run } from '../db.ts';
import { emit } from '../bus.ts';
import { now, parseJson, ulid } from '../util.ts';
import { candidateForAgent, dispatchThroughAdapter } from './router.ts';
import { archiveSession } from './cli-sessions.ts';
import { getAttachment } from './attachments.ts';
import { getRepo } from '../engine/engine.ts';
import type { Agent, WorkItem, WorkItemResult } from '../types.ts';

export type ItemKind = 'feature' | 'technology' | 'issue' | 'reference' | 'constraint';
export type ItemState = 'proposed' | 'accepted' | 'removed';
export const ITEM_KINDS: ItemKind[] = ['feature', 'technology', 'issue', 'reference', 'constraint'];

export interface IntakeItem {
  id: string; kind: ItemKind; text: string; detail?: string;
  state: ItemState; source: 'agent' | 'owner'; round: number;
}
export interface IntakeConcern { id: string; type: 'unclear' | 'risk' | 'missing' | 'conflict'; text: string }
export interface IntakeNote { round: number; text: string; at: string }
export type DraftStatus = 'analyzing' | 'review' | 'failed' | 'approved' | 'discarded';

export interface Draft {
  id: string; workspaceId: string; repoId: string | null; agentId: string; agentName: string; request: string;
  notes: IntakeNote[]; summary: string; items: IntakeItem[]; concerns: IntakeConcern[]; ready: boolean;
  attachmentIds: string[]; status: DraftStatus; round: number; error: string; costUsd: number; runId: string | null;
  createdAt: string; updatedAt: string;
}

export const LIMITS = { request: 20_000, note: 4_000, item: 400, detail: 600, items: 60, concerns: 10 };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const keyOf = (kind: string, text: string) => `${kind}|${norm(text)}`;
const clip = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function toDraft(r: Record<string, unknown>): Draft {
  return {
    id: r.id as string, workspaceId: r.workspace_id as string, repoId: (r.repo_id as string | null) ?? null, agentId: r.agent_id as string,
    agentName: (q1('SELECT name FROM agents WHERE id = ?', r.agent_id as string)?.name as string) ?? 'agent',
    request: r.request as string, notes: parseJson(r.notes as string, []), summary: (r.summary as string) ?? '',
    items: parseJson(r.items as string, []), concerns: parseJson(r.concerns as string, []), ready: !!r.ready,
    attachmentIds: parseJson(r.attachment_ids as string, []), status: r.status as DraftStatus, round: (r.round as number) ?? 0,
    error: (r.error as string) ?? '', costUsd: (r.cost_usd as number) ?? 0, runId: (r.run_id as string | null) ?? null,
    createdAt: r.created_at as string, updatedAt: r.updated_at as string,
  };
}

export function getDraft(id: string): Draft | null { const r = q1('SELECT * FROM request_drafts WHERE id = ?', id); return r ? toDraft(r) : null; }

export function listDrafts(workspaceId: string): Draft[] {
  return q(`SELECT * FROM request_drafts WHERE workspace_id = ? AND status IN ('analyzing','review','failed') ORDER BY updated_at DESC LIMIT 20`, workspaceId).map(toDraft);
}

const save = (id: string, patch: Record<string, unknown>) => {
  const cols = Object.keys(patch);
  run(`UPDATE request_drafts SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    ...cols.map((c) => (typeof patch[c] === 'object' && patch[c] !== null ? JSON.stringify(patch[c]) : patch[c])), now(), id);
};
const announce = (d: Draft) => emit('intake.updated', 'intake', { draftId: d.id, status: d.status, round: d.round, workspaceId: d.workspaceId });

// ---------- the merge: what the agent may and may not change ----------

export interface ProposedItem { id?: unknown; kind?: unknown; text?: unknown; detail?: unknown }

/**
 * Combine the owner's decisions with the agent's new proposal.
 *  - accepted items stay exactly as they are (text, kind, place), whatever the agent sends;
 *  - removed items stay removed, and an equal item the agent proposes again is dropped;
 *  - open (proposed) items are the agent's to reword, replace or drop — keeping an id updates it in place;
 *  - new items are added at the end, unless they repeat something already there.
 */
export function mergeItems(prev: IntakeItem[], proposed: ProposedItem[], round: number): { items: IntakeItem[]; ignored: number } {
  const byId = new Map(prev.map((i) => [i.id, i]));
  const seen = new Set(prev.filter((i) => i.state !== 'proposed').map((i) => keyOf(i.kind, i.text)));
  const touched = new Set<string>();
  let ignored = 0;
  const updated = new Map<string, IntakeItem>();
  const added: IntakeItem[] = [];
  for (const p of Array.isArray(proposed) ? proposed : []) {
    if (!p || typeof p !== 'object') continue;
    const text = clip(p.text, LIMITS.item);
    if (!text) continue;
    const id = typeof p.id === 'string' ? p.id : '';
    const kind = ITEM_KINDS.includes(p.kind as ItemKind) ? (p.kind as ItemKind) : (id && byId.get(id)?.kind) || 'feature';
    const detail = clip(p.detail, LIMITS.detail) || undefined;
    const cur = id ? byId.get(id) : undefined;
    if (cur) {
      if (cur.state !== 'proposed') { ignored++; continue; }                 // the owner already decided this one
      if (touched.has(cur.id)) continue;
      touched.add(cur.id);
      if (seen.has(keyOf(kind, text))) continue;                              // reworded into something the owner already settled
      seen.add(keyOf(kind, text));
      updated.set(cur.id, { ...cur, kind, text, detail, round });
      continue;
    }
    if (seen.has(keyOf(kind, text))) { ignored++; continue; }
    seen.add(keyOf(kind, text));
    added.push({ id: `i-${ulid().slice(-8).toLowerCase()}`, kind, text, detail, state: 'proposed', source: 'agent', round });
  }
  const kept = prev.flatMap((i) => (i.state !== 'proposed' ? [i] : updated.has(i.id) ? [updated.get(i.id)!] : []));
  return { items: [...kept, ...added].slice(0, LIMITS.items), ignored };
}

// ---------- the prompt ----------

const itemLine = (i: IntakeItem) => `${i.id} | ${i.kind} | ${i.text}${i.detail ? ` — ${i.detail}` : ''}`;

export function buildPrompt(d: Draft, note: string): string {
  const files = d.attachmentIds.map((id) => getAttachment(id)).filter(Boolean).map((a) => `- ${a!.name} (${a!.kind}) — ${a!.path}`);
  const by = (s: ItemState) => d.items.filter((i) => i.state === s);
  const block = (label: string, body: string) => `<${label}>\n${body || '(none)'}\n</${label}>`;
  return [
    `You are the Request analyst of an AI engineering office. The owner describes what they want; before any engineer starts, you turn it into a clear, checked summary they can review. This is pass ${d.round}.`,
    'You only read and think. Do not create, edit or delete any file, do not run the application, do not start any work on the request itself.',
    '',
    'What to do:',
    '1. Read the request and the owner notes, and open the reference files that matter (paths below). If the repository is your working directory, look at the real code to check what the request touches.',
    '2. List what the owner wants as items. kind is one of: feature (something to build or change), technology (a library, framework, API or tool to use or keep using), issue (a bug or problem to fix), reference (a file, link, design or example to follow), constraint (a rule, limit or thing to avoid). One idea per item, plain words, under 25 words. Never invent requirements the owner did not ask for.',
    '3. Validate: say what is unclear, risky, missing or contradictory in `concerns` (type: unclear | risk | missing | conflict) — each one a question or warning the owner can answer, at most 6. Do not guess silently.',
    '4. Write `summary`: two or three sentences saying what will be built, as if for a teammate.',
    '',
    'The owner has already made decisions. Obey them:',
    '- LOCKED_ITEMS are approved. Do not repeat, reword, split or contradict them; build on them.',
    '- RULED_OUT items were rejected. Never propose them or anything equivalent again.',
    '- OPEN_ITEMS are your earlier proposals nobody has judged yet. Keep the ones that still hold (same id, you may sharpen the text), leave out the ones the new information makes wrong, and add new items for what is new.',
    '- Change only what the latest owner note (or the request) asks you to change. Do not re-do the whole analysis.',
    '',
    block('REQUEST', d.request),
    block('OWNER_NOTES', d.notes.map((n) => `pass ${n.round}: ${n.text}`).join('\n')),
    block('LATEST_OWNER_NOTE', note),
    block('REFERENCE_FILES', files.join('\n')),
    block('LOCKED_ITEMS', by('accepted').map(itemLine).join('\n')),
    block('RULED_OUT', by('removed').map((i) => `${i.kind} | ${i.text}`).join('\n')),
    block('OPEN_ITEMS', by('proposed').map(itemLine).join('\n')),
    '',
    'Reply with ONLY one JSON object, no prose around it, no code fence:',
    '{"summary": "...", "items": [{"id": "<id of an OPEN item you are keeping, omit for a new one>", "kind": "feature|technology|issue|reference|constraint", "text": "...", "detail": "<optional, one sentence>"}], "concerns": [{"type": "unclear|risk|missing|conflict", "text": "..."}], "ready": true|false}',
    '`items` holds only OPEN and new items — never the locked ones. `ready` is true only when nothing important is left unclear.',
  ].join('\n');
}

// ---------- running the agent ----------

const running = new Set<string>();

function parseAnswer(r: WorkItemResult): { summary: string; items: ProposedItem[]; concerns: IntakeConcern[]; ready: boolean } | null {
  const raw = (r.raw ?? {}) as { json?: unknown; text?: string };
  const j = (raw.json && typeof raw.json === 'object' ? raw.json : null) as Record<string, unknown> | null;
  if (!j || !Array.isArray(j.items)) return null;
  const concerns = (Array.isArray(j.concerns) ? j.concerns : []).slice(0, LIMITS.concerns).flatMap((c: any): IntakeConcern[] => {
    const text = clip(c?.text ?? (typeof c === 'string' ? c : ''), LIMITS.item);
    return text ? [{ id: `c-${ulid().slice(-8).toLowerCase()}`, type: ['unclear', 'risk', 'missing', 'conflict'].includes(c?.type) ? c.type : 'unclear', text }] : [];
  });
  return { summary: clip(j.summary, 1200), items: j.items as ProposedItem[], concerns, ready: j.ready === true };
}

async function analyze(id: string, note: string): Promise<void> {
  if (running.has(id)) return;
  running.add(id);
  try {
    let d = getDraft(id)!;
    const cand = candidateForAgent(d.workspaceId, d.agentId);
    if (!cand) throw new Error(`${d.agentName} is not part of this office, so it cannot analyse the request`);
    if (cand.blocked) throw new Error(`${d.agentName} is unavailable: ${cand.blocked}`);
    const repo = getRepo(d.repoId);
    let answer: ReturnType<typeof parseAnswer> = null;
    let cost = 0;
    for (let attempt = 0; attempt < 2 && !answer; attempt++) {
      const prompt = buildPrompt(d, note) + (attempt ? '\n\nYour previous reply was not a valid JSON object with an "items" array. Reply again with only that JSON object.' : '');
      const wi = {
        id: `wi-${ulid()}`, taskId: null, runId: `intake-${d.id}`, kind: 'analyse', agentId: d.agentId, accountId: cand.account?.id ?? null,
        modelId: cand.model?.id ?? null, promptVersionId: null, idempotencyKey: `${d.id}:${d.round}:${attempt}`, cacheKey: null, status: 'running',
        startedAt: now(), heartbeatAt: now(), finishedAt: null, result: null, adapterRef: null, errorSignature: null, attempt: d.round,
        workflowNodeId: null, workflowEdgeId: null,
      } as WorkItem;
      const { result } = await dispatchThroughAdapter({
        workItem: wi, task: null, prompt, worktree: null,
        repo: repo ?? null,
        emit: (type, payload) => { if (type !== 'agent.heartbeat') emit(type, cand.agent.name, { draftId: d.id, ...payload }, null, d.id); },
      }, cand, [], undefined, d.workspaceId);
      cost += result.usage?.costUsd ?? 0;
      answer = parseAnswer(result);
    }
    if (!answer) throw new Error(`${d.agentName} did not return a usable summary — try again, or choose another agent`);
    d = getDraft(id)!;
    const merged = mergeItems(d.items, answer.items, d.round);
    save(id, { summary: answer.summary || d.summary, items: merged.items, concerns: answer.concerns, ready: answer.ready ? 1 : 0, status: 'review', error: '', cost_usd: d.costUsd + cost });
    if (merged.ignored) emit('intake.kept', 'intake', { draftId: id, ignored: merged.ignored, note: 'the agent tried to change items the owner had already decided; they were kept as they were' });
  } catch (e) {
    save(id, { status: 'failed', error: String((e as Error)?.message ?? e).slice(0, 400) });
  } finally {
    running.delete(id);
    const d = getDraft(id); if (d) announce(d);
  }
}

// ---------- the owner's side ----------

export interface Failure { error: string; status: number }
const fail = (status: number, error: string): Failure => ({ status, error });

/** Agents that can be chosen for the Request step: every agent in the office that can be reached right now. */
export function intakeAgents(workspaceId: string): { id: string; name: string; provider: string; roles: string[]; available: boolean; reason?: string }[] {
  const ids = q('SELECT DISTINCT agent_id FROM memberships WHERE workspace_id = ? AND active = 1', workspaceId).map((r) => r.agent_id as string);
  return ids.flatMap((id) => {
    const a = q1('SELECT * FROM agents WHERE id = ?', id) as Record<string, unknown> | undefined;
    if (!a) return [];
    const cand = candidateForAgent(workspaceId, id);
    const roles = q(`SELECT r.name FROM memberships m JOIN roles r ON r.id = m.role_id WHERE m.agent_id = ? AND m.workspace_id = ? AND m.active = 1`, id, workspaceId).map((r) => r.name as string);
    return [{ id, name: a.name as string, provider: cand?.provider?.name ?? '', roles, available: !!cand && !cand.blocked, reason: cand?.blocked ?? (cand ? undefined : 'not in this office') }];
  });
}

export function startDraft(i: { workspaceId: string; repoId?: string | null; agentId: string; request: unknown; attachmentIds?: unknown }): Draft | Failure {
  if (!q1('SELECT id FROM workspaces WHERE id = ?', i.workspaceId)) return fail(404, 'office not found');
  const request = String(i.request ?? '').trim();
  if (!request) return fail(400, 'describe what you need first');
  if (request.length > LIMITS.request) return fail(400, `the request is longer than ${LIMITS.request} characters`);
  if (!i.agentId || !q1('SELECT id FROM agents WHERE id = ?', i.agentId)) return fail(400, 'choose an agent to analyse the request');
  const cand = candidateForAgent(i.workspaceId, i.agentId);
  if (!cand) return fail(400, 'that agent is not part of this office');
  if (cand.blocked) return fail(400, `that agent is unavailable: ${cand.blocked}`);
  if (i.repoId && !q1('SELECT id FROM repos WHERE id = ?', i.repoId)) return fail(400, 'repository not found');
  const atts = (Array.isArray(i.attachmentIds) ? i.attachmentIds.map(String) : []).slice(0, 50).filter((a) => getAttachment(a));
  const id = ulid();
  run(`INSERT INTO request_drafts (id, workspace_id, repo_id, agent_id, request, attachment_ids, status, round, created_at, updated_at) VALUES (?,?,?,?,?,?, 'analyzing', 1, ?, ?)`,
    id, i.workspaceId, i.repoId ?? null, i.agentId, request, JSON.stringify(atts), now(), now());
  const d = getDraft(id)!;
  announce(d);
  void analyze(id, '');
  return d;
}

export interface Revision {
  request?: unknown; note?: unknown; reanalyze?: unknown; attachmentIds?: unknown;
  edits?: { id?: unknown; state?: unknown; text?: unknown; kind?: unknown }[];
  add?: { kind?: unknown; text?: unknown }[];
}

/** The owner's changes: decisions on items, new items, extra details, then (optionally) another pass by the agent. */
export function reviseDraft(id: string, b: Revision): Draft | Failure {
  const d = getDraft(id);
  if (!d) return fail(404, 'draft not found');
  if (d.status === 'analyzing') return fail(409, 'the agent is still working — wait for it to finish');
  if (d.status === 'approved' || d.status === 'discarded') return fail(409, `this request was already ${d.status}`);
  const items = d.items.map((i) => ({ ...i }));
  for (const e of Array.isArray(b.edits) ? b.edits : []) {
    const it = items.find((x) => x.id === e.id);
    if (!it) return fail(400, `item ${String(e.id)} not found`);
    if (e.state !== undefined) {
      if (!['proposed', 'accepted', 'removed'].includes(String(e.state))) return fail(400, 'state must be proposed, accepted or removed');
      it.state = e.state as ItemState;
    }
    if (e.kind !== undefined) {
      if (!ITEM_KINDS.includes(e.kind as ItemKind)) return fail(400, `kind must be one of ${ITEM_KINDS.join(', ')}`);
      it.kind = e.kind as ItemKind;
    }
    if (e.text !== undefined) {
      const t = clip(e.text, LIMITS.item);
      if (!t) return fail(400, 'an item needs some text');
      if (t !== it.text) { it.text = t; it.detail = undefined; it.source = 'owner'; if (it.state === 'proposed') it.state = 'accepted'; }   // what the owner wrote is theirs, so it is locked
    }
  }
  for (const a of Array.isArray(b.add) ? b.add : []) {
    const t = clip(a.text, LIMITS.item);
    if (!t) return fail(400, 'a new item needs some text');
    const kind = ITEM_KINDS.includes(a.kind as ItemKind) ? (a.kind as ItemKind) : 'feature';
    if (items.some((x) => x.state !== 'removed' && keyOf(x.kind, x.text) === keyOf(kind, t))) continue;
    items.push({ id: `i-${ulid().slice(-8).toLowerCase()}`, kind, text: t, state: 'accepted', source: 'owner', round: d.round });
  }
  if (items.length > LIMITS.items) return fail(400, `at most ${LIMITS.items} items — remove some first`);
  const patch: Record<string, unknown> = { items };
  if (b.request !== undefined) {
    const r = String(b.request).trim();
    if (!r) return fail(400, 'the request cannot be empty');
    if (r.length > LIMITS.request) return fail(400, `the request is longer than ${LIMITS.request} characters`);
    patch.request = r;
  }
  if (Array.isArray(b.attachmentIds)) patch.attachment_ids = b.attachmentIds.map(String).slice(0, 50).filter((a) => getAttachment(a));
  const note = String(b.note ?? '').trim();
  if (note.length > LIMITS.note) return fail(400, `a note can be at most ${LIMITS.note} characters`);
  const again = b.reanalyze === true;
  if (again) {
    const cand = candidateForAgent(d.workspaceId, d.agentId);
    if (!cand || cand.blocked) return fail(400, `${d.agentName} is unavailable${cand?.blocked ? `: ${cand.blocked}` : ''}`);
    patch.status = 'analyzing'; patch.round = d.round + 1; patch.error = '';
  }
  if (note) patch.notes = [...d.notes, { round: again ? d.round + 1 : d.round, text: note, at: now() }];
  save(id, patch);
  const next = getDraft(id)!;
  announce(next);
  if (again) void analyze(id, note);
  return next;
}

/** The request as the run's goal: what the owner wrote, then the reviewed breakdown. */
export function composeGoal(d: Draft): string {
  const live = d.items.filter((i) => i.state !== 'removed');
  const section = (title: string, kind: ItemKind) => {
    const list = live.filter((i) => i.kind === kind);
    return list.length ? [`### ${title}`, ...list.map((i) => `- ${i.text}${i.detail ? ` (${i.detail})` : ''}`), ''] : [];
  };
  const out = [d.request.trim()];
  if (live.length || d.summary) {
    out.push('', '## Request breakdown (reviewed and approved by the owner before work started)');
    if (d.summary) out.push(d.summary, '');
    out.push(...section('Features', 'feature'), ...section('Technologies', 'technology'), ...section('Issues to fix', 'issue'), ...section('References', 'reference'), ...section('Constraints', 'constraint'));
    const ruled = d.items.filter((i) => i.state === 'removed');
    if (ruled.length) out.push('### Ruled out by the owner — do not do these', ...ruled.map((i) => `- ${i.text}`), '');
  }
  if (d.notes.length) out.push('### More details from the owner', ...d.notes.map((n) => `- ${n.text}`), '');
  return out.join('\n').trim();
}

/** Approve: the caller starts the run with this goal, then reports its id back with `markApproved`. */
export function approvable(id: string): { draft: Draft; goal: string } | Failure {
  const d = getDraft(id);
  if (!d) return fail(404, 'draft not found');
  if (d.status === 'analyzing') return fail(409, 'the agent is still working — wait for it to finish');
  if (d.status === 'approved') return fail(409, 'this request was already approved');
  if (d.status === 'discarded') return fail(409, 'this request was discarded');
  return { draft: d, goal: composeGoal(d) };
}

export function markApproved(id: string, runId: string): void {
  save(id, { status: 'approved', run_id: runId });
  retireSession(id);
  const d = getDraft(id); if (d) announce(d);
}

export function discardDraft(id: string): { ok: true } | Failure {
  const d = getDraft(id);
  if (!d) return fail(404, 'draft not found');
  if (d.status === 'approved') return fail(409, 'this request was already approved');
  save(id, { status: 'discarded' });
  retireSession(id);
  announce(getDraft(id)!);
  return { ok: true };
}

/** The draft's own CLI session is done with: retire it (the CLI keeps its copy of the conversation). */
function retireSession(id: string): void {
  for (const s of q(`SELECT id, busy_item FROM cli_sessions WHERE owner_key = ? AND status = 'active'`, `intake-${id}`)) {
    if (!s.busy_item) archiveSession(s.id as string, 'the request was finished');
  }
}

/** A daemon that stopped mid-analysis leaves drafts "analyzing" that nothing is working on. */
export function recoverDrafts(): void {
  run(`UPDATE request_drafts SET status = 'failed', error = 'the daemon restarted while the agent was working — run it again' WHERE status = 'analyzing'`);
}

export const intakeSessions = (id: string) => q(`SELECT id, label, status, uses, external_id FROM cli_sessions WHERE owner_key = ?`, `intake-${id}`);
export type { Agent };
