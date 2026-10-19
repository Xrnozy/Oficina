// End to end with the scripted agents: reference files and task attachments reach the agents' real prompts,
// a task the owner adds mid-run is picked up and carries only its own files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-attach-e2e-'));

const { q, q1, run } = await import('../src/db.ts');
const { createRun, createUserTask, wireEngineEvents } = await import('../src/engine/engine.ts');
const { ensureBuiltinWorkflow } = await import('../src/services/workflow.ts');
const A = await import('../src/services/attachments.ts');
const { ensureRepo } = await import('../src/services/git.ts');
const { now, ulid } = await import('../src/util.ts');

const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-attach-e2e-repo-'));
ensureRepo(repoDir);
for (const name of ['pm', 'prompt-creator', 'developer', 'reviewer', 'analyst', 'qa', 'docs']) {
  run(`INSERT INTO roles (id, name, version, responsibilities, allowed_actions, default_instructions, default_skills)
       VALUES (?,?,1,'[]','[]','','[]')`, `role-${name}`, name);
}
run(`INSERT INTO policies (id, scope, rules) VALUES ('pol-e','{}','[]')`);
run(`INSERT INTO providers (id, name, kind, adapter_id, adapter_version, adapter_hash, tier, enabled, capabilities, config)
     VALUES ('prov-e','Scripted','agent','scripted','1.0.0','local',1,1,'{}','{}')`);
run(`INSERT INTO models (id, provider_id, name, context_tokens, max_output_tokens, price_in, price_out, strength_tier)
     VALUES ('m-e','prov-e','scripted-1',128000,8192,0,0,'standard')`);
run(`INSERT INTO accounts (id, provider_id, label, billing, enabled, config) VALUES ('acct-e','prov-e','local','payg',1,'{}')`);
run(`INSERT INTO workspaces (id, name, purpose, repo_ids, allowed_provider_ids, policy_id, memory_scope, settings)
     VALUES ('ws-e','E','', '["repo-e"]','[]','pol-e','isolated','{"workMode":"direct"}')`);
run(`INSERT INTO repos (id, workspace_id, path, remote_url, default_branch, integration_branch, build_cmd, test_cmd)
     VALUES ('repo-e','ws-e',?,NULL,'main','integration','','')`, repoDir);
run(`INSERT INTO checks (id, repo_id, name, kind, command, parser, pass_rule, timeout_sec, affected_paths, protected)
     VALUES ('chk-e','repo-e','build','build','node --check src/a.js','auto','exit0',60,'["src/**"]',0)`);

const mkAgent = (id, role, script = {}) => {
  run(`INSERT INTO agents (id, name, avatar, account_id, model_id, settings, instructions, caps, observability, status)
       VALUES (?,?,?,?,?,?,?,?,'actions','idle')`,
    id, `${id} agent`, 'x', 'acct-e', 'm-e', JSON.stringify({ script }), '', JSON.stringify({ perTaskUsd: 10, perDayUsd: 50, maxTokensPerCall: 128000 }));
  run(`INSERT INTO memberships (id, agent_id, workspace_id, role_id, active_since, max_concurrent_tasks, active)
       VALUES (?,?,?,?,?,1,1)`, ulid(), id, 'ws-e', `role-${role}`, now());
};
mkAgent('ag-pm', 'pm', { plan: {
  dodItems: [{ id: 'F1', text: 'module parses', kind: 'feature', checks: ['build'] }],
  tasks: [{ key: 'T1', title: 'Add module a', type: 'feature', priority: 1, difficulty: 2, dependsOn: [], dodItemIds: ['F1'], budgetUsd: 5,
    acceptanceCriteria: ['src/a.js parses'], affectedPaths: ['src/'], meta: { files: { 'src/a.js': 'export const a = 1;\n' } } }],
  notes: 'e2e',
} });
mkAgent('ag-pc', 'prompt-creator'); mkAgent('ag-dev', 'developer'); mkAgent('ag-rev', 'reviewer');
mkAgent('ag-an', 'analyst'); mkAgent('ag-qa', 'qa'); mkAgent('ag-doc', 'docs');
wireEngineEvents();
ensureBuiltinWorkflow('ws-e');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) { const v = pred(); if (v) return v; if (Date.now() > deadline) return null; await sleep(200); }
}
const promptsFor = (runId, taskId) => q(`SELECT payload FROM events WHERE run_id = ? AND type = 'agent.activity' AND entity_id IN (SELECT id FROM work_items WHERE task_id = ?)`, runId, taskId)
  .map((e) => JSON.parse(e.payload)).filter((p) => p.kind === 'prompt').map((p) => p.detail ?? '');

test('references reach the planner and the developer; a task added mid-run is picked up with only its own attachments', { timeout: 150000 }, async () => {
  const spec = A.addAttachment({ workspaceId: 'ws-e', scope: 'project', name: 'spec.md', data: Buffer.from('# Product spec\n\nThe module exports a.\n') });
  assert.ok(!spec.error);
  const own = A.addAttachment({ workspaceId: 'ws-e', scope: 'agent', agentId: 'ag-dev', name: 'dev-notes.md', data: Buffer.from('# Dev notes\n') });
  assert.ok(!own.error);

  const r = createRun({ workspaceId: 'ws-e', goal: 'Add module a', oneShot: true });
  const planned = await waitFor(() => q1(`SELECT id FROM tasks WHERE run_id = ? AND planned_by != 'owner'`, r.id)?.id);
  assert.ok(planned, 'the PM planned a task');

  // the owner drops a bug screenshot into Ready while the run is going
  const t = createUserTask(r.id, { title: 'Fix the layout bug', description: 'see the screenshot' });
  assert.ok(!t.error, t.error);
  const shot = A.addAttachment({ workspaceId: 'ws-e', scope: 'task', taskId: t.id, name: 'bug.png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9]) });
  assert.ok(!shot.error, shot.error);

  const devPrompt = await waitFor(() => {
    const wi = q1(`SELECT id FROM work_items WHERE task_id = ? AND kind = 'implement' ORDER BY rowid LIMIT 1`, t.id);
    return wi ? q(`SELECT payload FROM events WHERE type = 'agent.activity' AND entity_id = ?`, wi.id).map((e) => JSON.parse(e.payload)).find((p) => p.kind === 'prompt')?.detail : null;
  });
  assert.ok(devPrompt, 'the developer got an implement prompt for the new task');
  assert.match(devPrompt, /bug.png/, 'the developer was told about the screenshot');
  assert.match(devPrompt, /spec\.md/, 'project reference present');
  assert.match(devPrompt, /dev-notes\.md/, "the developer's own reference present");
  assert.ok(devPrompt.includes(A.fileOf(shot.attachment)), 'the absolute path is given so the agent can open it');
  assert.ok(!devPrompt.includes('The module exports a.'), 'contents are not pasted into the prompt');

  const plannedPrompts = await waitFor(() => { const p = promptsFor(r.id, planned); return p.length ? p : null; });
  assert.ok(plannedPrompts.every((p) => !/bug\.png/.test(p)), "a task never sees another task's attachment");
  assert.ok(plannedPrompts.some((p) => /spec\.md/.test(p)));

  const finished = await waitFor(() => { const s = q1('SELECT status FROM tasks WHERE id = ?', t.id)?.status; return ['done', 'approved', 'failed', 'blocked'].includes(s) ? s : null; }, 120000);
  assert.ok(['done', 'approved'].includes(finished), `the owner task finished (was ${finished})`);
});
