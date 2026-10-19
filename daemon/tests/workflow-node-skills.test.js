// Visual routing phase 3b: node-scoped skills. Node refs (stored in the
// version's graph) resolve before agent/role attachments, de-dupe by skill,
// and record their source. Unapproved/missing skills are warned about, not
// delivered. The version graph carries the refs through clone and export.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-nskills-'));
const { q1, run } = await import('../src/db.ts');
const sk = await import('../src/services/skills.ts');
const {
  defaultWorkflowGraph, validateWorkflow, cloneWorkflow, saveWorkflowVersion,
  getWorkflow, getWorkflowVersion, ensureBuiltinWorkflow,
} = await import('../src/services/workflow.ts');

const WS = 'ws-ns'; const ROLE = 'role-dev-ns'; const AGENT = 'ag-ns';
run(`INSERT INTO workspaces (id, name, settings) VALUES (?, 'NS', '{}')`, WS);
// the default graph references these role names — seed them all (id = role-<name>-ns)
for (const r of ['pm', 'prompt-creator', 'developer', 'qa', 'analyst', 'reviewer', 'docs'])
  run(`INSERT INTO roles (id, name) VALUES (?, ?)`, `role-${r}-ns`, r);
run(`INSERT INTO agents (id, name) VALUES (?, 'Ns Agent')`, AGENT);
run(`INSERT INTO memberships (id, agent_id, workspace_id, role_id, active) VALUES ('m-ns', ?, ?, ?, 1)`, AGENT, WS, ROLE);
ensureBuiltinWorkflow(WS);

const forNode = (nodeSkills, extra = {}) => sk.skillsFor({ agentId: AGENT, roleId: ROLE, kind: 'implement', taskText: 'add a parser', nodeSkills, ...extra });
const mk = (name, instructions, extra = {}) => sk.createSkill({ name, instructions, ...extra }).skillId;

test('no node → unchanged behavior (role attachment delivered, via=role)', () => {
  const id = mk('Plain role skill', 'Always write small commits.');
  sk.attachSkill({ skillId: id, roleId: ROLE });
  const d = forNode();
  const a = d.applied.find((x) => x.name === 'Plain role skill');
  assert.ok(a); assert.equal(a.via, 'role');
});

test('node skills come first under the budget and record via=node; dedupe by skill', () => {
  const roleBig = mk('Role big', 'x'.repeat(14000));           // ~14k — fits alone
  const nodeSmall = mk('Node small', 'y'.repeat(4000));        // ~4k — fits alone
  sk.attachSkill({ skillId: roleBig, roleId: ROLE });
  sk.attachSkill({ skillId: nodeSmall, roleId: ROLE });        // same skill on the role too
  const d = forNode([{ skillId: nodeSmall, name: 'Node small' }]);
  const node = d.applied.find((x) => x.name === 'Node small');
  assert.ok(node); assert.equal(node.via, 'node');
  // deduped — appears once, sourced from the node (node wins over role)
  assert.equal(d.applied.filter((x) => x.name === 'Node small').length, 1);
  // 4k + 14k > 16k budget: resolved node-first, the role skill is the one skipped.
  // (Role-first ordering would apply Role big and skip Node small instead.)
  assert.ok(d.skipped.some((s) => s.name === 'Role big' && /budget/.test(s.reason)), JSON.stringify(d.skipped));
});

test('node order matters: refs are resolved in the order the node lists them', () => {
  const a = mk('Node A', 'alpha '.repeat(1200));   // ~8.4k
  const b = mk('Node B', 'beta '.repeat(1200));    // ~6k — fits after A
  const c = mk('Node C', 'gamma '.repeat(1400));   // ~9.8k — does not fit after A+B
  const d = forNode([{ skillId: a, name: 'Node A' }, { skillId: b, name: 'Node B' }, { skillId: c, name: 'Node C' }]);
  const names = d.applied.map((x) => x.name);
  assert.ok(names.includes('Node A') && names.includes('Node B'), JSON.stringify(names));
  assert.ok(d.skipped.some((s) => s.name === 'Node C' && /budget/.test(s.reason)));
  assert.ok(d.used <= d.budget);
});

test('skillsOnly excludes agent/role skills — reported as skipped with the reason', () => {
  const inherited = mk('Inherited only', 'Inherited text.');
  const own = mk('Own node skill', 'Node text.');
  sk.attachSkill({ skillId: inherited, agentId: AGENT });
  const d = forNode([{ skillId: own, name: 'Own node skill' }], { inheritSkills: false });
  assert.ok(d.applied.some((x) => x.name === 'Own node skill' && x.via === 'node'));
  assert.ok(d.skipped.some((s) => s.name === 'Inherited only' && /node skills only/.test(s.reason) && s.via === 'agent'));
});

test('an imported-but-unapproved skill ref is skipped at dispatch and warned at validate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-nskill-'));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: imported-tdd\n---\nWrite the failing test first.\n');
  const imp = sk.importSkillDir(dir);              // stays 'unreviewed'
  const d = forNode([{ skillId: imp.skillId, name: 'imported-tdd' }]);
  assert.ok(d.skipped.some((s) => s.name === 'imported-tdd' && /no approved version/.test(s.reason) && s.via === 'node'));
  // validator warns — it is not a hard error
  const g = defaultWorkflowGraph();
  const dev = g.nodes.find((x) => x.role === 'developer' && x.config?.purpose === 'implement');
  dev.config = { ...dev.config, skills: [{ skillId: imp.skillId, name: 'imported-tdd' }] };
  const issues = validateWorkflow(g, WS);
  assert.ok(issues.some((i) => i.level === 'warning' && i.nodeId === dev.id && /waiting for approval/.test(i.message)), JSON.stringify(issues));
});

test('unknown and disabled skill refs warn at validate but do not break the graph', () => {
  const dead = mk('Dead skill', 'never delivered');
  run('UPDATE skills SET enabled = 0 WHERE id = ?', dead);
  const g = defaultWorkflowGraph();
  const dev = g.nodes.find((x) => x.role === 'developer' && x.config?.purpose === 'implement');
  dev.config = { ...dev.config, skills: [{ skillId: 'sk-missing', name: 'ghost-skill' }, { skillId: dead, name: 'Dead skill' }] };
  const issues = validateWorkflow(g, WS);
  assert.ok(!issues.some((i) => i.level === 'error'));
  assert.ok(issues.some((i) => /not in this office/.test(i.message)));
  assert.ok(issues.some((i) => /disabled/.test(i.message)));
});

test('node skill refs ride in the version graph — clone and reload keep them', () => {
  const c = cloneWorkflow(q1('SELECT id FROM workflows WHERE builtin = 1 AND workspace_id = ?', WS).id, 'with skills');
  const g = getWorkflow(c.workflowId).graph;
  const dev = g.nodes.find((x) => x.role === 'developer' && x.config?.purpose === 'implement');
  dev.config = { ...dev.config, skills: [{ skillId: 'sk-a', name: 'A' }, { skillId: 'sk-b', name: 'B', versionId: 'v-b' }] };
  const saved = saveWorkflowVersion(c.workflowId, g, 'attach skills');
  assert.ok(saved.version);
  const reloaded = getWorkflowVersion(saved.version.id).graph;
  const d = reloaded.nodes.find((x) => x.id === dev.id);
  assert.deepEqual(d.config.skills, dev.config.skills);
  // clone of this workflow carries the refs too
  const c2 = cloneWorkflow(c.workflowId, 'copy2');
  const d2 = getWorkflow(c2.workflowId).graph.nodes.find((x) => x.id === dev.id);
  assert.deepEqual(d2.config.skills, dev.config.skills);
});
