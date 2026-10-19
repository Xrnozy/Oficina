// Phase 5 demo: an end-to-end scripted run on a CUSTOM workflow graph —
// inserted analyst node, a task.type condition branch (docs vs code paths),
// a dev→accept message edge, and two bounded loops. Scripted agents only:
// no model calls, no cost. Mirrors bench.mjs setup.
//   node scripts/demo-workflow.mjs [src-dir] [label] [port]
// Writes <tmp>/officechain-bench/demo-workflow-<label>.json.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [srcDir = path.join(HERE, '..', 'src'), label = 'current', port = '4812'] = process.argv.slice(2);
const S = path.join(os.tmpdir(), 'officechain-bench');
fs.mkdirSync(S, { recursive: true });
const root = path.join(S, `demo-wf-${label}`);
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'daemon'), { recursive: true });
fs.mkdirSync(path.join(root, 'data'));
fs.writeFileSync(path.join(root, 'daemon', 'office.yaml'), `port: ${port}\nuiDir: ../ui/dist\n`);
const TSX = path.join(HERE, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const env = { ...process.env, OFFICE_DATA_DIR: path.join(root, 'data') };
execFileSync(process.execPath, [TSX, path.join(srcDir, 'seed.ts')], { cwd: path.join(root, 'daemon'), env, stdio: 'ignore' });

const daemon = spawn(process.execPath, [TSX, path.join(srcDir, 'index.ts')], { cwd: path.join(root, 'daemon'), env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; daemon.stdout.on('data', (d) => { log += d; }); daemon.stderr.on('data', (d) => { log += d; });
const B = `http://localhost:${port}/api`;
const api = async (p, body, method) => { const r = await fetch(B + p, body ? { method: method ?? 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined); return r.json(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 60; i++) { try { await fetch(B + '/health'); break; } catch { await sleep(500); } }

const db = new DatabaseSync(path.join(root, 'data', 'office.db'));
await api('/agents', { name: 'Cursor (Tester)', avatar: 'T', role: 'role-qa', workspace: 'ws-demo' });
db.prepare(`UPDATE workspaces SET settings = ? WHERE id = 'ws-demo'`).run(JSON.stringify({ workMode: 'direct', commitMode: 'auto' }));

// The custom graph: analyst triage inserted before the branch; a task.type
// condition sends docs work to the writer and code work to dev→qa→review;
// dev pings the acceptor with a message edge; two bounded loops (dev failure
// re-triages, qa failure re-implements).
const n = (id, label, role, purpose, extra = {}) => ({ id, type: 'agent', label, role, position: { x: 0, y: 0 }, config: { purpose, ...extra } });
const graph = {
  nodes: [
    { id: 'start', type: 'start', label: 'Start', position: { x: 0, y: 0 } },
    n('pm-plan', 'Ada · plan', 'pm', 'plan', { scope: 'run' }),
    n('triage', 'Ana · triage', 'analyst', 'analyse'),            // inserted agent — not in the default pipeline
    { id: 'kind', type: 'condition', label: 'docs or code?', position: { x: 0, y: 0 } },
    n('doc', 'Doc · write docs', 'docs', 'doc'),
    n('dev', 'Dev · implement', 'developer', 'implement'),
    n('qa', 'Tester · QA', 'qa', 'qa'),
    n('rev', 'Rey · review', 'reviewer', 'review'),
    n('accept', 'Ada · accept', 'pm', 'accept'),
    { id: 'end', type: 'end', label: 'End', position: { x: 0, y: 0 } },
  ],
  edges: [
    { id: 'e0', from: 'start', to: 'pm-plan', kind: 'next' },
    { id: 'e1', from: 'pm-plan', to: 'triage', kind: 'next' },
    { id: 'e2', from: 'triage', to: 'kind', kind: 'next' },
    { id: 'e3', from: 'kind', to: 'doc', kind: 'next', label: 'docs task', condition: { field: 'task.type', op: 'eq', value: 'docs' } },
    { id: 'e4', from: 'kind', to: 'dev', kind: 'next', else: true, label: 'everything else' },
    { id: 'e5', from: 'doc', to: 'rev', kind: 'next' },
    { id: 'e6', from: 'dev', to: 'qa', kind: 'next' },
    { id: 'e7', from: 'dev', to: 'triage', kind: 'on-failure', label: 'diagnose the failure', maxLoops: 2 },
    { id: 'e8', from: 'qa', to: 'rev', kind: 'on-success' },
    { id: 'e9', from: 'qa', to: 'dev', kind: 'on-failure', label: 'rework', maxLoops: 1 },
    { id: 'e10', from: 'rev', to: 'accept', kind: 'on-success' },
    { id: 'e11', from: 'accept', to: 'end', kind: 'on-success' },
    { id: 'm1', from: 'dev', to: 'accept', kind: 'message', label: 'heads-up for the acceptor', waitForReply: false },
  ],
  guardrails: { maxStepsPerTask: 30, maxStepsPerRun: 80 },
};

const created = await api('/workflows', { workspaceId: 'ws-demo', name: 'Demo routing', description: 'Phase 5 e2e demo graph', graph });
if (!created.id) { console.log('create failed:', JSON.stringify(created)); daemon.kill(); process.exit(1); }
const detail = await api(`/workflows/${created.id}`);
console.log('validation:', JSON.stringify(detail.issues), 'estimate:', JSON.stringify(detail.estimate));
const sim = await api('/workflows/simulate', { graph, outcomes: { dev: ['failure', 'success'] } });
console.log(`dry run: ${sim.result}, ${sim.calls} calls, path: ${sim.steps.map((s) => s.nodeId).join(' → ')}`);
await api(`/workflows/${created.id}/activate`, {});

const t0 = Date.now();
const run = await api('/runs', { workspaceId: 'ws-demo', goal: 'Add heading conversion to the markdown converter', budgetUsd: 50 });
let status = '';
const approvals = [];
let dodApproved = false;
for (let i = 0; i < 600; i++) {
  await sleep(1000);
  // defensive: decide any gate that appears so the scripted demo can't stall
  for (const a of (await api('/approvals')).filter((x) => x.status === 'pending' && x.run_id === run.id)) {
    approvals.push(a.action);
    await api(`/approvals/${a.id}/decide`, { approve: true });
  }
  status = (await api(`/runs/${run.id}`)).status;
  if (status === 'paused' && !dodApproved) { dodApproved = true; await api(`/runs/${run.id}/approve-dod`, {}); await api(`/runs/${run.id}/resume`, {}); continue; }
  if (['done', 'stopped', 'failed', 'paused'].includes(status)) break;
  if (Date.now() - t0 > 4 * 60_000) { status = `timeout(${status})`; break; }
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const tasks = db.prepare(`SELECT id, title, type, status FROM tasks WHERE run_id = ? ORDER BY rowid`).all(run.id);
const items = db.prepare(`SELECT w.kind, w.agent_id, w.workflow_node_id, w.status, w.task_id FROM work_items w WHERE w.run_id = ? ORDER BY w.rowid`).all(run.id);
const planItems = db.prepare(`SELECT kind, agent_id, workflow_node_id FROM work_items WHERE run_id = ? AND task_id IS NULL`).all(run.id);
const wfEvents = db.prepare(`SELECT type, payload FROM events WHERE run_id = ? AND type LIKE 'workflow.%' ORDER BY seq`).all(run.id);
const msgs = db.prepare(`SELECT kind, substr(text,1,90) text FROM agent_messages WHERE run_id = ? ORDER BY rowid`).all(run.id);
const summary = {
  status, elapsedSec: Number(elapsed), decidedApprovals: approvals,
  tasks, planItems,
  itemsByTask: tasks.map((t) => ({ title: t.title.slice(0, 44), type: t.type, status: t.status, steps: items.filter((w) => w.task_id === t.id).map((w) => `${w.workflow_node_id ?? '-'}:${w.kind}`) })),
  workflowEvents: wfEvents.map((e) => e.type),
  messages: msgs,
  runSummary: await api(`/runs/${run.id}/summary`),
};
fs.writeFileSync(path.join(S, `demo-workflow-${label}.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
daemon.kill();
db.close();
