import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, q, q1, run } from '../db.ts';
import { emit } from '../bus.ts';
import { now, sha256, ulid } from '../util.ts';
import { postMessage } from './messages.ts';

// Reference files and task attachments. Files live in the daemon's data folder, never in the user's repository,
// and are handed to agents as a short manifest (name, kind, one-line summary, path): an agent opens only what its
// work needs, so a long reference never costs tokens until it is actually read.
//
// Three scopes, which keep the relationship between a file and its owner explicit:
//   project - the whole office (every agent); with run_id set, only that run
//   agent   - one agent's own references
//   task    - attached to one task; only the agents working that task see it

export type AttachScope = 'project' | 'agent' | 'task';
export type AttachKind = 'markdown' | 'text' | 'code' | 'image' | 'document' | 'data';

export interface Attachment {
  id: string; workspaceId: string; runId: string | null; scope: AttachScope; agentId: string | null; taskId: string | null;
  name: string; mime: string; size: number; sha256: string; kind: AttachKind; summary: string;
  createdAt: string; updatedAt: string;
}

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PER_TASK = 30;
export const MAX_PER_OFFICE = 200;
const MANIFEST_MAX_ENTRIES = 40;
const MANIFEST_MAX_CHARS = 3500;

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

const rootDir = () => path.join(DATA_DIR, 'attachments');

const toRow = (r: Record<string, unknown>): Attachment => ({
  id: r.id as string, workspaceId: r.workspace_id as string, runId: (r.run_id as string | null) ?? null, scope: r.scope as AttachScope,
  agentId: (r.agent_id as string | null) ?? null, taskId: (r.task_id as string | null) ?? null, name: r.name as string, mime: r.mime as string,
  size: r.size as number, sha256: r.sha256 as string, kind: r.kind as AttachKind, summary: (r.summary as string) ?? '',
  createdAt: r.created_at as string, updatedAt: r.updated_at as string,
});

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

export function fileOf(a: Attachment): string { return path.join(rootDir(), a.workspaceId, a.id, a.name); }

// An office's runs that are still going: new files announce themselves there.
const LIVE = ['draft', 'dod-review', 'running', 'pausing', 'paused', 'verifying'];
export const liveRunOf = (workspaceId: string): string | null =>
  (q1(`SELECT id FROM runs WHERE workspace_id = ? AND status IN (${LIVE.map(() => '?').join(',')}) ORDER BY rowid DESC LIMIT 1`, workspaceId, ...LIVE)?.id as string | undefined) ?? null;

export interface AddInput {
  workspaceId: string; scope: AttachScope; name: unknown; data: Buffer;
  agentId?: string | null; taskId?: string | null; runId?: string | null; by?: string;
}

