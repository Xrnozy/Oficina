import React, { useEffect, useMemo, useRef, useState } from 'react';
import { del, post, useQuery } from './api';
import { Modal, Muted, Panel, Segmented, Tag, act, fmtAgo, roleLabel, toast } from './components';
import { Select } from './Select';
import { useOfficeAgents } from './office';
import {
  File as FileIcon, FileCode, FileImage, FileJson, FileText, ListPlus, Paperclip, Plus, RefreshCw, StickyNote, Trash2, UploadCloud, X,
} from 'lucide-react';

// Reference files and task attachments: the upload helpers, the drop target, and the pieces every page shares.
// Reference files are filed in the repository's documents/ folder by audience (all-agents, pm, dev, ...); task
// attachments stay with the task. Agents get a short list of what exists and open only what their work needs.

export type Scope = 'project' | 'role' | 'agent' | 'task';
export interface Attachment {
  id: string; workspaceId: string; runId: string | null; scope: Scope; role: string | null; agentId: string | null; taskId: string | null; itemRef: string | null;
  name: string; mime: string; size: number; kind: 'markdown' | 'text' | 'code' | 'image' | 'document' | 'data'; summary: string;
  path: string; location: string | null; createdAt: string; updatedAt: string;
}
export interface Target { workspaceId: string; scope: Scope; agentId?: string | null; taskId?: string | null; runId?: string | null; role?: string | null; itemRef?: string | null }

export const ACCEPT = '.md,.markdown,.mdx,.txt,.log,.json,.yaml,.yml,.toml,.ini,.xml,.csv,.tsv,.png,.jpg,.jpeg,.gif,.webp,.svg,.bmp,.pdf,.docx,.pptx,.xlsx,'
  + '.js,.mjs,.ts,.tsx,.jsx,.py,.rb,.go,.rs,.java,.kt,.cs,.c,.h,.cpp,.php,.swift,.sh,.ps1,.bat,.cmd,.sql,.html,.css,.scss,.vue,.svelte,.dart';
const MAX_BYTES = 10 * 1024 * 1024;

export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Checked in the browser first so a wrong file fails instantly; the daemon checks again. */
export function precheck(f: File): string | null {
  if (!f.size) return `${f.name} is empty`;
  if (f.size > MAX_BYTES) return `${f.name} is ${fmtSize(f.size)} — the limit is 10 MB per file`;
  const ext = f.name.includes('.') ? `.${f.name.split('.').pop()!.toLowerCase()}` : '';
  if (!ext || !ACCEPT.split(',').includes(ext)) return `${f.name}: ${ext || 'this'} files are not supported (Markdown, text, JSON/YAML/CSV, source and scripts, images, PDF and Office documents are)`;
  return null;
}

async function send(path: string, method: 'POST' | 'PUT', file: File): Promise<{ attachment: Attachment; updated: boolean }> {
  const res = await fetch(`/api${path}`, { method, headers: { 'content-type': 'application/octet-stream' }, body: file });
  const isJson = (res.headers.get('content-type') ?? '').includes('json');
  if (!res.ok) {
    if (res.status === 404 && !isJson) throw new Error('The daemon doesn\'t support file uploads yet: it is still running an older version. Restart Oficina and retry.');
    const b = isJson ? await res.json().catch(() => ({})) : {};
    throw new Error(b.error ?? `upload failed (${res.status})`);
  }
  return res.json();
}

/** Upload one by one (so one bad file never loses the others); returns what was stored and reports the rest. */
export async function uploadFiles(files: File[], t: Target, opts: { quiet?: boolean } = {}): Promise<Attachment[]> {
  const stored: Attachment[] = []; const failed: string[] = []; let updated = 0;
  for (const f of files) {
    const bad = precheck(f);
    if (bad) { failed.push(bad); continue; }
    const qs = new URLSearchParams({ workspaceId: t.workspaceId, scope: t.scope, name: f.name });
    if (t.agentId) qs.set('agentId', t.agentId);
    if (t.taskId) qs.set('taskId', t.taskId);
    if (t.runId) qs.set('runId', t.runId);
    if (t.role) qs.set('role', t.role);
    if (t.itemRef) qs.set('itemRef', t.itemRef);
    try { const r = await send(`/attachments?${qs}`, 'POST', f); stored.push(r.attachment); if (r.updated) updated++; }
    catch (e) { failed.push(`${f.name}: ${String((e as Error).message ?? e)}`); }
  }
  failed.slice(0, 3).forEach((m) => toast(m, 'bad'));
  if (failed.length > 3) toast(`…and ${failed.length - 3} more could not be added`, 'bad');
  if (!opts.quiet && stored.length) toast(stored.length === 1 ? `${stored[0].name} ${updated ? 'updated' : 'added'}${stored[0].location ? ` → ${stored[0].location}` : ''}` : `${stored.length} files added${updated ? ` (${updated} updated)` : ''}`);
  return stored;
}

