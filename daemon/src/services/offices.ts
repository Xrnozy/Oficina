// Offices: a workspace with its own agents (memberships), roles and workflows.
// Create blank, clone an existing one, rename, delete, and export/import a whole
// office — or a single workflow — as portable JSON. Agents are referenced by
// name in a bundle (ids are local to a machine), so a flow lands on whichever
// agent of that name the target office has, or falls back to the node's role.
import { q, q1, run } from '../db.ts';
import { emit } from '../bus.ts';
import { now, parseJson, ulid } from '../util.ts';
import {
  createWorkflow, ensureBuiltinWorkflow, getWorkflow, listWorkflows, setActiveWorkflow,
  type WfGraph, type WfNode,
} from './workflow.ts';

type Row = Record<string, unknown>;

const OFFICE_FORMAT = 'officechain.office';
const WORKFLOW_FORMAT = 'officechain.workflow';
// settings that travel with an office; the active-workflow pointer is rebuilt on import
const PORTABLE_SETTINGS = ['promptReview', 'selfReview', 'confirmPlan', 'routing', 'workMode', 'commitMode', 'approvalMode'];

const clean = (s: unknown, max: number): string => String(s ?? '').trim().slice(0, max);
const roleIdByName = (name: string): string | null => (q1('SELECT id FROM roles WHERE name = ? OR id = ?', name, name)?.id as string) ?? null;

// ---------- graph <-> portable ----------

function mapNodes(graph: WfGraph, f: (n: WfNode) => WfNode): WfGraph {
  return { ...graph, nodes: graph.nodes.map(f) };
}

/** Replace local agent ids with agent names (and keep the role as a fallback). */
function toPortable(graph: WfGraph, wsId: string): WfGraph {
  return mapNodes(graph, (n) => {
    if (!n.agentId) return n;
    const a = q1('SELECT name FROM agents WHERE id = ?', n.agentId);
    const m = q1(`SELECT r.name FROM memberships m JOIN roles r ON r.id = m.role_id WHERE m.agent_id = ? AND m.workspace_id = ? AND m.active = 1`, n.agentId, wsId);
    const { agentId: _drop, ...rest } = n;
    return { ...rest, role: n.role ?? (m?.name as string | undefined), agent: (a?.name as string | undefined) } as WfNode;
  });
}

/** Resolve portable agent names to ids in `wsId` (plus any agents just created); otherwise fall back to the role. */
function fromPortable(graph: WfGraph, byName: Map<string, string>, warnings: string[], flowName: string): WfGraph {
  return mapNodes(graph, (n) => {
    const { agent, ...rest } = n as WfNode & { agent?: string };
    if (n.type !== 'agent') { const { agentId: _a, role: _r, ...plain } = rest; return plain as WfNode; }
    const id = agent ? byName.get(agent.toLowerCase()) : undefined;
    if (id) return { ...rest, agentId: id } as WfNode;
    delete (rest as Partial<WfNode>).agentId;
    if (agent) warnings.push(`${flowName}: "${agent}" is not in this office${rest.role ? ` — step "${n.label}" now uses the ${rest.role} role` : ` — step "${n.label}" has no agent`}`);
    return rest as WfNode;
  });
}

const agentNames = (wsId: string): Map<string, string> => {
  const m = new Map<string, string>();
  for (const r of q(`SELECT DISTINCT a.id, a.name FROM agents a JOIN memberships ms ON ms.agent_id = a.id WHERE ms.workspace_id = ? AND ms.active = 1 ORDER BY a.rowid`, wsId)) {
    const k = String(r.name).toLowerCase();
    if (!m.has(k)) m.set(k, r.id as string);
  }
  return m;
};

// ---------- create / clone / rename / delete ----------

