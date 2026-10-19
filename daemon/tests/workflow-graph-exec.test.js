// Phase 2: the engine executes a saved custom workflow graph, and the legacy
// pipeline still runs byte-for-byte when no custom workflow is active. The
// compat test drives a full scripted run and asserts the same work-item
// kinds and agents as before custom workflows existed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-gexec-'));
process.env.OFFICE_DATA_DIR = dataDir;

const { q, q1, run } = await import('../src/db.ts');
const { createRun, wireEngineEvents } = await import('../src/engine/engine.ts');
const { createWorkflow, setActiveWorkflow, defaultWorkflowGraph } = await import('../src/services/workflow.ts');
const { decideApproval } = await import('../src/services/policy.ts');
const { ensureRepo } = await import('../src/services/git.ts');
const { now, ulid } = await import('../src/util.ts');

// ---------- fixture (compact mirror of seed.ts) ----------
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-grepo-'));
ensureRepo(repoDir);

const ROLES = ['pm', 'prompt-creator', 'developer', 'reviewer', 'analyst', 'qa', 'docs'];
for (const name of ROLES) {
  run(`INSERT INTO roles (id, name, version, responsibilities, allowed_actions, default_instructions, default_skills)
       VALUES (?,?,1,'[]','[]','','[]')`, `role-${name}`, name);
}
run(`INSERT INTO policies (id, scope, rules) VALUES ('pol-g','{}','[]')`);
run(`INSERT INTO providers (id, name, kind, adapter_id, adapter_version, adapter_hash, tier, enabled, capabilities, config)
     VALUES ('prov-g','Scripted','agent','scripted','1.0.0','local',1,1,'{}','{}')`);
run(`INSERT INTO models (id, provider_id, name, context_tokens, max_output_tokens, price_in, price_out, strength_tier)
     VALUES ('m-g','prov-g','scripted-1',128000,8192,0,0,'standard')`);
run(`INSERT INTO accounts (id, provider_id, label, billing, enabled, config) VALUES ('acct-g','prov-g','local','payg',1,'{}')`);
run(`INSERT INTO workspaces (id, name, purpose, repo_ids, allowed_provider_ids, policy_id, memory_scope, settings)
     VALUES ('ws-g','G','', '["repo-g"]','[]','pol-g','isolated','{}')`);
run(`INSERT INTO repos (id, workspace_id, path, remote_url, default_branch, integration_branch, build_cmd, test_cmd)
     VALUES ('repo-g','ws-g',?,NULL,'main','integration','','')`, repoDir);
run(`INSERT INTO checks (id, repo_id, name, kind, command, parser, pass_rule, timeout_sec, affected_paths, protected)
     VALUES ('chk-g','repo-g','build','build','node --check src/a.js','auto','exit0',60,'["src/**"]',0)`);

const mkAgent = (id, role, script = {}) => {
  run(`INSERT INTO agents (id, name, avatar, account_id, model_id, settings, instructions, caps, observability, status)
       VALUES (?,?,?,?,?,?,?,?,'actions','idle')`,
    id, `${id} agent`, 'x', 'acct-g', 'm-g', JSON.stringify({ script }), '', JSON.stringify({ perTaskUsd: 10, perDayUsd: 50, maxTokensPerCall: 128000 }));
  run(`INSERT INTO memberships (id, agent_id, workspace_id, role_id, active_since, max_concurrent_tasks, active)
       VALUES (?,?,?,?,?,1,1)`, ulid(), id, 'ws-g', `role-${role}`, now());
};
const setPlan = (plan) => run(`UPDATE agents SET settings = ? WHERE id = 'ag-pm'`, JSON.stringify({ script: { plan } }));

mkAgent('ag-pm', 'pm');
mkAgent('ag-pc', 'prompt-creator');
mkAgent('ag-dev', 'developer');
mkAgent('ag-rev', 'reviewer');
mkAgent('ag-an', 'analyst');
mkAgent('ag-qa', 'qa');
mkAgent('ag-doc', 'docs');