export async function replaceFile(id: string, f: File): Promise<boolean> {
  const bad = precheck(f);
  if (bad) { toast(bad, 'bad'); return false; }
  try { await send(`/attachments/${id}`, 'PUT', f); toast(`${f.name} updated`); return true; }
  catch (e) { toast(String((e as Error).message ?? e), 'bad'); return false; }
}

/** Text typed or pasted into the app becomes a Markdown file — a way to add a reference where no file picker is available. */
export function noteFile(title: string, text: string): File {
  const base = title.trim().replace(/[^\w\- .]+/g, '').replace(/\s+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'note';
  return new File([text], /\.[a-z0-9]+$/i.test(base) ? base : `${base}.md`, { type: 'text/markdown' });
}

/** A drop target for files from the desktop; `over` is true while a file is being dragged across it. */
export function useFileDrop(onFiles: (files: File[]) => void, enabled = true) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const has = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  return {
    over,
    props: enabled ? {
      onDragEnter: (e: React.DragEvent) => { if (!has(e)) return; e.preventDefault(); depth.current++; setOver(true); },
      onDragOver: (e: React.DragEvent) => { if (!has(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; },
      onDragLeave: (e: React.DragEvent) => { if (!has(e)) return; depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); },
      onDrop: (e: React.DragEvent) => {
        if (!has(e)) return;
        e.preventDefault(); e.stopPropagation(); depth.current = 0; setOver(false);
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length) onFiles(files);
      },
    } : {},
  };
}

/** Pasted screenshots and files (Ctrl+V) while `active`; text pasted into a field is left alone. */
export function usePasteFiles(onFiles: (files: File[]) => void, active = true) {
  const cb = useRef(onFiles); cb.current = onFiles;
  useEffect(() => {
    if (!active) return;
    const h = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const files = Array.from(e.clipboardData?.files ?? []).map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}-${i + 1}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })));
      if (files.length) { e.preventDefault(); cb.current(files); }
    };
    document.addEventListener('paste', h);
    return () => document.removeEventListener('paste', h);
  }, [active]);
}

const KIND_ICON = { markdown: FileText, text: FileText, code: FileCode, image: FileImage, document: FileIcon, data: FileJson } as const;
export function KindIcon({ kind, size = 15, className = '' }: { kind: Attachment['kind']; size?: number; className?: string }) {
  const I = KIND_ICON[kind] ?? FileIcon;
  return <I size={size} className={className} />;
}

/** Click-or-drop zone. */
export function DropZone({ onFiles, compact = false, label, busy = false }: { onFiles: (files: File[]) => void; compact?: boolean; label?: string; busy?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const { over, props } = useFileDrop(onFiles);
  return (
    <div {...props} role="button" tabIndex={0} aria-label={label ?? 'Add files'}
      onClick={() => input.current?.click()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click(); } }}
      className={`cursor-pointer rounded-xl border border-dashed transition-colors text-center ${compact ? 'px-3 py-3' : 'px-4 py-5'} ${over ? 'border-fg bg-raised' : 'border-line-strong hover:border-fg-3 hover:bg-raised/50'} ${busy ? 'opacity-60 pointer-events-none' : ''}`}>
      <input ref={input} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ''; if (f.length) onFiles(f); }} />
      <div className="flex items-center justify-center gap-2 text-sm text-fg-2">
        <UploadCloud size={15} className="text-fg-3" />
        <span>{busy ? 'Uploading…' : (label ?? <>Drop files here or <span className="text-fg underline underline-offset-2">browse</span></>)}</span>
      </div>
      {!compact && <div className="text-2xs text-fg-4 mt-1">Markdown, text, JSON/YAML, source and scripts, images, PDF and Office documents · up to 10 MB each</div>}
    </div>
  );
}

// ------------------------------------------------------------------- audiences

const ROLE_DIR: Record<string, string> = { pm: 'pm', developer: 'dev', reviewer: 'reviewer', qa: 'qa', analyst: 'analyst', docs: 'docs', 'prompt-creator': 'prompt-creator' };
const ROLE_WHO: Record<string, string> = { pm: 'Project Manager', developer: 'Developers', reviewer: 'Reviewers', qa: 'QA / testers', analyst: 'Analysts', docs: 'Docs writers', 'prompt-creator': 'Prompt Creator' };

