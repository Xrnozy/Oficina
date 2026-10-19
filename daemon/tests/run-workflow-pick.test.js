// Workflow choice per request/run, and Routing's view of any workflow or an unsaved draft.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-rwp-'));
process.env.OFFICE_DATA_DIR = dataDir;

const { q, q1, run } = await import('../src/db.ts');
const {
  routingView, defaultWorkflowGraph, createWorkflow, setActiveWorkflow,
  saveWorkflowVersion, patchNodeRouting, addNodeForAgent, cloneWorkflow,
} = await import('../src/services/workflow.ts');
const { routeChain } = await import('../src/services/routing.ts');
const { createRun, wireEngineEvents, setRunWorkflow } = await import('../src/engine/engine.ts');
const { ensureRepo } = await import('../src/services/git.ts');
const { now, ulid } = await import('../src/util.ts');

// ---------- fixture (compact mirror of workflow-graph-exec) ----------
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-rwprepo-'));
ensureRepo(repoDir);
for (const name of ['pm', 'prompt-creator', 'developer', 'reviewer', 'analyst', 'qa', 'docs']) {
  run(`INSERT INTO roles (id, name, version, responsibilities, allowed_actions, default_instructions, default_skills)
       VALUES (?,?,1,'[]','[]','','[]')`, `role-${name}`, name);
}
run(`INSERT INTO policies (id, scope, rules) VALUES ('pol-r','{}','[]')`);
run(`INSERT INTO providers (id, name, kind, adapter_id, adapter_version, adapter_hash, tier, enabled, capabilities, config)
     VALUES ('prov-r','Scripted','agent','scripted','1.0.0','local',1,1,'{}','{}')`);
run(`INSERT INTO models (id, provider_id, name, context_tokens, max_output_tokens, price_in, price_out, strength_tier)
     VALUES ('m-r','prov-r','scripted-1',128000,8192,0,0,'standard')`);
run(`INSERT INTO accounts (id, provider_id, label, billing, enabled, config) VALUES ('acct-r','prov-r','local','payg',1,'{}')`);
run(`INSERT INTO workspaces (id, name, purpose, repo_ids, allowed_provider_ids, policy_id, memory_scope, settings)
     VALUES ('ws-r','R','', '["repo-r"]','[]','pol-r','isolated','{}')`);
run(`INSERT INTO repos (id, workspace_id, path, remote_url, default_branch, integration_branch, build_cmd, test_cmd)
     VALUES ('repo-r','ws-r',?,NULL,'main','integration','','')`, repoDir);
run(`INSERT INTO checks (id, repo_id, name, kind, command, parser, pass_rule, timeout_sec, affected_paths, protected)
     VALUES ('chk-r','repo-r','build','build','node --check src/a.js','auto','exit0',60,'["src/**"]',0)`);

const mkAgent = (id, role) => {
  run(`INSERT INTO agents (id, name, avatar, account_id, model_id, settings, instructions, caps, observability, status)
       VALUES (?,?,?,?,?,?,?,?,'actions','idle')`,
    id, `${id} agent`, 'x', 'acct-r', 'm-r', '{}', '', JSON.stringify({ perTaskUsd: 10, perDayUsd: 50, maxTokensPerCall: 128000 }));
  run(`INSERT INTO memberships (id, agent_id, workspace_id, role_id, active_since, max_concurrent_tasks, active)
       VALUES (?,?,?,?,?,1,1)`, ulid(), id, 'ws-r', `role-${role}`, now());
};
mkAgent('ag-pm', 'pm');
mkAgent('ag-pc', 'prompt-creator');
mkAgent('ag-dev', 'developer');
mkAgent('ag-qa', 'qa');
mkAgent('ag-rev', 'reviewer');
mkAgent('ag-spare', 'docs');           // never named by the graphs below

const an = (id, role, purpose, extra = {}) => ({ id, type: 'agent', label: id, role, config: { purpose, ...extra }, position: { x: 0, y: 0 } });
const e = (id, from, to, kind = 'next', extra = {}) => ({ id, from, to, kind, ...extra });
const snode = (id, type = 'start') => ({ id, type, label: id, position: { x: 0, y: 0 } });

// step ids in flow order, including lanes
const stepIds = (rows) => rows.flatMap((r) => r.kind === 'step' ? [r.step.nodeId]
  : r.kind === 'branches' ? r.lanes.flatMap((l) => stepIds(l.rows)) : []);
const stepOf = (rows, id) => rows.flatMap((r) => r.kind === 'step' ? [r.step]
  : r.kind === 'branches' ? r.lanes.flatMap((l) => stepOf(l.rows, id)) : []).find((s) => s?.nodeId === id);

wireEngineEvents();