const PLAN = {
  dodItems: [{ id: 'F1', text: 'module parses', kind: 'feature', checks: ['build'] }],
  tasks: [{
    key: 'T1', title: 'Add module a', type: 'feature', priority: 1, difficulty: 2,
    dependsOn: [], dodItemIds: ['F1'], budgetUsd: 5,
    acceptanceCriteria: ['src/a.js parses'], affectedPaths: ['src/'],
    meta: { files: { 'src/a.js': 'export const a = 1;\n' } },
  }],
  notes: 'g',
};

wireEngineEvents();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitRun(runId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = q1('SELECT status FROM runs WHERE id = ?', runId);
    if (r && ['done', 'failed', 'stopped'].includes(r.status)) return r.status;
    if (Date.now() > deadline) return `timeout(${r?.status})`;
    await sleep(250);
  }
}
const items = (runId) => q(`SELECT kind, agent_id, workflow_node_id FROM work_items WHERE run_id = ? ORDER BY rowid`, runId);

// ---------- compatibility: no custom workflow → identical pipeline ----------
test('compat: no active workflow runs the unchanged legacy sequence', { timeout: 180000 }, async () => {
  setPlan(PLAN);
  const r = createRun({ workspaceId: 'ws-g', goal: 'Add module a' });
  const status = await waitRun(r.id);
  assert.equal(status, 'done');
  const kinds = items(r.id).map((x) => x.kind);
  // legacy pipeline: QA doubles as the review step, PM accepts — unchanged
  assert.deepEqual(kinds, ['plan', 'prompt', 'prompt-review', 'implement', 'qa', 'accept']);
  const agents = items(r.id).map((x) => x.agent_id);
  assert.deepEqual(agents, ['ag-pm', 'ag-pc', 'ag-pm', 'ag-dev', 'ag-qa', 'ag-pm']);
  // nothing was stamped with graph node ids — the executor stayed out
  assert.ok(items(r.id).every((x) => x.workflow_node_id == null));
});

// ---------- custom graph: a trimmed pipeline, graph drives the sequence ----------
test('custom graph: run follows the graph nodes and stamps each step', { timeout: 180000 }, async () => {
  setPlan(PLAN);
  const g = {
    nodes: [
      { id: 'start', type: 'start', label: 'Go', position: { x: 0, y: 0 } },
      { id: 'dev', type: 'agent', label: 'Build', role: 'developer', config: { purpose: 'implement' }, position: { x: 0, y: 0 } },
      { id: 'qa', type: 'agent', label: 'Verify', role: 'qa', config: { purpose: 'qa' }, position: { x: 0, y: 0 } },
      { id: 'rev', type: 'agent', label: 'Review', role: 'reviewer', config: { purpose: 'review' }, position: { x: 0, y: 0 } },
      { id: 'acc', type: 'agent', label: 'Accept', role: 'pm', config: { purpose: 'accept' }, position: { x: 0, y: 0 } },
      { id: 'end', type: 'end', label: 'Done', position: { x: 0, y: 0 } },
    ],
    edges: [
      { id: 'e0', from: 'start', to: 'dev', kind: 'next' },
      { id: 'e1', from: 'dev', to: 'qa', kind: 'next' },
      { id: 'e2', from: 'qa', to: 'rev', kind: 'next' },
      { id: 'e3', from: 'rev', to: 'acc', kind: 'next' },
      { id: 'e4', from: 'rev', to: 'dev', kind: 'on-reject', maxLoops: 3 },
      { id: 'e5', from: 'qa', to: 'dev', kind: 'on-failure', maxLoops: 3 },
      { id: 'e6', from: 'acc', to: 'end', kind: 'on-success' },
      { id: 'e7', from: 'acc', to: 'dev', kind: 'on-reject', maxLoops: 2 },
    ],
  };
  const made = createWorkflow('ws-g', 'trimmed', '', g);
  assert.ok(made.workflowId, JSON.stringify(made));
  assert.ok(setActiveWorkflow('ws-g', made.workflowId).ok);
  try {
    const r = createRun({ workspaceId: 'ws-g', goal: 'Add module a (graph)' });
    assert.equal((q1('SELECT workflow_version_id FROM runs WHERE id = ?', r.id) ?? {}).workflow_version_id != null, true);
    const status = await waitRun(r.id);
    assert.equal(status, 'done');
    const nodes = items(r.id).map((x) => x.workflow_node_id);
    assert.deepEqual(nodes.filter(Boolean), ['dev', 'qa', 'rev', 'acc']);
    // no prompt/prompt-review items — the graph has no such nodes
    assert.deepEqual(items(r.id).map((x) => x.kind), ['plan', 'implement', 'qa', 'review', 'accept']);
    const steps = q(`SELECT DISTINCT json_extract(payload,'$.nodeId') n FROM events WHERE run_id = ? AND type = 'workflow.step'`, r.id).map((x) => x.n);
    for (const n of ['dev', 'qa', 'rev', 'acc']) assert.ok(steps.includes(n), `workflow.step missing ${n}`);
  } finally {
    setActiveWorkflow('ws-g', null);
  }
});

