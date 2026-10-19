import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { q, q1, run } from '../db.ts';
import { emit } from '../bus.ts';
import { now, parseJson, sha256, ulid } from '../util.ts';
import type { WorkItemKind } from '../types.ts';

// Skills: imported (SKILL.md folders, quarantine-scanned and reviewed) or
// written by the owner (general or role-specific). A skill reaches an agent
// only when it is enabled, has an approved version WITH content, and is
// attached to the agent or its role — and then only when it is relevant to
// the work item (manifest kinds/keywords). Delivery is through the prompt,
// which every provider supports; what was applied is recorded per work item.

export interface SkillManifest {
  kinds?: WorkItemKind[];   // only for these kinds of work (default: all)
  keywords?: string[];      // only when the task mentions one of these (default: always)
  purpose?: string; useCases?: string; constraints?: string; expectedOutput?: string;
}

// ------------------------------------------------------------ import

export function scanSkillFile(name: string, content: string): string[] {
  const findings: string[] = [];
  const checks: [RegExp, string][] = [
    [/\b(fetch|axios|curl|wget|requests\.get|http\.request)\b/, 'network call'],
    [/\b(exec|spawn|subprocess|os\.system|child_process|eval\()\b/, 'shell/process spawn'],
    [/ignore (all |previous )?instructions|disregard (all |previous )?instructions/i, 'possible prompt injection'],
    [/api[_-]?key|secret|password|token/i, 'references secrets/credentials'],
    [/[A-Za-z0-9+/]{200,}={0,2}/, 'large base64-like blob'],
  ];
  for (const [re, why] of checks) if (re.test(content)) findings.push(`${name}: ${why}`);
  return findings;
}

export function hasSkillMd(dir: string): boolean {
  try { return fs.readdirSync(dir).some((f) => /^skill\.md$/i.test(f)); } catch { return false; }
}

// find skill folders under a parent dir — direct children first, then one
// level deeper, capped so a stray giant folder can't hang the request
export function findSkillDirs(root: string, depth = 0, found: string[] = []): string[] {
  if (depth > 2 || found.length > 200) return found;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return found; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    const sub = path.join(root, e.name);
    if (hasSkillMd(sub)) found.push(sub);
    else findSkillDirs(sub, depth + 1, found);
  }
  return found;
}

function readSkillDir(dir: string): { files: { path: string; sha256: string; size: number }[]; findings: string[]; hash: string; md: string } {
  const skillMdFile = fs.readdirSync(dir).find((f) => /^skill\.md$/i.test(f));
  if (!skillMdFile) throw new Error('no SKILL.md found');
  const files: { path: string; sha256: string; size: number }[] = [];
  const findings: string[] = [];
  const walk = (d: string, base: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel);
      else {
        const content = fs.readFileSync(path.join(d, e.name));
        files.push({ path: rel, sha256: sha256(content), size: content.length });
        findings.push(...scanSkillFile(rel, content.toString('utf8')));
      }
    }
  };
  walk(dir, '');
  return { files, findings, hash: sha256(files.map((f) => f.sha256).join('')), md: fs.readFileSync(path.join(dir, skillMdFile), 'utf8') };
}

function frontmatter(md: string): Record<string, string> {
  const fm = md.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string> = {};
  for (const line of fm?.[1].split('\n') ?? []) { const m = line.match(/^(\w[\w-]*):\s*(.*)$/); if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); }
  return out;
}

