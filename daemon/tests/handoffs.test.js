// Stage 3: typed hand-off envelopes, strict reply validation, single-delivery
// broadcasts and message dedupe.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-handoff-'));
const { q, q1, run } = await import('../src/db.ts');
const { postMessage, takeInbox } = await import('../src/services/messages.ts');
const { handoffEnvelope, validateReply } = await import('../src/services/handoffs.ts');

const RUN = 'run-h1';
const agent = (id, name) => run('INSERT INTO agents (id, name) VALUES (?,?)', id, name);
agent('ag-dev', 'Dev'); agent('ag-qa', 'Testa'); agent('ag-pm', 'Pia');
run(`INSERT INTO tasks (id, run_id, title, status) VALUES ('task-open','${RUN}','Open task','verifying')`);
run(`INSERT INTO tasks (id, run_id, title, status) VALUES ('task-done','${RUN}','Done task','done')`);
const task = { id: 'task-open', runId: RUN, type: 'feature', status: 'verifying', meta: {} };

test('envelope: engine-produced, bounded, from stored facts', () => {
  run(`INSERT INTO work_items (id, task_id, run_id, kind, agent_id, status, finished_at, result)
       VALUES ('wi-impl','task-open','${RUN}','implement','ag-dev','delivered','2026-10-19T10:00:00Z',?)`,
    JSON.stringify({ summary: 'Wrote the converter', filesChanged: ['src/a.ts', 'HANDOFF.md'] }));
  run(`INSERT INTO checks (id, repo_id, name, kind, command) VALUES ('ck-1','r','unit','test','npm test')`);
  run(`INSERT INTO check_runs (id, check_id, task_id, run_id, status, created_at)
       VALUES ('cr-1','ck-1','task-open','${RUN}','pass','2026-10-19T10:01:00Z')`);
  postMessage({ runId: RUN, taskId: 'task-open', from: 'ag-dev', to: 'qa', kind: 'decision', text: 'chose the table parser' });
  postMessage({ runId: RUN, taskId: 'task-open', from: 'ag-dev', to: 'qa', kind: 'question', text: 'does the empty case matter?' });

  const env = handoffEnvelope(task, 'qa');
  assert.equal(env.fromRole, 'developer');
  assert.equal(env.toRole, 'qa');
  assert.equal(env.taskId, 'task-open');
  assert.equal(env.summary, 'Wrote the converter');
  assert.deepEqual(env.filesChanged, ['src/a.ts']);       // HANDOFF.md excluded
  assert.deepEqual(env.checksRun, ['unit pass']);
  assert.equal(env.decisions.length, 1);
  assert.equal(env.openQuestions.length, 1);
  // persisted for audit
  const row = q1(`SELECT artifacts FROM handoffs WHERE task_id = 'task-open' ORDER BY created_at DESC LIMIT 1`);
  assert.ok(JSON.parse(row.artifacts).taskId === 'task-open');
  // summary is capped at 400 chars
  const long = 'x'.repeat(900);
  run(`UPDATE work_items SET result = ? WHERE id = 'wi-impl'`, JSON.stringify({ summary: long }));
  assert.equal(handoffEnvelope(task, 'qa').summary.length, 400);
});

test('broadcasts deliver to each agent at most once', () => {
  postMessage({ runId: RUN, taskId: 'task-open', from: 'ag-dev', to: 'all', kind: 'finding', text: 'watch out for CRLF in fixtures' });
  const a1 = takeInbox('ag-qa', 'qa', RUN, 'task-open');
  assert.ok(a1.some((m) => m.text.includes('CRLF')));
  const a2 = takeInbox('ag-qa', 'qa', RUN, 'task-open');
  assert.ok(!a2.some((m) => m.text.includes('CRLF')));          // not re-sent
  const b1 = takeInbox('ag-pm', 'pm', RUN, 'task-open');
  assert.ok(b1.some((m) => m.text.includes('CRLF')));          // each agent gets it once
});

test('messages on finished tasks are never delivered', () => {
  postMessage({ runId: RUN, taskId: 'task-done', from: 'ag-dev', to: 'all', kind: 'note', text: 'old task note' });
  const inbox = takeInbox('ag-qa', 'qa', RUN, 'task-done');
  assert.ok(!inbox.some((m) => m.text === 'old task note'));
});

test('a near-identical unread message to the same recipient is dropped', () => {
  const first = postMessage({ runId: RUN, taskId: 'task-open', from: 'ag-dev', to: 'ag-qa', kind: 'note', text: 'Please look at the flaky test in suite two' });
  assert.ok(first);
  const dupe = postMessage({ runId: RUN, taskId: 'task-open', from: 'ag-dev', to: 'ag-qa', kind: 'note', text: 'Please look at the flaky test in suite two!' });
  assert.equal(dupe, null);
  const different = postMessage({ runId: RUN, taskId: 'task-open', from: 'ag-dev', to: 'ag-qa', kind: 'note', text: 'Completely different request about the docs page' });
  assert.ok(different);
  // direct mail is consumed on delivery, so the same text later is new again
  takeInbox('ag-qa', 'qa', RUN, 'task-open');
  const resend = postMessage({ runId: RUN, taskId: 'task-open', from: 'ag-dev', to: 'ag-qa', kind: 'note', text: 'Please look at the flaky test in suite two' });
  assert.ok(resend);
});

test('validateReply: strict shapes per decision role', () => {
  assert.equal(validateReply('qa', { decision: 'pass', findings: [] }), null);
  assert.match(validateReply('qa', { findings: [] }), /decision/);
  assert.match(validateReply('qa', { decision: 'pass', findings: 'none' }), /findings/);
  assert.equal(validateReply('review', { decision: 'request-changes', notes: 'x' }), null);
  assert.match(validateReply('review', { decision: 'lgtm' }), /decision/);
  assert.equal(validateReply('prompt-review', { decision: 'revise', notes: 'n' }), null);
  assert.equal(validateReply('prompt', { brief: 'do it' }), null);
  assert.match(validateReply('prompt', { rationale: 'nothing' }), /brief|prompt/);
  assert.equal(validateReply('accept', { decision: 'accept' }), null);
  assert.match(validateReply('accept', { decision: 'ok' }), /decision/);
  assert.equal(validateReply('plan', { planDiff: { add: [] } }), null);
  assert.equal(validateReply('plan', { tasks: [] }), null);
  assert.match(validateReply('plan', { dodItems: [] }), /tasks|planDiff/);
  // kinds outside the decision roles are not strict
  assert.equal(validateReply('implement', {}), null);
});
