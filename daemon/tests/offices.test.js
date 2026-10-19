// Offices: create / clone / rename / delete, and portable export + import of a whole office or one workflow.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-off-'));

const { q, q1, run } = await import('../src/db.ts');
const {
  createOffice, updateOffice, deleteOffice, exportOffice, importOffice, exportWorkflow, importWorkflow,
} = await import('../src/services/offices.ts');
const { createWorkflow, getWorkflow, setActiveWorkflow, activeWorkflowId, listWorkflows } = await import('../src/services/workflow.ts');
const { now, ulid } = await import('../src/util.ts');

for (const name of ['pm', 'developer', 'reviewer', 'qa']) {
  run(`INSERT INTO roles (id, name, version, responsibilities, allowed_actions, default_instructions, default_skills)
       VALUES (?,?,1,'[]','[]','','[]')`, `role-${name}`, name);
}
run(`INSERT INTO policies (id, scope, rules) VALUES ('pol-o','{}','[]')`);
run(`INSERT INTO providers (id, name, kind, adapter_id, adapter_version, adapter_hash, tier, enabled, capabilities, config)
     VALUES ('prov-o','Scripted','agent','scripted','1.0.0','local',1,1,'{}','{}')`);
run(`INSERT INTO models (id, provider_id, name, context_tokens, max_output_tokens, price_in, price_out, strength_tier)
     VALUES ('m-o','prov-o','scripted-1',128000,8192,0,0,'standard')`);
run(`INSERT INTO accounts (id, provider_id, label, billing, enabled, config) VALUES ('acct-o','prov-o','local','payg',1,'{}')`);
run(`INSERT INTO workspaces (id, name, purpose, repo_ids, allowed_provider_ids, policy_id, memory_scope, settings)
     VALUES ('ws-a','Alpha','first','[]','[]','pol-o','isolated','{"confirmPlan":true,"workMode":"direct"}')`);

const hire = (id, name, role, ws = 'ws-a') => {
  run(`INSERT INTO agents (id, name, avatar, account_id, model_id, settings, instructions, caps, observability, status)
       VALUES (?,?,?,?,?,?,?,?,'actions','idle')`, id, name, 'x', 'acct-o', 'm-o', '{"reasoningEffort":"high","fallbacks":["m-o"]}', `be ${name}`, '{}');
  run(`INSERT INTO memberships (id, agent_id, workspace_id, role_id, active_since, max_concurrent_tasks, active) VALUES (?,?,?,?,?,1,1)`, ulid(), id, ws, `role-${role}`, now());
};
hire('ag-ada', 'Ada', 'pm');
hire('ag-dev', 'Dev', 'developer');
hire('ag-rey', 'Rey', 'reviewer');

const node = (id, type, extra = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, ...extra });
const edge = (id, from, to, kind = 'next') => ({ id, from, to, kind });
const flow = () => ({
  nodes: [node('start', 'start'), node('dev', 'agent', { agentId: 'ag-dev', config: { purpose: 'implement' } }),
    node('acc', 'agent', { agentId: 'ag-ada', role: 'pm', config: { purpose: 'accept' } }), node('end', 'end')],
  edges: [edge('e0', 'start', 'dev'), edge('e1', 'dev', 'acc'), edge('e2', 'acc', 'end', 'on-success')],
});
const wf = createWorkflow('ws-a', 'Alpha flow', 'two steps', flow());
assert.ok(wf.workflowId, JSON.stringify(wf));
setActiveWorkflow('ws-a', wf.workflowId);

const agentsIn = (ws) => q(`SELECT a.* FROM agents a JOIN memberships m ON m.agent_id = a.id WHERE m.workspace_id = ? AND m.active = 1 ORDER BY a.rowid`, ws);

test('a blank office starts with no agents and only the built-in workflow', () => {
  const r = createOffice({ name: 'Blank' });
  assert.ok(r.id, JSON.stringify(r));
  assert.equal(agentsIn(r.id).length, 0);
  const flows = listWorkflows(r.id);
  assert.equal(flows.length, 1);
  assert.equal(flows[0].builtin, true);
  assert.equal(activeWorkflowId(r.id), null);
});

test('office names are required and unique', () => {
  assert.match(createOffice({ name: '  ' }).error, /name required/);
  assert.match(createOffice({ name: 'alpha' }).error, /already exists/);
});

test('cloning copies agents and workflows; the copies are independent of the source', () => {
  const r = createOffice({ name: 'Alpha copy', cloneFrom: 'ws-a' });
  assert.ok(r.id, JSON.stringify(r));
  const copies = agentsIn(r.id);
  assert.deepEqual(copies.map((a) => a.name), ['Ada', 'Dev', 'Rey']);
  assert.ok(copies.every((a) => !['ag-ada', 'ag-dev', 'ag-rey'].includes(a.id)), 'new agent rows, not shared ones');
  assert.deepEqual(copies.map((a) => a.instructions), ['be Ada', 'be Dev', 'be Rey']);

  const flows = listWorkflows(r.id).filter((w) => !w.builtin);
  assert.equal(flows.length, 1);
  assert.equal(flows[0].active, true, 'the active workflow carries over');
  const graph = getWorkflow(flows[0].id).graph;
  const pinned = graph.nodes.filter((n) => n.agentId).map((n) => n.agentId);
  assert.equal(pinned.length, 2);
  assert.ok(pinned.every((id) => copies.some((a) => a.id === id)), 'pinned agents were remapped into the new office');
  assert.equal(JSON.parse(q1('SELECT settings FROM workspaces WHERE id = ?', r.id).settings).confirmPlan, true);

  // renaming an agent in the copy leaves the original alone
  run('UPDATE agents SET name = ? WHERE id = ?', 'Ada 2', copies[0].id);
  assert.equal(q1('SELECT name FROM agents WHERE id = ?', 'ag-ada').name, 'Ada');
});

