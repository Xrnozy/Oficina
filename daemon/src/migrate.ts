import { relinkSkillContent } from './services/skills.ts';
import { q1, run } from './db.ts';
import { now, ulid } from './util.ts';
import { PM_ROLE, PROMPT_ROLE, QA_ROLE } from './seed.ts';

// Idempotent upgrades for databases created by earlier versions: the Prompt
// Creator role, the coordinator-only PM role, and — in the scripted demo
// workspace only — a Prompt Creator agent plus a demo team message.

// Earlier built-in PM definitions; a role still on one of these was never
// customised by the owner and is upgraded to the current orchestrator-only PM.
const OLD_PM_INSTRUCTIONS = [
  'You are the Planner. Propose DoD items with executable checks and a validated task graph. Never write code.',
  'You are the Project Manager. You plan, delegate, review prompts and document decisions. You never write, modify, inspect or validate code and never do QA — developers, reviewers, testers and QA agents do that.',
  'You are the Project Manager. You orchestrate the AI company: create tasks and prompts, assign them to the right specialist, coordinate hand-offs and track progress. You never write, modify, review, test or validate code — and never inspect it to judge it. Developers implement and self-check, QA tests, reviewers review, analysts diagnose failures. Describe WHAT must be achieved and how it is accepted, never HOW to code it.',
];

// Earlier built-in QA definitions (the tester used to write tests itself).
const OLD_QA_INSTRUCTIONS = [
  'Write acceptance tests from DoD items, never from the implementation. Do not edit src/**.',
  'You own testing: write and run acceptance tests from DoD items, never from the implementation, and report what passed. Do not edit src/**.',
  'You are the tester. For each delivery, build it and run the tests, check the acceptance criteria, and look for errors, regressions and quality problems. Report pass or fail with evidence. Never edit, create or delete code or tests — the developer fixes what you find.',
];

// Skill versions imported before their content was stored are found again by
// exact content hash in the usual skill folders (best effort, never fatal).
function relinkSkills(): void {
  try { relinkSkillContent(); } catch { /* not fatal */ }
}

// One workflow node, one persistent session: agents saved with the earlier defaults (an additional session when busy,
// a new one after 30 tasks — the agent form stored them even when nobody chose them) get the new ones once. A value the
// owner sets afterwards is kept: the flag makes this run a single time.
function sessionDefaultsOnce(): void {
  run('CREATE TABLE IF NOT EXISTS app_flags (name TEXT PRIMARY KEY, at TEXT)');
  if (q1(`SELECT 1 FROM app_flags WHERE name = 'cli-session-node-defaults'`)) return;
  run(`UPDATE agents SET settings = json_set(settings, '$.cliSession.whenBusy', 'wait', '$.cliSession.rotateAfter', 0)
       WHERE json_valid(settings) AND json_extract(settings, '$.cliSession.whenBusy') = 'new' AND json_extract(settings, '$.cliSession.rotateAfter') = 30`);
  run(`INSERT INTO app_flags (name, at) VALUES ('cli-session-node-defaults', ?)`, now());
}

export function migrate(): void {
  relinkSkills();
  sessionDefaultsOnce();
  const qa = q1('SELECT * FROM roles WHERE id = ?', QA_ROLE.id);
  if (qa && OLD_QA_INSTRUCTIONS.includes(qa.default_instructions as string)) {
    run('UPDATE roles SET responsibilities = ?, allowed_actions = ?, default_instructions = ?, version = version + 1 WHERE id = ?',
      JSON.stringify(QA_ROLE.responsibilities), JSON.stringify(QA_ROLE.allowedActions), QA_ROLE.instructions, QA_ROLE.id);
  }
  if (!q1('SELECT id FROM roles WHERE name = ?', PROMPT_ROLE.name)) {
    run(`INSERT INTO roles (id, name, version, responsibilities, allowed_actions, default_instructions, default_skills) VALUES (?,?,1,?,?,?,'[]')`,
      PROMPT_ROLE.id, PROMPT_ROLE.name, JSON.stringify(PROMPT_ROLE.responsibilities), JSON.stringify(PROMPT_ROLE.allowedActions), PROMPT_ROLE.instructions);
  }
  // only replace the PM definition if the owner never customised it
  const pm = q1('SELECT * FROM roles WHERE id = ?', PM_ROLE.id);
  if (pm && OLD_PM_INSTRUCTIONS.includes(pm.default_instructions as string)) {
    run('UPDATE roles SET responsibilities = ?, allowed_actions = ?, default_instructions = ?, version = version + 1 WHERE id = ?',
      JSON.stringify(PM_ROLE.responsibilities), JSON.stringify(PM_ROLE.allowedActions), PM_ROLE.instructions, PM_ROLE.id);
  }

  const demo = q1(`SELECT id FROM workspaces WHERE id = 'ws-demo'`);
  const scripted = q1(`SELECT id FROM accounts WHERE id = 'acct-scripted'`);
  if (!demo || !scripted) return;
  const roleId = (q1('SELECT id FROM roles WHERE name = ?', PROMPT_ROLE.name)!.id as string);
  if (!q1('SELECT id FROM agents WHERE id = ?', 'ag-prompt')) {
    run(`INSERT INTO agents (id, name, avatar, account_id, model_id, settings, instructions, caps, observability, status)
         VALUES ('ag-prompt','Pia (Prompt Creator)','📝','acct-scripted','local-office:scripted-1',?,?,?,'actions','idle')`,
      JSON.stringify({ script: { omitCriteriaFirst: true } }), 'You are the Prompt Creator agent.',
      JSON.stringify({ perTaskUsd: 10, perDayUsd: 50, maxTokensPerCall: 128000 }));
    run(`INSERT INTO memberships (id, agent_id, workspace_id, role_id, active_since, max_concurrent_tasks, active) VALUES (?,?,?,?,?,2,1)`,
      ulid(), 'ag-prompt', 'ws-demo', roleId, now());
  }
  const dev = q1(`SELECT settings FROM agents WHERE id = 'ag-dev' AND account_id = 'acct-scripted'`);
  if (dev) {
    const s = JSON.parse((dev.settings as string) || '{}');
    if (!s.script?.messages) {
      s.script = { ...(s.script ?? {}), messages: { implement: [{ to: 'reviewer', kind: 'finding', text: 'Heads-up for review: convert() trims heading text and leaves non-heading lines untouched — the tests cover h1–h3 only.' }] } };
      run(`UPDATE agents SET settings = ? WHERE id = 'ag-dev'`, JSON.stringify(s));
    }
  }
}