export function createOffice(opts: { name: string; purpose?: string; cloneFrom?: string | null }): { id: string; warnings: string[] } | { error: string } {
  const name = clean(opts.name, 80);
  if (!name) return { error: 'name required' };
  if (q1('SELECT id FROM workspaces WHERE lower(name) = lower(?)', name)) return { error: `an office named "${name}" already exists` };
  const src = opts.cloneFrom ? q1('SELECT * FROM workspaces WHERE id = ?', opts.cloneFrom) : null;
  if (opts.cloneFrom && !src) return { error: 'office to clone not found' };

  const id = `ws-${ulid().slice(-10).toLowerCase()}`;
  const settings = src ? parseJson<Record<string, unknown>>(src.settings as string, {}) : {};
  delete settings.activeWorkflowId;
  run(`INSERT INTO workspaces (id, name, purpose, repo_ids, allowed_provider_ids, policy_id, memory_scope, settings) VALUES (?,?,?,?,?,?,?,?)`,
    id, name, clean(opts.purpose, 240), '[]', src ? (src.allowed_provider_ids as string) : '[]', (src?.policy_id as string) ?? 'pol-default', (src?.memory_scope as string) ?? 'isolated', JSON.stringify(settings));
  ensureBuiltinWorkflow(id);
  const warnings: string[] = [];

  if (src) {
    // copies, not shares: each office owns its agents, so editing one never touches the other
    const copy = new Map<string, string>();
    for (const m of q('SELECT * FROM memberships WHERE workspace_id = ? AND active = 1 ORDER BY rowid', src.id as string)) {
      let nid = copy.get(m.agent_id as string);
      if (!nid) {
        const a = q1('SELECT * FROM agents WHERE id = ?', m.agent_id as string);
        if (!a) continue;
        nid = ulid();
        run(`INSERT INTO agents (id, name, avatar, account_id, model_id, settings, instructions, skill_version_ids, caps, observability, status)
             VALUES (?,?,?,?,?,?,?,?,?,?,'idle')`, nid, a.name, a.avatar, a.account_id, a.model_id, a.settings, a.instructions, a.skill_version_ids, a.caps, a.observability);
        copy.set(m.agent_id as string, nid);
      }
      run(`INSERT INTO memberships (id, agent_id, workspace_id, role_id, active_since, max_concurrent_tasks, active, context_scope, team)
           VALUES (?,?,?,?,?,?,1,?,?)`, ulid(), nid, id, m.role_id, now(), m.max_concurrent_tasks ?? 1, m.context_scope ?? 'task', m.team ?? null);
    }
    const srcActive = parseJson<Record<string, unknown>>(src.settings as string, {}).activeWorkflowId;
    for (const w of listWorkflows(src.id as string).filter((x) => !x.builtin)) {
      const g = getWorkflow(w.id)?.graph;
      if (!g) continue;
      const mapped = mapNodes(g, (n) => {
        if (!n.agentId) return n;
        const to = copy.get(n.agentId);
        if (to) return { ...n, agentId: to };
        const { agentId: _d, ...rest } = n;
        return rest as WfNode;
      });
      const r = createWorkflow(id, w.name, w.description, mapped);
      if ('error' in r) { warnings.push(`${w.name}: ${r.error}`); continue; }
      if (srcActive === w.id) setActiveWorkflow(id, r.workflowId);
    }
  }
  emit('workspace.created', 'owner', { workspaceId: id, name, clonedFrom: src?.id ?? null });
  return { id, warnings };
}

export function updateOffice(id: string, patch: { name?: string; purpose?: string }): { ok: true } | { error: string } {
  if (!q1('SELECT id FROM workspaces WHERE id = ?', id)) return { error: 'office not found' };
  if (patch.name != null) {
    const name = clean(patch.name, 80);
    if (!name) return { error: 'name required' };
    if (q1('SELECT id FROM workspaces WHERE lower(name) = lower(?) AND id != ?', name, id)) return { error: `an office named "${name}" already exists` };
    run('UPDATE workspaces SET name = ? WHERE id = ?', name, id);
  }
  if (patch.purpose != null) run('UPDATE workspaces SET purpose = ? WHERE id = ?', clean(patch.purpose, 240), id);
  emit('workspace.updated', 'owner', { workspaceId: id });
  return { ok: true };
}

