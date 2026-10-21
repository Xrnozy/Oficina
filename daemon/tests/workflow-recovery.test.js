// Recovery when an agent stops mid-workflow. Each case was seen in a real run:
//  - an agent CLI went silent: the stuck detector marked it interrupted but left the process running and the run waiting;
//  - a workflow step's backend failed: QA dropped the task into the fixed pipeline's review, a prompt step was lost;
//  - two triggers advanced the same run at once and each started a new planning cycle.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-recover-'));
process.env.OFFICE_DATA_DIR = dataDir;

const { q, q1, run } = await import('../src/db.ts');
const { createRun, wireEngineEvents, fireDueTimers, maybeAdvanceRun } = await import('../src/engine/engine.ts');
const { createWorkflow, setActiveWorkflow } = await import('../src/services/workflow.ts');
const { ensureRepo } = await import('../src/services/git.ts');
const { now, ulid } = await import('../src/util.ts');

const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-recover-repo-'));
ensureRepo(repoDir);

for (const name of ['pm', 'prompt-creator', 'developer', 'reviewer', 'analyst', 'qa', 'docs']) {
  run(`INSERT INTO roles (id, name, version, responsibilities, allowed_actions, default_instructions, default_skills) VALUES (?,?,1,'[]','[]','','[]')`, `role-${name}`, name);
}
run(`INSERT INTO policies (id, scope, rules) VALUES ('pol-r','{}','[]')`);
run(`INSERT INTO providers (id, name, kind, adapter_id, adapter_version, adapter_hash, tier, enabled, capabilities, config) VALUES ('prov-s','Scripted','agent','scripted','1.0.0','local',1,1,'{}','{}')`);
run(`INSERT INTO providers (id, name, kind, adapter_id, adapter_version, adapter_hash, tier, enabled, capabilities, config) VALUES ('prov-c','Fake CLI','agent','cli','1.0.0','local',2,1,'{}','{}')`);
run(`INSERT INTO models (id, provider_id, name, context_tokens, max_output_tokens, price_in, price_out, strength_tier) VALUES ('m-s','prov-s','scripted-1',128000,8192,0,0,'standard')`);
run(`INSERT INTO models (id, provider_id, name, context_tokens, max_output_tokens, price_in, price_out, strength_tier) VALUES ('m-c','prov-c','',128000,8192,0,0,'standard')`);
run(`INSERT INTO accounts (id, provider_id, label, billing, enabled, config) VALUES ('acct-s','prov-s','local','payg',1,'{}')`);

// a CLI that, the first time, prints its start-up record and then hangs without a word (like the stalled CLIs in the
// field); the second time it does the work
const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-recover-cli-'));
const marker = path.join(cliDir, 'first.pid');
const fake = path.join(cliDir, 'fake-cli.mjs');
fs.writeFileSync(fake, `
import fs from 'node:fs';
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x' }));
if (!fs.existsSync(${JSON.stringify(marker)})) {
  fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  fs.mkdirSync('src', { recursive: true });
  fs.writeFileSync('src/a.js', 'export const a = 1;\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'wrote src/a.js' }));
}
`);
// idleTimeoutSec 0: the CLI's own watchdog is off, so this exercises the engine's stuck detector
run(`INSERT INTO accounts (id, provider_id, label, billing, enabled, config) VALUES ('acct-c','prov-c','cli','payg',1,?)`,
  JSON.stringify({ command: `"${process.execPath}" "${fake}"`, idleTimeoutSec: 0 }));

const mkWorkspace = (id, repoId, dir) => {
  run(`INSERT INTO workspaces (id, name, purpose, repo_ids, allowed_provider_ids, policy_id, memory_scope, settings) VALUES (?,?,'',?,'[]','pol-r','isolated','{"commitMode":"manual"}')`, id, id, JSON.stringify([repoId]));
  run(`INSERT INTO repos (id, workspace_id, path, remote_url, default_branch, integration_branch, build_cmd, test_cmd) VALUES (?,?,?,NULL,'main','integration','','')`, repoId, id, dir);
  run(`INSERT INTO checks (id, repo_id, name, kind, command, parser, pass_rule, timeout_sec, affected_paths, protected) VALUES (?,?,'build','build','node --check src/a.js','auto','exit0',60,'["src/**"]',0)`, `chk-${repoId}`, repoId);
};
mkWorkspace('ws-r', 'repo-r', repoDir);