const flow = (devLabel) => ({
  nodes: [snode('start'), an('dev', 'developer', 'implement', {}), an('acc', 'pm', 'accept'), snode('end', 'end')].map((n) => (n.id === 'dev' ? { ...n, label: devLabel } : n)),
  edges: [e('e0', 'start', 'dev'), e('e1', 'dev', 'acc'), e('e2', 'acc', 'end', 'on-success')],
});

test('routing view can show any saved workflow, not only the active one', () => {
  const a = createWorkflow('ws-r', 'Flow A', '', flow('A dev'));
  const b = createWorkflow('ws-r', 'Flow B', '', flow('B dev'));
  setActiveWorkflow('ws-r', a.workflowId);
  const active = routingView('ws-r');
  assert.equal(active.workflow.id, a.workflowId);
  assert.equal(active.workflow.active, true);
  const other = routingView('ws-r', b.workflowId);
  assert.equal(other.workflow.id, b.workflowId);
  assert.equal(other.workflow.active, false);
  assert.equal(other.custom, true);
  assert.equal(other.preview, false);
  // a workflow from another workspace is ignored
  assert.equal(routingView('ws-r', 'nope').workflow.id, a.workflowId);
  setActiveWorkflow('ws-r', null);
});

test('an unsaved draft graph previews on the routing view without being stored', () => {
  const a = createWorkflow('ws-r', 'Flow C', '', flow('C dev'));
  const draft = flow('C dev');
  draft.nodes.splice(2, 0, an('docsx', 'docs', 'doc'));
  draft.edges = [e('e0', 'start', 'dev'), e('e1', 'dev', 'docsx'), e('e1b', 'docsx', 'acc'), e('e2', 'acc', 'end', 'on-success')];
  const saved = routingView('ws-r', a.workflowId);
  const preview = routingView('ws-r', a.workflowId, draft);
  assert.equal(preview.preview, true);
  assert.deepEqual(saved.agentNodes.map((s) => s.nodeId), ['dev', 'acc']);
  assert.deepEqual(preview.agentNodes.map((s) => s.nodeId), ['dev', 'docsx', 'acc']);
  // the saved version is untouched
  assert.deepEqual(routingView('ws-r', a.workflowId).agentNodes.map((s) => s.nodeId), ['dev', 'acc']);
});

test('a request can pick its workflow; "builtin" and the workspace default still work', () => {
  const a = createWorkflow('ws-r', 'Flow D', '', flow('D dev'));
  const def = createWorkflow('ws-r', 'Flow Default', '', flow('Def dev'));
  setActiveWorkflow('ws-r', def.workflowId);
  const versionOf = (runId) => q1('SELECT v.workflow_id AS wf FROM runs r JOIN workflow_versions v ON v.id = r.workflow_version_id WHERE r.id = ?', runId)?.wf ?? null;

  assert.equal(versionOf(createRun({ workspaceId: 'ws-r', goal: 'default' }).id), def.workflowId);
  assert.equal(versionOf(createRun({ workspaceId: 'ws-r', goal: 'picked', workflowId: a.workflowId }).id), a.workflowId);
  assert.equal(versionOf(createRun({ workspaceId: 'ws-r', goal: 'standard', workflowId: 'builtin' }).id), null);
  assert.throws(() => createRun({ workspaceId: 'ws-r', goal: 'bad', workflowId: 'nope' }), /workflow not found/);
  setActiveWorkflow('ws-r', null);
});

test('a run can switch workflow while it is not mid-flight, and not while running', () => {
  const a = createWorkflow('ws-r', 'Flow E', '', flow('E dev'));
  const b = createWorkflow('ws-r', 'Flow F', '', flow('F dev'));
  const r = createRun({ workspaceId: 'ws-r', goal: 'switch me', workflowId: a.workflowId });
  const wfOf = () => q1('SELECT v.workflow_id AS wf FROM runs r JOIN workflow_versions v ON v.id = r.workflow_version_id WHERE r.id = ?', r.id)?.wf ?? null;
  run("UPDATE runs SET status = 'paused' WHERE id = ?", r.id);
  assert.deepEqual(setRunWorkflow(r.id, b.workflowId), { ok: true });
  assert.equal(wfOf(), b.workflowId);
  assert.deepEqual(setRunWorkflow(r.id, 'builtin'), { ok: true });
  assert.equal(wfOf(), null);
  assert.ok('error' in setRunWorkflow(r.id, 'nope'));
  run("UPDATE runs SET status = 'running' WHERE id = ?", r.id);
  assert.match(setRunWorkflow(r.id, a.workflowId).error, /pause the run first/);
  assert.ok('error' in setRunWorkflow('missing-run', a.workflowId));
});
