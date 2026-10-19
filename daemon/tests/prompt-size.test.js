// Stage 2: prompt-size reduction — task-scoped context packs skip the repo
// tour, prompts keep a stable prefix and record what they dropped to fit the
// budget, and logs/diffs are compacted instead of pasted whole.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-prompt-'));
const { buildContextPack } = await import('../src/services/context.ts');
const { renderPrompt, finalizeApprovedPrompt } = await import('../src/engine/prompts.ts');
const { capDiff, compactLog } = await import('../src/util.ts');

const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-repo-'));
fs.writeFileSync(path.join(repoDir, 'README.md'), '# Demo repo\nline\n'.repeat(80));
fs.mkdirSync(path.join(repoDir, 'src'));
fs.writeFileSync(path.join(repoDir, 'src', 'a.ts'), 'export const a = 1;\n'.repeat(40));
fs.writeFileSync(path.join(repoDir, 'src', 'b.ts'), 'export const b = 2;\n'.repeat(40));

const repo = { path: repoDir, integrationBranch: 'office/integration' };
const task = { id: 'task-x', title: 'Add a thing', description: 'desc', acceptanceCriteria: ['works'], affectedPaths: ['src/a.ts'], meta: {} };
const agent = { name: 'Dev', instructions: '' };

test('repo scope: file list + README for a task\'s first items', () => {
  const pack = buildContextPack({ repo, task, tokenBudget: 12000, scope: 'repo' });
  assert.match(pack.repoSummary, /Files \(/);
  assert.ok(pack.files.some((f) => f.path === 'README.md'));
  assert.ok(pack.files.some((f) => f.path === 'src/a.ts'));
});

test('task scope: only the task\'s changed files, no repo tour or README', () => {
  const pack = buildContextPack({ repo, task, tokenBudget: 12000, scope: 'task', changedFiles: ['src/a.ts', 'src/b.ts'], excerpts: true });
  assert.match(pack.repoSummary, /src\/a\.ts/);
  assert.ok(!pack.files.some((f) => f.path === 'README.md'));
  assert.deepEqual(pack.files.map((f) => f.path).sort(), ['src/a.ts', 'src/b.ts']);
});

test('task scope without excerpts carries paths only', () => {
  const pack = buildContextPack({ repo, task, tokenBudget: 12000, scope: 'task', changedFiles: ['src/a.ts'], excerpts: false });
  assert.equal(pack.files.length, 0);
  assert.match(pack.repoSummary, /src\/a\.ts/);
});

test('renderPrompt: stable prefix first, data blocks after, deterministic', () => {
  const pack = buildContextPack({ repo, task, tokenBudget: 12000 });
  const opts = { kind: 'implement', agent, task, goal: 'goal', pack, extra: { diff: 'diff --git a/x b/x\n+x' } };
  const a = renderPrompt(opts);
  const b = renderPrompt(opts);
  assert.equal(a.text, b.text);
  const taskAt = a.text.indexOf('## Task: Add a thing');
  const dataAt = a.text.indexOf('REPO_SUMMARY');
  const tailAt = a.text.indexOf('Remember: you are Dev.');
  assert.ok(taskAt > -1 && dataAt > -1 && tailAt > -1);
  assert.ok(taskAt < dataAt && dataAt < tailAt);
  assert.equal(a.dropped.length, 0);
});

test('renderPrompt: drops low-value sections to fit the budget and records them', () => {
  const pack = buildContextPack({ repo, task, tokenBudget: 10 }); // ~40 chars
  const out = renderPrompt({ kind: 'qa', agent, task, pack, extra: { inbox: 'msg 1\nmsg 2', diff: 'x'.repeat(9000) } });
  assert.ok(out.dropped.includes('repo-summary'));
  assert.ok(out.dropped.includes('file README.md') || out.dropped.some((d) => d.startsWith('file')));
  assert.ok(out.dropped.includes('messages'));
  assert.ok(out.text.includes('Remember: you are Dev.'));
  assert.ok(out.text.includes('OUTPUT CONTRACT'));
});

test('finalizeApprovedPrompt keeps the contract and fits the inbox to budget', () => {
  const draft = '## Brief\nDo the thing.';
  const out = finalizeApprovedPrompt(draft, 'implement', 'api', 'hello\nworld', undefined, 'HANDOFF.md', draft.length + 10);
  assert.ok(out.text.includes('OUTPUT CONTRACT'));
  assert.ok(out.dropped.includes('messages'));
  const roomy = finalizeApprovedPrompt(draft, 'implement', 'api', 'hello\nworld');
  assert.ok(roomy.text.includes('TEAM_MESSAGES'));
  assert.equal(roomy.dropped.length, 0);
});

test('capDiff truncates at file boundaries and counts what it omitted', () => {
  const diff = ['a.ts', 'b.ts', 'c.ts'].map((f) => `diff --git a/${f} b/${f}\n+${'x'.repeat(5000)}\n`).join('');
  const out = capDiff(diff, 12000);
  assert.ok(out.includes('more file'));
  assert.ok(out.length < diff.length);
  const small = capDiff('diff --git a/x b/x\n+1\n', 12000);
  assert.equal(small, 'diff --git a/x b/x\n+1\n');
});

test('compactLog collapses repeated lines and keeps failure context plus tail', () => {
  const noise = 'same warning\n'.repeat(100);
  const log = `${noise}line1\nFAIL everything broke\nstack\nstack2\n${'tail line\n'.repeat(20)}`;
  const out = compactLog(log, 30);
  assert.ok(out.includes('(line repeated ×99)'));
  assert.ok(out.includes('FAIL everything broke'));
  assert.ok(out.includes('tail line'));
  assert.ok(out.split('\n').length <= 40);
});
