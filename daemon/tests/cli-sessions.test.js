// CLI sessions: an agent keeps using one CLI session across work items instead of starting a new one every time.
// The rules are tested directly; the adapter is tested end to end against a fake CLI that remembers sessions the way
// Claude Code / Devin do (it can resume what it has, and refuses an id it has never heard of).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-clisess-'));

const { q, q1, run } = await import('../src/db.ts');
const S = await import('../src/services/cli-sessions.ts');
const { cliAdapter, SESSION_GONE } = await import('../src/adapters/cli.ts');
const { cliSessionSupport, withSessionArgs, CLI_PRESETS } = await import('../src/adapters/cli-resolve.ts');
const { cliSessionSettings, validateModelSettings } = await import('../src/services/models.ts');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sessrepo-'));
const other = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sessother-'));
const claude = CLI_PRESETS.claude.sessions;

const agent = (id, cliSession) => ({ id, name: id, settings: cliSession ? { cliSession } : {} });
const account = { id: 'acct-a' };
const base = (o = {}) => ({ account, preset: 'claude', cwd: repo, support: claude, stable: true, ...o });
let n = 0;
const item = () => `wi-${++n}`;
const rows = (f = {}) => S.listSessions({ includeArchived: true, ...f });

// ---------- settings ----------

test('session settings default to reuse; bad values are rejected', () => {
  // one node, one persistent session: waited for when busy, never rotated unless the owner sets a limit
  assert.deepEqual(cliSessionSettings({}), { mode: 'reuse', pinnedId: null, whenBusy: 'wait', rotateAfter: 0 });
  assert.equal(cliSessionSettings({ cliSession: { mode: 'new', whenBusy: 'wait', rotateAfter: 0 } }).mode, 'new');
  assert.equal(cliSessionSettings({ cliSession: { mode: 'bogus' } }).mode, 'reuse');
  assert.match(validateModelSettings({ cliSession: { mode: 'pinned' } }).join(), /choose the session/);
  assert.match(validateModelSettings({ cliSession: { rotateAfter: -1 } }).join(), /rotateAfter/);
  assert.match(validateModelSettings({ tierOverride: 'huge' }).join(), /tierOverride/);
  assert.deepEqual(validateModelSettings({ tierOverride: 'strong', cliSession: { mode: 'reuse', whenBusy: 'wait', rotateAfter: 10 } }), []);
});

test('each known CLI knows how to continue a session; custom ones are configured', () => {
  assert.equal(cliSessionSupport('claude -p').idFrom, 'assign');
  assert.equal(cliSessionSupport('agent -p').idFrom, 'stream');
  assert.equal(cliSessionSupport('devin -p --prompt-file {promptFile}').idFrom, 'list');
  assert.equal(cliSessionSupport('my-cli --go'), null, 'an unknown CLI has no session support until the owner configures it');
  assert.deepEqual(cliSessionSupport('my-cli', { resumeArgs: '--continue {session}', sessionIdPattern: 'id=(\\S+)' }), { resume: '--continue {session}', fresh: undefined, idFrom: 'pattern', pattern: 'id=(\\S+)' });
  assert.equal(withSessionArgs('claude -p', '--resume {session}', 'abc-123'), 'claude -p --resume "abc-123"');
});

test('a session id is read from stream-json, a pattern, or devin list output', () => {
  assert.equal(S.sessionIdFromOutput('{"type":"system","subtype":"init","session_id":"s-42"}\n{"type":"result"}'), 's-42');
  assert.equal(S.sessionIdFromOutput('junk\nSession saved: id=abc9 ok', 'id=(\\w+)'), 'abc9');
  assert.equal(S.sessionIdFromOutput('nothing here'), null);
  const sample = '\x1b[?2004h[\n  {"id":"buttered-wool","short_id":"buttered-wool","working_directory":"C:\\\\x","last_activity_at":1792387125,"title":"T1"},\n  {"id":"curved-breeze","working_directory":"C:\\\\x","last_activity_at":5,"title":"T2"}\n]\x1b[0m';
  assert.deepEqual(S.parseSessionList(sample).map((s) => [s.id, s.lastAt]), [['buttered-wool', 1792387125], ['curved-breeze', 5]]);
  assert.deepEqual(S.parseSessionList('No previous sessions'), []);
});

