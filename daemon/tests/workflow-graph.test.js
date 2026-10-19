// Visual routing phase 1: graph validation rules, the built-in default
// workflow, immutable versioning, clone/activate — all before the engine
// touches graphs (no behavior change yet).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-wfg-'));
const { q1, run } = await import('../src/db.ts');
const {
  defaultWorkflowGraph, validateWorkflow, ensureBuiltinWorkflow, listWorkflows,
  createWorkflow, saveWorkflowVersion, cloneWorkflow, deleteWorkflow,
  setActiveWorkflow, activeWorkflowFor, getWorkflow,
} = await import('../src/services/workflow.ts');

run(`INSERT INTO workspaces (id, name, settings) VALUES ('ws-wf', 'Wf', '{}')`);
// the default graph names roles — all of them must exist for validation
for (const r of ['pm', 'prompt-creator', 'developer', 'qa', 'analyst', 'reviewer', 'docs'])
  run(`INSERT INTO roles (id, name) VALUES (?, ?)`, `role-${r}`, r);
run(`INSERT INTO agents (id, name) VALUES ('ag-x', 'Agent X')`);
run(`INSERT INTO memberships (id, agent_id, workspace_id, role_id, active) VALUES ('m-x', 'ag-x', 'ws-wf', 'role-qa', 1)`);
ensureBuiltinWorkflow('ws-wf');

const g = defaultWorkflowGraph();
const n = (id, extra = {}) => ({ id, type: 'agent', label: id, role: 'qa', config: { purpose: 'qa' }, position: { x: 0, y: 0 }, ...extra });
const e = (id, from, to, kind = 'next', extra = {}) => ({ id, from, to, kind, ...extra });
const errs = (issues) => issues.filter((i) => i.level === 'error').map((i) => i.message).join(' | ');
const warnFor = (issues, nodeId) => issues.find((i) => i.level === 'warning' && i.nodeId === nodeId);

test('the built-in default graph passes validation and mirrors the pipeline', () => {
  const issues = validateWorkflow(g, 'ws-wf');
  assert.equal(errs(issues), '');
  const roles = g.nodes.map((x) => x.role);
  for (const r of ['pm', 'prompt-creator', 'developer', 'qa', 'analyst', 'reviewer']) assert.ok(roles.includes(r), `missing role ${r}`);
  const purposes = g.nodes.map((x) => x.config?.purpose);
  for (const p of ['plan', 'prompt', 'prompt-review', 'implement', 'qa', 'analyse', 'fix', 'review', 'accept']) assert.ok(purposes.includes(p), `missing purpose ${p}`);
  // the fix / review / send-back loops exist and are all loop-kind edges
  const loops = g.edges.filter((x) => x.kind === 'on-reject' || x.kind === 'on-failure');
  assert.ok(loops.length >= 4);
});

test('validation: exactly one start, reachability, path to end', () => {
  const two = { nodes: [...g.nodes, { id: 'start2', type: 'start', label: 's2', position: { x: 0, y: 0 } }], edges: g.edges };
  assert.match(errs(validateWorkflow(two, 'ws-wf')), /exactly one start/);

  const loner = { nodes: [...g.nodes, n('orphan')], edges: g.edges };
  assert.match(errs(validateWorkflow(loner, 'ws-wf')), /not reachable/);

  const noEnd = { nodes: g.nodes.filter((x) => x.id !== 'end'), edges: g.edges.filter((x) => x.to !== 'end') };
  assert.match(errs(validateWorkflow(noEnd, 'ws-wf')), /end node required|no path from start/);
});

test('validation: condition needs exactly one else edge and conditions on the rest', () => {
  const cond = { nodes: [...g.nodes, { id: 'c1', type: 'condition', label: 'if', position: { x: 0, y: 0 } }],
    edges: [...g.edges, e('ec1', 'reviewer', 'c1'), e('ec2', 'c1', 'pm-accept', 'next', { condition: { field: 'verdict', op: 'eq', value: 'approve' } })] };
  assert.match(errs(validateWorkflow(cond, 'ws-wf')), /exactly one else/);
  const fixed = { ...cond, edges: [...cond.edges, e('ec3', 'c1', 'end', 'next', { else: true })] };
  assert.equal(errs(validateWorkflow(fixed, 'ws-wf')), '');
});

test('validation: cycles only close through on-failure/on-reject edges', () => {
  const bad = { nodes: [...g.nodes, n('extra')],
    edges: [...g.edges, e('eb1', 'dev', 'extra'), e('eb2', 'extra', 'dev', 'next')] };
  assert.match(errs(validateWorkflow(bad, 'ws-wf')), /on-failure\/on-reject/);
  const ok = { ...bad, edges: bad.edges.map((x) => x.id === 'eb2' ? { ...x, kind: 'on-failure' } : x) };
  assert.equal(errs(validateWorkflow(ok, 'ws-wf')), '');
});

