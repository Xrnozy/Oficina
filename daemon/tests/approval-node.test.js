// The Human approval node end to end: the engine launches a real app, an agent reports, the engine verifies the screens
// itself, the owner approves or rejects with feedback, and every decision and the app's lifetime are what they should be.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-approval-'));
process.env.OFFICE_NO_BROWSER = '1';

const { q, q1, run } = await import('../src/db.ts');
const { createRun, wireEngineEvents, simulateWorkflow, deleteTask } = await import('../src/engine/engine.ts');
const { createWorkflow, setActiveWorkflow, validateWorkflow, workflowTemplates, estimateWorkflowCalls, ensureBuiltinWorkflow } = await import('../src/services/workflow.ts');
const L = await import('../src/services/app-launcher.ts');
const { decideApproval } = await import('../src/services/policy.ts');
const { ensureRepo } = await import('../src/services/git.ts');
const { now, ulid } = await import('../src/util.ts');

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const PORT = await freePort();
const URL_BASE = `http://127.0.0.1:${PORT}`;

const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-approval-repo-'));
ensureRepo(repoDir);
// the "project": a tiny web app with a healthy page, a login page and a broken one
fs.writeFileSync(path.join(repoDir, 'server.js'), `
const http = require('http');
http.createServer((req, res) => {
  if (req.url === '/boom') { console.error('Error: boom while rendering /boom'); res.statusCode = 500; return res.end('boom'); }
  if (req.url === '/' || req.url === '/login') { res.setHeader('content-type', 'text/html'); return res.end('<h1>' + req.url + '</h1>'); }
  res.statusCode = 404; res.end('nope');
}).listen(${PORT}, '127.0.0.1', () => console.log('listening on http://127.0.0.1:${PORT}'));
`);
fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'demo-app', scripts: { start: 'node server.js' } }));
fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
fs.writeFileSync(path.join(repoDir, '.gitignore'), 'node_modules/\n');

for (const name of ['pm', 'prompt-creator', 'developer', 'reviewer', 'analyst', 'qa', 'docs']) {
  run(`INSERT INTO roles (id, name, version, responsibilities, allowed_actions, default_instructions, default_skills) VALUES (?,?,1,'[]','[]','','[]')`, `role-${name}`, name);
}
run(`INSERT INTO policies (id, scope, rules) VALUES ('pol-h','{}','[]')`);
run(`INSERT INTO providers (id, name, kind, adapter_id, adapter_version, adapter_hash, tier, enabled, capabilities, config) VALUES ('prov-h','Scripted','agent','scripted','1.0.0','local',1,1,'{}','{}')`);
run(`INSERT INTO models (id, provider_id, name, context_tokens, max_output_tokens, price_in, price_out, strength_tier) VALUES ('m-h','prov-h','scripted-1',128000,8192,0,0,'standard')`);
run(`INSERT INTO accounts (id, provider_id, label, billing, enabled, config) VALUES ('acct-h','prov-h','local','payg',1,'{}')`);
run(`INSERT INTO workspaces (id, name, purpose, repo_ids, allowed_provider_ids, policy_id, memory_scope, settings) VALUES ('ws-h','H','', '["repo-h"]','[]','pol-h','isolated','{"workMode":"direct"}')`);
run(`INSERT INTO repos (id, workspace_id, path, remote_url, default_branch, integration_branch, build_cmd, test_cmd) VALUES ('repo-h','ws-h',?,NULL,'main','integration','','')`, repoDir);
run(`INSERT INTO checks (id, repo_id, name, kind, command, parser, pass_rule, timeout_sec, affected_paths, protected) VALUES ('chk-h','repo-h','build','build','node --check src/a.js','auto','exit0',60,'["src/**"]',0)`);
const mkAgent = (id, role, script = {}) => {
  run(`INSERT INTO agents (id, name, avatar, account_id, model_id, settings, instructions, caps, observability, status) VALUES (?,?,?,?,?,?,?,?,'actions','idle')`,
    id, `${id} agent`, 'x', 'acct-h', 'm-h', JSON.stringify({ script }), '', JSON.stringify({ perTaskUsd: 10, perDayUsd: 50, maxTokensPerCall: 128000 }));
  run(`INSERT INTO memberships (id, agent_id, workspace_id, role_id, active_since, max_concurrent_tasks, active) VALUES (?,?,?,?,?,1,1)`, ulid(), id, 'ws-h', `role-${role}`, now());
};
const PLAN = {
  dodItems: [{ id: 'F1', text: 'module parses', kind: 'feature', checks: ['build'] }],
  tasks: [{ key: 'T1', title: 'Add the login form', type: 'feature', priority: 1, difficulty: 2, dependsOn: [], dodItemIds: ['F1'], budgetUsd: 5,
    acceptanceCriteria: ['src/a.js parses'], affectedPaths: ['src/'], meta: { files: { 'src/a.js': 'export const a = 1;\n' } } }],
  notes: 'approval e2e',
};
mkAgent('ag-pm', 'pm', { plan: PLAN }); mkAgent('ag-pc', 'prompt-creator'); mkAgent('ag-dev', 'developer'); mkAgent('ag-rev', 'reviewer');
mkAgent('ag-an', 'analyst'); mkAgent('ag-docs', 'docs');
mkAgent('ag-qa', 'qa', { approval: { routes: [{ label: 'Login page', path: '/login', why: 'the request was about the login form' }, { label: 'Broken page', path: '/boom', why: 'checks the error handling' }, { label: 'Elsewhere', path: 'https://evil.example/', why: 'must be dropped' }] } });
wireEngineEvents();
ensureBuiltinWorkflow('ws-h');