/** Who a file is for: everyone, this run only, one role, or one agent. */
export type Audience = 'all' | 'run' | `role:${string}` | `agent:${string}`;

export function audienceTarget(a: Audience, workspaceId: string, runId?: string | null): Target {
  if (a === 'all') return { workspaceId, scope: 'project' };
  if (a === 'run') return { workspaceId, scope: 'project', runId };
  if (a.startsWith('role:')) return { workspaceId, scope: 'role', role: a.slice(5) };
  return { workspaceId, scope: 'agent', agentId: a.slice(6) };
}

export function AudiencePicker({ value, onChange, runId, className = '' }: { value: Audience; onChange: (a: Audience) => void; runId?: string | null; className?: string }) {
  const { agents } = useOfficeAgents();
  const { data: roles } = useQuery<any[]>('/roles');
  const members = (agents ?? []).filter((a: any) => (a.memberships ?? []).some((m: any) => m.active));
  return (
    <Select className={`input input-sm w-full ${className}`} value={value} onChange={(e) => onChange(e.target.value as Audience)} aria-label="Who should get these files">
      <option value="all">Every agent — documents/all-agents</option>
      {runId && <option value="run">Every agent, this run only</option>}
      {(roles ?? []).map((r: any) => <option key={r.id} value={`role:${r.name}`}>{ROLE_WHO[r.name] ?? roleLabel(r.name)} — documents/{ROLE_DIR[r.name] ?? r.name}</option>)}
      {members.map((a: any) => <option key={a.id} value={`agent:${a.id}`}>Only {a.name}</option>)}
    </Select>
  );
}

const audienceOf = (a: Attachment, nameOf: (id: string | null) => string | undefined): string =>
  a.scope === 'role' ? (ROLE_WHO[a.role ?? ''] ?? roleLabel(a.role ?? '')) : a.scope === 'agent' ? (nameOf(a.agentId) ?? 'one agent') : a.runId ? 'this run' : a.scope === 'task' ? 'this task' : 'all agents';

/** One stored file: open it, replace its content, remove it. */
export function AttachmentRow({ a, nameOf, onChanged, showScope = true, itemLabel }: { a: Attachment; nameOf?: (id: string | null) => string | undefined; onChanged: () => void; showScope?: boolean; itemLabel?: string }) {
  const swap = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <li className="group flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-raised transition-colors min-w-0">
      {a.kind === 'image'
        ? <a href={`/api/attachments/${a.id}/file`} target="_blank" rel="noreferrer" className="shrink-0"><img src={`/api/attachments/${a.id}/file`} alt="" className="w-9 h-9 rounded-md object-cover border border-line bg-sunken" /></a>
        : <span className="w-9 h-9 shrink-0 rounded-md border border-line bg-sunken grid place-items-center text-fg-3"><KindIcon kind={a.kind} /></span>}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <a href={`/api/attachments/${a.id}/file`} target="_blank" rel="noreferrer" className="text-sm text-fg truncate hover:underline underline-offset-2" title={a.name}>{a.name}</a>
          {showScope && <Tag tone={a.scope === 'project' && !a.runId ? 'info' : 'idle'}>{audienceOf(a, nameOf ?? (() => undefined))}</Tag>}
          {itemLabel && <Tag>{itemLabel}</Tag>}
        </div>
        <div className="text-2xs text-fg-4 truncate">{a.location && <><span className="mono">{a.location}</span> · </>}{fmtSize(a.size)} · {a.summary || a.kind} · {a.updatedAt !== a.createdAt ? `updated ${fmtAgo(a.updatedAt)}` : fmtAgo(a.createdAt)}</div>
      </div>
      <input ref={swap} type="file" accept={ACCEPT} className="hidden" onChange={async (e) => {
        const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
        setBusy(true); if (await replaceFile(a.id, f)) onChanged(); setBusy(false);
      }} />
      <button className="btn btn-ghost btn-xs btn-icon opacity-60 group-hover:opacity-100" title="Replace with a newer version" aria-label={`Replace ${a.name}`} disabled={busy} onClick={() => swap.current?.click()}><RefreshCw size={13} /></button>
      <button className="btn btn-ghost btn-xs btn-icon opacity-60 group-hover:opacity-100" title="Remove" aria-label={`Remove ${a.name}`} disabled={busy}
        onClick={async () => { if (await act(del(`/attachments/${a.id}`), `${a.name} removed`)) onChanged(); }}><Trash2 size={13} /></button>
    </li>
  );
}

