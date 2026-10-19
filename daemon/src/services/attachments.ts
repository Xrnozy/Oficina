import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, q, q1, run } from '../db.ts';
import { emit } from '../bus.ts';
import { now, parseJson, sha256, ulid } from '../util.ts';
import { postMessage } from './messages.ts';
import { setOwnPathProvider } from './snapshot.ts';

// Reference files and task attachments, handed to agents as a short manifest (name, kind, one-line summary, path):
// an agent opens only what its work needs, so a long reference never costs tokens until it is actually read.
//
// Four audiences keep the relationship between a file and who needs it explicit:
//   project - every agent in the office (with run_id set, only that run)      -> documents/all-agents/
//   role    - every agent acting in one role (pm, developer, reviewer, ...)   -> documents/pm/, documents/dev/, ...
//   agent   - one agent's own references                                      -> documents/agents/<name>/
//   task    - attached to one task; only the agents working it see it         -> the daemon's data folder
//
// Reference files (everything but task attachments) live in the repository's `documents/` folder, arranged by
// audience, so the owner can see, version and edit them like any other file. They are written without ever
// overwriting a file the office did not put there, and are kept out of every task's change set, checkpoint and
// commit (see setOwnPathProvider).

export type AttachScope = 'project' | 'role' | 'agent' | 'task';
export type AttachKind = 'markdown' | 'text' | 'code' | 'image' | 'document' | 'data';

export interface Attachment {
  id: string; workspaceId: string; runId: string | null; scope: AttachScope; role: string | null; agentId: string | null; taskId: string | null;
  itemRef: string | null;               // the task work item a file was attached to (w1, w2, ...)
  name: string; mime: string; size: number; sha256: string; kind: AttachKind; summary: string;
  path: string;                         // where the bytes are on disk
  location: string | null;              // path inside the repository (documents/dev/spec.md) when it lives there
  createdAt: string; updatedAt: string;
}

export const DOCS_DIR = 'documents';
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PER_TASK = 30;
export const MAX_PER_OFFICE = 200;
const MANIFEST_MAX_ENTRIES = 40;
const MANIFEST_MAX_CHARS = 4200;

const EXT: Record<string, { kind: AttachKind; mime: string }> = {};
const add = (kind: AttachKind, mime: string, ...exts: string[]) => { for (const e of exts) EXT[e] = { kind, mime }; };
add('markdown', 'text/markdown', 'md', 'markdown', 'mdx');
add('text', 'text/plain', 'txt', 'log', 'rst', 'rtf');
add('data', 'application/json', 'json');
add('data', 'text/yaml', 'yaml', 'yml', 'toml', 'ini', 'env', 'xml');
add('data', 'text/csv', 'csv', 'tsv');
add('code', 'text/plain', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'cs', 'c', 'h', 'cpp', 'hpp', 'php', 'swift',
  'sh', 'bash', 'ps1', 'bat', 'cmd', 'sql', 'html', 'css', 'scss', 'vue', 'svelte', 'dart', 'lua', 'gradle');
add('image', 'image/png', 'png'); add('image', 'image/jpeg', 'jpg', 'jpeg'); add('image', 'image/gif', 'gif');
add('image', 'image/webp', 'webp'); add('image', 'image/svg+xml', 'svg'); add('image', 'image/bmp', 'bmp');
add('document', 'application/pdf', 'pdf');
add('document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx');
add('document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx');
add('document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx');

const legacyRoot = () => path.join(DATA_DIR, 'attachments');

// ---------------------------------------------------------------- audiences and folders

const ROLE_DIR: Record<string, string> = { pm: 'pm', developer: 'dev', reviewer: 'reviewer', qa: 'qa', analyst: 'analyst', docs: 'docs', 'prompt-creator': 'prompt-creator' };
const ROLE_ALIAS: Record<string, string> = { dev: 'developer', developers: 'developer', tester: 'qa', writer: 'docs', 'project-manager': 'pm', manager: 'pm' };
const slug = (s: string) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';

/** 'Dev' / 'developers' / 'developer' all mean the developer role. */
export function normRole(x: unknown): string {
  const k = String(x ?? '').trim().toLowerCase();
  return ROLE_ALIAS[k] ?? k;
}
export const roleFolder = (role: string): string => ROLE_DIR[role] ?? slug(role);