// ---------- loop edge: QA fails once → on-failure sends work back ----------
test('on-failure loop re-runs the writer until QA passes', { timeout: 180000 }, async () => {
  setPlan(PLAN);
  run(`UPDATE agents SET settings = ? WHERE id = 'ag-qa'`, JSON.stringify({ script: { qaFailFirst: true } }));
  const g = {
    nodes: [
      { id: 'start', type: 'start', label: 'Go', position: { x: 0, y: 0 } },
      { id: 'dev', type: 'agent', label: 'Build', role: 'developer', config: { purpose: 'implement' }, position: { x: 0, y: 0 } },
      { id: 'qa', type: 'agent', label: 'Verify', role: 'qa', config: { purpose: 'qa' }, position: { x: 0, y: 0 } },
      { id: 'acc', type: 'agent', label: 'Accept', role: 'pm', config: { purpose: 'accept' }, position: { x: 0, y: 0 } },
      { id: 'end', type: 'end', label: 'Done', position: { x: 0, y: 0 } },
    ],
    edges: [
      { id: 'e0', from: 'start', to: 'dev', kind: 'next' },
      { id: 'e1', from: 'dev', to: 'qa', kind: 'next' },
      { id: 'e2', from: 'qa', to: 'acc', kind: 'next' },
      { id: 'e3', from: 'qa', to: 'dev', kind: 'on-failure', maxLoops: 3 },
      { id: 'e4', from: 'acc', to: 'end', kind: 'on-success' },
    ],
  };
  const made = createWorkflow('ws-g', 'with-fail', '', g);
  setActiveWorkflow('ws-g', made.workflowId);
  try {
    const r = createRun({ workspaceId: 'ws-g', goal: 'Fail once' });
    const status = await waitRun(r.id);
    assert.equal(status, 'done');
    const impls = items(r.id).filter((x) => x.kind === 'implement').length;
    const qas = items(r.id).filter((x) => x.kind === 'qa').length;
    assert.equal(impls, 2, 'qa failure should re-dispatch the developer');
    assert.equal(qas, 2);
    // re-entering a node is a retry of that step — attempt must increment
    // per node so attempt-based behaviour (fail-once scripts, retry
    // policies) sees the retry
    const attempts = q(`SELECT workflow_node_id n, attempt a FROM work_items WHERE run_id = ? AND kind = 'implement' ORDER BY rowid`, r.id).map((x) => [x.n, x.a]);
    assert.deepEqual(attempts, [['dev', 1], ['dev', 2]]);
    const branch = q1(`SELECT payload FROM events WHERE run_id = ? AND type = 'workflow.branch' AND json_extract(payload,'$.from') = 'qa'`, r.id);
    assert.ok(branch && JSON.parse(branch.payload).edges.includes('e3'), 'the on-failure edge must be taken');
  } finally {
    setActiveWorkflow('ws-g', null);
    run(`UPDATE agents SET settings = ? WHERE id = 'ag-qa'`, JSON.stringify({ script: {} }));
  }
});