test('the "session is gone" check matches what the real CLIs print', () => {
  assert.ok(SESSION_GONE.test('No conversation found with session ID: 11111111-2222-4333-8444-555555555555'));   // claude 2.x
  assert.ok(SESSION_GONE.test("Error: No session found matching 'does-not-exist-123'"));                          // devin
  assert.ok(SESSION_GONE.test('chat abc not found'));
  assert.ok(!SESSION_GONE.test('TypeError: x is not a function\nrate limited, retry later'), 'ordinary failures are not mistaken for it');
});

// ---------- choosing a session ----------

test('an agent keeps its session: the first use creates one, the next continues it', async () => {
  const a = agent('ag-reuse');
  const first = await S.acquireSession({ ...base(), agent: a, itemId: item() });
  assert.equal(first.resumed, false);
  assert.ok(first.session.externalId, 'Claude Code gets an id we choose, up front');
  S.releaseSession(first.session.id, { itemId: 'x', ok: true, started: true });

  const second = await S.acquireSession({ ...base(), agent: a, itemId: item() });
  assert.equal(second.session.id, first.session.id);
  assert.equal(second.resumed, true);
  assert.match(second.note, /1 earlier work item/);
  S.releaseSession(second.session.id, { itemId: 'y', ok: true, started: true });
  assert.equal(rows({ agentId: 'ag-reuse' }).length, 1, 'still one session, not one per work item');
  assert.equal(S.getSession(first.session.id).uses, 2);
});

test('mode "new" and per-task worktrees do not track a session', async () => {
  const fresh = await S.acquireSession({ ...base(), agent: agent('ag-new', { mode: 'new' }), itemId: item() });
  assert.equal(fresh.session, null);
  const wt = await S.acquireSession({ ...base({ stable: false }), agent: agent('ag-wt'), itemId: item() });
  assert.equal(wt.session, null);
  assert.match(wt.note, /worktree/);
  const none = await S.acquireSession({ ...base({ support: null }), agent: agent('ag-none'), itemId: item() });
  assert.equal(none.session, null);
  assert.equal(rows({ agentId: 'ag-new' }).length + rows({ agentId: 'ag-wt' }).length + rows({ agentId: 'ag-none' }).length, 0);
});

test('sessions are per folder and per backend', async () => {
  const a = agent('ag-folders');
  const inRepo = await S.acquireSession({ ...base(), agent: a, itemId: item() });
  S.releaseSession(inRepo.session.id, { itemId: 'x', ok: true, started: true });
  const elsewhere = await S.acquireSession({ ...base({ cwd: other }), agent: a, itemId: item() });
  assert.notEqual(elsewhere.session.id, inRepo.session.id);
  S.releaseSession(elsewhere.session.id, { itemId: 'y', ok: true, started: true });
  const otherBackend = await S.acquireSession({ ...base({ account: { id: 'acct-b' } }), agent: a, itemId: item() });
  assert.notEqual(otherBackend.session.id, inRepo.session.id);
  S.releaseSession(otherBackend.session.id, { itemId: 'z', ok: true, started: true });
});

test('a busy session is waited for, never duplicated — even for an agent saved with "start an additional one"', async () => {
  for (const [id, whenBusy] of [['ag-busy', 'new'], ['ag-wait', 'wait']]) {
    const w = agent(id, { mode: 'reuse', whenBusy, rotateAfter: 0 });
    const held = await S.acquireSession({ ...base(), agent: w, itemId: item() });
    setTimeout(() => S.releaseSession(held.session.id, { itemId: 'z', ok: true, started: true }), 700);
    const t0 = Date.now();
    const notes = [];
    const after = await S.acquireSession({ ...base(), agent: w, itemId: item(), onWait: (n) => n && notes.push(n) });
    assert.equal(after.session.id, held.session.id, 'waited and continued the same session');
    assert.ok(Date.now() - t0 >= 600, 'it really waited');
    assert.equal(after.resumed, true);
    assert.match(notes[0], /waiting for session .* finishing another work item/);
    S.releaseSession(after.session.id, { itemId: 'q', ok: true, started: true });
    assert.equal(rows({ agentId: id }).length, 1);
  }
});

test('a work item stopped while waiting for its session gives up instead of starting another', async () => {
  const a = agent('ag-stopwait');
  const held = await S.acquireSession({ ...base(), agent: a, itemId: item() });
  run(`INSERT INTO work_items (id, run_id, kind, agent_id, status, idempotency_key, attempt) VALUES ('wi-waiter','r','qa','ag-stopwait','running','kw',1)`);
  setTimeout(() => run(`UPDATE work_items SET status = 'cancelled' WHERE id = 'wi-waiter'`), 300);
  await assert.rejects(S.acquireSession({ ...base(), agent: a, itemId: 'wi-waiter' }), /cancelled/);
  S.releaseSession(held.session.id, { itemId: 'x', ok: true, started: true });
  assert.equal(rows({ agentId: 'ag-stopwait' }).length, 1);
});