const n = (id, role, purpose, extra = {}) => ({ id, type: 'agent', label: id, role, config: { purpose, ...extra }, position: { x: 0, y: 0 } });
const e = (id, from, to, kind = 'next', extra = {}) => ({ id, from, to, kind, ...extra });
const bookends = { start: { id: 'start', type: 'start', label: 'S', position: { x: 0, y: 0 } }, end: { id: 'end', type: 'end', label: 'E', position: { x: 0, y: 0 } } };
const approvalNode = (extra = {}) => ({ id: 'ha', type: 'approval', label: 'Human approval', role: 'qa', config: { approval: { command: 'node server.js', url: URL_BASE, readyTimeoutSec: 30, ...extra } }, position: { x: 0, y: 0 } });
const GRAPH = {
  nodes: [bookends.start, n('plan', 'pm', 'plan', { scope: 'run' }), n('dev', 'developer', 'implement'), approvalNode(), bookends.end],
  edges: [e('e1', 'start', 'plan'), e('e2', 'plan', 'dev'), e('e3', 'dev', 'ha'), e('e4', 'ha', 'end', 'on-success'), e('e5', 'ha', 'dev', 'on-reject', { maxLoops: 3, label: 'rejected' })],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) { const v = pred(); if (v) return v; if (Date.now() > deadline) return null; await sleep(200); }
}
const pending = (runId) => q1(`SELECT id, payload FROM approvals WHERE run_id = ? AND action = 'human.approval' AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, runId);
const up = async () => (await L.probe(`${URL_BASE}/`, 1000)).status != null;
const taskOf = (runId) => q1(`SELECT id, status, meta FROM tasks WHERE run_id = ?`, runId);
const wf = createWorkflow('ws-h', 'with approval', '', GRAPH);
setActiveWorkflow('ws-h', wf.workflowId);

test('the node needs a connected agent and an approve path; a reject path is strongly suggested', () => {
  const bad = { nodes: [bookends.start, { id: 'ha', type: 'approval', label: 'A', position: { x: 0, y: 0 } }, bookends.end], edges: [e('e1', 'start', 'ha'), e('e2', 'ha', 'end', 'on-reject')] };
  const msgs = validateWorkflow(bad, 'ws-h');
  assert.ok(msgs.some((i) => i.level === 'error' && /agent connected/.test(i.message)), 'no agent -> error');
  assert.ok(msgs.some((i) => i.level === 'error' && /approve path/.test(i.message)), 'no approve edge -> error');
  const noReject = { nodes: [bookends.start, approvalNode(), bookends.end], edges: [e('e1', 'start', 'ha'), e('e2', 'ha', 'end', 'on-success')] };
  const w = validateWorkflow(noReject, 'ws-h');
  assert.ok(w.every((i) => i.level !== 'error'), JSON.stringify(w));
  assert.ok(w.some((i) => i.level === 'warning' && /nowhere to go/.test(i.message)));
  const badCfg = { nodes: [bookends.start, approvalNode({ url: 'ftp://x', readyTimeoutSec: 1 }), bookends.end], edges: noReject.edges };
  const ev = validateWorkflow(badCfg, 'ws-h').filter((i) => i.level === 'error').map((i) => i.message);
  assert.ok(ev.some((m) => /http/.test(m)) && ev.some((m) => /timeout/.test(m)));
  assert.deepEqual(validateWorkflow(GRAPH, 'ws-h').filter((i) => i.level === 'error'), []);
});

test('the shipped template validates, counts the approval as an agent call and a human gate, and the dry run honours reject', () => {
  const tpl = workflowTemplates().find((t) => t.id === 'human-approval');
  assert.ok(tpl);
  assert.deepEqual(validateWorkflow(tpl.graph, 'ws-h').filter((i) => i.level === 'error'), []);
  const est = estimateWorkflowCalls(tpl.graph);
  assert.equal(est.humanGates, 1);
  const base = estimateWorkflowCalls(workflowTemplates().find((t) => t.id === 'default').graph);
  assert.ok(est.maxCalls > base.maxCalls, 'the approval node and its reject loop add calls');
  const ok = simulateWorkflow(tpl.graph);
  assert.equal(ok.result, 'end');
  assert.ok(ok.steps.some((s) => s.type === 'approval'));
  const rej = simulateWorkflow(tpl.graph, { outcomes: { 'human-approval': ['reject', 'success'] } });
  assert.equal(rej.result, 'end');
  assert.ok(rej.steps.filter((s) => s.type === 'approval').length >= 2, 'a rejection loops back through the approval node');
  assert.ok(rej.takenEdges.includes('e-approval-reject'));
});

test('launcher: detects how to start a project, refuses unsafe addresses, and reports a failure honestly', async () => {
  assert.equal(L.detectLaunch(repoDir).command, 'npm start');
  assert.equal(L.detectLaunch(os.tmpdir()).command, null);
  assert.equal(L.safeUrl('javascript:alert(1)'), null);
  assert.equal(L.safeUrl('file:///etc/passwd'), null);
  assert.equal(L.safeUrl('http://user:pw@localhost:3000'), null);
  assert.ok(L.safeUrl('http://localhost:3000/x'));
  for (const bad of ['//evil.example', 'https://evil.example/', '/a/../b', '/a b', 'nothing']) assert.equal(L.safeRoutePath(bad), null, bad);
  assert.equal(L.safeRoutePath('/login?next=/home'), '/login?next=/home');
  const none = await L.startApp('t-nocmd', {}, os.tmpdir());
  assert.equal(none.state, 'failed');
  assert.match(none.note, /Nothing to start/);
  const outside = await L.startApp('t-out', { command: 'node -v', cwd: '..' }, repoDir);
  assert.equal(outside.state, 'failed');
  const crash = await L.startApp('t-crash', { command: 'node -e "console.error(\'Error: it broke\'); process.exit(3)"', readyTimeoutSec: 10 }, repoDir);
  assert.equal(crash.state, 'exited');
  assert.equal(crash.exitCode, 3);
  assert.match(crash.note, /exited right away/);
  const d = await L.diagnose('t-crash');
  assert.ok(d.errorLines.some((l) => /it broke/.test(l)));
  assert.match(L.appLog('t-crash').join('\n'), /it broke/);
});

test('an address that already answers is refused: a stale copy must never be reviewed as the new app', async () => {
  const stale = http.createServer((req, res) => res.end('stale')).listen(0, '127.0.0.1');
  await new Promise((r) => stale.once('listening', r));
  try {
    const url = `http://127.0.0.1:${stale.address().port}`;
    const info = await L.startApp('t-stale', { command: 'node -e "setInterval(()=>{},1000)"', url, readyTimeoutSec: 5 }, repoDir);
    assert.equal(info.state, 'failed');
    assert.match(info.note, /already answering/);
    assert.equal(info.pid, null, 'nothing was started');
  } finally { stale.close(); }
});