test('rename and delete; offices with runs are kept', () => {
  const r = createOffice({ name: 'Temp' });
  assert.deepEqual(updateOffice(r.id, { name: 'Temp 2', purpose: 'scratch' }), { ok: true });
  assert.equal(q1('SELECT name, purpose FROM workspaces WHERE id = ?', r.id).name, 'Temp 2');
  assert.match(updateOffice(r.id, { name: 'Alpha' }).error, /already exists/);

  const kept = createOffice({ name: 'Has runs' });
  run(`INSERT INTO runs (id, workspace_id, goal, status) VALUES ('run-x', ?, 'g', 'done')`, kept.id);
  assert.match(deleteOffice(kept.id).error, /has runs/);

  assert.deepEqual(deleteOffice(r.id), { ok: true });
  assert.ok(!q1('SELECT id FROM workspaces WHERE id = ?', r.id));
  assert.ok(!q1('SELECT id FROM workflows WHERE workspace_id = ?', r.id));
});

test('exporting a workflow names agents instead of ids, and importing resolves them in the target office', () => {
  const file = exportWorkflow(wf.workflowId);
  assert.equal(file.format, 'officechain.workflow');
  const dev = file.graph.nodes.find((n) => n.id === 'dev');
  assert.equal(dev.agentId, undefined);
  assert.equal(dev.agent, 'Dev');
  assert.equal(dev.role, 'developer', 'the role is kept as a fallback');

  const other = createOffice({ name: 'Importer' });
  hire('ag-dev2', 'dev', 'developer', other.id);            // matches by name, case-insensitively
  const r = importWorkflow(other.id, JSON.parse(JSON.stringify(file)));
  assert.ok(r.workflowId, JSON.stringify(r));
  const g = getWorkflow(r.workflowId).graph;
  assert.equal(g.nodes.find((n) => n.id === 'dev').agentId, 'ag-dev2');
  // "Ada" is not in this office: the step falls back to its role and says so
  const acc = g.nodes.find((n) => n.id === 'acc');
  assert.equal(acc.agentId, undefined);
  assert.equal(acc.role, 'pm');
  assert.ok(r.warnings.some((w) => /Ada/.test(w)), r.warnings.join('|'));
});

test('importing a workflow rejects things that are not workflows', () => {
  const ws = createOffice({ name: 'Rejects' }).id;
  assert.match(importWorkflow(ws, { hello: 1 }).error, /not a workflow/);
  assert.match(importWorkflow(ws, { format: 'officechain.office', graph: { nodes: [], edges: [] } }).error, /not a workflow/);
  assert.match(importWorkflow('nope', flow()).error, /office not found/);
  // a bare { nodes, edges } graph (the older export shape) is accepted
  assert.ok(importWorkflow(ws, { name: 'bare', graph: { nodes: [node('s', 'start'), node('e', 'end')], edges: [edge('x', 's', 'e')] } }).workflowId);
});

test('an office round-trips through export and import as a new office', () => {
  const file = exportOffice('ws-a');
  assert.equal(file.format, 'officechain.office');
  assert.deepEqual(file.agents.map((a) => a.name), ['Ada', 'Dev', 'Rey']);
  assert.deepEqual(file.agents[0].roles, ['pm']);
  assert.equal(file.agents[0].settings.fallbacks, undefined, 'machine-specific model fallbacks are not exported');
  assert.equal(file.agents[0].settings.reasoningEffort, 'high');
  assert.equal(file.workflows.length, 1);
  assert.equal(file.workflows[0].active, true);
  assert.equal(JSON.stringify(file).includes('ag-dev'), false, 'no local agent ids leak into the file');

  const r = importOffice(JSON.parse(JSON.stringify(file)));
  assert.ok(r.id, JSON.stringify(r));
  assert.equal(q1('SELECT name FROM workspaces WHERE id = ?', r.id).name, 'Alpha (2)', 'a taken name gets a suffix');
  const agents = agentsIn(r.id);
  assert.deepEqual(agents.map((a) => a.name), ['Ada', 'Dev', 'Rey']);
  assert.ok(agents.every((a) => a.account_id === 'acct-o' && a.model_id === 'm-o'), 'new agents start on this machine\'s backend');
  const flows = listWorkflows(r.id).filter((w) => !w.builtin);
  assert.equal(flows.length, 1);
  assert.equal(flows[0].active, true);
  const g = getWorkflow(flows[0].id).graph;
  assert.ok(g.nodes.filter((n) => n.agentId).every((n) => agents.some((a) => a.id === n.agentId)));
  assert.deepEqual(r.warnings, []);
});

test('importing an office rejects other files', () => {
  assert.match(importOffice({ format: 'officechain.workflow' }).error, /not an office file/);
  assert.match(importOffice(null).error, /not an office file/);
});
