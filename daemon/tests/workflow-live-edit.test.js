// Saving a workflow while a run follows it: the run switches to the new version at once unless a step that currently
// has work was removed (or changed kind); then it waits and switches when that work has finished.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-liveedit-'));
const { q1, run } = await import('../src/db.ts');
const { adoptWorkflowVersion, adoptLatestForRun, wireEngineEvents, getRun, graphFor } = await import('../src/engine/engine.ts');
const { createWorkflow, saveWorkflowVersion, latestVersionOf } = await import('../src/services/workflow.ts');
const { now } = await import('../src/util.ts');

run(`INSERT INTO policies (id, scope, rules) VALUES ('pol-l','{}','[]')`);
run(`INSERT INTO workspaces (id, name, purpose, repo_ids, allowed_provider_ids, policy_id, memory_scope, settings) VALUES ('ws-l','L','','[]','[]','pol-l','isolated','{}')`);
for (const name of ['pm', 'developer', 'reviewer']) run(`INSERT INTO roles (id, name, version, responsibilities, allowed_actions, default_instructions, default_skills) VALUES (?,?,1,'[]','[]','','[]')`, `role-${name}`, name);
wireEngineEvents();

const P = { x: 0, y: 0 };
const n = (id, role, purpose) => ({ id, type: 'agent', label: id, role, config: { purpose }, position: P });
const START = { id: 'start', type: 'start', label: 'S', position: P }, END = { id: 'end', type: 'end', label: 'E', position: P };
const e = (id, from, to, kind = 'next') => ({ id, from, to, kind });
const g1 = { nodes: [START, n('dev', 'developer', 'implement'), n('rev', 'reviewer', 'review'), END], edges: [e('a', 'start', 'dev'), e('b', 'dev', 'rev'), e('c', 'rev', 'end')] };

const wf = createWorkflow('ws-l', 'Live', '', g1);
const wfId = wf.workflowId;
const v1 = latestVersionOf(wfId).versionId;
run(`INSERT INTO dod (id, run_id, version, items, status) VALUES ('dod-l','run-l',1,'[]','approved')`);
run(`INSERT INTO runs (id, workspace_id, repo_id, goal, status, dod_id, budget, limits, current_cycle, started_at, workflow_version_id) VALUES ('run-l','ws-l','r','goal','paused','dod-l','{}','{}',1,?,?)`, now(), v1);
const task = (id, title, wfState) => run(`INSERT INTO tasks (id, run_id, title, description, type, status, priority, depends_on, acceptance_criteria, deliverables, planned_by, difficulty, budget_usd, dod_item_ids, affected_paths, meta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  id, 'run-l', title, '', 'feature', 'in-progress', 1, '[]', '[]', '[]', 'pm', 2, 5, '[]', '[]', JSON.stringify({ wf: wfState }));
task('t1', 'Add login', { nodes: ['dev'], fired: [], loops: {}, arrived: {} });

const versionOf = () => getRun('run-l').workflowVersionId;
const save = (g, note) => saveWorkflowVersion(wfId, g, note);

test('adding a step while another is running switches the run at once and leaves the work alone', () => {
  const g2 = { ...g1, nodes: [START, n('dev', 'developer', 'implement'), n('qa', 'reviewer', 'review'), n('rev', 'reviewer', 'review'), END], edges: [e('a', 'start', 'dev'), e('b', 'dev', 'qa'), e('b2', 'qa', 'rev'), e('c', 'rev', 'end')] };
  const r = save(g2, 'add QA');
  assert.ok(!('error' in r));
  assert.equal(versionOf(), r.version.id, 'the run now follows the new version');
  assert.ok(graphFor(getRun('run-l')).graph.nodes.some((x) => x.id === 'qa'));
  assert.equal(q1('SELECT status FROM tasks WHERE id = ?', 't1').status, 'in-progress');
  assert.equal(q1('SELECT meta FROM tasks WHERE id = ?', 't1').meta.includes('"dev"'), true, 'the task still sits on its step');
  assert.equal(q1('SELECT pending_workflow_version_id p FROM runs WHERE id = ?', 'run-l').p, null);
});

test('removing the step that is working waits for it; the switch happens when it has finished', () => {
  const before = versionOf();
  const g3 = { nodes: [START, n('rev', 'reviewer', 'review'), END], edges: [e('a', 'start', 'rev'), e('c', 'rev', 'end')] };
  const r = save(g3, 'drop dev');
  assert.equal(versionOf(), before, 'still on the old version');
  assert.equal(q1('SELECT pending_workflow_version_id p FROM runs WHERE id = ?', 'run-l').p, r.version.id);
  const again = adoptWorkflowVersion('run-l', r.version.id);
  assert.equal(again.pending, true);
  assert.match(again.blockers[0], /“dev” is still working on “Add login”/);
  // the task finishes its step
  run(`UPDATE tasks SET meta = ?, status = 'done' WHERE id = 't1'`, JSON.stringify({ wf: { nodes: [], fired: ['dev'], loops: {}, arrived: {} } }));
  const done = adoptLatestForRun('run-l');
  assert.equal(done.adopted, true);
  assert.equal(versionOf(), r.version.id);
  assert.equal(q1('SELECT pending_workflow_version_id p FROM runs WHERE id = ?', 'run-l').p, null);
});

test('a step that changes kind under running work blocks the switch; finished runs and the built-in flow are left alone', () => {
  task('t2', 'Second task', { nodes: ['rev'], fired: [], loops: {}, arrived: {} });
  const g4 = { nodes: [START, { id: 'rev', type: 'human', label: 'rev', position: P, config: {} }, END], edges: [e('a', 'start', 'rev'), e('c', 'rev', 'end')] };
  const before = versionOf();
  save(g4, 'rev is now a human gate');
  assert.equal(versionOf(), before);
  assert.match(adoptWorkflowVersion('run-l', latestVersionOf(wfId).versionId).blockers[0], /changed kind/);
  run(`UPDATE runs SET status = 'done' WHERE id = 'run-l'`);
  assert.deepEqual(adoptWorkflowVersion('run-l', latestVersionOf(wfId).versionId), { adopted: false });
  assert.equal(adoptLatestForRun('nope').error, 'run not found');
  run(`INSERT INTO runs (id, workspace_id, repo_id, goal, status, dod_id, budget, limits, current_cycle) VALUES ('run-b','ws-l','r','g','running','dod-l','{}','{}',0)`);
  assert.match(adoptLatestForRun('run-b').error, /built-in/);
});
