// Stage 6: derived checks from acceptance criteria, result-cache key
// stability, per-repo lessons memory, and the model-free run summary.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-wf6-'));
const { q, q1, run } = await import('../src/db.ts');
const { deriveChecks } = await import('../src/services/verify.ts');
const { lessonsFor, recordLesson, recordReviewerFlag } = await import('../src/services/errors.ts');
const { buildRunSummary, summaryMarkdown } = await import('../src/services/summary.ts');
const { emit } = await import('../src/bus.ts');
const { now } = await import('../src/util.ts');

run(`INSERT INTO workspaces (id, name, settings) VALUES ('ws-wf', 'WF', '{}')`);
run(`INSERT INTO repos (id, workspace_id, path, integration_branch) VALUES ('repo-wf','ws-wf','/tmp/x','main')`);
run(`INSERT INTO runs (id, workspace_id, repo_id, goal, status) VALUES ('run-wf','ws-wf','repo-wf','Ship the thing','running')`);
run(`INSERT INTO checks (id, repo_id, name, kind, command) VALUES
  ('c-build','repo-wf','build','build','npm run build'),
  ('c-test','repo-wf','unit','unit','npm test'),
  ('c-lint','repo-wf','lint','lint','npm run lint'),
  ('c-doc','repo-wf','docs-present','doc','')`);

test('deriveChecks maps criteria to runnable checks and flags the rest', () => {
  const d = deriveChecks('repo-wf', [
    'all unit tests pass via `npm test`',          // command mention → unit
    'the build compiles without errors',            // kind hint → build
    'check "lint" reports no warnings',             // name mention → lint
    'documentation is updated',                     // doc hint → docs-present
    'the feature feels intuitive to use',           // nothing runnable
  ]);
  assert.equal(d.length, 5);
  assert.equal(d[0].checkName, 'unit');
  assert.equal(d[1].checkName, 'build');
  assert.equal(d[2].checkName, 'lint');
  assert.equal(d[3].checkName, 'docs-present');
  assert.equal(d[4].checkable, false);
  assert.equal(d[4].checkId, null);
});

test('deriveChecks: no checks configured → every criterion non-checkable', () => {
  const d = deriveChecks('repo-none', ['tests pass']);
  assert.equal(d[0].checkable, false);
});

test('recordReviewerFlag upserts by signature and counts repeats', () => {
  recordReviewerFlag({ workspaceId: 'ws-wf', repoId: 'repo-wf', flag: 'Missing error handling around the HTTP call', files: ['src/api.ts'] });
  recordReviewerFlag({ workspaceId: 'ws-wf', repoId: 'repo-wf', flag: 'Missing error handling around the HTTP call', files: ['src/api.ts'] });
  recordReviewerFlag({ workspaceId: 'ws-wf', repoId: 'repo-wf', flag: 'totally different complaint about naming' });
  const row = q1(`SELECT times_seen FROM error_kb WHERE signature LIKE 'revflag:%'`);
  assert.equal(row.times_seen, 2); // first flag deduped, not duplicated
  assert.equal(q(`SELECT id FROM error_kb WHERE signature LIKE 'revflag:%'`).length, 2);
});

test('lessonsFor returns at most 3 lessons within ~300 tokens, ranked by match', () => {
  // resolved-error lesson + reviewer flag already exist; add path-matched + irrelevant rows
  recordLesson({ workspaceId: 'ws-wf', repoId: 'repo-wf', signature: 'sig-path', errorText: 'typecheck failed src/api.ts', fixSummary: 'Regenerate the API client before touching callers', files: ['src/api.ts'] });
  for (let i = 0; i < 6; i++) recordLesson({ workspaceId: 'ws-wf', repoId: 'repo-wf', signature: `sig-pad-${i}`, errorText: `x${i}`, fixSummary: `padding ${'y'.repeat(600)}` });
  const out = lessonsFor({ workspaceId: 'ws-wf', repoId: 'repo-wf', files: ['src/api.ts'], text: 'fix the api error handling' });
  assert.ok(out.length >= 1 && out.length <= 3);
  // the repeated reviewer flag on the same path should rank first
  assert.ok(out[0].signature.startsWith('revflag:'), `expected a reviewer flag first, got ${out[0].signature}`);
  // the path-matched lesson must be in the result set
  assert.ok(out.some((l) => l.signature === 'sig-path'));
  const chars = out.reduce((a, l) => a + l.text.length, 0);
  assert.ok(chars <= 1200, `lesson chars ${chars} exceed ~300 tokens`);
});