const mkAgent = (id, ws, role, { account = 'acct-s', model = 'm-s', script = {} } = {}) => {
  run(`INSERT INTO agents (id, name, avatar, account_id, model_id, settings, instructions, caps, observability, status) VALUES (?,?,?,?,?,?,?,?,'actions','idle')`,
    id, `${id} agent`, 'x', account, model, JSON.stringify({ script }), '', JSON.stringify({ perTaskUsd: 10, perDayUsd: 50, maxTokensPerCall: 128000 }));
  run(`INSERT INTO memberships (id, agent_id, workspace_id, role_id, active_since, max_concurrent_tasks, active) VALUES (?,?,?,?,?,1,1)`, ulid(), id, ws, `role-${role}`, now());
};
const PLAN = {
  dodItems: [{ id: 'F1', text: 'module parses', kind: 'feature', checks: ['build'] }],
  tasks: [{ key: 'T1', title: 'Add module a', type: 'feature', priority: 1, difficulty: 2, dependsOn: [], dodItemIds: ['F1'], budgetUsd: 5,
    acceptanceCriteria: ['src/a.js parses'], affectedPaths: ['src/'], meta: { files: { 'src/a.js': 'export const a = 1;\n' } } }],
};
mkAgent('ag-pm', 'ws-r', 'pm', { script: { plan: PLAN } });
mkAgent('ag-cli', 'ws-r', 'developer', { account: 'acct-c', model: 'm-c' });
mkAgent('ag-qa', 'ws-r', 'qa');

wireEngineEvents();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 60000, step = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > deadline) return null; await sleep(step); }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const node = (id, type, extra = {}) => ({ id, type, label: id, position: { x: 0, y: 0 }, ...extra });

test('a silent agent is stopped, its work retried on the same step, and the run finishes', { timeout: 120000 }, async () => {
  const g = {
    nodes: [node('start', 'start'), node('dev', 'agent', { role: 'developer', config: { purpose: 'implement' } }), node('end', 'end')],
    edges: [{ id: 'e0', from: 'start', to: 'dev', kind: 'next' }, { id: 'e1', from: 'dev', to: 'end', kind: 'next' }],
  };
  const made = createWorkflow('ws-r', 'stuck', '', g);
  setActiveWorkflow('ws-r', made.workflowId);
  const r = createRun({ workspaceId: 'ws-r', goal: 'Add module a', limits: { stuckAgentMinApi: 0.05 } });   // 3 s of silence counts as stuck
  const first = await waitFor(() => q1(`SELECT id FROM work_items WHERE run_id = ? AND kind = 'implement' AND status = 'running'`, r.id));
  assert.ok(first, 'the developer step should start');
  const pid = Number(await waitFor(() => fs.existsSync(marker) && fs.readFileSync(marker, 'utf8')));
  assert.ok(alive(pid), 'the fake CLI is running');
  await sleep(4000);
  run(`UPDATE timers SET fire_at = ? WHERE type = 'heartbeat.missed'`, new Date(Date.now() - 1000).toISOString());
  fireDueTimers();

  assert.equal(q1('SELECT status FROM work_items WHERE id = ?', first.id).status, 'interrupted');
  const stuck = q1(`SELECT payload FROM events WHERE type = 'agent.stuck' AND entity_id = ?`, first.id);
  assert.ok(stuck && JSON.parse(stuck.payload).killed === 1, 'the stuck agent\'s process is stopped');
  assert.ok(await waitFor(() => !alive(pid), 10000), 'the stuck CLI process is gone');

  const status = await waitFor(() => { const s = q1('SELECT status FROM runs WHERE id = ?', r.id).status; return ['done', 'stopped', 'failed'].includes(s) && s; }, 90000);
  assert.equal(status, 'done', 'the retried step delivers and the run completes');
  const impl = q(`SELECT id, status, workflow_node_id FROM work_items WHERE run_id = ? AND kind = 'implement' ORDER BY rowid`, r.id);
  assert.deepEqual(impl.map((w) => [w.status, w.workflow_node_id]), [['interrupted', 'dev'], ['delivered', 'dev']]);
  // the killed item never turned into a delivery afterwards
  await sleep(1500);
  assert.equal(q1('SELECT status FROM work_items WHERE id = ?', first.id).status, 'interrupted');
  setActiveWorkflow('ws-r', null);
});

