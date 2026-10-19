import fs from 'node:fs';
import path from 'node:path';
import { q1, run } from './db.ts';
import { now, ulid } from './util.ts';
import { ensureIntegration, ensureRepo } from './services/git.ts';
import type { OfficeConfig } from './config.ts';

// Seeds the demo workspace: roles, policies, the scripted provider's account,
// five agents (PM, developer, reviewer, analyst, docs), a demo repo on disk,
// and its check profile. The scripted PM's plan includes a deliberately
// buggy first delivery so the full verify → Error Report → fix → review →
// merge loop is exercised without spending a cent.

type RoleSeed = { id: string; name: string; responsibilities: string[]; allowedActions: string[]; instructions: string };

// The PM runs the company: it turns the goal into tasks and prompts, assigns
// them to the right specialist, coordinates hand-offs and tracks progress.
// It never writes, reviews, tests or validates code — specialists own their
// work end to end (spec 2). The engine enforces this: PM agents only receive
// plan/prompt work and run outside the repository.
export const PM_ROLE: RoleSeed = {
  id: 'role-pm', name: 'pm',
  responsibilities: [
    'Turn the goal into a Definition of Done and a task graph',
    'Write the prompt the developer receives',
    'Route every task to the right role: developer, qa, docs',
    'Accept finished work against the request, or send it back with instructions',
    'Re-plan when requirements or results change',
  ],
  allowedActions: ['task.create', 'task.cancel', 'task.assign', 'dod.propose', 'prompt.draft', 'prompt.review', 'task.accept', 'doc.project'],
  instructions: "You are the Project Manager. Turn each request into requirements, tasks and the developer's prompt; route the work; and decide from the tester's report and the developer's notes whether the result matches the request — accept it or send it back with clear instructions. You never write, modify, review or test code, and never inspect it to judge it. Describe WHAT must be achieved and how it is accepted, never HOW to code it.",
};

export const PROMPT_ROLE: RoleSeed = {
  id: 'role-prompt', name: 'prompt-creator',
  responsibilities: ['Turn each task into a complete, unambiguous prompt for the agent doing it', 'Revise prompts the PM sends back'],
  allowedActions: ['repo.read', 'prompt.draft'],
  instructions: 'You are the Prompt Creator. Write the exact prompt another agent will receive: goal, scope, every acceptance criterion, constraints and output contract. Address every PM revision note.',
};

// The tester (e.g. Cursor) reviews and validates every code delivery and
// reports to the PM — it never changes code; the developer fixes.
export const QA_ROLE: RoleSeed = {
  id: 'role-qa', name: 'qa',
  responsibilities: ['Review and validate every code delivery against its acceptance criteria', 'Run the tests; find errors, regressions and quality problems', 'Report pass/fail with evidence to the PM'],
  allowedActions: ['repo.read', 'shell.run.sandbox'],
  instructions: "You are the reviewer and tester. For each delivery, read the developer's change notes, review the diff, build it and run the tests, and check every acceptance criterion. Report pass or fail with evidence to the PM. Never edit, create or delete code or tests — the developer fixes what you find.",
};

const ROLES: RoleSeed[] = [
  PM_ROLE,
  PROMPT_ROLE,
  { id: 'role-dev', name: 'developer', responsibilities: ['Implement tasks and fixes on own branch', 'unit tests for own code'], allowedActions: ['repo.read', 'repo.write.worktree', 'git.push.agent_branch', 'pr.open', 'shell.run.sandbox'], instructions: 'Implement the task and write unit tests for it. Validate your own work before handing off: build, run the tests, and check every acceptance criterion. Never touch tests/acceptance, CI files, or the integration branch.' },
  { id: 'role-reviewer', name: 'reviewer', responsibilities: ['Review diffs for correctness and conventions'], allowedActions: ['repo.read', 'review.approve'], instructions: 'Review the diff for correctness, conventions and every acceptance criterion. You are the code reviewer — approve or request changes with concrete reasons.' },
  { id: 'role-analyst', name: 'analyst', responsibilities: ['Failure analysis', 'Error Reports', 'fix routing', 'cycle summaries'], allowedActions: ['repo.read'], instructions: 'Analyse check failures into structured Error Reports. Facts come from the engine; you fill cause and fix.' },
  QA_ROLE,
  { id: 'role-docs', name: 'docs', responsibilities: ['README, API docs, changelog'], allowedActions: ['repo.read', 'repo.write.worktree', 'git.push.agent_branch'], instructions: 'Write documentation under docs/, README.md, CHANGELOG.md only.' },
];

