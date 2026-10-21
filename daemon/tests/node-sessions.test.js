// One workflow node, one persistent CLI session: each node's agent keeps its own conversation across tasks, retries,
// loops and runs; separate nodes (PM and PM1, two nodes on one provider) and separate agents never share one. The owner
// can see each session — its work and its conversation — and open the exact session in a terminal.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-nodesess-'));
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-claudecfg-'));
const { q1, run } = await import('../src/db.ts');
const S = await import('../src/services/cli-sessions.ts');
const V = await import('../src/services/cli-session-view.ts');
const { CLI_PRESETS } = await import('../src/adapters/cli-resolve.ts');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-nodesess-repo-'));
const claude = CLI_PRESETS.claude.sessions;
const agent = (id) => ({ id, name: id, settings: {} });
let n = 0;
const item = () => `nwi-${++n}`;
const take = (a, node, extra = {}) => S.acquireSession({ agent: a, account: { id: 'acct-c' }, preset: 'claude', cwd: repo, support: claude, stable: true, itemId: item(), node, ...extra });
const done = (acq) => S.releaseSession(acq.session.id, { itemId: 'x', ok: true, started: true });
const PM = { key: 'wf:wf1:pm', label: 'PM' };
const PM1 = { key: 'wf:wf1:pm1', label: 'PM1' };

test('a node keeps one session across tasks, retries and loop iterations', async () => {
  const pm = agent('ag-pm');
  const first = await take(pm, PM); done(first);
  assert.match(first.note, /first work for the node “PM”/);
  for (let i = 0; i < 5; i++) {               // next tasks, a retry, three trips round a review loop
    const again = await take(pm, PM);
    assert.equal(again.session.id, first.session.id);
    assert.equal(again.resumed, true);
    done(again);
  }
  assert.equal(S.getSession(first.session.id).uses, 6);
  assert.equal(S.getSession(first.session.id).label, 'ag-pm · PM');
  assert.equal(S.getSession(first.session.id).nodeKey, 'wf:wf1:pm');
});

test('PM and PM1 — two nodes, even with the same agent and provider — have separate sessions', async () => {
  const pm = agent('ag-pm');
  const a = await take(pm, PM); done(a);
  const b = await take(pm, PM1); done(b);
  assert.notEqual(a.session.id, b.session.id);
  const a2 = await take(pm, PM); done(a2);
  const b2 = await take(pm, PM1); done(b2);
  assert.equal(a2.session.id, a.session.id);
  assert.equal(b2.session.id, b.session.id, 'each node continues its own conversation');
});

test('two agents on the same node never share: a fallback agent gets a session of its own', async () => {
  const dev = { key: 'wf:wf1:dev', label: 'Developer' };
  const mine = await take(agent('ag-dev'), dev); done(mine);
  const theirs = await take(agent('ag-dev-backup'), dev); done(theirs);
  assert.notEqual(mine.session.id, theirs.session.id);
});

test('a session from before nodes were tracked becomes the node\'s session (the conversation goes on)', async () => {
  const old = S.createSession({ accountId: 'acct-c', preset: 'claude', agentId: 'ag-legacy', cwd: repo, externalId: 'old-ext', started: true, label: 'old one' });
  const got = await take(agent('ag-legacy'), null);
  assert.equal(got.session.id, old.id);
  assert.equal(got.resumed, true);
  assert.equal(S.getSession(old.id).nodeKey, 'pipeline');
  done(got);
});

test('only a reset starts the node over; the next work then has a new session and the old one is kept', async () => {
  const node = { key: 'wf:wf1:qa', label: 'QA' };
  const a = await take(agent('ag-qa'), node); done(a);
  assert.equal(S.resetSession(a.session.id).status, 'archived');
  const b = await take(agent('ag-qa'), node); done(b);
  assert.notEqual(b.session.id, a.session.id);
  assert.match(S.getSession(a.session.id).note, /reset by the owner/);
  const c = await take(agent('ag-qa'), node); done(c);
  assert.equal(c.session.id, b.session.id);
});

test('the node of a work item comes from its workflow; work outside a node continues the agent\'s node session', async () => {
  run(`INSERT INTO workflow_versions (id, workflow_id, n, graph) VALUES ('wv1', 'wf-main', 1, ?)`, JSON.stringify({ nodes: [{ id: 'n-pm', label: 'Project manager' }] }));
  run(`INSERT INTO runs (id, workspace_id, goal, workflow_version_id) VALUES ('run-g', 'ws', 'g', 'wv1'), ('run-std', 'ws', 'g', NULL)`);
  run(`INSERT INTO work_items (id, run_id, kind, status, idempotency_key, attempt, workflow_node_id) VALUES ('w-node','run-g','plan','running','k1',1,'n-pm'), ('w-free','run-g','diagnose','running','k2',1,NULL), ('w-std','run-std','plan','running','k3',1,NULL)`);
  assert.deepEqual(S.nodeFor({ id: 'w-node', runId: 'run-g', workflowNodeId: null }), { key: 'wf:wf-main:n-pm', label: 'Project manager' }, 'read from the row, not the stale object');
  assert.equal(S.nodeFor({ id: 'w-std', runId: 'run-std' }), null, 'standard pipeline');
  const pm = agent('ag-graph-pm');
  const s = await take(pm, S.nodeFor({ id: 'w-node', runId: 'run-g' })); done(s);
  assert.deepEqual(S.nodeFor({ id: 'w-free', runId: 'run-g' }, 'ag-graph-pm'), { key: 'wf:wf-main:n-pm', label: 'Project manager' });
});

