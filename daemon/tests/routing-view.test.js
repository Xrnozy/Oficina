// Routing page's derived view: the active workflow graph flattened into
// ordered steps, branches, loops and message refs — plus per-node routing
// overrides (modelTier / budgetChars) that the engine must actually honor,
// and the unchanged legacy behavior when no custom workflow is active.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-rv-'));
process.env.OFFICE_DATA_DIR = dataDir;

const { q, q1, run } = await import('../src/db.ts');
const {
  routingView, defaultWorkflowGraph, createWorkflow, setActiveWorkflow,
  saveWorkflowVersion, patchNodeRouting, addNodeForAgent, cloneWorkflow,
} = await import('../src/services/workflow.ts');
const { routeChain } = await import('../src/services/routing.ts');
const { createRun, wireEngineEvents, simulateWorkflow } = await import('../src/engine/engine.ts');
const { ensureRepo } = await import('../src/services/git.ts');
const { now, ulid } = await import('../src/util.ts');

// ---------- fixture (compact mirror of workflow-graph-exec) ----------
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-rvrepo-'));
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

test('no custom workflow: routing view renders the generated default graph', () => {
  const v = routingView('ws-r');
  assert.equal(v.custom, false);
  assert.equal(v.fallback, false);
  assert.equal(v.workflow.builtin, true);
  assert.equal(v.workflow.name, 'Default pipeline');
  assert.equal(v.issues.filter((i) => i.level === 'error').length, 0);
  // the default pipeline's agent steps, in flow order — the same nodes the
  // engine would walk, not a separate hard-coded list
  assert.deepEqual(v.agentNodes.map((s) => s.nodeId),
    ['pm-plan', 'pc-draft', 'pm-review', 'dev', 'qa', 'reviewer', 'pm-accept', 'analyst', 'fixer']);
  const dev = v.agentNodes.find((s) => s.nodeId === 'dev');
  assert.deepEqual(dev.agents.map((a) => a.id), ['ag-dev']);
  // the workspace's docs agent is not on the canvas
  assert.deepEqual(v.notInWorkflow.map((a) => a.id), ['ag-spare']);
});

test('custom workflow active: inserted agent appears in flow order and panels', () => {
  const g = {
    nodes: [snode('start'), an('dev', 'developer', 'implement'), an('docsx', 'docs', 'doc'), an('acc', 'pm', 'accept'), snode('end', 'end')],
    edges: [e('e0', 'start', 'dev'), e('e1', 'dev', 'docsx'), e('e2', 'docsx', 'acc'), e('e3', 'acc', 'end', 'on-success'), e('e4', 'acc', 'dev', 'on-reject', { maxLoops: 2 })],
  };
  const { workflowId } = createWorkflow('ws-r', 'Custom', '', g);
  setActiveWorkflow('ws-r', workflowId);
  const v = routingView('ws-r');
  assert.equal(v.custom, true);
  assert.equal(v.workflow.id, workflowId);
  assert.deepEqual(stepIds(v.rows), ['start', 'dev', 'docsx', 'acc', 'end']);
  assert.deepEqual(v.agentNodes.map((s) => s.nodeId), ['dev', 'docsx', 'acc']);
  assert.equal(stepOf(v.rows, 'docsx').purpose, 'doc');
  setActiveWorkflow('ws-r', null);
});

test('branch: condition fan-out renders labeled stacked lanes', () => {
  const g = {
    nodes: [snode('start'), an('dev', 'developer', 'implement'), an('qa', 'qa', 'qa'),
      { id: 'c', type: 'condition', label: 'kind', position: { x: 0, y: 0 } },
      an('docw', 'docs', 'doc'), an('acc', 'pm', 'accept'), snode('end', 'end')],
    edges: [e('e0', 'start', 'dev'), e('e1', 'dev', 'c'),
      e('e2', 'c', 'qa', 'next', { condition: { field: 'task.type', op: 'eq', value: 'feature' } }),
      e('e3', 'c', 'docw', 'next', { else: true }),
      e('e4', 'qa', 'acc'), e('e5', 'docw', 'acc'), e('e6', 'acc', 'end', 'on-success')],
  };
  const { workflowId } = createWorkflow('ws-r', 'Branched', '', g);
  setActiveWorkflow('ws-r', workflowId);
  const v = routingView('ws-r');
  const branch = v.rows.find((r) => r.kind === 'branches');
  assert.ok(branch, 'fan-out renders as branches');
  assert.equal(branch.lanes.length, 2);
  assert.match(branch.lanes[0].label, /task type/);
  assert.equal(branch.lanes[1].isElse, true);
  assert.equal(branch.lanes[1].label, 'otherwise');
  // both lanes rejoin at accept — rendered once, after the block
  assert.equal(stepIds(v.rows).filter((x) => x === 'acc').length, 1);
  setActiveWorkflow('ws-r', null);
});