test('lessonsFor scopes to the repo', () => {
  const out = lessonsFor({ workspaceId: 'ws-wf', repoId: 'repo-other', files: ['src/api.ts'], text: 'error handling api' });
  assert.ok(!out.some((l) => l.signature === 'sig-path'), 'repo-lesson must not leak to another repo');
});

test('buildRunSummary assembles goal, tasks, commits, checks, tokens, retries, interventions — no model', () => {
  run(`INSERT INTO tasks (id, run_id, title, status) VALUES ('t1','run-wf','Do the thing','done')`);
  run(`INSERT INTO tasks (id, run_id, title, status) VALUES ('t2','run-wf','Other thing','failed')`);
  emit('commit.created', 'engine', { taskId: 't1', sha: 'abcdef123456', title: 'feat: the thing' }, 'run-wf', 't1');
  run(`INSERT INTO check_runs (id, check_id, run_id, task_id, status, duration_ms, summary, failures, created_at)
       VALUES ('cr1','c-build','run-wf','t1','pass',1200,'ok','[]',?)`, now());
  run(`INSERT INTO check_runs (id, check_id, run_id, task_id, status, duration_ms, summary, failures, created_at)
       VALUES ('cr2','c-test','run-wf','t1','fail',3400,'2 failing','[{"name":"x","message":"boom"}]',?)`, now());
  run(`INSERT INTO work_items (id, task_id, run_id, kind, agent_id, status, attempt) VALUES ('wi1','t1','run-wf','implement','a1','delivered',2)`);
  run(`INSERT INTO prompt_versions (id, work_item_id, rendered_text, created_at) VALUES ('pv1','wi1',?,?)`, 'x'.repeat(4000), now());
  run(`INSERT INTO approvals (id, run_id, task_id, action, payload, requested_by, status, reason, decided_at, created_at)
       VALUES ('ap1','run-wf','t1','commit.task','{}','engine','approved','auto-approved (policy: auto)',?,?)`, now(), now());
  run(`INSERT INTO approvals (id, run_id, task_id, action, payload, requested_by, status, reason, decided_at, created_at)
       VALUES ('ap2','run-wf','t2','task.escalate','{}','engine','rejected','owner declined',?,?)`, now(), now());

  const s = buildRunSummary('run-wf');
  assert.equal(s.goal, 'Ship the thing');
  assert.equal(s.tasks.length, 2);
  assert.equal(s.commits.length, 1);
  assert.equal(s.commits[0].sha, 'abcdef1234'.slice(0, 10));
  assert.equal(s.checks.total, 2);
  assert.equal(s.checks.passed, 1);
  assert.equal(s.checks.failed, 1);
  const impl = s.stages.find((x) => x.kind === 'implement');
  assert.equal(impl.workItems, 1);
  assert.equal(impl.promptChars, 4000);
  assert.equal(s.retries.retriedWorkItems, 1);
  // only the human-decided approval counts — the auto-approval is excluded
  assert.equal(s.humanInterventions.approvalsDecided, 1);
  assert.equal(s.humanInterventions.items[0].action, 'task.escalate');

  const md = summaryMarkdown(s);
  assert.match(md, /# Run summary — run-wf/);
  assert.match(md, /Ship the thing/);
  assert.match(md, /Tokens & cost per stage/);
  assert.match(md, /Human interventions \(1 approvals/);
});
