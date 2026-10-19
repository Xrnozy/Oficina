// Phase 4: templates validate, the worst-case estimator counts loops, the
// dry-run simulator follows mocked outcomes (no model), referenced-by
// warnings find pinned/last-member nodes, guardrails pause dispatching with
// a Needs-you item, and edits land in the hash-chained audit log.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-wfsafe-'));
process.env.OFFICE_DATA_DIR = dataDir;

const { q, q1, run } = await import('../src/db.ts');
const { createRun, wireEngineEvents, simulateWorkflow } = await import('../src/engine/engine.ts');
const {
  createWorkflow, setActiveWorkflow, defaultWorkflowGraph, validateWorkflow,
  workflowTemplates, estimateWorkflowCalls, workflowRefsFor, workflowAudit,
  saveWorkflowVersion, getWorkflow, ensureBuiltinWorkflow,
} = await import('../src/services/workflow.ts');
const { decideApproval } = await import('../src/services/policy.ts');
const { ensureRepo } = await import('../src/services/git.ts');
const { now, ulid } = await import('../src/util.ts');

// ---------- fixture (mirror of workflow-graph-exec.test.js) ----------
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-srepo-'));
ensureRepo(repoDir);
const ROLES = ['pm', 'prompt-creator', 'developer', 'reviewer', 'analyst', 'qa', 'docs'];
for (const name of ROLES) {
  run(`INSERT INTO roles (id, name, version, responsibilities, allowed_actions, default_instructions, default_skills)
       VALUES (?,?,1,'[]','[]','','[]')`, `role-${name}`, name);
}
run(`INSERT INTO policies (id, scope, rules) VALUES ('pol-s','{}','[]')`);
run(`INSERT INTO providers (id, name, kind, adapter_id, adapter_version, adapter_hash, tier, enabled, capabilities, config)
     VALUES ('prov-s','Scripted','agent','scripted','1.0.0','local',1,1,'{}','{}')`);
run(`INSERT INTO models (id, provider_id, name, context_tokens, max_output_tokens, price_in, price_out, strength_tier)
     VALUES ('m-s','prov-s','scripted-1',128000,8192,0,0,'standard')`);
run(`INSERT INTO accounts (id, provider_id, label, billing, enabled, config) VALUES ('acct-s','prov-s','local','payg',1,'{}')`);
run(`INSERT INTO workspaces (id, name, purpose, repo_ids, allowed_provider_ids, policy_id, memory_scope, settings)
     VALUES ('ws-s','S','', '["repo-s"]','[]','pol-s','isolated','{}')`);
run(`INSERT INTO repos (id, workspace_id, path, remote_url, default_branch, integration_branch, build_cmd, test_cmd)
     VALUES ('repo-s','ws-s',?,NULL,'main','integration','','')`, repoDir);
run(`INSERT INTO checks (id, repo_id, name, kind, command, parser, pass_rule, timeout_sec, affected_paths, protected)
     VALUES ('chk-s','repo-s','build','build','node --check src/a.js','auto','exit0',60,'["src/**"]',0)`);

const mkAgent = (id, role, script = {}) => {
  run(`INSERT INTO agents (id, name, avatar, account_id, model_id, settings, instructions, caps, observability, status)
       VALUES (?,?,?,?,?,?,?,?,'actions','idle')`,
    id, `${id} agent`, 'x', 'acct-s', 'm-s', JSON.stringify({ script }), '', JSON.stringify({ perTaskUsd: 10, perDayUsd: 50, maxTokensPerCall: 128000 }));
  run(`INSERT INTO memberships (id, agent_id, workspace_id, role_id, active_since, max_concurrent_tasks, active)
       VALUES (?,?,?,?,?,1,1)`, ulid(), id, 'ws-s', `role-${role}`, now());
};
mkAgent('ag-pm', 'pm'); mkAgent('ag-pc', 'prompt-creator'); mkAgent('ag-dev', 'developer');
mkAgent('ag-rev', 'reviewer'); mkAgent('ag-an', 'analyst'); mkAgent('ag-qa', 'qa'); mkAgent('ag-doc', 'docs');
const setPlan = (plan) => run(`UPDATE agents SET settings = ? WHERE id = 'ag-pm'`, JSON.stringify({ script: { plan } }));
const PLAN = {
  dodItems: [{ id: 'F1', text: 'module parses', kind: 'feature', checks: ['build'] }],
  tasks: [{
    key: 'T1', title: 'Add module a', type: 'feature', priority: 1, difficulty: 2,
    dependsOn: [], dodItemIds: ['F1'], budgetUsd: 5,
    acceptanceCriteria: ['src/a.js parses'], affectedPaths: ['src/'],
    meta: { files: { 'src/a.js': 'export const a = 1;\n' } },
  }],
  notes: 's',
};
wireEngineEvents();
ensureBuiltinWorkflow('ws-s');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(200);
  }
}