/** Files on one task: the list plus a drop zone. */
export function TaskFiles({ taskId, workspaceId, readOnly = false, workItems = [] }: { taskId: string; workspaceId: string; readOnly?: boolean; workItems?: { id: string; title: string }[] }) {
  const { data, reload } = useQuery<Attachment[]>(`/attachments?taskId=${taskId}`, [taskId]);
  const [busy, setBusy] = useState(false);
  const add = async (files: File[]) => { setBusy(true); await uploadFiles(files, { workspaceId, scope: 'task', taskId }); setBusy(false); reload(); };
  const list = data ?? [];
  return (
    <div>
      {list.length === 0 && <div className="mb-3"><Muted>Nothing attached. Agents working this task see what you add here — a screenshot of a bug, a spec, a script.</Muted></div>}
      {list.length > 0 && <ul className="-mx-2 mb-2">{list.map((a) => {
        const i = a.itemRef ? workItems.findIndex((w) => w.id === a.itemRef) : -1;
        return <AttachmentRow key={a.id} a={a} showScope={false} itemLabel={i >= 0 ? `work item ${i + 1}` : undefined} onChanged={reload} />;
      })}</ul>}
      {!readOnly && <DropZone compact onFiles={add} busy={busy} label={list.length ? 'Drop more files, or browse' : undefined} />}
    </div>
  );
}

/** Reference files for one agent (the agent drawer). */
export function AgentFiles({ agentId, workspaceId }: { agentId: string; workspaceId: string }) {
  const { data, reload } = useQuery<Attachment[]>(`/attachments?workspaceId=${workspaceId}&scope=agent&agentId=${agentId}`, [agentId, workspaceId]);
  const [busy, setBusy] = useState(false);
  const list = data ?? [];
  return (
    <div>
      {list.length > 0 && <ul className="-mx-2 mb-2">{list.map((a) => <AttachmentRow key={a.id} a={a} showScope={false} onChanged={reload} />)}</ul>}
      <DropZone compact busy={busy} label={list.length ? 'Add another reference' : 'Add a reference only this agent receives'}
        onFiles={async (f) => { setBusy(true); await uploadFiles(f, { workspaceId, scope: 'agent', agentId }); setBusy(false); reload(); }} />
    </div>
  );
}