test('a session open in a terminal is held: the agent waits until it closes, and a restart keeps the hold while it is open', async () => {
  const a = agent('ag-term');
  const s = await take(a, { key: 'wf:wf1:term', label: 'T' }); done(s);
  run('UPDATE cli_sessions SET busy_item = ? WHERE id = ?', `terminal:${s.session.id}:${process.pid}`, s.session.id);   // an open terminal (a live pid)
  S.clearBusySessions();
  assert.match(S.getSession(s.session.id).busyItem, /^terminal:/, 'still open after a restart');
  const notes = [];
  setTimeout(() => run('UPDATE cli_sessions SET busy_item = NULL WHERE id = ?', s.session.id), 600);    // the owner closes it
  const next = await take(a, { key: 'wf:wf1:term', label: 'T' }, { onWait: (x) => x && notes.push(x) });
  assert.equal(next.session.id, s.session.id);
  assert.match(notes[0], /open in a terminal/);
  done(next);
  run('UPDATE cli_sessions SET busy_item = ? WHERE id = ?', `terminal:${s.session.id}:999999`, s.session.id);           // a terminal that is gone
  S.clearBusySessions();
  assert.equal(S.getSession(s.session.id).busyItem, null);
  assert.match(S.resetSession((await take(a, { key: 'wf:wf1:term', label: 'T' })).session.id).error, /in use/);
});

test('session details: node, agent, backend, the work it did, its Claude transcript and the command that resumes it', async () => {
  run(`INSERT INTO providers (id, name, kind, adapter_id, tier, enabled, capabilities, config) VALUES ('p-cl','Claude Code','agent','cli',2,1,'{}','{}')`);
  run(`INSERT INTO accounts (id, provider_id, label, enabled, config) VALUES ('acct-view','p-cl','My Claude',1,'{"command":"claude -p --output-format stream-json"}')`);
  const s = S.createSession({ accountId: 'acct-view', preset: 'claude', agentId: 'ag-view', cwd: repo, externalId: '11111111-2222-4333-8444-555555555555', started: true, nodeKey: 'wf:wf1:dev', nodeLabel: 'Developer' });
  run(`INSERT INTO prompt_versions (id, work_item_id, rendered_text) VALUES ('pv-v', 'w-v', 'Implement the login form')`);
  run(`INSERT INTO work_items (id, run_id, kind, status, idempotency_key, attempt, prompt_version_id, cli_session_id, started_at, result) VALUES ('w-v','run-std','implement','delivered','kv',1,'pv-v',?, '2026-10-20T10:00:00Z', ?)`, s.id, JSON.stringify({ summary: 'Added the form' }));
  const file = V.claudeTranscriptPath(repo, s.externalId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    { type: 'user', timestamp: 't1', message: { role: 'user', content: 'Implement the login form' } },
    { type: 'assistant', timestamp: 't2', message: { role: 'assistant', content: [{ type: 'text', text: 'Reading the page first.' }, { type: 'tool_use', name: 'Read', input: { file_path: 'login.tsx' } }] } },
    { type: 'summary', summary: 'x' },
  ].map((l) => JSON.stringify(l)).join('\n'));
  assert.match(path.basename(path.dirname(file)), /^[A-Za-z0-9-]+$/, 'Claude Code names the folder after the path, non-alphanumerics as "-"');

  const d = V.sessionDetails(s.id);
  assert.equal(d.session.nodeLabel, 'Developer');
  assert.equal(d.session.backend, 'My Claude');
  assert.equal(d.resumeCommand, 'claude --resume "11111111-2222-4333-8444-555555555555"', 'the interactive CLI, continuing this exact conversation');
  assert.equal(d.canOpen, true);
  assert.deepEqual(d.work.map((w) => [w.kind, w.prompt, w.reply]), [['implement', 'Implement the login form', 'Added the form']]);
  assert.deepEqual(d.transcript.turns.map((t) => t.role), ['user', 'assistant']);
  assert.match(d.transcript.turns[1].text, /Reading the page first\.\n\[tool: Read/);

  // not openable while its agent uses it, or before the CLI has created it
  run(`UPDATE cli_sessions SET busy_item = 'w-v' WHERE id = ?`, s.id);
  assert.match(V.openInTerminal(s.id).error, /using it right now/);
  run(`UPDATE cli_sessions SET busy_item = NULL WHERE id = ?`, s.id);
  const unstarted = S.createSession({ accountId: 'acct-view', preset: 'claude', agentId: 'ag-view2', cwd: repo });
  assert.match(V.openInTerminal(unstarted.id).error, /not been started/);
  assert.equal(V.sessionDetails('nope'), null);
});