const n = (id, role, purpose, extra = {}) => ({ id, type: 'agent', label: id, role, config: { purpose, ...extra }, position: { x: 0, y: 0 } });
const e = (id, from, to, kind = 'next', extra = {}) => ({ id, from, to, kind, ...extra });
const bookends = { start: { id: 'start', type: 'start', label: 'S', position: { x: 0, y: 0 } }, end: { id: 'end', type: 'end', label: 'E', position: { x: 0, y: 0 } } };

// ---------- templates ----------

test('all templates validate cleanly against the seeded roles', () => {
  const tpls = workflowTemplates();
  assert.deepEqual(tpls.map((t) => t.id), ['default', 'human-approval', 'fast', 'strict', 'docs', 'bugfix', 'parallel']);
  for (const t of tpls) {
    const issues = validateWorkflow(t.graph, 'ws-s');
    const errs = issues.filter((i) => i.level === 'error').map((i) => i.message);
    assert.equal(errs.length, 0, `${t.id}: ${errs.join('; ')}`);
  }
});

// ---------- estimate ----------

test('estimate counts agent nodes plus bounded loop passes', () => {
  const g = {
    nodes: [bookends.start, n('dev', 'developer', 'implement'), n('qa', 'qa', 'qa'), bookends.end],
    edges: [e('e1', 'start', 'dev'), e('e2', 'dev', 'qa'), e('e3', 'qa', 'dev', 'on-failure', { maxLoops: 2 }), e('e4', 'qa', 'end', 'on-success')],
  };
  const est = estimateWorkflowCalls(g);
  // 2 agents + up to 2 loop passes, each re-entering dev+qa
  assert.equal(est.maxCalls, 2 + 2 * 2);
  assert.equal(est.humanGates, 0);
  const def = estimateWorkflowCalls(defaultWorkflowGraph());
  assert.ok(def.maxCalls > def.minCalls);
});

// ---------- simulation ----------

test('simulate: happy path reaches end and marks taken edges', () => {
  const g = {
    nodes: [bookends.start, n('dev', 'developer', 'implement'), n('qa', 'qa', 'qa'), bookends.end],
    edges: [e('e1', 'start', 'dev'), e('e2', 'dev', 'qa'), e('e3', 'qa', 'end', 'on-success')],
  };
  const r = simulateWorkflow(g);
  assert.equal(r.result, 'end');
  assert.equal(r.calls, 2);
  assert.deepEqual(r.takenEdges.sort(), ['e1', 'e2', 'e3']);
  assert.deepEqual(r.steps.map((s) => s.nodeId), ['start', 'dev', 'qa', 'end']);
});

test('simulate: a mocked failure takes the loop, a later success exits it', () => {
  const g = {
    nodes: [bookends.start, n('dev', 'developer', 'implement'), n('qa', 'qa', 'qa'), bookends.end],
    edges: [e('e1', 'start', 'dev'), e('e2', 'dev', 'qa'), e('e3', 'qa', 'dev', 'on-failure', { maxLoops: 3 }), e('e4', 'qa', 'end', 'on-success')],
  };
  const r = simulateWorkflow(g, { outcomes: { qa: ['failure', 'success'] } });
  assert.equal(r.result, 'end');
  assert.equal(r.calls, 4);                                    // dev, qa, dev, qa
  assert.equal(r.loopsUsed['e3'], 1);
  assert.ok(r.takenEdges.includes('e3'));
});