/** The folder (under documents/) an audience's files go to. */
export function folderFor(a: { scope: AttachScope; role?: string | null; agentId?: string | null; runId?: string | null }): string {
  if (a.scope === 'role') return roleFolder(normRole(a.role));
  if (a.scope === 'agent') return `agents/${slug((q1('SELECT name FROM agents WHERE id = ?', a.agentId ?? '')?.name as string) ?? a.agentId ?? 'agent')}`;
  if (a.runId) return `runs/${a.runId.slice(-8).toLowerCase()}`;
  return 'all-agents';
}

const toRow = (r: Record<string, unknown>): Attachment => {
  const p = ((r.path as string | null) ?? '') || path.join(legacyRoot(), r.workspace_id as string, r.id as string, r.name as string);
  const repo = r.repo_id ? (q1('SELECT path FROM repos WHERE id = ?', r.repo_id as string)?.path as string | undefined) : undefined;
  const rel = repo ? path.relative(repo, p).replace(/\\/g, '/') : '';
  return {
    id: r.id as string, workspaceId: r.workspace_id as string, runId: (r.run_id as string | null) ?? null, scope: r.scope as AttachScope,
    role: (r.role as string | null) ?? null, agentId: (r.agent_id as string | null) ?? null, taskId: (r.task_id as string | null) ?? null,
    itemRef: (r.item_ref as string | null) ?? null, name: r.name as string, mime: r.mime as string, size: r.size as number, sha256: r.sha256 as string,
    kind: r.kind as AttachKind, summary: (r.summary as string) ?? '', path: p, location: rel && !rel.startsWith('..') ? rel : null,
    createdAt: r.created_at as string, updatedAt: r.updated_at as string,
  };
};