test('approve: the app is started, the agent reports, the engine probes each screen, the owner approves, the app is stopped', { timeout: 120000 }, async () => {
  assert.equal(await up(), false, 'nothing is running yet');
  const r = createRun({ workspaceId: 'ws-h', goal: 'Add a login form', oneShot: true });
  const a = await waitFor(() => pending(r.id));
  assert.ok(a, 'a Needs-you item was raised for the human approval');
  const p = JSON.parse(a.payload);
  assert.equal(p.nodeLabel, 'Human approval');
  assert.equal(p.app.state, 'ready');
  assert.equal(p.app.url, URL_BASE);
  assert.equal(p.app.listening, true);
  assert.equal(await up(), true, 'the app really is running for the owner to test');
  // the agent proposed /login, /boom and an off-site URL: the offsite one is dropped, /boom is probed and flagged by the engine
  assert.deepEqual(p.routes.map((x) => x.path), ['/login', '/boom']);
  assert.equal(p.routes[0].url, `${URL_BASE}/login`);
  assert.equal(p.routes[0].probe.status, 200);
  assert.equal(p.routes[1].probe.status, 500);
  assert.ok(p.report.issues.some((i) => i.source === 'engine' && /\/boom/.test(i.message) && /500/.test(i.message)), 'the engine, not the agent, found the failing page');
  assert.equal(p.report.appStatus, 'degraded', 'the agent said ready; the failing route makes it degraded');
  assert.ok(p.errorLines.some((l) => /boom while rendering/.test(l)), 'the app log was captured');
  assert.equal(taskOf(r.id).status, 'waiting-input');
  assert.ok(fs.existsSync(p.app.logFile));

  // the generic decision route must not let a rejection through without feedback — tested at the service level below; approve here
  decideApproval(a.id, true, 'Looks right');
  const done = await waitFor(() => ['done', 'stopped', 'failed'].includes(q1('SELECT status FROM runs WHERE id = ?', r.id)?.status));
  assert.ok(done);
  assert.equal(q1('SELECT status FROM runs WHERE id = ?', r.id).status, 'done');
  const t = taskOf(r.id);
  const meta = JSON.parse(t.meta);
  assert.equal(meta.humanDecisions.length, 1);
  assert.deepEqual({ d: meta.humanDecisions[0].decision, f: meta.humanDecisions[0].feedback }, { d: 'approved', f: 'Looks right' });
  const ev = q1(`SELECT payload FROM events WHERE type = 'human.decided' AND run_id = ?`, r.id);
  assert.equal(JSON.parse(ev.payload).decision, 'approved');
  await sleep(500);
  assert.equal(await up(), false, 'the app is stopped once the owner has decided');
});