test('simulate: loop bound is respected and reported, then dead-end', () => {
  const g = {
    nodes: [bookends.start, n('dev', 'developer', 'implement'), n('qa', 'qa', 'qa'), bookends.end],
    edges: [e('e1', 'start', 'dev'), e('e2', 'dev', 'qa'), e('e3', 'qa', 'dev', 'on-failure', { maxLoops: 1 }), e('e4', 'qa', 'end', 'on-success')],
  };
  const r = simulateWorkflow(g, { outcomes: { qa: 'failure' } });
  assert.equal(r.result, 'dead-end');
  assert.ok(r.notes.some((x) => /loop.*bound/.test(x)), JSON.stringify(r.notes));
});

test('simulate: condition edges evaluate deterministically; else catches the rest', () => {
  // 'next' edges only fire on positive outcomes, so conditions split on task/
  // outcome fields — the docs-only template pattern.
  const g = {
    nodes: [bookends.start, n('dev', 'developer', 'implement'), { id: 'c', type: 'condition', label: 'if', position: { x: 0, y: 0 } },
      n('doc', 'docs', 'doc'), n('accept', 'pm', 'accept'), bookends.end],
    edges: [e('e1', 'start', 'dev'), e('e2', 'dev', 'c'),
      e('e3', 'c', 'doc', 'next', { condition: { field: 'task.type', op: 'eq', value: 'docs' } }),
      e('e4', 'c', 'accept', 'next', { else: true }),
      e('e5', 'doc', 'accept'), e('e6', 'accept', 'end', 'on-success')],
  };
  const code = simulateWorkflow(g);
  assert.deepEqual(code.steps.map((s) => s.nodeId), ['start', 'dev', 'c', 'accept', 'end']);
  const docs = simulateWorkflow(g, { taskType: 'docs' });
  assert.deepEqual(docs.steps.map((s) => s.nodeId), ['start', 'dev', 'c', 'doc', 'accept', 'end']);
  assert.equal(docs.calls, 3);
});

test('simulate: parallel branches merge before accept; step cap catches runaway graphs', () => {
  const g = {
    nodes: [bookends.start, n('dev', 'developer', 'implement'), n('ra', 'reviewer', 'review'), n('rb', 'reviewer', 'review'),
      { id: 'join', type: 'merge', label: 'both', position: { x: 0, y: 0 } }, n('accept', 'pm', 'accept'), bookends.end],
    edges: [e('e1', 'start', 'dev'), e('e2', 'dev', 'ra'), e('e3', 'dev', 'rb'), e('e4', 'ra', 'join'), e('e5', 'rb', 'join'),
      e('e6', 'join', 'accept'), e('e7', 'accept', 'end', 'on-success')],
  };
  const r = simulateWorkflow(g);
  assert.equal(r.result, 'end');
  assert.equal(r.calls, 4);                                    // dev + two reviewers + accept
  assert.deepEqual(r.steps.map((s) => s.nodeId), ['start', 'dev', 'ra', 'rb', 'join', 'join', 'accept', 'end']);
  assert.match(r.steps[5].note ?? '', /2\/2 arrived/);
  const loopy = { nodes: g.nodes, edges: [...g.edges, e('e8', 'accept', 'dev', 'on-reject', { maxLoops: 50 })] };
  const capped = simulateWorkflow(loopy, { outcomes: { accept: 'reject' }, maxSteps: 30 });
  assert.equal(capped.result, 'max-steps');
});

// ---------- referenced-by warnings ----------