// ---------- loop bound: always-rejecting reviewer exhausts maxLoops → ask ----------
test('loop bound: exhausted on-reject edge pauses for an owner decision', { timeout: 180000 }, async () => {
  setPlan(PLAN);
  run(`UPDATE agents SET settings = ? WHERE id = 'ag-rev'`, JSON.stringify({ script: { review: { decision: 'request-changes' } } }));
  const g = {
    nodes: [
      { id: 'start', type: 'start', label: 'Go', position: { x: 0, y: 0 } },
      { id: 'dev', type: 'agent', label: 'Build', role: 'developer', config: { purpose: 'implement' }, position: { x: 0, y: 0 } },
      { id: 'rev', type: 'agent', label: 'Review', role: 'reviewer', config: { purpose: 'review' }, position: { x: 0, y: 0 } },
      { id: 'end', type: 'end', label: 'Done', position: { x: 0, y: 0 } },
    ],
    edges: [
      { id: 'e0', from: 'start', to: 'dev', kind: 'next' },
      { id: 'e1', from: 'dev', to: 'rev', kind: 'next' },
      { id: 'e2', from: 'rev', to: 'dev', kind: 'on-reject', maxLoops: 1 },
      { id: 'e3', from: 'rev', to: 'end', kind: 'on-success' },
    ],
  };
  const made = createWorkflow('ws-g', 'loop-bound', '', g);
  setActiveWorkflow('ws-g', made.workflowId);
  try {
    const r = createRun({ workspaceId: 'ws-g', goal: 'Bound the loop' });
    // wait for the workflow.loop approval to appear
    let ap = null;
    const deadline = Date.now() + 120000;
    while (!ap && Date.now() < deadline) {
      ap = q1(`SELECT id, action, task_id FROM approvals WHERE run_id = ? AND action = 'workflow.loop' AND status = 'pending'`, r.id);
      if (!ap) await sleep(250);
    }
    assert.ok(ap, 'expected a workflow.loop approval request');
    const task = q1('SELECT status FROM tasks WHERE id = ?', ap.task_id);
    assert.equal(task.status, 'waiting-input');
    // declining stops the loop — the task blocks, the run does not hang
    decideApproval(ap.id, false, 'stop the loop');
    const t2 = q1('SELECT status FROM tasks WHERE id = ?', ap.task_id);
    assert.equal(t2.status, 'blocked');
  } finally {
    setActiveWorkflow('ws-g', null);
    run(`UPDATE agents SET settings = ? WHERE id = 'ag-rev'`, JSON.stringify({ script: {} }));
  }
});

// ---------- unit: deterministic condition + edge matching ----------
test('conditions evaluate deterministically against the outcome', async () => {
  const { wfEvalCondition, wfFieldValue } = await import('../src/engine/engine.ts');
  const ctx = { outcome: { status: 'success', verdict: 'approve', checksPassed: true, files: ['src/a.js', 'docs/x.md'] }, task: { attempts: 1, type: 'feature', difficulty: 2, affectedPaths: [] } };
  assert.equal(wfEvalCondition({ field: 'step.verdict', op: 'eq', value: 'approve' }, ctx), true);
  assert.equal(wfEvalCondition({ field: 'checks', op: 'eq', value: 'pass' }, ctx), true);
  assert.equal(wfEvalCondition({ field: 'files', op: 'matches', value: 'docs/**' }, ctx), true);
  assert.equal(wfEvalCondition({ field: 'files', op: 'contains', value: 'src/a.js' }, ctx), true);
  assert.equal(wfEvalCondition({ and: [{ field: 'attempts', op: 'lt', value: 3 }, { not: { field: 'task.type', op: 'eq', value: 'docs' } }] }, ctx), true);
  assert.equal(wfEvalCondition({ or: [{ field: 'step.status', op: 'eq', value: 'failure' }, { field: 'step.verdict', op: 'eq', value: 'approve' }] }, ctx), true);
  assert.equal(wfFieldValue('checks', ctx), 'pass');
});

test('wfEntryNodes walks start to the first task-scope nodes', async () => {
  const { wfEntryNodes } = await import('../src/engine/engine.ts');
  const entries = wfEntryNodes(defaultWorkflowGraph(), { outcome: { status: 'success' }, task: { affectedPaths: [], attempts: 0, type: 'feature', difficulty: 2 } });
  // pm-plan is run-scope: tasks enter at the prompt draft like the pipeline
  assert.deepEqual(entries.map((n) => n.id), ['pc-draft']);
});
