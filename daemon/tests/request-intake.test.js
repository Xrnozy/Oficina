// Request intake: the chosen agent turns a request into a structured summary; the owner's decisions (accepted, removed)
// survive every later pass; the agent has a CLI session of its own; approving starts a normal run with the reviewed goal.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-intake-'));

const { q, q1, run } = await import('../src/db.ts');
const I = await import('../src/services/intake.ts');
const S = await import('../src/services/cli-sessions.ts');
const { validateWorkflow } = await import('../src/services/workflow.ts');
const { createServer } = await import('../src/api/server.ts');
const { wireEngineEvents } = await import('../src/engine/engine.ts');
const { ensureRepo } = await import('../src/services/git.ts');
const { CLI_PRESETS } = await import('../src/adapters/cli-resolve.ts');
const { now, ulid } = await import('../src/util.ts');

const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-intake-repo-'));
ensureRepo(repoDir);
for (const name of ['pm', 'prompt-creator', 'developer', 'reviewer', 'analyst', 'qa', 'docs']) {
  run(`INSERT INTO roles (id, name, version, responsibilities, allowed_actions, default_instructions, default_skills) VALUES (?,?,1,'[]','[]','','[]')`, `role-${name}`, name);
}
run(`INSERT INTO policies (id, scope, rules) VALUES ('pol-i','{}','[]')`);
run(`INSERT INTO providers (id, name, kind, adapter_id, adapter_version, adapter_hash, tier, enabled, capabilities, config) VALUES ('prov-i','Scripted','agent','scripted','1.0.0','local',1,1,'{}','{}')`);
run(`INSERT INTO models (id, provider_id, name, context_tokens, max_output_tokens, price_in, price_out, strength_tier) VALUES ('m-i','prov-i','scripted-1',128000,8192,0,0,'standard')`);
run(`INSERT INTO accounts (id, provider_id, label, billing, enabled, config) VALUES ('acct-i','prov-i','local','payg',1,'{}')`);
run(`INSERT INTO workspaces (id, name, purpose, repo_ids, allowed_provider_ids, policy_id, memory_scope, settings) VALUES ('ws-i','I','', '["repo-i"]','[]','pol-i','isolated','{"workMode":"direct"}')`);
run(`INSERT INTO repos (id, workspace_id, path, remote_url, default_branch, integration_branch, build_cmd, test_cmd) VALUES ('repo-i','ws-i',?,NULL,'main','integration','','')`, repoDir);
const mkAgent = (id, role, script = {}) => {
  run(`INSERT INTO agents (id, name, avatar, account_id, model_id, settings, instructions, caps, observability, status) VALUES (?,?,?,?,?,?,?,?,'actions','idle')`,
    id, `${id} agent`, 'x', 'acct-i', 'm-i', JSON.stringify({ script: { latencyMs: 5, ...script } }), '', JSON.stringify({ perTaskUsd: 10, perDayUsd: 50, maxTokensPerCall: 128000 }));
  run(`INSERT INTO memberships (id, agent_id, workspace_id, role_id, active_since, max_concurrent_tasks, active) VALUES (?,?,?,?,?,1,1)`, ulid(), id, 'ws-i', `role-${role}`, now());
};
mkAgent('ag-pm', 'pm', { plan: { dodItems: [{ id: 'F1', text: 'x', kind: 'feature', checks: [] }], tasks: [] } });
mkAgent('ag-intake', 'analyst');
// a badly behaved analyst: keeps rewriting what the owner already decided and proposing what they removed
mkAgent('ag-rude', 'analyst', { intake: { rounds: [
  { summary: 'first', items: [{ kind: 'feature', text: 'Login form' }, { kind: 'feature', text: 'Dark mode' }, { kind: 'technology', text: 'React' }], concerns: [{ type: 'unclear', text: 'OAuth or password?' }], ready: false },
  { summary: 'second', items: [], concerns: [], ready: true },
] } });
wireEngineEvents();

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const port = await freePort();
const server = createServer(port, os.tmpdir());
if (!server.listening) await new Promise((r) => server.once('listening', r));
test.after(() => server.close());
const api = async (method, url, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j.data ?? j, raw: j };
};
const settle = async (id, want = ['review', 'failed']) => {
  for (let i = 0; i < 200; i++) { const d = I.getDraft(id); if (want.includes(d.status)) return d; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('analysis never finished');
};

// ---------- the merge rules ----------

const item = (id, kind, text, state = 'proposed') => ({ id, kind, text, state, source: 'agent', round: 1 });

test('merge: accepted items are never changed, removed ones never return, open ones follow the agent', () => {
  const prev = [item('a', 'feature', 'Login form', 'accepted'), item('b', 'feature', 'Dark mode', 'removed'), item('c', 'technology', 'React'), item('d', 'issue', 'Crash on save')];
  const { items, ignored } = I.mergeItems(prev, [
    { id: 'a', kind: 'issue', text: 'Something else entirely' },        // tries to rewrite an accepted item
    { id: 'b', text: 'Dark mode (again)' },                              // tries to revive a removed one by id
    { kind: 'feature', text: '  dark   MODE ' },                         // …and by wording
    { id: 'c', text: 'React 18 with hooks' },                            // legitimately sharpens an open one
    { kind: 'feature', text: 'Remember me checkbox' },                   // new
    { kind: 'feature', text: 'login form' },                             // repeats an accepted one
    { kind: 'nonsense', text: 'Defaults to a feature' },
    { id: 'zzz', kind: 'issue', text: 'Unknown id counts as new' },
    { text: '   ' },                                                     // empty
  ], 2);
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.deepEqual([by.a.kind, by.a.text, by.a.state], ['feature', 'Login form', 'accepted']);
  assert.deepEqual([by.b.text, by.b.state], ['Dark mode', 'removed']);
  assert.equal(by.c.text, 'React 18 with hooks');
  assert.equal(by.c.state, 'proposed');
  assert.equal(by.d, undefined, 'an open item the agent leaves out is dropped');
  const added = items.filter((i) => !['a', 'b', 'c'].includes(i.id));
  assert.deepEqual(added.map((i) => [i.kind, i.text]), [['feature', 'Remember me checkbox'], ['feature', 'Defaults to a feature'], ['issue', 'Unknown id counts as new']]);
  assert.ok(added.every((i) => i.state === 'proposed' && i.source === 'agent' && i.round === 2));
  assert.ok(ignored >= 4);
  assert.deepEqual(items.slice(0, 3).map((i) => i.id), ['a', 'b', 'c'], 'existing items keep their place');
});

test('merge: cap on length, count and garbage input', () => {
  const long = 'x'.repeat(2000);
  const { items } = I.mergeItems([], [{ kind: 'feature', text: long, detail: long }, null, 'str', 5], 1);
  assert.equal(items.length, 1);
  assert.equal(items[0].text.length, I.LIMITS.item);
  assert.equal(items[0].detail.length, I.LIMITS.detail);
  const many = I.mergeItems([], Array.from({ length: 200 }, (_, i) => ({ kind: 'feature', text: `item ${i}` })), 1).items;
  assert.equal(many.length, I.LIMITS.items);
  assert.deepEqual(I.mergeItems([], 'not an array', 1).items, []);
});

test('the prompt states the decisions, lists the files, and asks for JSON only', () => {
  const d = { id: 'd1', request: 'Add login', notes: [{ round: 1, text: 'use OAuth', at: '' }], round: 2, attachmentIds: [],
    items: [item('a', 'feature', 'Login form', 'accepted'), item('b', 'feature', 'Dark mode', 'removed'), item('c', 'technology', 'React')] };
  const p = I.buildPrompt(d, 'also SSO');
  assert.match(p, /<LOCKED_ITEMS>\na \| feature \| Login form\n<\/LOCKED_ITEMS>/);
  assert.match(p, /<RULED_OUT>\nfeature \| Dark mode\n<\/RULED_OUT>/);
  assert.match(p, /<OPEN_ITEMS>\nc \| technology \| React\n<\/OPEN_ITEMS>/);
  assert.match(p, /<LATEST_OWNER_NOTE>\nalso SSO\n<\/LATEST_OWNER_NOTE>/);
  assert.match(p, /Do not create, edit or delete any file/);
  assert.match(p, /ONLY one JSON object/);
});

// ---------- the full flow through the API ----------

test('agents list, validation, and a draft is analysed by the chosen agent', async () => {
  const agents = await api('GET', '/intake/agents?workspaceId=ws-i');
  assert.deepEqual(agents.body.map((a) => a.id).sort(), ['ag-intake', 'ag-pm', 'ag-rude']);
  assert.ok(agents.body.every((a) => a.available));
  assert.equal((await api('POST', '/intake/drafts', { workspaceId: 'ws-i', agentId: 'ag-intake', request: '   ' })).status, 400);
  assert.equal((await api('POST', '/intake/drafts', { workspaceId: 'ws-i', agentId: 'nobody', request: 'x' })).status, 400);
  assert.equal((await api('POST', '/intake/drafts', { workspaceId: 'ws-i', request: 'x' })).status, 400);
  assert.equal((await api('POST', '/intake/drafts', { workspaceId: 'nope', agentId: 'ag-intake', request: 'x' })).status, 404);
  assert.equal((await api('POST', '/intake/drafts', { workspaceId: 'ws-i', agentId: 'ag-intake', request: 'x'.repeat(20_001) })).status, 400);

  const made = await api('POST', '/intake/drafts', { workspaceId: 'ws-i', repoId: 'repo-i', agentId: 'ag-intake', request: 'Add a login form to the app. It must use OAuth.' });
  assert.equal(made.status, 200);
  assert.equal(made.body.status, 'analyzing');
  const d = await settle(made.body.id);
  assert.equal(d.status, 'review', d.error);
  assert.equal(d.round, 1);
  assert.ok(d.summary && d.items.length >= 2 && d.items.every((i) => i.state === 'proposed'));
  assert.equal(d.concerns.length, 1);
  assert.equal((await api('GET', `/intake/drafts?workspaceId=ws-i`)).body.some((x) => x.id === d.id), true);
});

test('iterations keep what the owner accepted, drop what they removed, and only change what they asked for', async () => {
  const made = (await api('POST', '/intake/drafts', { workspaceId: 'ws-i', agentId: 'ag-rude', request: 'Build a login page' })).body;
  let d = await settle(made.id);
  const [login, dark, react] = d.items;
  assert.deepEqual([login.text, dark.text, react.text], ['Login form', 'Dark mode', 'React']);
  // while it is analysing nothing can be changed
  // owner: accept the login form, remove dark mode, leave React open, add an item of their own, edit nothing else
  let r = await api('POST', `/intake/drafts/${d.id}/refine`, { edits: [{ id: login.id, state: 'accepted' }, { id: dark.id, state: 'removed' }], add: [{ kind: 'constraint', text: 'No new dependencies' }], note: 'Use the existing design', reanalyze: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'analyzing');
  assert.equal(r.body.round, 2);
  assert.equal((await api('POST', `/intake/drafts/${d.id}/refine`, { note: 'too early' })).status, 409);
  d = await settle(d.id);
  assert.equal(d.status, 'review', d.error);
  const by = (t) => d.items.find((i) => i.text === t);
  assert.equal(by('Login form').state, 'accepted', 'accepted stays accepted');
  assert.equal(by('Dark mode').state, 'removed', 'removed stays removed');
  assert.equal(by('No new dependencies').state, 'accepted');
  assert.equal(by('No new dependencies').source, 'owner');
  assert.equal(by('React'), undefined, 'the agent returned nothing for the open item, so it is gone');
  assert.deepEqual(d.notes.map((n) => [n.round, n.text]), [[2, 'Use the existing design']]);
  assert.equal(d.ready, true);

  // editing an item's text makes it the owner's and locks it
  const edited = await api('POST', `/intake/drafts/${d.id}/refine`, { edits: [{ id: by('Login form').id, text: 'Login page with email and password' }] });
  assert.equal(edited.body.items.find((i) => i.id === login.id).text, 'Login page with email and password');
  assert.equal(edited.body.items.find((i) => i.id === login.id).source, 'owner');
  // a removed item can be brought back by the owner (not by the agent)
  const back = await api('POST', `/intake/drafts/${d.id}/refine`, { edits: [{ id: dark.id, state: 'proposed' }] });
  assert.equal(back.body.items.find((i) => i.id === dark.id).state, 'proposed');
  // bad edits
  assert.equal((await api('POST', `/intake/drafts/${d.id}/refine`, { edits: [{ id: 'nope', state: 'accepted' }] })).status, 400);
  assert.equal((await api('POST', `/intake/drafts/${d.id}/refine`, { edits: [{ id: login.id, state: 'maybe' }] })).status, 400);
  assert.equal((await api('POST', `/intake/drafts/${d.id}/refine`, { edits: [{ id: login.id, text: '  ' }] })).status, 400);
  assert.equal((await api('POST', `/intake/drafts/${d.id}/refine`, { add: [{ text: '' }] })).status, 400);
  assert.equal((await api('POST', `/intake/drafts/${d.id}/refine`, { note: 'n'.repeat(5000) })).status, 400);
  assert.equal((await api('POST', '/intake/drafts/nope/refine', {})).status, 404);
});

test('the default scripted pass builds on the open items and the latest note without redoing the rest', async () => {
  const made = (await api('POST', '/intake/drafts', { workspaceId: 'ws-i', agentId: 'ag-intake', request: 'Add export to CSV. Needs a button.' })).body;
  let d = await settle(made.id);
  const ids = d.items.map((i) => i.id);
  const keep = d.items[0];
  await api('POST', `/intake/drafts/${d.id}/refine`, { edits: [{ id: keep.id, state: 'accepted' }], note: 'also JSON export', reanalyze: true });
  d = await settle(d.id);
  assert.equal(d.items.find((i) => i.id === keep.id).state, 'accepted');
  assert.ok(ids.filter((i) => i !== keep.id).every((i) => d.items.some((x) => x.id === i)), 'the other open items were kept, same ids');
  assert.ok(d.items.some((i) => /JSON export/.test(i.text)), 'the new detail became a new item');
  assert.equal(d.items.length, ids.length + 1);
});

test('approving starts a run whose goal is the reviewed breakdown; discarded and approved drafts are closed', async () => {
  const made = (await api('POST', '/intake/drafts', { workspaceId: 'ws-i', repoId: 'repo-i', agentId: 'ag-rude', request: 'Build a login page' })).body;
  let d = await settle(made.id);
  const [login, dark] = d.items;
  await api('POST', `/intake/drafts/${d.id}/refine`, { edits: [{ id: login.id, state: 'accepted' }, { id: dark.id, state: 'removed' }], note: 'Keep it simple' });
  const goal = I.composeGoal(I.getDraft(d.id));
  assert.match(goal, /^Build a login page/);
  assert.match(goal, /### Features\n- Login form/);
  assert.match(goal, /### Technologies\n- React/);
  assert.match(goal, /### Ruled out by the owner — do not do these\n- Dark mode/);
  assert.match(goal, /### More details from the owner\n- Keep it simple/);
  assert.doesNotMatch(goal.split('Ruled out')[0], /Dark mode/);

  const ap = await api('POST', `/intake/drafts/${d.id}/approve`, { budgetUsd: 3 });
  assert.equal(ap.status, 200, JSON.stringify(ap.raw));
  const runRow = q1('SELECT goal, status FROM runs WHERE id = ?', ap.body.id);
  assert.equal(runRow.goal, goal);
  const after = I.getDraft(d.id);
  assert.equal(after.status, 'approved');
  assert.equal(after.runId, ap.body.id);
  assert.equal((await api('POST', `/intake/drafts/${d.id}/approve`, {})).status, 409);
  assert.equal((await api('POST', `/intake/drafts/${d.id}/refine`, { note: 'late' })).status, 409);
  assert.equal((await api('DELETE', `/intake/drafts/${d.id}`)).status, 409);
  assert.equal((await api('POST', '/intake/drafts/nope/approve', {})).status, 404);

  const m2 = (await api('POST', '/intake/drafts', { workspaceId: 'ws-i', agentId: 'ag-intake', request: 'Something' })).body;
  await settle(m2.id);
  assert.equal((await api('DELETE', `/intake/drafts/${m2.id}`)).status, 200);
  assert.equal((await api('POST', `/intake/drafts/${m2.id}/approve`, {})).status, 409);
  assert.equal((await api('GET', '/intake/drafts?workspaceId=ws-i')).body.some((x) => x.id === m2.id), false);
});

test('a failing agent leaves a failed draft the owner can retry or approve as typed', async () => {
  mkAgent('ag-broken', 'analyst', { intake: { rounds: [{ not: 'valid' }] } });
  const made = (await api('POST', '/intake/drafts', { workspaceId: 'ws-i', agentId: 'ag-broken', request: 'Do the thing' })).body;
  const d = await settle(made.id);
  assert.equal(d.status, 'failed');
  assert.match(d.error, /usable summary/);
  const retry = await api('POST', `/intake/drafts/${d.id}/refine`, { reanalyze: true });
  assert.equal(retry.status, 200);
  assert.equal((await settle(d.id)).status, 'failed');
  assert.equal(I.composeGoal(I.getDraft(d.id)), 'Do the thing', 'with nothing reviewed the goal is just what was typed');
  const ap = await api('POST', `/intake/drafts/${d.id}/approve`, { budgetUsd: 1 });
  assert.equal(ap.status, 200);
});

test('a daemon restart does not leave a draft analysing forever', () => {
  const id = ulid();
  run(`INSERT INTO request_drafts (id, workspace_id, agent_id, request, status, round, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?)`, id, 'ws-i', 'ag-intake', 'x', 'analyzing', now(), now());
  I.recoverDrafts();
  assert.equal(I.getDraft(id).status, 'failed');
});

// ---------- the agent's own CLI session ----------

test('intake gets a CLI session of its own per draft, continued on every pass and never lent to the agent\'s other work', async () => {
  const agent = { id: 'ag-intake', name: 'ag-intake', settings: {} };
  const o = (extra = {}) => ({ agent, account: { id: 'acct-i' }, preset: 'claude', cwd: repoDir, support: CLI_PRESETS.claude.sessions, stable: true, ...extra });
  const A = await S.acquireSession(o({ itemId: 'w1', dedicated: { key: 'intake-dA', label: 'Request intake · A' } }));
  assert.ok(A.session.ownerKey === 'intake-dA' && A.session.label === 'Request intake · A');
  assert.equal(A.resumed, false);
  S.releaseSession(A.session.id, { itemId: 'w1', ok: true, externalId: 'ext-A', started: true });
  const A2 = await S.acquireSession(o({ itemId: 'w2', dedicated: { key: 'intake-dA', label: 'x' } }));
  assert.equal(A2.session.id, A.session.id, 'the next pass continues the same session');
  assert.equal(A2.resumed, true);
  S.releaseSession(A2.session.id, { itemId: 'w2', ok: true });
  // another draft, and the agent's ordinary work, never share it
  const B = await S.acquireSession(o({ itemId: 'w3', dedicated: { key: 'intake-dB', label: 'Request intake · B' } }));
  assert.notEqual(B.session.id, A.session.id);
  S.releaseSession(B.session.id, { itemId: 'w3', ok: true });
  const plain = await S.acquireSession(o({ itemId: 'w4' }));
  assert.ok(plain.session && plain.session.id !== A.session.id && plain.session.id !== B.session.id && plain.session.ownerKey === null);
  // even an agent set to "a new session every time" keeps the draft's own session
  const eager = { ...agent, id: 'ag-rude', settings: { cliSession: { mode: 'new' } } };
  const E1 = await S.acquireSession(o({ agent: eager, itemId: 'w5', dedicated: { key: 'intake-dC', label: 'C' } }));
  S.releaseSession(E1.session.id, { itemId: 'w5', ok: true, externalId: 'e', started: true });
  const E2 = await S.acquireSession(o({ agent: eager, itemId: 'w6', dedicated: { key: 'intake-dC', label: 'C' } }));
  assert.equal(E2.session.id, E1.session.id);
  // and approving or discarding retires it
  run(`INSERT INTO request_drafts (id, workspace_id, agent_id, request, status, round, created_at, updated_at) VALUES ('dA','ws-i','ag-intake','x','review',1,?,?)`, now(), now());
  S.releaseSession(E2.session.id, { itemId: 'w6', ok: true });
  assert.deepEqual(I.discardDraft('dA'), { ok: true });
  assert.equal(S.getSession(A.session.id).status, 'archived');
  assert.equal(S.getSession(B.session.id).status, 'active', 'other drafts are untouched');
});

// ---------- the Request node ----------

test('the Request node may name its agent; a role there is ignored with a warning', () => {
  const g = (start) => ({ nodes: [start, { id: 'end', type: 'end', label: 'E', position: { x: 0, y: 0 } }], edges: [{ id: 'e', from: 'start', to: 'end', kind: 'next' }] });
  const base = { id: 'start', type: 'start', label: 'Request', position: { x: 0, y: 0 } };
  assert.deepEqual(validateWorkflow(g({ ...base, agentId: 'ag-intake' })).filter((i) => /ignores/.test(i.message)), []);
  assert.ok(validateWorkflow(g({ ...base, role: 'pm' })).some((i) => i.level === 'warning' && /Request node/.test(i.message)));
});