const DEFAULT_POLICY_RULES = [
  { action: 'repo.read', effect: 'allow' }, { action: 'repo.write.worktree', effect: 'allow' },
  { action: 'git.push.agent_branch', effect: 'allow' }, { action: 'pr.open', effect: 'allow' },
  { action: 'shell.run.sandbox', effect: 'allow' }, { action: 'task.create', effect: 'allow' },
  { action: 'deps.add', effect: 'approve' }, { action: 'file.delete', effect: 'approve' },
  { action: 'skill.run_script', effect: 'approve' }, { action: 'secret.read', effect: 'approve' },
  { action: 'deploy.preview', effect: 'approve' }, { action: 'pr.merge', effect: 'approve' },
  { action: 'file.write.protected', effect: 'approve' },
  { action: 'git.force_push', effect: 'forbid' }, { action: 'git.merge.main', effect: 'forbid' },
  { action: 'shell.run.host', effect: 'forbid' }, { action: 'deploy.prod', effect: 'forbid' },
];

const FIXED_CONVERT = `// markdown heading → HTML converter
const RE = /^(#{1,6})\\s+(.*)$/;
export function convert(md) {
  return md.split('\\n').map((line) => {
    const m = line.match(RE);
    if (!m) return line;
    const level = m[1].length;
    return '<h' + level + '>' + m[2].trim() + '</h' + level + '>';
  }).join('\\n');
}
`;

const BUGGY_CONVERT = `// markdown heading → HTML converter
const RE = /^(#{1,6})\\s+(.*)$/;
export function convert(md) {
  return md.split('\\n').map((line) => {
    const m = line.match(RE);
    if (!m) return line;
    // BUG: everything becomes h1
    return '<h1>' + m[2].trim() + '</h1>';
  }).join('\\n');
}
`;

const CLI_JS = `import { convert } from './convert.js';
const input = process.argv.slice(2).join(' ');
console.log(convert(input || '# Hello'));
`;

const TEST_JS = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert } from '../src/convert.js';

test('converts h1', () => {
  assert.equal(convert('# Title'), '<h1>Title</h1>');
});
test('converts h2', () => {
  assert.equal(convert('## Sub'), '<h2>Sub</h2>');
});
test('converts h3', () => {
  assert.equal(convert('### Deep'), '<h3>Deep</h3>');
});
test('leaves plain text alone', () => {
  assert.equal(convert('plain line'), 'plain line');
});
`;

const README = `# mdhead

A tiny markdown-heading-to-HTML converter, built autonomously by the Office.

## Setup

\`\`\`
node --version   # needs Node 18+
\`\`\`

## Usage

\`\`\`
node src/cli.js "## Hello"
node --test    # run the test suite
\`\`\`
`;

export function demoRepoPath(): string {
  return path.resolve(process.cwd(), '..', 'demo-repo');
}