test('reject: the feedback and the app log reach the developer, the task returns for another review, then approve', { timeout: 180000 }, async () => {
  const r = createRun({ workspaceId: 'ws-h', goal: 'Add a login form v2', oneShot: true });
  const first = await waitFor(() => pending(r.id));
  assert.ok(first);
  assert.equal(await up(), true);
  const devBefore = q1(`SELECT COUNT(*) c FROM work_items WHERE run_id = ? AND kind = 'implement'`, r.id).c;
  decideApproval(first.id, false, 'The login button does nothing when I click it');
  // a rejection returns the task to the developer through the reject edge — with the feedback, then to a fresh review
  const second = await waitFor(() => { const p = pending(r.id); return p && p.id !== first.id ? p : null; }, 120000);
  assert.ok(second, 'the task came back for another review');
  const impls = q(`SELECT id FROM work_items WHERE run_id = ? AND kind = 'implement' ORDER BY rowid`, r.id);
  assert.ok(impls.length > devBefore, 'the developer was dispatched again');
  const redo = q1(`SELECT p.rendered_text t FROM prompt_versions p WHERE p.work_item_id = ?`, impls[impls.length - 1].id).t;
  const prompts = q(`SELECT payload FROM events WHERE type = 'agent.activity' AND entity_id = ?`, impls[impls.length - 1].id).map((x) => JSON.parse(x.payload)).filter((x) => x.kind === 'prompt').map((x) => x.detail).join('\n');
  assert.match(redo + prompts, /login button does nothing/, 'the owner\'s own words are in the developer\'s prompt');
  assert.match(redo + prompts, /REJECTED by the owner/);
  assert.match(redo + prompts, /boom while rendering/, "and so is what the app's log showed");
  const meta1 = JSON.parse(taskOf(r.id).meta);
  assert.equal(meta1.humanDecisions[0].decision, 'rejected');
  assert.equal(meta1.humanDecisions[0].feedback, 'The login button does nothing when I click it');
  const p2 = JSON.parse(second.payload);
  assert.match(p2.report.summary, /Re-review after: 1. The login button does nothing/, 'the second report knows what was rejected before');
  assert.equal(await up(), true, 'the app was started again for the second review');
  decideApproval(second.id, true, '');
  assert.ok(await waitFor(() => q1('SELECT status FROM runs WHERE id = ?', r.id)?.status === 'done'), 'approving the second review finishes the run');
  const meta2 = JSON.parse(taskOf(r.id).meta);
  assert.deepEqual(meta2.humanDecisions.map((d) => [d.round, d.decision]), [[1, 'rejected'], [2, 'approved']]);
  await sleep(500);
  assert.equal(await up(), false);
});

