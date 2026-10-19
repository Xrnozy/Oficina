// Skills reach an agent only when enabled, approved, stored, attached and
// relevant — and the result says exactly which were applied or skipped.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skills-data-'));
const { run, q1 } = await import('../src/db.ts');
const sk = await import('../src/services/skills.ts');

const ROLE_DEV = 'role-dev-t'; const ROLE_QA = 'role-qa-t';
const forDev = (kind = 'implement', text = 'Add a parser') => sk.skillsFor({ agentId: 'ag-x', roleId: ROLE_DEV, kind, taskText: text });

test('a general skill written by the owner can be attached to several roles and is delivered', () => {
  const { skillId } = sk.createSkill({ name: 'Small diffs', category: 'general', instructions: 'Keep every change minimal and focused.', purpose: 'Reviewable changes', constraints: 'No unrelated refactors' });
  sk.attachSkill({ skillId, roleId: ROLE_DEV });
  sk.attachSkill({ skillId, roleId: ROLE_QA });
  const d = forDev();
  assert.equal(d.applied.length, 1);
  assert.equal(d.applied[0].name, 'Small diffs');
  assert.equal(d.applied[0].method, 'prompt');
  assert.match(d.section, /Keep every change minimal/);
  assert.match(d.section, /## Constraints\nNo unrelated refactors/);
  assert.equal(sk.skillsFor({ agentId: 'other', roleId: ROLE_QA, kind: 'qa', taskText: '' }).applied.length, 1);
  // attaching twice to the same role does not duplicate it
  sk.attachSkill({ skillId, roleId: ROLE_DEV });
  assert.equal(forDev().applied.length, 1);
});

test('relevance: kinds and keywords decide; disabled and unattached skills are reported, not applied', () => {
  const { skillId } = sk.createSkill({ name: 'SQL review', category: 'role', instructions: 'Check every query for injection.', kinds: ['review', 'qa'], keywords: ['sql', 'database'] });
  sk.attachSkill({ skillId, roleId: ROLE_DEV });
  const implement = forDev('implement', 'database migration');
  assert.ok(implement.skipped.some((s) => s.name === 'SQL review' && /not for implement/.test(s.reason)));
  const review = forDev('review', 'Add a parser');
  assert.ok(review.skipped.some((s) => s.name === 'SQL review' && /keywords/.test(s.reason)));
  assert.ok(forDev('review', 'Fix the SQL builder').applied.some((s) => s.name === 'SQL review'));
  run('UPDATE skills SET enabled = 0 WHERE id = ?', skillId);
  assert.ok(forDev('review', 'sql').skipped.some((s) => s.name === 'SQL review' && s.reason === 'disabled'));
  assert.equal(sk.skillsFor({ agentId: 'nobody', roleId: 'role-none', kind: 'implement', taskText: '' }).applied.length, 0);
});

test('imported skills: unreviewed cannot be attached; re-import keeps the approval and stores the content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skill-'));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: tdd\ndescription: test first\n---\nWrite the failing test first.\n');
  const imp = sk.importSkillDir(dir);
  assert.throws(() => sk.attachSkill({ versionId: imp.versionId, roleId: ROLE_DEV }), /unreviewed/);
  run(`UPDATE skill_versions SET review_status = 'approved' WHERE id = ?`, imp.versionId);
  const again = sk.importSkillDir(dir);
  assert.equal(again.versionId, imp.versionId);
  assert.equal(again.unchanged, true);
  sk.attachSkill({ versionId: imp.versionId, roleId: ROLE_DEV });
  assert.ok(forDev().applied.some((s) => s.name === 'tdd'));
});

test('versions imported without content are relinked by exact hash, otherwise reported', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skillroot-'));
  const dir = path.join(root, 'lint-rules'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: lint-rules\n---\nRun the linter before handing off.\n');
  const imp = sk.importSkillDir(dir);
  run(`UPDATE skill_versions SET content = NULL, source_dir = NULL, review_status = 'approved' WHERE id = ?`, imp.versionId);   // as stored by the old importer
  sk.attachSkill({ versionId: imp.versionId, roleId: ROLE_DEV });
  assert.ok(forDev().skipped.some((s) => s.name === 'lint-rules' && /content not stored/.test(s.reason)));
  const r = sk.relinkSkillContent([root]);
  assert.deepEqual(r.linked, ['lint-rules']);
  assert.ok(forDev().applied.some((s) => s.name === 'lint-rules'));
  assert.equal(q1('SELECT source_dir FROM skill_versions WHERE id = ?', imp.versionId).source_dir, dir);
});

test('edit makes a new version that unpinned attachments follow; duplicate and remove', () => {
  const { skillId } = sk.createSkill({ name: 'Docs style', category: 'general', instructions: 'Use short sentences.' });
  sk.attachSkill({ skillId, roleId: ROLE_DEV });
  sk.updateSkill(skillId, { instructions: 'Use short sentences and active voice.' });
  assert.match(forDev().section, /active voice/);
  const copy = sk.duplicateSkill(skillId);
  assert.ok(q1('SELECT name FROM skills WHERE id = ?', copy.skillId).name.startsWith('Docs style (copy'));
  sk.removeSkill(skillId);
  assert.ok(!forDev().applied.some((s) => s.name === 'Docs style'));
});