export function importSkillDir(dir: string): { skillId: string; versionId: string; name: string; findings: string[]; unchanged?: boolean } {
  const { files, findings, hash, md } = readSkillDir(dir);
  const fm = frontmatter(md);
  const name = fm.name || path.basename(dir);
  const description = fm.description ?? '';
  const manifest = fs.existsSync(path.join(dir, 'office.skill.yaml'))
    ? parseJson(JSON.stringify(fs.readFileSync(path.join(dir, 'office.skill.yaml'), 'utf8')), {})
    : {};
  let skill = q1('SELECT * FROM skills WHERE name = ?', name);
  if (!skill) {
    run('INSERT INTO skills (id, name, description, owner_origin, enabled, category, updated_at) VALUES (?,?,?,?,1,?,?)', ulid(), name, description, 'imported', 'role', now());
    skill = q1('SELECT * FROM skills WHERE name = ?', name);
  }
  // same content already imported: keep that version (and its review) — just store what it was missing
  const same = q1('SELECT id FROM skill_versions WHERE skill_id = ? AND content_hash = ?', skill!.id as string, hash);
  if (same) {
    run('UPDATE skill_versions SET content = COALESCE(content, ?), source_dir = ? WHERE id = ?', md, dir, same.id);
    return { skillId: skill!.id as string, versionId: same.id as string, name, findings, unchanged: true };
  }
  const versionId = ulid();
  run(`INSERT INTO skill_versions (id, skill_id, semver, content_hash, manifest, review_status, created_at, files, content, source_dir)
       VALUES (?,?,?,?,?,'unreviewed',?,?,?,?)`,
    versionId, skill!.id as string, `1.0.${(q1('SELECT COUNT(*) c FROM skill_versions WHERE skill_id = ?', skill!.id as string)?.c as number) ?? 0}`,
    hash, JSON.stringify(manifest), now(), JSON.stringify(files), md, dir);
  run('UPDATE skills SET latest_version_id = ?, description = COALESCE(NULLIF(?, \'\'), description), updated_at = ? WHERE id = ?', versionId, description, now(), skill!.id as string);
  emit('skill.imported', 'owner', { skill: name, versionId, findings: findings.length });
  return { skillId: skill!.id as string, versionId, name, findings };
}

// Versions imported before content was stored: find their folder again by
// exact content hash in the usual skill locations (or a folder you give).
export function relinkSkillContent(extraRoots: string[] = []): { linked: string[]; missing: string[] } {
  const home = os.homedir();
  const roots = [...extraRoots, path.join(home, '.claude', 'skills'), path.join(home, '.cursor', 'skills'), path.join(home, '.codex', 'skills'),
    path.join(home, '.agents', 'skills'), path.join(home, 'skills'), path.join(process.cwd(), 'skills')];
  const need = q(`SELECT v.id, v.content_hash, s.name FROM skill_versions v JOIN skills s ON s.id = v.skill_id WHERE v.content IS NULL AND s.owner_origin = 'imported'`);
  if (!need.length) return { linked: [], missing: [] };
  const byHash = new Map<string, string>();
  for (const root of roots) {
    for (const dir of [...(hasSkillMd(root) ? [root] : []), ...findSkillDirs(root)]) {
      try { const r = readSkillDir(dir); if (!byHash.has(r.hash)) byHash.set(r.hash, dir); } catch { /* unreadable */ }
    }
  }
  const linked: string[] = []; const missing: string[] = [];
  for (const v of need) {
    const dir = byHash.get(v.content_hash as string);
    if (!dir) { missing.push(v.name as string); continue; }
    run('UPDATE skill_versions SET content = ?, source_dir = ? WHERE id = ?', readSkillDir(dir).md, dir, v.id);
    linked.push(v.name as string);
  }
  if (linked.length) emit('skill.relinked', 'engine', { linked, missing });
  return { linked, missing };
}

// ------------------------------------------------------------ authored skills

export interface SkillDraft {
  name: string; description?: string; category?: 'general' | 'role';
  instructions: string; purpose?: string; useCases?: string; constraints?: string; expectedOutput?: string;
  kinds?: WorkItemKind[]; keywords?: string[];
}

function renderSkillMd(d: SkillDraft): string {
  const parts = [`---\nname: ${d.name}\ndescription: ${(d.description ?? d.purpose ?? '').replace(/\n/g, ' ')}\n---`, `# ${d.name}`];
  if (d.purpose) parts.push(`## Purpose\n${d.purpose}`);
  if (d.useCases) parts.push(`## When to use\n${d.useCases}`);
  parts.push(`## Instructions\n${d.instructions}`);
  if (d.constraints) parts.push(`## Constraints\n${d.constraints}`);
  if (d.expectedOutput) parts.push(`## Expected output\n${d.expectedOutput}`);
  return parts.join('\n\n') + '\n';
}