export function addAttachment(i: AddInput): { attachment: Attachment; updated: boolean } | { error: string; status: number } {
  if (!q1('SELECT id FROM workspaces WHERE id = ?', i.workspaceId)) return { error: 'office not found', status: 404 };
  if (!['project', 'agent', 'task'].includes(i.scope)) return { error: 'scope must be project, agent or task', status: 400 };
  const name = cleanName(i.name);
  if (!name) return { error: 'the file needs a name', status: 400 };
  const cls = classify(name);
  if (!cls) return { error: `.${path.extname(name).slice(1) || '?'} files are not supported — Markdown, text, JSON/YAML/CSV, source and script files, images, PDF and Office documents are`, status: 415 };
  if (!i.data.length) return { error: `${name} is empty`, status: 400 };
  if (i.data.length > MAX_FILE_BYTES) return { error: `${name} is ${fmtSize(i.data.length)} — the limit is ${fmtSize(MAX_FILE_BYTES)} per file`, status: 413 };
  // the bytes must match the kind the extension promises (a .md that is really a binary would poison a prompt)
  if (['markdown', 'text', 'code', 'data'].includes(cls.kind) && looksBinary(i.data)) return { error: `${name} looks like a binary file, not text`, status: 415 };

  let agentId: string | null = null, taskId: string | null = null, runId: string | null = null;
  if (i.scope === 'agent') {
    if (!i.agentId || !q1('SELECT id FROM agents WHERE id = ?', i.agentId)) return { error: 'agent not found', status: 404 };
    agentId = i.agentId;
  } else if (i.scope === 'task') {
    const t = i.taskId ? q1('SELECT t.id, t.run_id, r.workspace_id ws FROM tasks t JOIN runs r ON r.id = t.run_id WHERE t.id = ?', i.taskId) : null;
    if (!t) return { error: 'task not found', status: 404 };
    if (t.ws !== i.workspaceId) return { error: 'that task belongs to another office', status: 400 };
    taskId = t.id as string; runId = t.run_id as string;
  } else if (i.runId) {
    const rr = q1('SELECT id FROM runs WHERE id = ? AND workspace_id = ?', i.runId, i.workspaceId);
    if (!rr) return { error: 'run not found in this office', status: 404 };
    runId = i.runId;
  }

  const sha = sha256(i.data.toString('latin1')).slice(0, 32);
  // same name in the same place = an update of that file (references are kept current by re-adding them)
  const same = q(`SELECT * FROM attachments WHERE workspace_id = ? AND scope = ? AND IFNULL(agent_id,'') = ? AND IFNULL(task_id,'') = ? AND IFNULL(run_id,'') = ? AND lower(name) = lower(?)`,
    i.workspaceId, i.scope, agentId ?? '', taskId ?? '', runId ?? '', name)[0];
  if (same) {
    const cur = toRow(same);
    if (cur.sha256 === sha) return { attachment: cur, updated: false };
    return replaceAttachment(cur.id, i.data, i.by);
  }
  if (taskId && (q1('SELECT COUNT(*) c FROM attachments WHERE task_id = ?', taskId)?.c as number) >= MAX_PER_TASK) return { error: `a task can hold ${MAX_PER_TASK} files — remove one first`, status: 409 };
  if ((q1('SELECT COUNT(*) c FROM attachments WHERE workspace_id = ?', i.workspaceId)?.c as number) >= MAX_PER_OFFICE) return { error: `this office already holds ${MAX_PER_OFFICE} files — remove some first`, status: 409 };

  const id = ulid();
  const row = { id, workspace_id: i.workspaceId, run_id: runId, scope: i.scope, agent_id: agentId, task_id: taskId, name, mime: cls.mime, size: i.data.length, sha256: sha, kind: cls.kind, summary: summarize(cls.kind, i.data), created_at: now(), updated_at: now() };
  const file = path.join(rootDir(), i.workspaceId, id, name);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, i.data);
  } catch (e) { return { error: `could not store ${name}: ${String(e).slice(0, 160)}`, status: 500 }; }
  try {
    run(`INSERT INTO attachments (id, workspace_id, run_id, scope, agent_id, task_id, name, mime, size, sha256, kind, summary, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, row.workspace_id, runId, i.scope, agentId, taskId, name, row.mime, row.size, sha, row.kind, row.summary, row.created_at, row.updated_at);
  } catch (e) { fs.rmSync(path.dirname(file), { recursive: true, force: true }); return { error: `could not record ${name}: ${String(e).slice(0, 160)}`, status: 500 }; }
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
  // write beside, then rename: a crash never leaves a half-written reference
  const file = fileOf(cur), tmp = `${file}.tmp`;
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); } catch (e) { return { error: `could not update ${cur.name}: ${String(e).slice(0, 160)}`, status: 500 }; }
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
  try { fs.rmSync(path.dirname(fileOf(att)), { recursive: true, force: true }); } catch { /* the row is gone; a stray file is harmless */ }
  emit('attachment.removed', 'owner', { attachmentId: id, name: att.name, scope: att.scope, taskId: att.taskId, agentId: att.agentId }, att.runId ?? liveRunOf(att.workspaceId), id);
  return { ok: true };
}

export function getAttachment(id: string): Attachment | null {
  const r = q1('SELECT * FROM attachments WHERE id = ?', id);
  return r ? toRow(r) : null;
}

export function listAttachments(f: { workspaceId?: string | null; scope?: string | null; agentId?: string | null; taskId?: string | null; runId?: string | null }): Attachment[] {
  const where: string[] = [], args: unknown[] = [];
  if (f.workspaceId) { where.push('workspace_id = ?'); args.push(f.workspaceId); }
  if (f.scope) { where.push('scope = ?'); args.push(f.scope); }
  if (f.agentId) { where.push('agent_id = ?'); args.push(f.agentId); }
  if (f.taskId) { where.push('task_id = ?'); args.push(f.taskId); }
  if (f.runId) { where.push('run_id = ?'); args.push(f.runId); }
  return q(`SELECT * FROM attachments ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at`, ...args).map(toRow);
}

/** Files chosen on the New run form before the run existed: this run only. */
export function bindToRun(ids: string[], runId: string, workspaceId: string): void {
  for (const id of ids) run(`UPDATE attachments SET run_id = ? WHERE id = ? AND workspace_id = ? AND scope = 'project'`, runId, id, workspaceId);
}

// A new file reaches the PM (and the agent it is for) through the normal message inbox: it rides along with their
// next prompt. Nothing running is interrupted and no task is restarted.
function announce(a: Attachment, what: 'added' | 'updated', by = 'owner'): void {
  const runId = a.runId ?? liveRunOf(a.workspaceId);
  emit(`attachment.${what}`, by, { attachmentId: a.id, name: a.name, kind: a.kind, scope: a.scope, taskId: a.taskId, agentId: a.agentId, size: a.size }, runId, a.id);
  if (!runId) return;
  const where = a.scope === 'project' ? 'for the whole office' : a.scope === 'agent' ? 'for one agent' : 'attached to a task';
  const text = `Reference file ${what === 'added' ? 'added' : 'updated'} ${where}: ${a.name} (${a.kind}) — ${a.summary || 'no summary'}. It is listed under "Reference files" in prompts from now on; open it only when it applies to your work.`;
  try {
    if (a.scope === 'agent' && a.agentId) postMessage({ runId, from: 'owner', to: a.agentId, kind: 'note', text });
    else postMessage({ runId, taskId: a.taskId, from: 'owner', to: 'pm', kind: 'note', text });
  } catch { /* the inbox is a courtesy; the file is already stored */ }
}

export interface ManifestOpts { workspaceId: string; runId: string | null; taskId?: string | null; agentId?: string | null }

function visible(o: ManifestOpts): { project: Attachment[]; agent: Attachment[]; task: Attachment[] } {
  const project = q(`SELECT * FROM attachments WHERE workspace_id = ? AND scope = 'project' AND (run_id IS NULL OR run_id = ?) ORDER BY created_at`, o.workspaceId, o.runId ?? '').map(toRow);
  const agent = o.agentId ? q(`SELECT * FROM attachments WHERE workspace_id = ? AND scope = 'agent' AND agent_id = ? ORDER BY created_at`, o.workspaceId, o.agentId).map(toRow) : [];
  const task = o.taskId ? q(`SELECT * FROM attachments WHERE scope = 'task' AND task_id = ? ORDER BY created_at`, o.taskId).map(toRow) : [];
  return { project, agent, task };
}

/** The section appended to a prompt: what exists and where, never the contents. */
export function manifestSection(o: ManifestOpts): { section: string; ids: string[] } {
  const v = visible(o);
  const all = [...v.project, ...v.agent, ...v.task];
  if (!all.length) return { section: '', ids: [] };
  const line = (a: Attachment) => `- \`${a.name}\` (${a.kind}, ${fmtSize(a.size)})${a.summary ? ` — ${a.summary}` : ''}\n  ${fileOf(a)}`;
  const parts: string[] = [
    '## Reference files',
    'Provided by the owner. They live outside the repository and are read-only. Open only the ones that apply to this work (read the path with your file tool; open images to look at them) — do not read them all by default, and follow them where they apply.',
  ];
  let left = MANIFEST_MAX_ENTRIES, hidden = 0;
  const block = (title: string, list: Attachment[]) => {
    if (!list.length) return;
    const shown = list.slice(0, Math.max(0, left)); left -= shown.length; hidden += list.length - shown.length;
    if (shown.length) parts.push(`${title}:`, ...shown.map(line));
  };
  block('Attached to this task', v.task);
  block('For you', v.agent);
  block('Project-wide', v.project);
  if (hidden) parts.push(`(${hidden} more not listed — the owner can trim the list)`);
  let section = parts.join('\n');
  if (section.length > MANIFEST_MAX_CHARS) section = `${section.slice(0, MANIFEST_MAX_CHARS)}\n… (list shortened)`;
  return { section, ids: all.map((a) => a.id) };
}

/** Changes whenever the files an agent would see change: part of the result-cache key. */
export function manifestFingerprint(o: ManifestOpts): string {
  const v = visible(o);
  return sha256([...v.project, ...v.agent, ...v.task].map((a) => `${a.id}:${a.sha256}`).join('|')).slice(0, 12);
}