test('a workflow step whose backend fails is retried on that step — QA is not skipped, a prompt step is not lost', { timeout: 150000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-recover-repo2-'));
  ensureRepo(dir);
  mkWorkspace('ws-g2', 'repo-g2', dir);
  mkAgent('ag2-pm', 'ws-g2', 'pm', { script: { plan: PLAN } });
  mkAgent('ag2-pc', 'ws-g2', 'prompt-creator', { script: { failOnce: ['prompt'] } });
  mkAgent('ag2-dev', 'ws-g2', 'developer');
  mkAgent('ag2-qa', 'ws-g2', 'qa', { script: { failOnce: ['qa'] } });
  mkAgent('ag2-rev', 'ws-g2', 'reviewer');
  const g = {
    nodes: [node('start', 'start'), node('pc', 'agent', { role: 'prompt-creator', config: { purpose: 'prompt' } }),
      node('dev', 'agent', { role: 'developer', config: { purpose: 'implement' } }), node('qa', 'agent', { role: 'qa', config: { purpose: 'qa' } }), node('end', 'end')],
    edges: [{ id: 'e0', from: 'start', to: 'pc', kind: 'next' }, { id: 'e1', from: 'pc', to: 'dev', kind: 'next' },
      { id: 'e2', from: 'dev', to: 'qa', kind: 'next' }, { id: 'e3', from: 'qa', to: 'end', kind: 'next' }],
  };
  const made = createWorkflow('ws-g2', 'flaky', '', g);
  setActiveWorkflow('ws-g2', made.workflowId);
  const r = createRun({ workspaceId: 'ws-g2', goal: 'Add module a' });
  const status = await waitFor(() => { const s = q1('SELECT status FROM runs WHERE id = ?', r.id).status; return ['done', 'stopped', 'failed'].includes(s) && s; }, 120000);
  const items = q(`SELECT kind, status, workflow_node_id n FROM work_items WHERE run_id = ? AND kind != 'plan' ORDER BY rowid`, r.id);
  assert.equal(status, 'done', JSON.stringify(items));
  assert.deepEqual(items.map((w) => [w.kind, w.status, w.n]), [
    ['prompt', 'failed', 'pc'], ['prompt', 'delivered', 'pc'],
    ['implement', 'delivered', 'dev'],
    ['qa', 'failed', 'qa'], ['qa', 'delivered', 'qa'],
  ]);
  assert.ok(!q1(`SELECT 1 FROM events WHERE run_id = ? AND type = 'qa.skipped'`, r.id), 'QA must not be skipped into the fixed pipeline');
});

test('two advances of the same run at once start one planning cycle, not two', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-recover-repo3-'));
  ensureRepo(dir);
  mkWorkspace('ws-c', 'repo-c', dir);
  mkAgent('ag3-pm', 'ws-c', 'pm', { script: { plan: { dodItems: [], tasks: [] }, latencyMs: 5000 } });
  const runId = ulid();
  const dodId = ulid();
  run(`INSERT INTO runs (id, workspace_id, repo_id, goal, status, dod_id, budget, limits, current_cycle, started_at) VALUES (?,?,?,?,'running',?,?,?,1,?)`,
    runId, 'ws-c', 'repo-c', 'g', dodId, JSON.stringify({ runUsd: 50, taskUsd: 10, warnPct: 80 }),
    JSON.stringify({ maxCycles: 30, maxWallclockMin: 600, maxParallel: 3, sameErrorAttempts: 3, noProgressCycles: 9, disagreeK: 3, stuckAgentMinApi: 10, stuckAgentMinHosted: 45, cycleMaxMinutes: 60 }), now());
  run(`INSERT INTO dod (id, run_id, version, items, status) VALUES (?,?,1,?, 'approved')`, dodId, runId, JSON.stringify([{ id: 'X', text: 'never passes', checks: ['no-such-check'] }]));
  run(`INSERT INTO cycles (id, run_id, n, phase, started_at) VALUES (?,?,1,'build',?)`, ulid(), runId, now());
  run(`INSERT INTO tasks (id, run_id, title, status) VALUES (?,?,'finished work','done')`, `T-c-${runId}`, runId);
  await Promise.all([maybeAdvanceRun(runId), maybeAdvanceRun(runId), maybeAdvanceRun(runId)]);
  assert.equal(q1('SELECT current_cycle c FROM runs WHERE id = ?', runId).c, 2, 'exactly one new cycle');
  assert.equal(q1(`SELECT COUNT(*) c FROM work_items WHERE run_id = ? AND kind = 'plan'`, runId).c, 1, 'exactly one plan dispatched');
  run(`UPDATE runs SET status = 'stopped' WHERE id = ?`, runId);
});