/** A file name that is safe to keep on disk: no folders, no control characters, no reserved device names. */
export function cleanName(raw: unknown): string {
  let n = String(raw ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  n = n.replace(/[\u0000-\u001f<>:"|?*]/g, '').replace(/^\.+/, '').trim().replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = `_${n}`;
  return n.slice(0, 120);
}

export function classify(name: string): { kind: AttachKind; mime: string } | null {
  const ext = path.extname(name).slice(1).toLowerCase();
  return EXT[ext] ?? null;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// One line to tell an agent whether the file is worth opening: the first heading, else the first real line.
function summarize(kind: AttachKind, buf: Buffer): string {
  if (kind === 'image') return 'image — open the file to look at it';
  if (kind === 'document') return 'document';
  if (looksBinary(buf)) return '';
  const lines = buf.toString('utf8', 0, 8000).split(/\r?\n/);
  const heading = lines.find((l) => /^#{1,3}\s+\S/.test(l));
  const first = heading ?? lines.find((l) => l.trim());
  const text = (first ?? '').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 110);
  const count = buf.toString('utf8').split('\n').length;
  return text ? `${text} (${count} lines)` : `${count} lines`;
}

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export function fileOf(a: Attachment): string { return a.path; }

// An office's runs that are still going: new files announce themselves there.
const LIVE = ['draft', 'dod-review', 'running', 'pausing', 'paused', 'verifying'];
export const liveRunOf = (workspaceId: string): string | null =>
  (q1(`SELECT id FROM runs WHERE workspace_id = ? AND status IN (${LIVE.map(() => '?').join(',')}) ORDER BY rowid DESC LIMIT 1`, workspaceId, ...LIVE)?.id as string | undefined) ?? null;

// ---------------------------------------------------------------- where files go

/** The repository an office's reference files are written into: the run's, else the office's first. */
function repoFor(workspaceId: string, runId: string | null): { id: string; path: string } | null {
  const row = (runId ? q1('SELECT r.id, r.path FROM runs ru JOIN repos r ON r.id = ru.repo_id WHERE ru.id = ?', runId) : null)
    ?? q1('SELECT id, path FROM repos WHERE workspace_id = ? ORDER BY rowid LIMIT 1', workspaceId);
  if (!row) return null;
  try { if (!fs.statSync(row.path as string).isDirectory()) return null; } catch { return null; }
  return { id: row.id as string, path: row.path as string };
}

const norm = (p: string) => path.resolve(p).toLowerCase();

/** A path under documents/<folder>/ that nothing the office owns, and nothing the owner put there, is using. */
function allocate(repoPath: string, folder: string, name: string): { abs: string; name: string } {
  const dir = path.join(repoPath, DOCS_DIR, ...folder.split('/'));
  const owned = new Set(q('SELECT path FROM attachments WHERE path IS NOT NULL').map((r) => norm(r.path as string)));
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  let cand = name;
  for (let n = 2; fs.existsSync(path.join(dir, cand)) || owned.has(norm(path.join(dir, cand))); n++) cand = `${stem} (${n})${ext}`;
  return { abs: path.join(dir, cand), name: cand };
}

function writeFileSafe(abs: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.oficina-tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, abs);
}

// Remove a file and the folders it leaves empty, up to and including documents/ itself (but never above it).
function pruneEmpty(repoPath: string, file: string): void {
  const root = path.join(repoPath, DOCS_DIR);
  let dir = path.dirname(file);
  while (norm(dir).startsWith(norm(root)) && norm(dir) !== norm(path.dirname(root))) {
    try { if (fs.readdirSync(dir).length) break; fs.rmdirSync(dir); } catch { break; }
    dir = path.dirname(dir);
  }
}

// Files the office keeps in a repository never belong to a task: they stay out of every snapshot, change set and commit.
setOwnPathProvider((repoPath) => {
  const root = norm(repoPath);
  const out: string[] = [];
  for (const r of q(`SELECT path FROM attachments WHERE path IS NOT NULL AND scope != 'task'`)) {
    const p = r.path as string;
    if (norm(p).startsWith(root + path.sep.toLowerCase()) || norm(p).startsWith(`${root}/`)) out.push(path.relative(repoPath, p).replace(/\\/g, '/'));
  }
  return out;
});

// ---------------------------------------------------------------- add / replace / remove

export interface AddInput {
  workspaceId: string; scope: AttachScope; name: unknown; data: Buffer;
  agentId?: string | null; taskId?: string | null; runId?: string | null; role?: string | null; itemRef?: string | null; by?: string;
}

export function addAttachment(i: AddInput): { attachment: Attachment; updated: boolean } | { error: string; status: number } {
  if (!q1('SELECT id FROM workspaces WHERE id = ?', i.workspaceId)) return { error: 'office not found', status: 404 };
  if (!['project', 'role', 'agent', 'task'].includes(i.scope)) return { error: 'scope must be project, role, agent or task', status: 400 };
  const name0 = cleanName(i.name);
  if (!name0) return { error: 'the file needs a name', status: 400 };
  const cls = classify(name0);
  if (!cls) return { error: `.${path.extname(name0).slice(1) || '?'} files are not supported — Markdown, text, JSON/YAML/CSV, source and script files, images, PDF and Office documents are`, status: 415 };
  if (!i.data.length) return { error: `${name0} is empty`, status: 400 };
  if (i.data.length > MAX_FILE_BYTES) return { error: `${name0} is ${fmtSize(i.data.length)} — the limit is ${fmtSize(MAX_FILE_BYTES)} per file`, status: 413 };
  // the bytes must match the kind the extension promises (a .md that is really a binary would poison a prompt)
  if (['markdown', 'text', 'code', 'data'].includes(cls.kind) && looksBinary(i.data)) return { error: `${name0} looks like a binary file, not text`, status: 415 };

  let agentId: string | null = null, taskId: string | null = null, runId: string | null = null, role: string | null = null, itemRef: string | null = null;
  if (i.scope === 'agent') {
    if (!i.agentId || !q1('SELECT id FROM agents WHERE id = ?', i.agentId)) return { error: 'agent not found', status: 404 };
    agentId = i.agentId;
  } else if (i.scope === 'role') {
    role = normRole(i.role);
    if (!role || !q1('SELECT id FROM roles WHERE lower(name) = ?', role)) return { error: `unknown role "${String(i.role ?? '')}"`, status: 404 };
  } else if (i.scope === 'task') {
    const t = i.taskId ? q1('SELECT t.id, t.run_id, t.meta, r.workspace_id ws FROM tasks t JOIN runs r ON r.id = t.run_id WHERE t.id = ?', i.taskId) : null;
    if (!t) return { error: 'task not found', status: 404 };
    if (t.ws !== i.workspaceId) return { error: 'that task belongs to another office', status: 400 };
    taskId = t.id as string; runId = t.run_id as string;
    if (i.itemRef) {
      const items = parseJson<{ id: string }[]>(JSON.stringify(parseJson<Record<string, unknown>>(t.meta as string, {}).workItems ?? []), []);
      if (!items.some((w) => w.id === i.itemRef)) return { error: `the task has no work item "${i.itemRef}"`, status: 400 };
      itemRef = i.itemRef;
    }
  } else if (i.runId) {
    const rr = q1('SELECT id FROM runs WHERE id = ? AND workspace_id = ?', i.runId, i.workspaceId);
    if (!rr) return { error: 'run not found in this office', status: 404 };
    runId = i.runId;
  }

  const sha = sha256(i.data.toString('latin1')).slice(0, 32);
  // same name in the same place = an update of that file (references are kept current by re-adding them)
  const same = q(`SELECT * FROM attachments WHERE workspace_id = ? AND scope = ? AND IFNULL(agent_id,'') = ? AND IFNULL(task_id,'') = ? AND IFNULL(run_id,'') = ? AND IFNULL(role,'') = ? AND IFNULL(item_ref,'') = ? AND lower(name) = lower(?)`,
    i.workspaceId, i.scope, agentId ?? '', taskId ?? '', runId ?? '', role ?? '', itemRef ?? '', name0)[0];
  if (same) {
    const cur = toRow(same);
    if (cur.sha256 === sha) return { attachment: cur, updated: false };
    return replaceAttachment(cur.id, i.data, i.by);
  }
  if (taskId && (q1('SELECT COUNT(*) c FROM attachments WHERE task_id = ?', taskId)?.c as number) >= MAX_PER_TASK) return { error: `a task can hold ${MAX_PER_TASK} files — remove one first`, status: 409 };
  if ((q1('SELECT COUNT(*) c FROM attachments WHERE workspace_id = ?', i.workspaceId)?.c as number) >= MAX_PER_OFFICE) return { error: `this office already holds ${MAX_PER_OFFICE} files — remove some first`, status: 409 };

  const id = ulid();
  // where it goes: the repository's documents/<audience>/ for reference files, the data folder for task attachments
  // (and for offices that have no repository yet)
  const repo = i.scope === 'task' ? null : repoFor(i.workspaceId, runId);
  let abs: string, name = name0, repoId: string | null = null;
  if (repo) { const a = allocate(repo.path, folderFor({ scope: i.scope, role, agentId, runId }), name0); abs = a.abs; name = a.name; repoId = repo.id; }
  else abs = path.join(legacyRoot(), i.workspaceId, id, name0);
  try { writeFileSafe(abs, i.data); }
  catch (e) { return { error: `could not store ${name0}: ${String(e).slice(0, 160)}`, status: 500 }; }
  const summary = summarize(cls.kind, i.data);
  try {
    run(`INSERT INTO attachments (id, workspace_id, run_id, scope, role, agent_id, task_id, item_ref, name, mime, size, sha256, kind, summary, path, repo_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, i.workspaceId, runId, i.scope, role, agentId, taskId, itemRef, name, cls.mime, i.data.length, sha, cls.kind, summary, abs, repoId, now(), now());
  } catch (e) {
    try { fs.rmSync(abs, { force: true }); if (repo) pruneEmpty(repo.path, abs); } catch { /* best effort */ }
    return { error: `could not record ${name0}: ${String(e).slice(0, 160)}`, status: 500 };
  }
  const att = toRow(q1('SELECT * FROM attachments WHERE id = ?', id)!);
  announce(att, 'added', i.by);
  return { attachment: att, updated: false };
}

export function replaceAttachment(id: string, data: Buffer, by?: string): { attachment: Attachment; updated: boolean } | { error: string; status: number } {
  const row = q1('SELECT * FROM attachments WHERE id = ?', id);
  if (!row) return { error: 'file not found', status: 404 };
  const cur = toRow(row);
  if (!data.length) return { error: `${cur.name} would be empty`, status: 400 };
  if (data.length > MAX_FILE_BYTES) return { error: `${cur.name} is ${fmtSize(data.length)} — the limit is ${fmtSize(MAX_FILE_BYTES)} per file`, status: 413 };
  if (['markdown', 'text', 'code', 'data'].includes(cur.kind) && looksBinary(data)) return { error: `${cur.name} looks like a binary file, not text`, status: 415 };
  const sha = sha256(data.toString('latin1')).slice(0, 32);
  try { writeFileSafe(fileOf(cur), data); } catch (e) { return { error: `could not update ${cur.name}: ${String(e).slice(0, 160)}`, status: 500 }; }
  run('UPDATE attachments SET size = ?, sha256 = ?, summary = ?, updated_at = ? WHERE id = ?', data.length, sha, summarize(cur.kind, data), now(), id);
  const att = toRow(q1('SELECT * FROM attachments WHERE id = ?', id)!);
  announce(att, 'updated', by);
  return { attachment: att, updated: true };
}

export function removeAttachment(id: string): { ok: true } | { error: string; status: number } {
  const row = q1('SELECT * FROM attachments WHERE id = ?', id);
  if (!row) return { error: 'file not found', status: 404 };
  const att = toRow(row);
  run('DELETE FROM attachments WHERE id = ?', id);
  try {
    const repo = row.repo_id ? (q1('SELECT path FROM repos WHERE id = ?', row.repo_id as string)?.path as string | undefined) : undefined;
    if (repo) { fs.rmSync(att.path, { force: true }); pruneEmpty(repo, att.path); }
    else fs.rmSync(path.dirname(att.path), { recursive: true, force: true });
  } catch { /* the row is gone; a stray file is harmless */ }
  emit('attachment.removed', 'owner', { attachmentId: id, name: att.name, scope: att.scope, taskId: att.taskId, agentId: att.agentId }, att.runId ?? liveRunOf(att.workspaceId), id);
  return { ok: true };
}

export function getAttachment(id: string): Attachment | null {
  const r = q1('SELECT * FROM attachments WHERE id = ?', id);
  return r ? toRow(r) : null;
}

export function listAttachments(f: { workspaceId?: string | null; scope?: string | null; agentId?: string | null; taskId?: string | null; runId?: string | null; role?: string | null }): Attachment[] {
  const where: string[] = [], args: unknown[] = [];
  if (f.workspaceId) { where.push('workspace_id = ?'); args.push(f.workspaceId); }
  if (f.scope) { where.push('scope = ?'); args.push(f.scope); }
  if (f.agentId) { where.push('agent_id = ?'); args.push(f.agentId); }
  if (f.taskId) { where.push('task_id = ?'); args.push(f.taskId); }
  if (f.runId) { where.push('run_id = ?'); args.push(f.runId); }
  if (f.role) { where.push('role = ?'); args.push(normRole(f.role)); }
  return q(`SELECT * FROM attachments ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at`, ...args).map(toRow);
}

/** Files chosen on the New run form before the run existed: this run only (and filed under documents/runs/<run>/). */
export function bindToRun(ids: string[], runId: string, workspaceId: string): void {
  for (const id of ids) {
    const row = q1(`SELECT * FROM attachments WHERE id = ? AND workspace_id = ? AND scope = 'project'`, id, workspaceId);
    if (!row) continue;
    const cur = toRow(row);
    run('UPDATE attachments SET run_id = ? WHERE id = ?', runId, id);
    relocate(cur, folderFor({ scope: 'project', runId }));
  }
}

/** Move a reference file to another audience folder (or into the repository for the first time). */
function relocate(cur: Attachment, folder: string): void {
  const row = q1('SELECT * FROM attachments WHERE id = ?', cur.id);
  if (!row || cur.scope === 'task') return;
  const repo = repoFor(cur.workspaceId, (row.run_id as string | null) ?? null);
  if (!repo) return;
  try {
    const target = allocate(repo.path, folder, cur.name);
    if (norm(target.abs) === norm(cur.path)) return;
    fs.mkdirSync(path.dirname(target.abs), { recursive: true });
    fs.copyFileSync(cur.path, target.abs);
    const prevRepo = row.repo_id ? (q1('SELECT path FROM repos WHERE id = ?', row.repo_id as string)?.path as string | undefined) : undefined;
    run('UPDATE attachments SET path = ?, repo_id = ?, name = ? WHERE id = ?', target.abs, repo.id, target.name, cur.id);
    fs.rmSync(cur.path, { force: true });
    if (prevRepo) pruneEmpty(prevRepo, cur.path); else fs.rmSync(path.dirname(cur.path), { recursive: true, force: true });
  } catch (e) { console.warn('[attachments] could not move', cur.name, String(e).slice(0, 120)); }
}

/** Reference files stored by an earlier version live in the data folder; bring them into the repository. Safe to repeat. */
export function relocateLegacy(): number {
  let moved = 0;
  for (const row of q(`SELECT * FROM attachments WHERE scope != 'task' AND (path IS NULL OR repo_id IS NULL)`)) {
    const cur = toRow(row);
    if (!row.path) run('UPDATE attachments SET path = ? WHERE id = ?', cur.path, cur.id);
    if (!fs.existsSync(cur.path)) continue;
    const before = q1('SELECT path FROM attachments WHERE id = ?', cur.id)?.path;
    relocate({ ...cur, path: (before as string) ?? cur.path }, folderFor({ scope: cur.scope, role: cur.role, agentId: cur.agentId, runId: cur.runId }));
    if (q1('SELECT repo_id FROM attachments WHERE id = ?', cur.id)?.repo_id) moved++;
  }
  return moved;
}

// A new file reaches the PM (and whoever it is for) through the normal message inbox: it rides along with their next
// prompt. Nothing running is interrupted and no task is restarted.
function announce(a: Attachment, what: 'added' | 'updated', by = 'owner'): void {
  const runId = a.runId ?? liveRunOf(a.workspaceId);
  emit(`attachment.${what}`, by, { attachmentId: a.id, name: a.name, kind: a.kind, scope: a.scope, role: a.role, taskId: a.taskId, agentId: a.agentId, location: a.location, size: a.size }, runId, a.id);
  if (!runId) return;
  const who = a.scope === 'project' ? 'for every agent' : a.scope === 'role' ? `for the ${a.role} role` : a.scope === 'agent' ? 'for one agent' : 'attached to a task';
  const text = `Reference file ${what} ${who}: ${a.name} (${a.kind}) — ${a.summary || 'no summary'}${a.location ? ` — ${a.location}` : ''}. It is listed under "Reference files" in prompts from now on; open it only when it applies to your work.`;
  try {
    if (a.scope === 'agent' && a.agentId) postMessage({ runId, from: 'owner', to: a.agentId, kind: 'note', text });
    else if (a.scope === 'role' && a.role) postMessage({ runId, from: 'owner', to: a.role, kind: 'note', text });
    else postMessage({ runId, taskId: a.taskId, from: 'owner', to: 'pm', kind: 'note', text });
  } catch { /* the inbox is a courtesy; the file is already stored */ }
}

// ---------------------------------------------------------------- what an agent is told

export interface ManifestOpts {
  workspaceId: string; runId: string | null; taskId?: string | null; agentId?: string | null;
  role?: string | null;                 // the role the agent is acting in for this work
  references?: string[];                // files the PM pointed this task at (name or documents/ path): shown first, whatever their audience
}

interface Visible { task: Attachment[]; picked: Attachment[]; mine: Attachment[]; project: Attachment[]; others: Attachment[] }

function taskReferences(o: ManifestOpts): string[] {
  if (o.references) return o.references;
  if (!o.taskId) return [];
  const meta = parseJson<Record<string, unknown>>(q1('SELECT meta FROM tasks WHERE id = ?', o.taskId)?.meta as string, {});
  return Array.isArray(meta.references) ? (meta.references as unknown[]).map(String) : [];
}

function visible(o: ManifestOpts): Visible {
  const role = o.role ? normRole(o.role) : '';
  const project = q(`SELECT * FROM attachments WHERE workspace_id = ? AND scope = 'project' AND (run_id IS NULL OR run_id = ?) ORDER BY created_at`, o.workspaceId, o.runId ?? '').map(toRow);
  const byRole = role ? q(`SELECT * FROM attachments WHERE workspace_id = ? AND scope = 'role' AND role = ? ORDER BY created_at`, o.workspaceId, role).map(toRow) : [];
  const byAgent = o.agentId ? q(`SELECT * FROM attachments WHERE workspace_id = ? AND scope = 'agent' AND agent_id = ? ORDER BY created_at`, o.workspaceId, o.agentId).map(toRow) : [];
  const task = o.taskId ? q(`SELECT * FROM attachments WHERE scope = 'task' AND task_id = ? ORDER BY created_at`, o.taskId).map(toRow) : [];
  const mine = [...byRole, ...byAgent];
  const seen = new Set([...project, ...mine, ...task].map((a) => a.id));
  // the PM's picks reach the agent whatever audience the file was filed under
  const wanted = taskReferences(o).map((x) => x.replace(/\\/g, '/').toLowerCase());
  const picked = wanted.length
    ? q(`SELECT * FROM attachments WHERE workspace_id = ? AND scope != 'task' ORDER BY created_at`, o.workspaceId).map(toRow)
        .filter((a) => !seen.has(a.id) && wanted.some((w) => w === a.name.toLowerCase() || w === (a.location ?? '').toLowerCase() || (a.location ?? '').toLowerCase().endsWith(`/${w}`)))
    : [];
  picked.forEach((a) => seen.add(a.id));
  // the PM also sees what the other audiences were given, so it can route a document to the task that needs it
  const others = role === 'pm'
    ? q(`SELECT * FROM attachments WHERE workspace_id = ? AND scope IN ('role','agent') ORDER BY created_at`, o.workspaceId).map(toRow).filter((a) => !seen.has(a.id))
    : [];
  return { task, picked, mine, project, others };
}

/** The section appended to a prompt: what exists and where, never the contents. */
export function manifestSection(o: ManifestOpts): { section: string; ids: string[] } {
  const v = visible(o);
  const all = [...v.task, ...v.picked, ...v.mine, ...v.project, ...v.others];
  if (!all.length) return { section: '', ids: [] };
  const items = o.taskId ? parseJson<{ id: string; title: string }[]>(JSON.stringify(parseJson<Record<string, unknown>>(q1('SELECT meta FROM tasks WHERE id = ?', o.taskId)?.meta as string, {}).workItems ?? []), []) : [];
  const agentName = (id: string | null) => (id ? (q1('SELECT name FROM agents WHERE id = ?', id)?.name as string) ?? id : '');
  const line = (a: Attachment, extra = '') => {
    const wi = a.itemRef ? items.findIndex((w) => w.id === a.itemRef) : -1;
    const tag = extra || (wi >= 0 ? `for work item ${wi + 1}: ${items[wi].title}` : '');
    return `- \`${a.name}\` (${a.kind}, ${fmtSize(a.size)})${a.summary ? ` — ${a.summary}` : ''}${tag ? ` [${tag}]` : ''}\n  ${fileOf(a)}`;
  };
  const parts: string[] = [
    '## Reference files',
    'Provided by the owner; they are inputs, not part of your change. Open only the ones that apply to this work (read the path with your file tool; open images to look at them) — do not read them all by default, and follow them where they apply.',
  ];
  let left = MANIFEST_MAX_ENTRIES, hidden = 0;
  const block = (title: string, list: Attachment[], tag?: (a: Attachment) => string) => {
    if (!list.length) return;
    const shown = list.slice(0, Math.max(0, left)); left -= shown.length; hidden += list.length - shown.length;
    if (shown.length) parts.push(`${title}:`, ...shown.map((a) => line(a, tag?.(a))));
  };
  block('Attached to this task', v.task);
  block('Chosen by the PM for this task', v.picked, () => 'PM pick');
  block(o.role ? `For you (${normRole(o.role)})` : 'For you', v.mine);
  block('Project-wide', v.project);
  block('Given to other agents (point a task at one with "references")', v.others, (a) => (a.scope === 'role' ? `for ${a.role}` : `for ${agentName(a.agentId)}`));
  if (hidden) parts.push(`(${hidden} more not listed — the owner can trim the list)`);
  let section = parts.join('\n');
  if (section.length > MANIFEST_MAX_CHARS) section = `${section.slice(0, MANIFEST_MAX_CHARS)}\n… (list shortened)`;
  return { section, ids: all.map((a) => a.id) };
}

/** Changes whenever the files an agent would see change: part of the result-cache key. */
export function manifestFingerprint(o: ManifestOpts): string {
  const v = visible(o);
  return sha256([...v.task, ...v.picked, ...v.mine, ...v.project, ...v.others].map((a) => `${a.id}:${a.sha256}`).join('|')).slice(0, 12);
}
