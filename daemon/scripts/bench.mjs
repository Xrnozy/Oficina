// Benchmark: one fixed scenario on a daemon source tree, with scripted agents
// (no model calls, no cost). Compare two trees — e.g. a copy of an older
// daemon/src against the current one — on the same scenario:
//   npm run bench -w daemon                                (current tree)
//   node scripts/bench.mjs <daemon-src-dir> <label> <port> [dod-check]
// Writes <tmp>/officechain-bench/bench-<label>.json.
// Scenario (mirrors the real ASR run): direct mode on main, prompt mode 'all',
// auto commits; Prompt Creator's first brief is sent back by the PM; the
// developer's first delivery fails the checks; the tester fails each task's
// first review; one DoD item uses `git:diff` (the item that looped for real).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [srcDir = path.join(HERE, '..', 'src'), label = 'current', port = '4811', extraCheck] = process.argv.slice(2);
const S = path.join(os.tmpdir(), 'officechain-bench');
fs.mkdirSync(S, { recursive: true });
const root = path.join(S, `bench-${label}`);
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

// scenario setup (the same writes for both versions)
const db = new DatabaseSync(path.join(root, 'data', 'office.db'));
await api('/agents', { name: 'Cursor (Tester)', avatar: 'T', role: 'role-qa', workspace: 'ws-demo' });
db.prepare(`UPDATE agents SET settings = ? WHERE name = 'Cursor (Tester)'`).run(JSON.stringify({ script: { qaFailFirst: true, latencyMs: 300 } }));
const pm = db.prepare(`SELECT settings FROM agents WHERE id = 'ag-pm'`).get();
const pms = JSON.parse(pm.settings);
pms.script.plan.dodItems.push({ id: 'C1', text: 'The work changed the repository', kind: 'feature', checks: [extraCheck || 'git:diff'] });
db.prepare(`UPDATE agents SET settings = ? WHERE id = 'ag-pm'`).run(JSON.stringify(pms));
db.prepare(`UPDATE workspaces SET settings = ? WHERE id = 'ws-demo'`).run(JSON.stringify({ promptReview: 'all', workMode: 'direct', commitMode: 'auto' }));
db.close();

const t0 = Date.now();
const run = await api('/runs', { workspaceId: 'ws-demo', goal: 'Add heading conversion to the markdown converter', budgetUsd: 50 });
let status = '', blockedBy = null;
for (let i = 0; i < 600; i++) {
  await sleep(1000);
  const r = await api(`/runs/${run.id}`);
  status = r.status;
  const pending = (await api('/approvals')).filter((a) => a.status === 'pending' && a.run_id === run.id && a.action !== 'commit.task');
  if (['done', 'stopped', 'failed'].includes(status)) break;
  if (status === 'paused') { blockedBy = pending.map((a) => a.action).join(',') || 'paused (no explanation)'; break; }
  if (pending.length && Date.now() - t0 > 15000) { blockedBy = pending.map((a) => a.action).join(','); }
  if (Date.now() - t0 > 4 * 60_000) { status = `timeout(${status})`; break; }
}
const secs = Math.round((Date.now() - t0) / 1000);
daemon.kill();
await sleep(800);

// metrics
const m = new DatabaseSync(path.join(root, 'data', 'office.db'), { readOnly: true });
const R = run.id;
const kinds = Object.fromEntries(m.prepare(`SELECT kind, COUNT(*) c FROM work_items WHERE run_id = ? GROUP BY kind`).all(R).map((x) => [x.kind, x.c]));
const total = Object.values(kinds).reduce((a, b) => a + b, 0);
const promptChars = m.prepare(`SELECT COALESCE(SUM(length(p.rendered_text)),0) s FROM work_items w JOIN prompt_versions p ON p.id = w.prompt_version_id WHERE w.run_id = ?`).get(R).s;
const byKindChars = Object.fromEntries(m.prepare(`SELECT w.kind, CAST(AVG(length(p.rendered_text)) AS INT) a FROM work_items w JOIN prompt_versions p ON p.id = w.prompt_version_id WHERE w.run_id = ? GROUP BY w.kind`).all(R).map((x) => [x.kind, x.a]));
const outChars = m.prepare(`SELECT COALESCE(SUM(length(result)),0) s FROM work_items WHERE run_id = ?`).get(R).s;
const events = m.prepare(`SELECT COUNT(*) c FROM events WHERE run_id = ?`).get(R).c;
const cycles = m.prepare(`SELECT COUNT(*) c FROM cycles WHERE run_id = ?`).get(R).c;
const tasks = m.prepare(`SELECT status, COUNT(*) c FROM tasks WHERE run_id = ? GROUP BY status`).all(R).map((x) => `${x.status}:${x.c}`).join(' ');
const failed = m.prepare(`SELECT COUNT(*) c FROM work_items WHERE run_id = ? AND status IN ('failed','interrupted')`).get(R).c;
const dod = JSON.parse(m.prepare(`SELECT d.items FROM dod d JOIN runs r ON r.dod_id = d.id WHERE r.id = ?`).get(R).items).map((i) => `${i.id}:${i.status}`).join(' ');
const checkRuns = m.prepare(`SELECT COUNT(*) c FROM check_runs WHERE run_id = ?`).get(R).c;
const out = { label, status, blockedBy, secs, workItems: total, kinds, promptChars, outChars, avgPromptChars: byKindChars, events, cycles, tasks, failedOrInterrupted: failed, checkRuns, dod };
fs.writeFileSync(path.join(S, `bench-${label}.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
if (/Error/.test(log)) console.log('daemon log errors:', log.split('\n').filter((l) => /Error/.test(l)).slice(0, 5).join('\n'));