/** The office's reference files, grouped by audience, with add, replace and remove. */
export function ReferencesPanel({ workspaceId, runId, officeName }: { workspaceId: string; runId?: string | null; officeName?: string }) {
  const { agents } = useOfficeAgents();
  const { data, reload } = useQuery<Attachment[]>(`/attachments?workspaceId=${workspaceId}`, [workspaceId]);
  const [audience, setAudience] = useState<Audience>('all');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ title: string; text: string } | null>(null);
  const nameOf = (id: string | null) => (agents ?? []).find((a: any) => a.id === id)?.name;
  const refs = (data ?? []).filter((a) => a.scope !== 'task');
  const groups = useMemo(() => {
    const m = new Map<string, { title: string; folder: string; list: Attachment[] }>();
    const key = (a: Attachment) => (a.scope === 'role' ? `role:${a.role}` : a.scope === 'agent' ? `agent:${a.agentId}` : a.runId ? 'run' : 'all');
    for (const a of refs) {
      const k = key(a);
      if (!m.has(k)) m.set(k, {
        title: k === 'all' ? `Every agent${officeName ? ` in ${officeName}` : ''}` : k === 'run' ? 'Every agent · this run only' : k.startsWith('role:') ? (ROLE_WHO[a.role ?? ''] ?? roleLabel(a.role ?? '')) : `Only ${nameOf(a.agentId) ?? 'one agent'}`,
        folder: (a.location ?? '').split('/').slice(0, -1).join('/'), list: [],
      });
      m.get(k)!.list.push(a);
    }
    return [...m.entries()].sort(([x], [y]) => (x === 'all' ? -1 : y === 'all' ? 1 : x.localeCompare(y))).map(([, v]) => v);
  }, [refs.map((a) => a.id + a.updatedAt).join(','), agents?.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = async (files: File[]) => { setBusy(true); await uploadFiles(files, audienceTarget(audience, workspaceId, runId)); setBusy(false); reload(); };
  return (
    <Panel title={<>Reference files{refs.length > 0 && <span className="ml-2 chip">{refs.length}</span>}</>}
      action={<span className="text-2xs text-fg-4 hidden sm:inline">filed in the repository's documents/ folder · agents open only what applies</span>} bodyClass="px-4 pb-4">
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-5 [&>*]:min-w-0">
        <div className="space-y-4">
          {groups.length === 0 && <Muted>None yet. Add a design.md, spec.md or coding standards and the right agents are told they exist — by audience: everyone, one role (the PM, the developers…) or a single agent.</Muted>}
          {groups.map((g) => (
            <div key={g.title + g.folder}>
              <div className="eyebrow mb-1 flex items-center gap-2 flex-wrap">{g.title}{g.folder && <span className="normal-case tracking-normal text-fg-4 mono">{g.folder}/</span>}</div>
              <ul className="-mx-2">{g.list.map((a) => <AttachmentRow key={a.id} a={a} showScope={false} nameOf={nameOf} onChanged={reload} />)}</ul>
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-line bg-raised/40 p-3.5 self-start space-y-3">
          <label className="block">
            <span className="field-label">Who should get it</span>
            <AudiencePicker value={audience} onChange={setAudience} runId={runId} />
          </label>
          <DropZone onFiles={add} busy={busy} />
          <button className="btn btn-sm w-full" onClick={() => setNote({ title: '', text: '' })}><StickyNote size={13} /> Write a note instead</button>
          <p className="text-2xs text-fg-4 leading-relaxed">Files are placed in <span className="mono">documents/</span> by audience; nothing you already have there is overwritten. Re-adding a name updates the file. A new file reaches the PM and the agents it is for with their next prompt — nothing running is restarted.</p>
        </div>
      </div>
      {note && (
        <Modal title="Write a reference note" onClose={() => setNote(null)}
          footer={<><button className="btn btn-ghost" onClick={() => setNote(null)}>Cancel</button><button className="btn btn-primary" disabled={!note.text.trim() || busy} onClick={async () => { await add([noteFile(note.title, note.text)]); setNote(null); }}>Add note</button></>}>
          <div className="space-y-3">
            <label className="block"><span className="field-label">Name</span><input className="input w-full" autoFocus placeholder="e.g. coding-standards" value={note.title} onChange={(e) => setNote({ ...note, title: e.target.value })} /></label>
            <label className="block"><span className="field-label">Markdown</span><textarea className="input w-full min-h-[10rem] font-mono text-xs" placeholder="# Title&#10;&#10;What the agents should know or follow…" value={note.text} onChange={(e) => setNote({ ...note, text: e.target.value })} /></label>
            <p className="text-xs text-fg-3">Goes to: <b className="font-medium text-fg-2">{audience === 'all' ? 'every agent' : audience === 'run' ? 'this run' : audience.startsWith('role:') ? ROLE_WHO[audience.slice(5)] ?? audience.slice(5) : nameOf(audience.slice(6)) ?? 'one agent'}</b> — change it in the panel before adding.</p>
          </div>
        </Modal>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------- new task

interface DraftItem { title: string; instructions: string; files: File[] }

function WorkItemRow({ n, w, onChange, onRemove, canRemove }: { n: number; w: DraftItem; onChange: (w: DraftItem) => void; onRemove: () => void; canRemove: boolean }) {
  const pick = useRef<HTMLInputElement>(null);
  const { over, props } = useFileDrop((f) => onChange({ ...w, files: [...w.files, ...f] }));
  const bad = w.instructions.trim() && !w.title.trim();
  return (
    <div {...props} className={`rounded-xl border p-3 space-y-2 transition-colors ${over ? 'border-fg bg-raised' : 'border-line'}`}>
      <div className="flex gap-2 items-center">
        <span className="mono text-2xs text-fg-4 w-4 shrink-0">{n}</span>
        <input className="input input-sm flex-1" placeholder="What needs to be done" value={w.title} maxLength={200} aria-label={`Work item ${n}`} aria-invalid={!!bad} onChange={(e) => onChange({ ...w, title: e.target.value })} />
        {canRemove && <button type="button" className="text-fg-4 hover:text-fg" aria-label={`Remove work item ${n}`} onClick={onRemove}><X size={14} /></button>}
      </div>
      <textarea className="input input-sm w-full !h-auto min-h-[2.75rem]" rows={2} placeholder="Instructions for the agents (optional) — constraints, where to look, how it should behave" value={w.instructions} maxLength={4000}
        aria-label={`Instructions for work item ${n}`} onChange={(e) => onChange({ ...w, instructions: e.target.value })} />
      <div className="flex flex-wrap items-center gap-1.5">
        {w.files.map((f, i) => (
          <span key={`${f.name}-${i}`} className="inline-flex items-center gap-1.5 h-6 px-2 rounded-md border border-line bg-surface text-2xs text-fg-2 max-w-[14rem]">
            <Paperclip size={11} className="text-fg-3 shrink-0" /><span className="truncate">{f.name}</span>
            <button type="button" className="text-fg-4 hover:text-fg" aria-label={`Remove ${f.name}`} onClick={() => onChange({ ...w, files: w.files.filter((_, j) => j !== i) })}><X size={11} /></button>
          </span>
        ))}
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => pick.current?.click()}><Paperclip size={12} /> Attach to this item</button>
        <input ref={pick} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ''; if (f.length) onChange({ ...w, files: [...w.files, ...f] }); }} />
        {bad && <span className="text-2xs text-bad">Give it a short title.</span>}
      </div>
    </div>
  );
}

/** Create a task for the running agents: what to do (work items), the instructions, and the files they need. */
export function NewTaskModal({ workspaceId, runId, initialFiles = [], onClose, onCreated }: { workspaceId: string; runId: string; initialFiles?: File[]; onClose: () => void; onCreated?: (taskId: string) => void }) {
  const [title, setTitle] = useState(() => (initialFiles[0] ? `Look into ${initialFiles[0].name.replace(/\.[^.]+$/, '')}` : ''));
  const [description, setDescription] = useState('');
  const [items, setItems] = useState<DraftItem[]>([{ title: '', instructions: '', files: [] }]);
  const [files, setFiles] = useState<File[]>(initialFiles);
  const [priority, setPriority] = useState<'normal' | 'urgent'>('normal');
  const [hold, setHold] = useState(false);
  const [busy, setBusy] = useState(false);
  const real = items.filter((w) => w.title.trim() || w.instructions.trim());
  const itemProblem = real.some((w) => !w.title.trim());
  const problems = [...files, ...real.flatMap((w) => w.files)].map(precheck).filter(Boolean) as string[];
  const submit = async () => {
    if (!title.trim() || busy || itemProblem) return;
    setBusy(true);
    const t = await act(post(`/runs/${runId}/tasks`, {
      title: title.trim(), description: description.trim(), priority: priority === 'urgent' ? 0 : 1, hold,
      workItems: real.map((w) => ({ title: w.title.trim(), instructions: w.instructions.trim() })),
    }), hold ? 'Task saved on hold — no agent will pick it up until you release it' : 'Task created — the next free agent picks it up');
    if (t?.id) {
      // the daemon numbers the work items 1..n in the order sent, so a row's files go to w<position>
      for (let i = 0; i < real.length; i++) {
        const ok = real[i].files.filter((f) => !precheck(f));
        if (ok.length) await uploadFiles(ok, { workspaceId, scope: 'task', taskId: t.id, itemRef: `w${i + 1}` }, { quiet: true });
      }
      const general = files.filter((f) => !precheck(f));
      if (general.length) await uploadFiles(general, { workspaceId, scope: 'task', taskId: t.id }, { quiet: true });
      onCreated?.(t.id); onClose();
    }
    setBusy(false);
  };
  return (
    <Modal title="New task" onClose={onClose} width="max-w-2xl"
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!title.trim() || busy || itemProblem} onClick={submit}>{busy ? 'Creating…' : hold ? 'Save on hold' : 'Create task'}</button></>}>
      <div className="space-y-5">
        <p className="text-sm text-fg-2">Add work to the run in progress. The PM reviews the brief, then whichever eligible agent is free takes it — running work isn't interrupted.</p>
        <label className="block"><span className="field-label">Title</span>
          <input className="input w-full" autoFocus value={title} maxLength={200} placeholder="e.g. Fix the login page on small screens" onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="block"><span className="field-label">Background <span className="normal-case tracking-normal text-fg-4">(optional)</span></span>
          <textarea className="input w-full min-h-[4.5rem]" value={description} placeholder="The problem or goal in a few sentences." onChange={(e) => setDescription(e.target.value)} /></label>

        <div>
          <div className="flex items-baseline gap-2 mb-1.5">
            <span className="field-label !mb-0">Work items</span>
            <span className="text-2xs text-fg-4">the specific things to do — each becomes an acceptance criterion the agents check</span>
          </div>
          <div className="space-y-2">
            {items.map((w, i) => (
              <WorkItemRow key={i} n={i + 1} w={w} canRemove={items.length > 1}
                onChange={(nw) => setItems(items.map((x, j) => (j === i ? nw : x)))} onRemove={() => setItems(items.filter((_, j) => j !== i))} />
            ))}
          </div>
          {items.length < 20 && <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={() => setItems([...items, { title: '', instructions: '', files: [] }])}><Plus size={13} /> Add a work item</button>}
        </div>

        <div>
          <span className="field-label">Files for the whole task <span className="normal-case tracking-normal text-fg-4">(only agents on this task see them)</span></span>
          {files.length > 0 && (
            <ul className="mb-2 space-y-1">
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="flex items-center gap-2 text-sm rounded-lg border border-line px-2.5 py-1.5">
                  <Paperclip size={13} className="text-fg-3 shrink-0" /><span className="truncate flex-1">{f.name}</span><span className="text-2xs text-fg-4">{fmtSize(f.size)}</span>
                  <button className="text-fg-4 hover:text-fg" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}><X size={13} /></button>
                </li>
              ))}
            </ul>
          )}
          <DropZone compact onFiles={(f) => setFiles((cur) => [...cur, ...f])} label={files.length ? 'Add more files' : 'Drop a screenshot, spec or script here, or browse'} />
          {problems.slice(0, 3).map((p) => <div key={p} className="text-xs text-bad mt-1.5">{p} — it will be skipped.</div>)}
        </div>

        <div className="flex items-end gap-6 flex-wrap">
          <div><span className="field-label">Priority</span><Segmented value={priority} options={['normal', 'urgent'] as const} onChange={setPriority} /></div>
          <label className="flex items-center gap-2 text-sm text-fg-2 cursor-pointer pb-1"><input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} /> Put on hold <span className="text-fg-4 text-xs">— keep it, but no agent works on it until you release it</span></label>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------- upload dock (Live activity)

/** The upload panel docked directly below the Live activity chat. */
export function UploadDock({ workspaceId, runId, mode, onClose, onDone }: { workspaceId: string; runId: string | null; mode: 'documents' | 'task'; onClose: () => void; onDone?: () => void }) {
  const { data: detail } = useQuery<any>(runId ? `/runs/${runId}` : null, [runId]);
  const tasks = (detail?.tasks ?? []).filter((t: any) => !['done', 'cancelled'].includes(t.status));
  const [audience, setAudience] = useState<Audience>('all');
  const [taskId, setTaskId] = useState('');
  const [tab, setTab] = useState<'files' | 'note'>('files');
  const [note, setNote] = useState({ title: '', text: '' });
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<Attachment[]>([]);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [mode]);
  useEffect(() => { if (mode === 'task' && !taskId && tasks[0]) setTaskId(tasks[0].id); }, [tasks.length, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const target = (): Target | null => (mode === 'task' ? (taskId ? { workspaceId, scope: 'task', taskId } : null) : audienceTarget(audience, workspaceId, runId));
  const add = async (files: File[]) => {
    const t = target();
    if (!t) { toast('Pick a task first', 'bad'); return; }
    setBusy(true);
    const stored = await uploadFiles(files, t);
    setBusy(false);
    if (stored.length) { setAdded((cur) => [...stored, ...cur].slice(0, 6)); onDone?.(); }
  };
  usePasteFiles(add, true);
  return (
    <section ref={ref} className="panel shrink-0 animate-rise" aria-label={mode === 'task' ? 'Attach files to a task' : 'Upload documents'}>
      <div className="flex items-center gap-2.5 px-4 h-11 border-b border-line">
        <UploadCloud size={15} className="text-fg-3" />
        <span className="text-sm font-medium text-fg">{mode === 'task' ? 'Attach files to a task' : 'Upload documents'}</span>
        <div className="ml-auto inline-flex p-0.5 rounded-md bg-sunken border border-line text-2xs">
          {(['files', 'note'] as const).map((t) => <button key={t} onClick={() => setTab(t)} className={`px-2.5 h-6 rounded ${tab === t ? 'bg-raised text-fg' : 'text-fg-3 hover:text-fg'}`}>{t === 'files' ? 'Files' : 'Write a note'}</button>)}
        </div>
        <button className="btn btn-ghost btn-icon btn-sm" aria-label="Close upload panel" onClick={onClose}><X size={14} /></button>
      </div>
      <div className="p-4 space-y-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="field-label !mb-0 shrink-0">{mode === 'task' ? 'Task' : 'Who should get it'}</span>
          <div className="flex-1 min-w-0">
            {mode === 'task'
              ? (tasks.length ? <Select className="input input-sm w-full" value={taskId} onChange={(e) => setTaskId(e.target.value)} aria-label="Task">{tasks.map((t: any) => <option key={t.id} value={t.id}>{t.title}</option>)}</Select> : <Muted>No open tasks yet.</Muted>)
              : <AudiencePicker value={audience} onChange={setAudience} runId={runId} />}
          </div>
        </div>
        <p className="text-2xs text-fg-4 leading-relaxed -mt-1">
          {mode === 'task' ? 'Only agents working that task see them.' : audience === 'all' ? 'Filed in documents/all-agents/ of the repository. Every agent is told it exists.' : audience === 'run' ? 'Filed under documents/runs/. Used by this run only.' : audience.startsWith('role:') ? `Filed in documents/${ROLE_DIR[audience.slice(5)] ?? audience.slice(5)}/. Agents acting in that role are told it exists.` : 'Only that agent is told it exists.'}
        </p>
        {tab === 'files' ? (
          <>
            <DropZone compact onFiles={add} busy={busy} label="Drop files here, browse, or paste a screenshot (Ctrl+V)" />
            {added.length > 0 && (
              <ul className="space-y-0.5">
                {added.map((a) => <li key={a.id} className="flex items-center gap-2 text-xs text-fg-2 min-w-0"><span className="text-ok">✓</span><span className="truncate">{a.name}</span>{a.location && <span className="mono text-fg-4 truncate">→ {a.location}</span>}</li>)}
              </ul>
            )}
          </>
        ) : (
          <div className="space-y-2">
            <input className="input input-sm w-full" placeholder="Name, e.g. coding-standards" aria-label="Note name" value={note.title} onChange={(e) => setNote({ ...note, title: e.target.value })} />
            <textarea className="input w-full min-h-[6rem] font-mono text-xs" placeholder="Write or paste Markdown…" aria-label="Note text" value={note.text} onChange={(e) => setNote({ ...note, text: e.target.value })} />
            <div className="flex justify-end"><button className="btn btn-primary btn-sm" disabled={!note.text.trim() || busy} onClick={async () => { await add([noteFile(note.title, note.text)]); setNote({ title: '', text: '' }); }}>Add note</button></div>
          </div>
        )}
      </div>
    </section>
  );
}

/** The + menu on Live activity. */
export function AddMenu({ workspaceId, runId, onChanged, onUpload }: { workspaceId: string; runId: string | null; onChanged?: () => void; onUpload: (mode: 'documents' | 'task') => void }) {
  const [open, setOpen] = useState(false);
  const [task, setTask] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const items: { key: 'task' | 'documents' | 'attach'; icon: React.ElementType; label: string; hint: string; needsRun?: boolean }[] = [
    { key: 'task', icon: ListPlus, label: 'Create a task', hint: 'Work items, instructions and files — agents pick it up when free', needsRun: true },
    { key: 'documents', icon: UploadCloud, label: 'Upload documents', hint: 'Specs, designs, standards — filed by who needs them' },
    { key: 'attach', icon: Paperclip, label: 'Attach files to a task', hint: 'Screenshots, specs, scripts', needsRun: true },
  ];
  return (
    <div className="relative" ref={box}>
      <button className="btn btn-primary btn-icon" aria-haspopup="menu" aria-expanded={open} aria-label="Add a task, reference or file" title="Add a task, reference or file" onClick={() => setOpen((o) => !o)}><Plus size={16} /></button>
      {open && (
        <div role="menu" className="animate-rise absolute right-0 top-full mt-2 z-40 w-80 rounded-xl border border-line-strong bg-surface shadow-pop p-1.5">
          {items.map((it) => {
            const off = !!it.needsRun && !runId;
            return (
              <button key={it.key} role="menuitem" disabled={off}
                onClick={() => { setOpen(false); if (it.key === 'task') setTask(true); else onUpload(it.key === 'attach' ? 'task' : 'documents'); }}
                className="w-full flex items-start gap-3 px-2.5 py-2 rounded-lg text-left hover:bg-raised disabled:opacity-45 disabled:hover:bg-transparent">
                <span className="w-7 h-7 shrink-0 rounded-md border border-line bg-sunken grid place-items-center text-fg-2"><it.icon size={14} /></span>
                <span className="min-w-0"><span className="block text-sm text-fg">{it.label}</span><span className="block text-2xs text-fg-4">{off ? 'Needs a run in progress' : it.hint}</span></span>
              </button>
            );
          })}
        </div>
      )}
      {task && runId && <NewTaskModal workspaceId={workspaceId} runId={runId} onClose={() => setTask(false)} onCreated={onChanged} />}
    </div>
  );
}