test('loop edges show as back-refs with their bound; merge joins lanes', () => {
  const g = {
    nodes: [snode('start'), an('dev', 'developer', 'implement'), an('ra', 'reviewer', 'review'), an('rb', 'reviewer', 'review'),
      { id: 'join', type: 'merge', label: 'both', position: { x: 0, y: 0 } }, an('acc', 'pm', 'accept'), snode('end', 'end')],
    edges: [e('e0', 'start', 'dev'), e('e1', 'dev', 'ra'), e('e2', 'dev', 'rb'),
      e('e3', 'ra', 'join'), e('e4', 'rb', 'join'), e('e5', 'join', 'acc'), e('e6', 'acc', 'end', 'on-success'),
      e('e7', 'ra', 'dev', 'on-reject', { maxLoops: 2, label: 'redo' })],
  };
  const { workflowId } = createWorkflow('ws-r', 'Parallel', '', g);
  setActiveWorkflow('ws-r', workflowId);
  const v = routingView('ws-r');
  const ra = stepOf(v.rows, 'ra');
  assert.equal(ra.loops.length, 1);
  assert.equal(ra.loops[0].maxLoops, 2);
  assert.equal(ra.loops[0].label, 'redo');
  // the merge node resumes the main line after the lanes
  const ids = stepIds(v.rows);
  assert.deepEqual(ids.slice(-3), ['join', 'acc', 'end']);
  setActiveWorkflow('ws-r', null);
});

test('disabled node is flagged in the view and skipped in simulation', () => {
  const g = {
    nodes: [snode('start'), an('dev', 'developer', 'implement'), an('rev', 'reviewer', 'review', { disabled: true }), snode('end', 'end')],
    edges: [e('e0', 'start', 'dev'), e('e1', 'dev', 'rev'), e('e2', 'rev', 'end')],
  };
  const { workflowId } = createWorkflow('ws-r', 'Bypassed', '', g);
  setActiveWorkflow('ws-r', workflowId);
  const v = routingView('ws-r');
  assert.equal(stepOf(v.rows, 'rev').disabled, true);
  assert.ok(v.issues.some((i) => i.level === 'warning' && /bypassed/.test(i.message)));
  const sim = simulateWorkflow(g);
  const rev = sim.steps.find((s) => s.nodeId === 'rev');
  assert.equal(rev.note, 'bypassed');
  assert.equal(sim.calls, 1);                    // only dev ran — no call for the bypass
  setActiveWorkflow('ws-r', null);
});

test('deleted pinned agent carries a warning; empty role warns too', () => {
  const { workflowId } = createWorkflow('ws-r', 'Will break', '', {
    nodes: [snode('start'), { ...an('pin', 'developer', 'implement'), agentId: 'ag-dev' }, snode('end', 'end')],
    edges: [e('e0', 'start', 'pin'), e('e1', 'pin', 'end')],
  });
  setActiveWorkflow('ws-r', workflowId);
  run(`DELETE FROM memberships WHERE agent_id = 'ag-dev'`);   // simulate the agent losing workspace membership
  let v = routingView('ws-r');
  assert.ok(stepOf(v.rows, 'pin').warnings.some((w) => /not an active member/.test(w)));
  run(`DELETE FROM agents WHERE id = 'ag-dev'`);              // now the agent is gone entirely
  v = routingView('ws-r');
  assert.ok(stepOf(v.rows, 'pin').warnings.some((w) => /deleted/.test(w)));
  // and a role with no holders warns without breaking the view
  assert.ok(stepOf(v.rows, 'pin').agents.length === 0);
  setActiveWorkflow('ws-r', null);
  run(`INSERT INTO agents (id, name, avatar, account_id, model_id, settings, instructions, caps, observability, status)
       VALUES ('ag-dev','ag-dev agent','x','acct-r','m-r','{}','','{"perTaskUsd":10,"perDayUsd":50,"maxTokensPerCall":128000}','actions','idle')`);
  run(`INSERT INTO memberships (id, agent_id, workspace_id, role_id, active_since, max_concurrent_tasks, active)
       VALUES (?,?,?,?,?,1,1)`, ulid(), 'ag-dev', 'ws-r', 'role-developer', now());
});

test('patchNodeRouting writes the same config the inspector edits; builtin refuses', () => {
  const { workflowId } = createWorkflow('ws-r', 'Tunable', '', {
    nodes: [snode('start'), an('dev', 'developer', 'implement'), snode('end', 'end')],
    edges: [e('e0', 'start', 'dev'), e('e1', 'dev', 'end')],
  });
  assert.equal(patchNodeRouting(workflowId, 'dev', { modelTier: 'fast', budgetChars: 4000 }).ok, true);
  setActiveWorkflow('ws-r', workflowId);
  const v = routingView('ws-r');
  assert.equal(v.agentNodes[0].modelTier, 'fast');
  assert.equal(v.agentNodes[0].budgetChars, 4000);
  // clearing returns to auto
  patchNodeRouting(workflowId, 'dev', { modelTier: null, budgetChars: null });
  assert.equal(routingView('ws-r').agentNodes[0].modelTier, null);
  setActiveWorkflow('ws-r', null);
  const bv = routingView('ws-r');
  assert.match(patchNodeRouting(bv.workflow.id, 'dev', { modelTier: 'fast' }).error, /read-only/);
});