test('validation: referenced agents and roles must exist; unknown refs error', () => {
  const badRole = { nodes: [...g.nodes, { ...n('bad'), role: 'nope' }], edges: [...g.edges, e('eb', 'dev', 'bad')] };
  assert.match(errs(validateWorkflow(badRole, 'ws-wf')), /role "nope" does not exist/);
  const badAgent = { nodes: [...g.nodes, n('bad2', { agentId: 'ag-nope', role: undefined })], edges: [...g.edges, e('eb2', 'dev', 'bad2')] };
  assert.match(errs(validateWorkflow(badAgent, 'ws-wf')), /does not exist/);
});

test('validation: separation of duties — same pinned agent cannot write and review', () => {
  const sod = {
    nodes: [...g.nodes, n('w', { agentId: 'ag-x', role: undefined, config: { purpose: 'implement' } }), n('rv', { agentId: 'ag-x', role: undefined, config: { purpose: 'review' } })],
    edges: [...g.edges, e('ew', 'dev', 'w'), e('ew2', 'w', 'rv'), e('ew3', 'rv', 'pm-accept')],
  };
  assert.match(errs(validateWorkflow(sod, 'ws-wf')), /separation of duties/);
  const distinct = { ...sod, nodes: sod.nodes.map((x) => x.id === 'rv' ? { ...x, agentId: undefined, role: 'reviewer' } : x) };
  assert.equal(errs(validateWorkflow(distinct, 'ws-wf')), '');
});

test('builtin workflow is created per workspace, read-only, cloneable', () => {
  const list = listWorkflows('ws-wf');
  const b = list.find((w) => w.builtin);
  assert.ok(b, 'builtin present');
  assert.equal(b.versionN, 1);
  const upd = saveWorkflowVersion(b.id, g, 'edit attempt');
  assert.match(upd.error, /read-only/);
  const del = deleteWorkflow(b.id);
  assert.match(del.error, /cannot be deleted/);
  const c = cloneWorkflow(b.id, 'My copy');
  assert.ok(c.workflowId);
  const copy = getWorkflow(c.workflowId);
  assert.equal(copy.workflow.name, 'My copy');
  assert.equal(copy.versions.length, 1);
  assert.equal(copy.graph.nodes.length, g.nodes.length);
});

test('saveWorkflowVersion creates immutable versions; activate/deactivate resolves the graph', () => {
  const c = cloneWorkflow('wf-builtin-ws-wf');
  const id = c.workflowId;
  const g2 = { ...g, nodes: [...g.nodes, n('docs2', { role: 'docs', config: { purpose: 'doc' } })], edges: [...g.edges, e('ex', 'dev', 'docs2'), e('ex2', 'docs2', 'qa')] };
  const s = saveWorkflowVersion(id, g2, 'add docs node');
  assert.equal(s.version.n, 2);
  const w = getWorkflow(id);
  assert.equal(w.versions.length, 2);
  assert.equal(w.graph.nodes.length, g.nodes.length + 1);
  // version 1 stays untouched
  const v1 = q1('SELECT graph FROM workflow_versions WHERE workflow_id = ? AND n = 1', id);
  assert.equal(JSON.parse(v1.graph).nodes.length, g.nodes.length);
  // an invalid graph is refused without a new version
  const bad = saveWorkflowVersion(id, { nodes: [], edges: [] }, 'bad');
  assert.match(bad.error, /validation failed/);
  assert.equal(getWorkflow(id).versions.length, 2);
  // activate resolves latest version; deactivate returns null
  assert.equal(setActiveWorkflow('ws-wf', id).ok, true);
  const act = activeWorkflowFor('ws-wf');
  assert.equal(act.workflowId, id);
  assert.equal(act.graph.nodes.length, g.nodes.length + 1);
  assert.equal(setActiveWorkflow('ws-wf', null).ok, true);
  assert.equal(activeWorkflowFor('ws-wf'), null);
});

test('a workflow used by a run cannot be deleted', () => {
  const c = cloneWorkflow('wf-builtin-ws-wf');
  const vId = getWorkflow(c.workflowId).workflow.latestVersionId;
  run(`INSERT INTO runs (id, workspace_id, goal, workflow_version_id) VALUES ('run-wf', 'ws-wf', 'g', ?)`, vId);
  assert.match(deleteWorkflow(c.workflowId).error, /a run was created/);
});
