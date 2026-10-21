// A session left "busy" by a work item that died (stopped, killed, lost) is free again, and a CLI's session id is kept
// from the moment it is printed, so an interrupted agent can reconnect to its conversation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-reconnect-'));
const { run } = await import('../src/db.ts');
const S = await import('../src/services/cli-sessions.ts');
const { CLI_PRESETS } = await import('../src/adapters/cli-resolve.ts');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-reconnect-repo-'));
const agent = { id: 'ag-x', name: 'x', settings: {} };
const base = (itemId) => ({ agent, account: { id: 'acct' }, preset: 'cursor', cwd: repo, support: CLI_PRESETS.cursor.sessions, stable: true, itemId });

test('a session held by a dead work item is released on the next acquire and reused', async () => {
  const s = S.createSession({ accountId: 'acct', preset: 'cursor', agentId: 'ag-x', cwd: repo });
  run(`INSERT INTO work_items (id, run_id, kind, agent_id, status, idempotency_key, attempt) VALUES ('wi-dead','r1','implement','ag-x','cancelled','k1',1)`);
  run('UPDATE cli_sessions SET busy_item = ? WHERE id = ?', 'wi-dead', s.id);
  const got = await S.acquireSession(base('wi-new'));
  assert.equal(got.session.id, s.id, 'the same session is used, not an additional one');
  assert.equal(S.listSessions({ agentId: 'ag-x' }).length, 1);
});

test('a session held by a work item that is still running stays busy: the next one waits for it, then continues it', async () => {
  const s = S.listSessions({ agentId: 'ag-x' })[0];
  S.releaseSession(s.id, { itemId: 'wi-new', ok: true });
  run(`INSERT INTO work_items (id, run_id, kind, agent_id, status, idempotency_key, attempt) VALUES ('wi-live','r1','implement','ag-x','running','k2',1)`);
  run('UPDATE cli_sessions SET busy_item = ? WHERE id = ?', 'wi-live', s.id);
  setTimeout(() => run(`UPDATE work_items SET status = 'delivered' WHERE id = 'wi-live'`), 600);
  const t0 = Date.now();
  const got = await S.acquireSession({ ...base('wi-other'), agent: { ...agent, settings: { cliSession: { whenBusy: 'new' } } } });
  assert.equal(got.session.id, s.id);
  assert.ok(Date.now() - t0 >= 500, 'it waited while the holder was running');
  assert.equal(S.listSessions({ agentId: 'ag-x' }).length, 1);
  S.releaseSession(s.id, { itemId: 'wi-other', ok: true });
});

test('the session id is saved as soon as it is known, once, and the session counts as started', () => {
  const s = S.createSession({ accountId: 'acct', preset: 'cursor', agentId: 'ag-y', cwd: repo });
  assert.equal(S.getSession(s.id).started, false);
  S.setSessionExternalId(s.id, 'abc-123');
  S.setSessionExternalId(s.id, 'other');
  const after = S.getSession(s.id);
  assert.equal(after.externalId, 'abc-123');
  assert.equal(after.started, true);
});