export function deleteOffice(id: string): { ok: true } | { error: string } {
  const ws = q1('SELECT * FROM workspaces WHERE id = ?', id);
  if (!ws) return { error: 'office not found' };
  if ((q1('SELECT COUNT(*) c FROM workspaces')?.c as number) <= 1) return { error: 'keep at least one office' };
  if (q1('SELECT id FROM runs WHERE workspace_id = ? LIMIT 1', id)) return { error: 'this office has runs — they are kept for the record, so the office can\'t be deleted' };
  for (const w of q('SELECT id FROM workflows WHERE workspace_id = ?', id)) run('DELETE FROM workflow_versions WHERE workflow_id = ?', w.id as string);
  run('DELETE FROM workflows WHERE workspace_id = ?', id);
  run('DELETE FROM memberships WHERE workspace_id = ?', id);
  run('DELETE FROM repos WHERE workspace_id = ?', id);
  run('DELETE FROM workspaces WHERE id = ?', id);
  emit('workspace.deleted', 'owner', { workspaceId: id, name: ws.name });
  return { ok: true };
}

// ---------- export / import ----------

export function exportWorkflow(workflowId: string): Row | null {
  const w = getWorkflow(workflowId);
  if (!w?.graph) return null;
  return {
    format: WORKFLOW_FORMAT, version: 1, exportedAt: now(),
    name: w.workflow.name, description: w.workflow.description,
    graph: toPortable(w.graph, w.workflow.workspaceId),
  };
}

export function importWorkflow(wsId: string, bundle: unknown, opts: { name?: string } = {}): { workflowId: string; warnings: string[] } | { error: string } {
  if (!q1('SELECT id FROM workspaces WHERE id = ?', wsId)) return { error: 'office not found' };
  const b = bundle as Row | null;
  // accept our bundle, or a bare { nodes, edges } graph (older exports)
  const graph = (b && typeof b === 'object' ? (b.graph ?? (Array.isArray(b.nodes) ? b : null)) : null) as WfGraph | null;
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return { error: 'not a workflow file (no graph with nodes and edges)' };
  if (b?.format && b.format !== WORKFLOW_FORMAT) return { error: `this file is a "${String(b.format)}", not a workflow` };
  const warnings: string[] = [];
  const name = clean(opts.name ?? b?.name, 80) || 'Imported workflow';
  const r = createWorkflow(wsId, name, clean(b?.description, 240), fromPortable(graph, agentNames(wsId), warnings, name));
  if ('error' in r) return r;
  return { workflowId: r.workflowId, warnings };
}

export function exportOffice(wsId: string): Row | null {
  const ws = q1('SELECT * FROM workspaces WHERE id = ?', wsId);
  if (!ws) return null;
  const settings = parseJson<Record<string, unknown>>(ws.settings as string, {});
  const portable: Row = {};
  for (const k of PORTABLE_SETTINGS) if (settings[k] !== undefined) portable[k] = settings[k];

  const agents: Row[] = [];
  const seen = new Set<string>();
  for (const m of q('SELECT agent_id FROM memberships WHERE workspace_id = ? AND active = 1 ORDER BY rowid', wsId)) {
    const aid = m.agent_id as string;
    if (seen.has(aid)) continue;
    seen.add(aid);
    const a = q1('SELECT * FROM agents WHERE id = ?', aid);
    if (!a) continue;
    const { fallbacks: _f, ...agentSettings } = parseJson<Record<string, unknown>>(a.settings as string, {});   // fallbacks name this machine's model ids
    agents.push({
      name: a.name, avatar: a.avatar, instructions: a.instructions, observability: a.observability,
      caps: parseJson(a.caps as string, {}), settings: agentSettings,
      roles: q(`SELECT r.name FROM memberships m JOIN roles r ON r.id = m.role_id WHERE m.agent_id = ? AND m.workspace_id = ? AND m.active = 1`, aid, wsId).map((r) => r.name),
    });
  }
  const active = settings.activeWorkflowId;
  const workflows = listWorkflows(wsId).filter((w) => !w.builtin).map((w) => ({
    name: w.name, description: w.description, active: w.id === active,
    graph: toPortable(getWorkflow(w.id)!.graph ?? { nodes: [], edges: [] }, wsId),
  }));
  return {
    format: OFFICE_FORMAT, version: 1, exportedAt: now(),
    office: { name: ws.name, purpose: ws.purpose, settings: portable },
    agents, workflows,
  };
}

