// The request queue: typed anywhere quick, shared by the whole app, started by hand or (opt-in) automatically.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-queue-'));

const { q, q1, run } = await import('../src/db.ts');
const { enqueue, listQueue, removeQueued, markStarted, officeBusy, startNextQueued, autoStartTick } = await import('../src/services/queue.ts');
const { createRun, wireEngineEvents, stopRun } = await import('../src/engine/engine.ts');
const { ensureRepo } = await import('../src/services/git.ts');

const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-queuerepo-'));
ensureRepo(repoDir);
for (const name of ['pm', 'developer', 'reviewer']) {
  run(`INSERT INTO roles (id, name, version, responsibilities, allowed_actions, default_instructions, default_skills)
       VALUES (?,?,1,'[]','[]','','[]')`, `role-${name}`, name);
}
run(`INSERT INTO policies (id, scope, rules) VALUES ('pol-q','{}','[]')`);
const mkOffice = (id, settings = '{}', withRepo = true) => {
  run(`INSERT INTO workspaces (id, name, purpose, repo_ids, allowed_provider_ids, policy_id, memory_scope, settings)
       VALUES (?,?,'', ?, '[]','pol-q','isolated',?)`, id, id, withRepo ? `["repo-${id}"]` : '[]', settings);
  if (withRepo) run(`INSERT INTO repos (id, workspace_id, path, remote_url, default_branch, integration_branch, build_cmd, test_cmd)
                     VALUES (?,?,?,NULL,'main','integration','','')`, `repo-${id}`, id, repoDir);
};
mkOffice('ws-a', '{"workMode":"direct"}');
mkOffice('ws-b', '{"workMode":"direct","autoStartQueue":true,"queueBudgetUsd":12}');
mkOffice('ws-bare', '{"autoStartQueue":true}', false);
wireEngineEvents();

test('a request is trimmed, validated and stored for its office', () => {
  const r = enqueue({ text: '  Add a --toc flag \r\n with tests ', workspaceId: 'ws-a', source: 'tray' });
  assert.equal(r.text, 'Add a --toc flag \n with tests');
  assert.equal(r.status, 'queued');
  assert.equal(r.source, 'tray');
  assert.deepEqual(listQueue('ws-a').map((x) => x.id), [r.id]);
  assert.deepEqual(listQueue('ws-b'), []);

  assert.match(enqueue({ text: '   ', workspaceId: 'ws-a' }).error, /type a request/);
  assert.match(enqueue({ text: 'x'.repeat(8001), workspaceId: 'ws-a' }).error, /too long/);
  assert.match(enqueue({ text: 'hi', workspaceId: 'nope' }).error, /office not found/);
  assert.equal(enqueue({ text: 'odd source', workspaceId: 'ws-a', source: '<script>' }).source, 'api');
});

test('without an office it goes to the first one (or the most recently used)', () => {
  const r = enqueue({ text: 'no office given' });
  assert.ok(q1('SELECT id FROM workspaces WHERE id = ?', r.workspaceId));
});

test('a queued request can be removed once, and removed ones leave the list', () => {
  const r = enqueue({ text: 'to remove', workspaceId: 'ws-a' });
  assert.deepEqual(removeQueued(r.id), { ok: true });
  assert.ok(!listQueue('ws-a').some((x) => x.id === r.id));
  assert.match(removeQueued(r.id).error, /already removed/);
  assert.match(removeQueued('nope').error, /not found/);
});

test('starting a run from a queued request consumes it', () => {
  const r = enqueue({ text: 'consume me', workspaceId: 'ws-a' });
  const created = createRun({ workspaceId: 'ws-a', goal: r.text });
  markStarted(r.id, created.id);
  const row = q1('SELECT status, run_id FROM request_queue WHERE id = ?', r.id);
  assert.equal(row.status, 'started');
  assert.equal(row.run_id, created.id);
  assert.ok(!listQueue('ws-a').some((x) => x.id === r.id));
  markStarted(r.id, 'other');                                   // already started: unchanged
  assert.equal(q1('SELECT run_id FROM request_queue WHERE id = ?', r.id).run_id, created.id);
  stopRun(created.id);
});

test('start-next uses the office repository and the configured budget, oldest first', () => {
  const first = enqueue({ text: 'first', workspaceId: 'ws-b' });
  enqueue({ text: 'second', workspaceId: 'ws-b' });
  const r = startNextQueued('ws-b');
  assert.equal(r.queueId, first.id);
  const row = q1('SELECT goal, repo_id, budget FROM runs WHERE id = ?', r.runId);
  assert.equal(row.goal, 'first');
  assert.equal(row.repo_id, 'repo-ws-b');
  assert.equal(JSON.parse(row.budget).runUsd, 12);
  assert.deepEqual(listQueue('ws-b').map((x) => x.text), ['second']);
  stopRun(r.runId);
});

test('an office without a repository keeps its queue and says why', () => {
  enqueue({ text: 'waiting for a repo', workspaceId: 'ws-bare' });
  assert.match(startNextQueued('ws-bare').skipped, /no repository/);
  assert.equal(listQueue('ws-bare').length, 1);
});

test('auto-start only fires for opted-in offices that are idle', () => {
  for (const r of q(`SELECT id FROM runs WHERE workspace_id IN ('ws-a','ws-b')`)) { try { stopRun(r.id); } catch { /* already stopped */ } }
  q(`SELECT id FROM request_queue WHERE status = 'queued'`).forEach((r) => removeQueued(r.id));
  assert.equal(officeBusy('ws-b'), false);

  enqueue({ text: 'a queued in a non-auto office', workspaceId: 'ws-a' });
  const b1 = enqueue({ text: 'auto one', workspaceId: 'ws-b' });
  const b2 = enqueue({ text: 'auto two', workspaceId: 'ws-b' });
  autoStartTick();
  assert.equal(q1('SELECT status FROM request_queue WHERE id = ?', b1.id).status, 'started', 'the idle opted-in office starts its first request');
  assert.equal(q1('SELECT status FROM request_queue WHERE id = ?', b2.id).status, 'queued', 'one at a time');
  assert.equal(listQueue('ws-a').length, 1, 'an office that did not opt in is left alone');
  assert.equal(officeBusy('ws-b'), true);

  autoStartTick();                                              // still busy: the second one keeps waiting
  assert.equal(q1('SELECT status FROM request_queue WHERE id = ?', b2.id).status, 'queued');

  stopRun(q1('SELECT run_id FROM request_queue WHERE id = ?', b1.id).run_id);
  assert.equal(officeBusy('ws-b'), false, 'a stopped run frees the office');
  autoStartTick();
  assert.equal(q1('SELECT status FROM request_queue WHERE id = ?', b2.id).status, 'started', 'the next one starts once the office is idle');
});