test('a session is retired after the configured number of work items', async () => {
  const a = agent('ag-rotate', { mode: 'reuse', whenBusy: 'new', rotateAfter: 2 });
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = await S.acquireSession({ ...base(), agent: a, itemId: item() });
    ids.push(r.session.id);
    S.releaseSession(r.session.id, { itemId: 'x', ok: true, started: true });
  }
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[2], ids[0], 'the third work item starts a new session');
  assert.equal(S.getSession(ids[0]).status, 'archived');
  assert.match(S.getSession(ids[0]).note, /rotated after 2/);
  assert.equal(rows({ agentId: 'ag-rotate' }).filter((r) => r.status === 'active').length, 1, 'nothing piles up');
});

test('a pinned session belongs to one agent: another agent pinning it gets its own, never a share', async () => {
  const pin = S.createSession({ accountId: 'acct-a', preset: 'claude', agentId: null, cwd: repo, externalId: 'pin-ext', started: true, label: 'chosen' });
  const p1 = await S.acquireSession({ ...base(), agent: agent('ag-p1', { mode: 'pinned', pinnedId: pin.id }), itemId: item() });
  assert.equal(p1.session.id, pin.id);
  assert.equal(p1.resumed, true);
  assert.equal(S.getSession(pin.id).agentId, 'ag-p1', 'pinning claims it');
  S.releaseSession(p1.session.id, { itemId: 'x', ok: true, started: true });
  const notes = [];
  const p2 = await S.acquireSession({ ...base(), agent: agent('ag-p2', { mode: 'pinned', pinnedId: pin.id }), itemId: item(), onWait: (n) => n && notes.push(n) });
  assert.notEqual(p2.session.id, pin.id, 'free, but another agent\'s conversation');
  assert.match(notes[0], /belongs to another agent/);
  S.releaseSession(p2.session.id, { itemId: 'y', ok: true, started: true });

  const wrong = [];
  const wrongFolder = await S.acquireSession({ ...base({ cwd: other }), agent: agent('ag-p1', { mode: 'pinned', pinnedId: pin.id }), itemId: item(), onWait: (n) => n && wrong.push(n) });
  assert.notEqual(wrongFolder.session.id, pin.id);
  assert.match(wrong[0], /another folder/);
  S.releaseSession(wrongFolder.session.id, { itemId: 'z', ok: true, started: true });
});

test('an unassigned (imported) session is claimed by the first agent that needs one', async () => {
  const loose = S.createSession({ accountId: 'acct-a', preset: 'devin', agentId: null, cwd: repo, externalId: 'imp-1', started: true, label: 'imported one' });
  const dev = { ...claude, idFrom: 'list' };
  const got = await S.acquireSession({ ...base({ preset: 'devin', support: dev }), agent: agent('ag-claimer'), itemId: item() });
  assert.equal(got.session.id, loose.id);
  assert.equal(got.session.agentId, 'ag-claimer');
  assert.equal(got.resumed, true);
  S.releaseSession(got.session.id, { itemId: 'x', ok: true, started: true });
});

test('reassigning, archiving and removing respect a session that is in use', async () => {
  const a = agent('ag-guard');
  const r = await S.acquireSession({ ...base(), agent: a, itemId: item() });
  assert.match(S.updateSession(r.session.id, { agentId: null }).error, /in use/);
  assert.match(S.updateSession(r.session.id, { status: 'archived' }).error, /in use/);
  assert.match(S.deleteSession(r.session.id).error, /in use/);
  S.releaseSession(r.session.id, { itemId: 'x', ok: true, started: true });
  run(`INSERT INTO agents (id, name, avatar, settings, instructions, caps, observability, status) VALUES ('ag-other','Other','', '{}','', '{}','actions','idle')`);
  assert.match(S.updateSession(r.session.id, { agentId: 'nobody' }).error, /agent not found/);
  assert.equal(S.updateSession(r.session.id, { label: 'renamed', agentId: 'ag-other' }).agentId, 'ag-other');
  assert.deepEqual(S.deleteSession(r.session.id), { ok: true });
  assert.equal(S.getSession(r.session.id), null);
  // a restart leaves no session "busy"
  const b = await S.acquireSession({ ...base(), agent: agent('ag-boot'), itemId: item() });
  S.clearBusySessions();
  assert.equal(S.getSession(b.session.id).busyItem, null);
});