export function importOffice(bundle: unknown, opts: { name?: string } = {}): { id: string; warnings: string[] } | { error: string } {
  const b = bundle as Row | null;
  if (!b || b.format !== OFFICE_FORMAT) return { error: 'not an office file (expected format "officechain.office")' };
  const office = (b.office ?? {}) as Row;
  const agents = Array.isArray(b.agents) ? (b.agents as Row[]) : [];
  const workflows = Array.isArray(b.workflows) ? (b.workflows as Row[]) : [];
  if (agents.length > 60 || workflows.length > 60) return { error: 'file is too large to be an office (over 60 agents or flows)' };

  let name = clean(opts.name ?? office.name, 80) || 'Imported office';
  const base = name;
  for (let i = 2; q1('SELECT id FROM workspaces WHERE lower(name) = lower(?)', name); i++) name = `${base} (${i})`;
  const created = createOffice({ name, purpose: clean(office.purpose, 240) });
  if ('error' in created) return created;
  const wsId = created.id;
  const warnings = created.warnings;

  const settings = parseJson<Record<string, unknown>>(q1('SELECT settings FROM workspaces WHERE id = ?', wsId)?.settings as string, {});
  const incoming = (office.settings ?? {}) as Row;
  for (const k of PORTABLE_SETTINGS) if (incoming[k] !== undefined) settings[k] = incoming[k];
  run('UPDATE workspaces SET settings = ? WHERE id = ?', JSON.stringify(settings), wsId);

  // backends are machine-specific: new agents start on this machine's first enabled account
  const acct = q1('SELECT id, provider_id FROM accounts WHERE enabled = 1 LIMIT 1');
  const model = acct ? q1('SELECT id FROM models WHERE provider_id = ? LIMIT 1', acct.provider_id as string) : null;
  const byName = new Map<string, string>();
  for (const a of agents) {
    const aname = clean(a.name, 80);
    if (!aname) continue;
    const aid = ulid();
    run(`INSERT INTO agents (id, name, avatar, account_id, model_id, settings, instructions, caps, observability, status)
         VALUES (?,?,?,?,?,?,?,?,?,'idle')`, aid, aname, clean(a.avatar, 16), acct?.id ?? null, model?.id ?? null,
      JSON.stringify((a.settings as Row) ?? {}), clean(a.instructions, 20000), JSON.stringify((a.caps as Row) ?? { perTaskUsd: 10, perDayUsd: 50, maxTokensPerCall: 128000 }),
      ['actions', 'summary', 'full'].includes(String(a.observability)) ? String(a.observability) : 'actions');
    if (!byName.has(aname.toLowerCase())) byName.set(aname.toLowerCase(), aid);
    for (const rn of Array.isArray(a.roles) ? (a.roles as unknown[]) : []) {
      const rid = roleIdByName(String(rn));
      if (!rid) { warnings.push(`${aname}: role "${String(rn)}" does not exist here — skipped`); continue; }
      run(`INSERT INTO memberships (id, agent_id, workspace_id, role_id, active_since, max_concurrent_tasks, active) VALUES (?,?,?,?,?,1,1)`, ulid(), aid, wsId, rid, now());
    }
  }
  for (const w of workflows) {
    const g = w.graph as WfGraph | undefined;
    if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) { warnings.push(`${clean(w.name, 80)}: no graph — skipped`); continue; }
    const wname = clean(w.name, 80) || 'Imported workflow';
    const r = createWorkflow(wsId, wname, clean(w.description, 240), fromPortable(g, byName, warnings, wname));
    if ('error' in r) { warnings.push(`${wname}: ${r.error}`); continue; }
    if (w.active) setActiveWorkflow(wsId, r.workflowId);
  }
  emit('workspace.imported', 'owner', { workspaceId: wsId, name, agents: agents.length, workflows: workflows.length, warnings: warnings.length });
  return { id: wsId, warnings };
}