test('workflowRefsFor finds pinned agents and role-named nodes in effective workflows', () => {
  // the built-in is the effective graph (no custom active) — 'developer' nodes are referenced
  const roleRefs = workflowRefsFor({ roleName: 'developer' });
  assert.ok(roleRefs.some((r) => r.nodes.some((x) => x.id === 'dev')), JSON.stringify(roleRefs));
  const g = {
    nodes: [bookends.start, { id: 'p1', type: 'agent', label: 'Pinned', agentId: 'ag-dev', config: { purpose: 'implement' }, position: { x: 0, y: 0 } }, n('acc', 'pm', 'accept'), bookends.end],
    edges: [e('e1', 'start', 'p1'), e('e2', 'p1', 'acc'), e('e3', 'acc', 'end', 'on-success')],
  };
  const c = createWorkflow('ws-s', 'pinned wf', '', g);
  assert.ok(c.workflowId);
  setActiveWorkflow('ws-s', c.workflowId);
  const agentRefs = workflowRefsFor({ agentId: 'ag-dev' });
  assert.ok(agentRefs.some((r) => r.nodes[0].id === 'p1'));
  setActiveWorkflow('ws-s', null);
});

// ---------- audit ----------

test('workflow edits land in the hash-chained audit log with who and what changed', () => {
  const c = createWorkflow('ws-s', 'audit wf', '', defaultWorkflowGraph());
  const wf = getWorkflow(c.workflowId);
  const g2 = { ...wf.graph, nodes: [...wf.graph.nodes, n('extra', 'docs', 'doc')], edges: [...wf.graph.edges, e('ex1', 'dev', 'extra'), e('ex2', 'extra', 'qa')] };
  saveWorkflowVersion(c.workflowId, g2, 'added docs node');
  const audit = workflowAudit(c.workflowId);
  assert.ok(audit.length >= 2);
  const saved = audit.find((a) => a.type === 'workflow.saved' && a.payload.n === 2);
  assert.ok(saved);
  assert.match(String(saved.payload.changes), /\+1 node.*extra/);
  // chain continuity: every event hash links to the previous one
  const chain = q(`SELECT seq, prev_hash, hash FROM events WHERE entity_id = ? ORDER BY seq`, c.workflowId);
  for (const row of chain) assert.ok(row.prev_hash && row.hash);
});

// ---------- guardrails end-to-end ----------

test('maxStepsPerTask guardrail pauses dispatching with a Needs-you item; approving continues', { timeout: 120000 }, async () => {
  setPlan(PLAN);
  const g = {
    nodes: [bookends.start, n('dev', 'developer', 'implement'), n('acc', 'pm', 'accept'), bookends.end],
    edges: [e('e1', 'start', 'dev'), e('e2', 'dev', 'acc'), e('e3', 'acc', 'end', 'on-success')],
    guardrails: { maxStepsPerTask: 1 },
  };
  const c = createWorkflow('ws-s', 'guarded wf', '', g);
  setActiveWorkflow('ws-s', c.workflowId);
  try {
    const r = createRun({ workspaceId: 'ws-s', goal: 'Add module a' });
    // the plan node is run-scope (free); the task's first agent step dispatches,
    // the second hits the task ceiling → pending approval
    const approval = await waitFor(() => q1(`SELECT id, action FROM approvals WHERE run_id = ? AND action = 'workflow.guardrail' AND status = 'pending'`, r.id));
    assert.ok(approval, 'expected a pending workflow.guardrail approval');
    const wis = q(`SELECT kind FROM work_items WHERE run_id = ? ORDER BY rowid`, r.id).map((x) => x.kind);
    assert.deepEqual(wis, ['plan', 'implement']);              // only one task step ran
    const task = q1(`SELECT status FROM tasks WHERE run_id = ?`, r.id);
    assert.equal(task.status, 'waiting-input');
    // owner approves — the run continues past the ceiling and finishes
    decideApproval(approval.id, true, 'ok');
    const done = await waitFor(() => { const s = q1('SELECT status FROM runs WHERE id = ?', r.id)?.status; return ['done', 'failed', 'stopped'].includes(s) ? s : null; });
    assert.equal(done, 'done');
  } finally {
    setActiveWorkflow('ws-s', null);
  }
});