// ---------- the adapter, against a fake CLI that remembers sessions ----------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-fakesess-'));
const fake = path.join(dir, 'fake.js');
const store = path.join(dir, 'store.json');
const log = path.join(dir, 'calls.jsonl');
fs.writeFileSync(fake, `
const fs = require('fs');
const args = process.argv.slice(2);
const val = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const store = ${JSON.stringify(store)};
const known = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : [];
const resume = val('--resume'), assigned = val('--session-id');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ resume, assigned, cwd: process.cwd() }) + '\\n');
const delay = Number(process.env.FAKE_DELAY || 0);
setTimeout(() => {
  if (resume && !known.includes(resume)) { console.error('No conversation found with session ID: ' + resume); process.exit(1); }
  const id = resume || assigned || ('fake-' + (known.length + 1));
  if (!known.includes(id)) fs.writeFileSync(store, JSON.stringify([...known, id]));
  if (!process.env.FAKE_SILENT) console.log('session=' + id);
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done ' + id, session_id: id }));
}, delay);
`);
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const reset = () => { fs.rmSync(store, { force: true }); fs.rmSync(log, { force: true }); q('SELECT id FROM cli_sessions').forEach((r) => S.deleteSession(r.id)); };

let wi = 0;
const dispatch = (a, cfg, extra = {}) => {
  const events = [];
  const ctx = {
    workItem: { id: `fw-${++wi}`, kind: 'qa', runId: 'r', attempt: 1 },
    task: { id: 't', title: 'T' }, prompt: 'do it', worktree: repo, repo: { path: repo },
    agent: a, account: { id: 'acct-fake', config: { command: `"${process.execPath}" "${fake}"`, ...cfg } }, model: null,
    emit: (type, payload) => events.push({ type, payload }), ...extra,
  };
  return cliAdapter.dispatch(ctx).then((res) => ({ res, events }));
};
const ASSIGN = { resumeArgs: '--resume {session}', newSessionArgs: '--session-id {session}' };
const PATTERN = { resumeArgs: '--resume {session}', sessionIdPattern: 'session=(\\S+)' };

test('adapter: the second work item continues the first one’s session (CLI told --resume)', async () => {
  reset();
  const a = agent('fa-1');
  const one = await dispatch(a, ASSIGN);
  const two = await dispatch(a, ASSIGN);
  const c = calls();
  assert.ok(c[0].assigned && !c[0].resume, 'first run starts a session under an id we chose');
  assert.equal(c[1].resume, c[0].assigned, 'second run resumes exactly that id');
  assert.equal(rows({ agentId: 'fa-1' }).length, 1);
  assert.equal(two.res.raw.cliSession.resumed, true);
  assert.equal(one.res.raw.cliSession.resumed, false);
  assert.ok(two.events.some((e) => /CLI session: continuing session/.test(e.payload.text ?? '')), 'the activity feed says so');
  assert.equal(S.getSession(two.res.raw.cliSession.id).uses, 2);
});

test('adapter: a CLI that reports its id (no assignment) is learned from the output, then resumed', async () => {
  reset();
  const a = agent('fa-2');
  await dispatch(a, PATTERN);
  const row = rows({ agentId: 'fa-2' })[0];
  assert.equal(row.externalId, 'fake-1');
  await dispatch(a, PATTERN);
  assert.equal(calls()[1].resume, 'fake-1');
  assert.equal(rows({ agentId: 'fa-2' }).length, 1);
});

test('adapter: "new session each time" leaves nothing behind and never resumes', async () => {
  reset();
  const a = agent('fa-3', { mode: 'new' });
  await dispatch(a, ASSIGN); await dispatch(a, ASSIGN);
  assert.ok(calls().every((c) => !c.resume && !c.assigned));
  assert.equal(rows().length, 0);
});