test('addNodeForAgent splices a pinned node before Done', () => {
  const { workflowId } = cloneWorkflow('wf-builtin-ws-r', 'Plus one');
  setActiveWorkflow('ws-r', workflowId);
  const r = addNodeForAgent(workflowId, 'ag-spare');
  assert.equal(r.ok, true);
  const v = routingView('ws-r');
  const step = stepOf(v.rows, r.nodeId);
  assert.ok(step, 'new node renders in the flow');
  assert.equal(step.agentId, 'ag-spare');
  assert.deepEqual(step.agents.map((a) => a.id), ['ag-spare']);
  // it sits right before the end node on the main line
  const ids = stepIds(v.rows);
  assert.equal(ids[ids.indexOf(r.nodeId) + 1], 'end');
  assert.equal(v.notInWorkflow.some((a) => a.id === 'ag-spare'), false);
  setActiveWorkflow('ws-r', null);
});

test('node tier override reaches the router: required tier + node name on the decision', () => {
  // routing.ts: the override replaces kind+difficulty as "required"
  const mk = (tier) => ({ account: { billing: 'payg' }, provider: { id: 'p', adapterId: 'x' }, model: { strengthTier: tier, name: tier } });
  const d = routeChain([mk('fast'), mk('strong')], 'implement', 2, 'strong');
  assert.equal(d.required, 'strong');
  assert.match(d.reason, /set on the node/);
  const d2 = routeChain([mk('fast')], 'implement', 2);          // unchanged default
  assert.equal(d2.required, 'standard');
});

test('a graph run stamps model.routed with the node and its tier override; legacy runs have neither', { timeout: 180000 }, async () => {
  run(`UPDATE agents SET settings = ? WHERE id = 'ag-pm'`, JSON.stringify({ script: { plan: {
    dodItems: [{ id: 'F1', text: 'module parses', kind: 'feature', checks: ['build'] }],
    tasks: [{ key: 'T1', title: 'Add module a', type: 'feature', priority: 1, difficulty: 2, dependsOn: [], dodItemIds: ['F1'], budgetUsd: 5, acceptanceCriteria: ['src/a.js parses'], affectedPaths: ['src/'], meta: { files: { 'src/a.js': 'export const a = 1;\n' } } }],
    notes: 'g',
  } } }));
  const g = {
    nodes: [snode('start'),
      { ...an('dev', 'developer', 'implement'), label: 'Build it', config: { purpose: 'implement', modelTier: 'strong', budgetChars: 9000 } },
      an('acc', 'pm', 'accept'), snode('end', 'end')],
    edges: [e('e0', 'start', 'dev'), e('e1', 'dev', 'acc', 'on-success'), e('e2', 'acc', 'end', 'on-success'), e('e3', 'acc', 'dev', 'on-reject', { maxLoops: 2 })],
  };
  const { workflowId } = createWorkflow('ws-r', 'Live', '', g);
  setActiveWorkflow('ws-r', workflowId);
  const r = createRun({ workspaceId: 'ws-r', goal: 'Add module a' });
  const deadline = Date.now() + 120000;
  let status;
  for (;;) {
    status = q1('SELECT status FROM runs WHERE id = ?', r.id).status;
    if (['done', 'failed', 'stopped'].includes(status) || Date.now() > deadline) break;
    await new Promise((r2) => setTimeout(r2, 250));
  }
  assert.equal(status, 'done');
  const routed = q(`SELECT payload FROM events WHERE type = 'model.routed' AND run_id = ? ORDER BY seq`, r.id)
    .map((x) => JSON.parse(x.payload));
  const devRoute = routed.find((x) => x.node === 'Build it');
  assert.ok(devRoute, 'a routing decision names the workflow node');
  assert.equal(devRoute.nodeId, 'dev');
  assert.equal(devRoute.required, 'strong');            // node's modelTier, not kind+difficulty ('implement'@2 → standard)
  // the prompt for that dispatch was fitted to the node's budget
  const wi = q1(`SELECT id FROM work_items WHERE run_id = ? AND workflow_node_id = 'dev'`, r.id);
  assert.equal(q1('SELECT budget_chars FROM prompt_versions WHERE work_item_id = ?', wi.id).budget_chars, 9000);
  setActiveWorkflow('ws-r', null);
});