test('deleting a task while it waits for approval cancels the review and stops its app', { timeout: 120000 }, async () => {
  const r = createRun({ workspaceId: 'ws-h', goal: 'Add a login form v3', oneShot: true });
  const a = await waitFor(() => pending(r.id));
  assert.ok(a);
  assert.equal(await up(), true);
  const t = taskOf(r.id);
  const res = deleteTask(t.id);
  assert.equal(res.ok, true);
  assert.equal(q1(`SELECT COUNT(*) c FROM approvals WHERE id = ? AND status = 'pending'`, a.id).c, 0, 'the pending review is withdrawn');
  await sleep(700);
  assert.equal(await up(), false, 'the app is stopped');
});

test('an unreachable app is reported as failed — never as fine — and the owner is told why', { timeout: 120000 }, async () => {
  const bad = createWorkflow('ws-h', 'broken app', '', { ...GRAPH, nodes: GRAPH.nodes.map((x) => (x.id === 'ha' ? approvalNode({ command: 'node -e "console.error(\'Error: cannot bind\'); process.exit(1)"', readyTimeoutSec: 8 }) : x)) });
  setActiveWorkflow('ws-h', bad.workflowId);
  try {
    const r = createRun({ workspaceId: 'ws-h', goal: 'Break the app', oneShot: true });
    const a = await waitFor(() => pending(r.id));
    assert.ok(a, 'the owner is still asked — they may want to look themselves');
    const p = JSON.parse(a.payload);
    assert.equal(p.report.appStatus, 'failed');
    assert.ok(p.report.issues.some((i) => i.source === 'engine' && /not running/.test(i.message)));
    assert.match(p.app.note, /exited right away/);
    assert.ok(p.errorLines.some((l) => /cannot bind/.test(l)));
    decideApproval(a.id, true, 'approving anyway');
    await waitFor(() => q1('SELECT status FROM runs WHERE id = ?', r.id)?.status === 'done');
  } finally { setActiveWorkflow('ws-h', wf.workflowId); }
});

test('the decide route needs feedback to reject a human approval, and records a decision once', { timeout: 120000 }, async () => {
  const { createServer } = await import('../src/api/server.ts');
  const port = await freePort();
  const server = createServer(port, os.tmpdir());
  if (!server.listening) await new Promise((res) => server.once('listening', res));
  try {
    const r = createRun({ workspaceId: 'ws-h', goal: 'Route test', oneShot: true });
    const a = await waitFor(() => pending(r.id));
    assert.ok(a);
    const post = async (body) => { const x = await fetch(`http://127.0.0.1:${port}/api/approvals/${a.id}/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: x.status, body: await x.json() }; };
    const empty = await post({ approve: false, reason: '   ' });
    assert.equal(empty.status, 400);
    assert.match(empty.body.error, /what needs to be fixed/);
    const okRes = await post({ approve: true, reason: 'fine' });
    assert.equal(okRes.status, 200);
    const again = await post({ approve: false, reason: 'changed my mind' });
    assert.equal(again.status, 409, 'a decision is recorded once');
    await waitFor(() => q1('SELECT status FROM runs WHERE id = ?', r.id)?.status === 'done');
    assert.equal(JSON.parse(taskOf(r.id).meta).humanDecisions.length, 1);
  } finally { server.close(); }
});