test('adapter: a session the CLI no longer has is retired and replaced without failing the work item', async () => {
  reset();
  const a = agent('fa-4');
  await dispatch(a, ASSIGN);
  fs.rmSync(store);                                              // the CLI forgot everything (cleared history, new machine, …)
  const r = await dispatch(a, ASSIGN);
  const c = calls();
  assert.equal(c.length, 3, 'resume attempt failed, then one retry with a fresh session');
  assert.ok(c[1].resume && !c[2].resume && c[2].assigned);
  assert.ok(r.res.raw.text.startsWith('done '), 'the work item still succeeded');
  assert.ok(r.events.some((e) => /no longer has that session/.test(e.payload.text ?? '')));
  const all = rows({ agentId: 'fa-4' });
  assert.equal(all.filter((x) => x.status === 'archived').length, 1);
  assert.equal(all.filter((x) => x.status === 'active').length, 1);
});

test('adapter: a CLI whose session id cannot be read leaves no session row to pile up', async () => {
  reset();
  process.env.FAKE_SILENT = '1';
  try {
    const r = await dispatch(agent('fa-5'), { resumeArgs: '--resume {session}', sessionIdPattern: 'nothing-matches-(\\d+)' });
    assert.ok(r.events.some((e) => /can't be reused/.test(e.payload.text ?? '')));
  } finally { delete process.env.FAKE_SILENT; }
  assert.equal(rows({ agentId: 'fa-5' }).length, 0);
});

test('adapter: one agent on two workflow nodes keeps two conversations, each continued on its next turn', async () => {
  reset();
  run(`INSERT INTO workflow_versions (id, workflow_id, n, graph) VALUES ('wv-a', 'wf-a', 1, ?)`, JSON.stringify({ nodes: [{ id: 'pm', label: 'PM' }, { id: 'pm1', label: 'PM1' }] }));
  run(`INSERT INTO runs (id, workspace_id, goal, workflow_version_id) VALUES ('r-nodes', 'ws', 'g', 'wv-a')`);
  const a = agent('fa-nodes');
  const turn = async (node) => {
    const id = `fw-${++wi}`;
    run(`INSERT INTO work_items (id, run_id, kind, status, idempotency_key, attempt, workflow_node_id) VALUES (?, 'r-nodes', 'qa', 'running', ?, 1, ?)`, id, `k-${id}`, node);
    const ctx = { workItem: { id, kind: 'qa', runId: 'r-nodes', attempt: 1, workflowNodeId: null }, task: { id: 't', title: 'T' }, prompt: 'go', worktree: repo, repo: { path: repo },
      agent: a, account: { id: 'acct-fake', config: { command: `"${process.execPath}" "${fake}"`, ...ASSIGN } }, model: null, emit: () => {} };
    const res = await cliAdapter.dispatch(ctx);
    return { res, row: q1('SELECT cli_session_id FROM work_items WHERE id = ?', id).cli_session_id };
  };
  const pm = await turn('pm'); const pm1 = await turn('pm1'); const pmAgain = await turn('pm'); const pm1Again = await turn('pm1');
  assert.notEqual(pm.res.raw.cliSession.id, pm1.res.raw.cliSession.id, 'PM and PM1 are separate conversations');
  assert.equal(pmAgain.res.raw.cliSession.id, pm.res.raw.cliSession.id);
  assert.equal(pm1Again.res.raw.cliSession.id, pm1.res.raw.cliSession.id);
  assert.equal(pmAgain.res.raw.cliSession.resumed, true);
  assert.equal(pm.row, pm.res.raw.cliSession.id, 'the work item records the session it ran in');
  const c = calls();
  assert.equal(c[2].resume, c[0].assigned);
  assert.equal(c[3].resume, c[1].assigned);
  assert.equal(rows({ agentId: 'fa-nodes' }).length, 2);
  assert.deepEqual(rows({ agentId: 'fa-nodes' }).map((r) => r.nodeLabel).sort(), ['PM', 'PM1']);
});

test('adapter: two work items at once take turns on the one session — never a second conversation', async () => {
  process.env.FAKE_DELAY = '400';
  try {
    for (const [id, whenBusy] of [['fa-6', 'new'], ['fa-7', 'wait']]) {
      reset();
      const w = agent(id, { mode: 'reuse', whenBusy, rotateAfter: 0 });
      const [x, y] = await Promise.all([dispatch(w, ASSIGN), dispatch(w, ASSIGN)]);
      assert.equal(rows({ agentId: id }).length, 1, 'waited its turn on the same session');
      const c = calls();
      assert.equal(c[1].resume, c[0].assigned);
      assert.ok([...x.events, ...y.events].some((e) => /waiting for session/.test(e.payload.text ?? '')), 'the wait is shown, not silent');
    }
  } finally { delete process.env.FAKE_DELAY; }
});