export function seedIfEmpty(_config: OfficeConfig): void {
  if (q1('SELECT id FROM workspaces LIMIT 1')) return;
  console.log('[seed] creating demo workspace…');

  for (const r of ROLES) {
    run(`INSERT INTO roles (id, name, version, responsibilities, allowed_actions, default_instructions, default_skills)
         VALUES (?,?,1,?,?,?, '[]')`,
      r.id, r.name, JSON.stringify(r.responsibilities), JSON.stringify(r.allowedActions), r.instructions);
  }
  run(`INSERT INTO policies (id, scope, rules) VALUES (?,?,?)`, 'pol-default', '{}', JSON.stringify(DEFAULT_POLICY_RULES));

  // scripted provider + model + shared account
  run(`INSERT INTO providers (id, name, kind, adapter_id, adapter_version, adapter_hash, tier, enabled, capabilities, config)
       VALUES ('local-office','Scripted Demo Agent','agent','scripted','1.0.0','local',1,1,?, '{}')`,
    JSON.stringify({ models: ['scripted-1'], observability: 'actions', reasoningVisibility: 'none', settings: {}, midSessionMessages: false, suspendResume: false, webhooks: false, usageData: { perResponse: false, accountApi: false, resetTimes: 'none' }, mcp: false, nativeSkills: false }));
  run(`INSERT INTO models (id, provider_id, name, context_tokens, max_output_tokens, price_in, price_out, strength_tier)
       VALUES ('local-office:scripted-1','local-office','scripted-1',128000,8192,0,0,'standard')`);
  run(`INSERT INTO accounts (id, provider_id, label, billing, enabled, config)
       VALUES ('acct-scripted','local-office','local scripted','payg',1,'{}')`);

  const wsId = 'ws-demo';
  run(`INSERT INTO workspaces (id, name, purpose, repo_ids, allowed_provider_ids, policy_id, memory_scope, settings)
       VALUES (?,?,?,?,?,?,?,?)`,
    wsId, 'Demo Office', 'Hackathon demo workspace', '[]', '[]', 'pol-default', 'isolated', '{}');

  // demo repo on disk
  const repoPath = demoRepoPath();
  ensureRepo(repoPath);
  const pkgPath = path.join(repoPath, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'mdhead', version: '0.1.0', type: 'module', scripts: { test: 'node --test' } }, null, 2));
    fs.writeFileSync(path.join(repoPath, '.gitignore'), 'node_modules/\n.office/\n');
  }
  run(`INSERT INTO repos (id, workspace_id, path, remote_url, default_branch, integration_branch, build_cmd, test_cmd)
       VALUES ('repo-demo',?,?,NULL,'main','integration',?,?)`,
    wsId, repoPath,
    'node --check src/convert.js && node --check src/cli.js',
    'node --test');
  run(`UPDATE workspaces SET repo_ids = '["repo-demo"]' WHERE id = ?`, wsId);

  // check profile for the demo repo
  const checks = [
    { id: 'chk-build', name: 'build', kind: 'build', command: 'node --check src/convert.js && node --check src/cli.js', passRule: 'exit0', timeout: 60, paths: ['src/**'] },
    { id: 'chk-unit', name: 'unit:all', kind: 'unit', command: 'node --test', passRule: 'exit0', timeout: 120, paths: ['src/**', 'test/**'] },
    { id: 'chk-errors', name: 'errors:open', kind: 'custom', command: '', passRule: 'errors:open(severity>=high)==0', timeout: 30, paths: [] },
    { id: 'chk-review', name: 'review:approved', kind: 'review', command: '', passRule: 'review:all-merged-approved', timeout: 30, paths: [] },
    { id: 'chk-readme', name: 'doc:readme', kind: 'doc', command: '', passRule: 'sections(README.md,[Setup,Usage])', timeout: 30, paths: [] },
  ];
  for (const c of checks) {
    run(`INSERT INTO checks (id, repo_id, name, kind, command, parser, pass_rule, timeout_sec, affected_paths, protected)
         VALUES (?,?,?,?,?,?,?,?,?,0)`,
      c.id, 'repo-demo', c.name, c.kind, c.command, 'auto', c.passRule, c.timeout, JSON.stringify(c.paths));
  }

  const scriptedPlan = {
    dodItems: [
      { id: 'F1', text: 'Converter turns #..###### markdown headings into <h1..h6>', kind: 'feature', checks: ['unit:all'] },
      { id: 'Q1', text: 'Sources parse cleanly (node --check)', kind: 'quality', checks: ['build'] },
      { id: 'Q2', text: 'No open high-or-critical Error Reports', kind: 'quality', checks: ['errors:open(severity>=high)==0'] },
      { id: 'R1', text: 'Every merged task approved by a different agent', kind: 'review', checks: ['review:all-merged-approved'] },
      { id: 'D1', text: 'README documents Setup and Usage', kind: 'docs', checks: ['doc:readme'] },
    ],
    tasks: [
      {
        key: 'T1', title: 'Implement markdown heading converter + tests', type: 'feature', priority: 1, difficulty: 2,
        dependsOn: [], dodItemIds: ['F1', 'Q1'], budgetUsd: 5,
        acceptanceCriteria: ['convert() maps #..###### to h1..h6', 'node --test passes'],
        affectedPaths: ['src/', 'test/'],
        meta: {
          failFirst: true,
          buggyFiles: { 'src/convert.js': BUGGY_CONVERT, 'src/cli.js': CLI_JS, 'test/convert.test.js': TEST_JS },
          fixFiles: { 'src/convert.js': FIXED_CONVERT },
          files: { 'src/convert.js': FIXED_CONVERT, 'src/cli.js': CLI_JS, 'test/convert.test.js': TEST_JS },
        },
      },
      {
        key: 'T2', title: 'Write README with Setup and Usage', type: 'docs', priority: 2, difficulty: 1,
        dependsOn: [], dodItemIds: ['D1'], budgetUsd: 2,
        acceptanceCriteria: ['README.md exists with Setup and Usage sections'],
        affectedPaths: ['README.md'],
        meta: { files: { 'README.md': README } },
      },
    ],
    notes: 'scripted bootstrap plan',
  };

  const mkAgent = (id: string, name: string, avatar: string, script: Record<string, unknown>, instructions: string, observability = 'actions') => {
    run(`INSERT INTO agents (id, name, avatar, account_id, model_id, settings, instructions, caps, observability, status)
         VALUES (?,?,?,?,?,?,?,?,?,'idle')`,
      id, name, avatar, 'acct-scripted', 'local-office:scripted-1',
      JSON.stringify({ script }), instructions,
      JSON.stringify({ perTaskUsd: 10, perDayUsd: 50, maxTokensPerCall: 128000 }), observability);
  };

  mkAgent('ag-pm', 'Ada (PM)', '🧭', { plan: scriptedPlan }, 'You are the Planner agent.');
  mkAgent('ag-dev', 'Dev (Developer)', '🛠️', {}, 'You are the Developer agent.');
  mkAgent('ag-rev', 'Rey (Reviewer)', '🔎', { review: { decision: 'approve', notes: 'LGTM — matches acceptance criteria.' } }, 'You are the Reviewer agent.');
  mkAgent('ag-an', 'Ana (Analyst)', '🩺', {}, 'You are the Prompt & Error Analyst.');
  mkAgent('ag-doc', 'Doc (Writer)', '✍️', {}, 'You are the Documentation Writer.');

  const mkMembership = (agentId: string, roleId: string) =>
    run(`INSERT INTO memberships (id, agent_id, workspace_id, role_id, active_since, max_concurrent_tasks, active)
         VALUES (?,?,?,?,?,1,1)`, ulid(), agentId, wsId, roleId, now());
  mkMembership('ag-pm', 'role-pm');
  mkMembership('ag-dev', 'role-dev');
  mkMembership('ag-rev', 'role-reviewer');
  mkMembership('ag-an', 'role-analyst');
  mkMembership('ag-doc', 'role-docs');

  ensureIntegration({ id: 'repo-demo', workspaceId: wsId, path: repoPath, remoteUrl: null, defaultBranch: 'main', integrationBranch: 'integration', buildCmd: '', testCmd: '', checkProfileId: null });
  console.log('[seed] demo workspace ready — repo at', repoPath);
}

if (process.argv[1] && process.argv[1].endsWith('seed.ts')) {
  const { loadConfig } = await import('./config.ts');
  seedIfEmpty(loadConfig());
}