function validDraft(d: SkillDraft): string | null {
  if (!d?.name?.trim()) return 'name is required';
  if (!/^[\w .:()'-]{1,80}$/.test(d.name.trim())) return "name: letters, numbers, spaces and . : ( ) ' - _ only (max 80)";
  if (!d.instructions?.trim()) return 'instructions are required';
  return null;
}

/** Create a skill you wrote; your own text needs no quarantine review. */
export function createSkill(d: SkillDraft): { skillId: string; versionId: string } {
  const problem = validDraft(d);
  if (problem) throw new Error(problem);
  if (q1('SELECT id FROM skills WHERE name = ?', d.name.trim())) throw new Error(`a skill named "${d.name.trim()}" already exists`);
  const skillId = ulid();
  run('INSERT INTO skills (id, name, description, owner_origin, enabled, category, updated_at) VALUES (?,?,?,?,1,?,?)',
    skillId, d.name.trim(), d.description ?? d.purpose ?? '', 'owner', d.category === 'general' ? 'general' : 'role', now());
  const versionId = addAuthoredVersion(skillId, d);
  emit('skill.created', 'owner', { skillId, name: d.name.trim(), category: d.category ?? 'role' });
  return { skillId, versionId };
}

function addAuthoredVersion(skillId: string, d: SkillDraft): string {
  const md = renderSkillMd({ ...d, name: d.name.trim() });
  const manifest: SkillManifest = { kinds: d.kinds?.length ? d.kinds : undefined, keywords: d.keywords?.filter(Boolean).length ? d.keywords.filter(Boolean) : undefined,
    purpose: d.purpose, useCases: d.useCases, constraints: d.constraints, expectedOutput: d.expectedOutput };
  const versionId = ulid();
  const n = (q1('SELECT COUNT(*) c FROM skill_versions WHERE skill_id = ?', skillId)?.c as number) ?? 0;
  run(`INSERT INTO skill_versions (id, skill_id, semver, content_hash, manifest, review_status, reviewed_at, review_notes, created_at, files, content)
       VALUES (?,?,?,?,?,'approved',?,?,?,'[]',?)`, versionId, skillId, `1.0.${n}`, sha256(md), JSON.stringify({ ...manifest, instructions: d.instructions }), now(), 'written by the owner', now(), md);
  run('UPDATE skills SET latest_version_id = ?, updated_at = ? WHERE id = ?', versionId, now(), skillId);
  // attachments that follow the latest version keep working; pinned ones stay pinned
  return versionId;
}

/** Edit: a new version (imported skills get an owner-written version too). */
export function updateSkill(skillId: string, d: Partial<SkillDraft> & { instructions?: string }): { versionId: string | null } {
  const s = q1('SELECT * FROM skills WHERE id = ?', skillId);
  if (!s) throw new Error('skill not found');
  if (d.name && d.name.trim() !== s.name) {
    if (q1('SELECT id FROM skills WHERE name = ? AND id != ?', d.name.trim(), skillId)) throw new Error(`a skill named "${d.name.trim()}" already exists`);
    run('UPDATE skills SET name = ? WHERE id = ?', d.name.trim(), skillId);
  }
  if (d.description != null) run('UPDATE skills SET description = ? WHERE id = ?', d.description, skillId);
  if (d.category) run('UPDATE skills SET category = ? WHERE id = ?', d.category === 'general' ? 'general' : 'role', skillId);
  let versionId: string | null = null;
  if (d.instructions != null || d.kinds || d.keywords || d.purpose != null || d.useCases != null || d.constraints != null || d.expectedOutput != null) {
    const cur = latestApproved(skillId);
    const m = parseJson<SkillManifest & { instructions?: string }>(cur?.manifest as string, {});
    const draft: SkillDraft = {
      name: (d.name ?? s.name) as string, description: (d.description ?? s.description) as string,
      instructions: d.instructions ?? m.instructions ?? String(cur?.content ?? ''),
      purpose: d.purpose ?? m.purpose, useCases: d.useCases ?? m.useCases, constraints: d.constraints ?? m.constraints,
      expectedOutput: d.expectedOutput ?? m.expectedOutput, kinds: d.kinds ?? m.kinds, keywords: d.keywords ?? m.keywords,
    };
    const problem = validDraft(draft);
    if (problem) throw new Error(problem);
    versionId = addAuthoredVersion(skillId, draft);
  }
  run('UPDATE skills SET updated_at = ? WHERE id = ?', now(), skillId);
  emit('skill.updated', 'owner', { skillId, versionId });
  return { versionId };
}

export function duplicateSkill(skillId: string, name?: string): { skillId: string; versionId: string } {
  const s = q1('SELECT * FROM skills WHERE id = ?', skillId);
  const v = latestApproved(skillId) ?? q1('SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY created_at DESC LIMIT 1', skillId);
  if (!s || !v) throw new Error('skill not found');
  const m = parseJson<SkillManifest & { instructions?: string }>(v.manifest as string, {});
  let copy = name?.trim() || `${s.name} (copy)`;
  for (let i = 2; q1('SELECT id FROM skills WHERE name = ?', copy); i++) copy = `${s.name} (copy ${i})`;
  return createSkill({ name: copy, description: s.description as string, category: (s.category as 'general' | 'role') ?? 'general',
    instructions: m.instructions ?? String(v.content ?? ''), purpose: m.purpose, useCases: m.useCases, constraints: m.constraints, expectedOutput: m.expectedOutput, kinds: m.kinds, keywords: m.keywords });
}

export function removeSkill(skillId: string): void {
  const vs = q('SELECT id FROM skill_versions WHERE skill_id = ?', skillId).map((v) => v.id as string);
  for (const v of vs) run('DELETE FROM skill_attachments WHERE skill_version_id = ?', v);
  run('DELETE FROM skill_versions WHERE skill_id = ?', skillId);
  run('DELETE FROM skills WHERE id = ?', skillId);
  emit('skill.removed', 'owner', { skillId });
}

// ------------------------------------------------------------ attachments

function latestApproved(skillId: string): Record<string, unknown> | undefined {
  return q1(`SELECT * FROM skill_versions WHERE skill_id = ? AND review_status = 'approved' ORDER BY created_at DESC, rowid DESC LIMIT 1`, skillId);
}

/**
 * Attach a skill to a role or an agent. Unpinned attachments follow the
 * latest approved version; pinned ones keep the exact version.
 */
export function attachSkill(opts: { skillId?: string; versionId?: string; roleId?: string; agentId?: string; pinned?: boolean }): { id: string } {
  if (!opts.roleId && !opts.agentId) throw new Error('attach to a roleId or an agentId');
  const v = opts.versionId ? q1('SELECT * FROM skill_versions WHERE id = ?', opts.versionId) : latestApproved(opts.skillId ?? '');
  if (!v) throw new Error(opts.versionId ? 'skill version not found' : 'this skill has no approved version yet — approve it first');
  if (v.review_status !== 'approved') throw new Error(`version ${v.semver} is ${v.review_status} — approve it before attaching`);
  const target = opts.roleId ? { roleId: opts.roleId } : { agentId: opts.agentId };
  const dup = q('SELECT a.id, a.skill_version_id FROM skill_attachments a JOIN skill_versions v ON v.id = a.skill_version_id WHERE v.skill_id = ? AND a.target = ?', v.skill_id, JSON.stringify(target));
  if (dup.length) {
    run('UPDATE skill_attachments SET skill_version_id = ?, pinned = ? WHERE id = ?', v.id, opts.pinned ? 1 : 0, dup[0].id);
    return { id: dup[0].id as string };
  }
  const id = ulid();
  run('INSERT INTO skill_attachments (id, skill_version_id, target, pinned) VALUES (?,?,?,?)', id, v.id, JSON.stringify(target), opts.pinned ? 1 : 0);
  emit('skill.attached', 'owner', { attachmentId: id, versionId: v.id, ...target });
  return { id };
}

export function detachSkill(attachmentId: string): void {
  run('DELETE FROM skill_attachments WHERE id = ?', attachmentId);
  emit('skill.detached', 'owner', { attachmentId });
}

// ------------------------------------------------------------ loading

export interface AppliedSkill { skillId: string; name: string; version: string; versionId: string; chars: number; method: 'prompt'; via: 'role' | 'agent' }
export interface SkippedSkill { name: string; reason: string }

const SKILL_BUDGET = 16000; // characters of skill text per prompt

/** The skills that apply to this agent/role for this work, rendered for the prompt. */
export function skillsFor(opts: { agentId: string; roleId: string | null; kind: WorkItemKind; taskText: string }): { section: string; applied: AppliedSkill[]; skipped: SkippedSkill[] } {
  const atts = q(`SELECT a.*, v.skill_id FROM skill_attachments a JOIN skill_versions v ON v.id = a.skill_version_id`)
    .map((a) => ({ skill_id: a.skill_id as string, skill_version_id: a.skill_version_id as string, pinned: a.pinned as number, target: parseJson<{ roleId?: string; agentId?: string }>(a.target as string, {}) }))
    .filter((a) => (opts.roleId && a.target.roleId === opts.roleId) || a.target.agentId === opts.agentId);
  const applied: AppliedSkill[] = []; const skipped: SkippedSkill[] = [];
  const blocks: string[] = [];
  let used = 0;
  const seen = new Set<string>();
  const text = opts.taskText.toLowerCase();
  // agent-specific attachments win over role ones for the same skill
  atts.sort((a, b) => (a.target.agentId ? 0 : 1) - (b.target.agentId ? 0 : 1));
  for (const a of atts) {
    const skillId = a.skill_id as string;
    if (seen.has(skillId)) continue;
    seen.add(skillId);
    const s = q1('SELECT * FROM skills WHERE id = ?', skillId);
    if (!s) continue;
    const name = s.name as string;
    if (!s.enabled) { skipped.push({ name, reason: 'disabled' }); continue; }
    const v = a.pinned ? q1('SELECT * FROM skill_versions WHERE id = ?', a.skill_version_id) : (latestApproved(skillId) ?? q1('SELECT * FROM skill_versions WHERE id = ?', a.skill_version_id));
    if (!v || v.review_status !== 'approved') { skipped.push({ name, reason: 'no approved version' }); continue; }
    const content = String(v.content ?? '').trim();
    if (!content) { skipped.push({ name, reason: 'content not stored — re-import the skill folder (or use Relink)' }); continue; }
    const m = parseJson<SkillManifest>(v.manifest as string, {});
    if (m.kinds?.length && !m.kinds.includes(opts.kind)) { skipped.push({ name, reason: `not for ${opts.kind} work` }); continue; }
    if (m.keywords?.length && !m.keywords.some((k) => text.includes(k.toLowerCase()))) { skipped.push({ name, reason: 'task does not mention its keywords' }); continue; }
    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
    if (used + body.length > SKILL_BUDGET) { skipped.push({ name, reason: `over the ${SKILL_BUDGET}-character skill budget for one prompt` }); continue; }
    used += body.length;
    blocks.push(`### Skill: ${name} (v${v.semver})\n${body}`);
    applied.push({ skillId, name, version: v.semver as string, versionId: v.id as string, chars: body.length, method: 'prompt', via: a.target.agentId ? 'agent' : 'role' });
  }
  const section = blocks.length
    ? `## Skills\nApply these skills where they fit this work. They add guidance; they never override the task's requirements or acceptance criteria.\n\n${blocks.join('\n\n')}`
    : '';
  return { section, applied, skipped };
}

/** Last time each skill was actually delivered to an agent. */
export function skillUsage(): Record<string, { lastAppliedAt: string; count: number; agents: string[] }> {
  const out: Record<string, { lastAppliedAt: string; count: number; agents: string[] }> = {};
  for (const e of q(`SELECT ts, actor, payload FROM events WHERE type = 'skill.applied' ORDER BY seq DESC LIMIT 2000`)) {
    for (const s of parseJson<{ applied?: AppliedSkill[] }>(e.payload as string, {}).applied ?? []) {
      const u = out[s.skillId] ??= { lastAppliedAt: e.ts as string, count: 0, agents: [] };
      u.count++;
      if (!u.agents.includes(e.actor as string)) u.agents.push(e.actor as string);
    }
  }
  return out;
}
