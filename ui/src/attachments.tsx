import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { del, post, useQuery } from './api';
import { Modal, Muted, Panel, Segmented, Tag, act, fmtAgo, toast } from './components';
import { Select } from './Select';
import { useOfficeAgents } from './office';
import {
  File as FileIcon, FileCode, FileImage, FileJson, FileText, ListPlus, Paperclip, Plus, RefreshCw, Trash2, UploadCloud, X,
} from 'lucide-react';

// Reference files and task attachments: the upload helpers, the drop target, and the pieces every page shares.
// Files are stored by the daemon (outside any repository) and agents get a short list of what exists — they open
// only what their work needs.

export interface Attachment {
  id: string; workspaceId: string; runId: string | null; scope: 'project' | 'agent' | 'task'; agentId: string | null; taskId: string | null;
  name: string; mime: string; size: number; kind: 'markdown' | 'text' | 'code' | 'image' | 'document' | 'data'; summary: string; createdAt: string; updatedAt: string;
}
export interface Target { workspaceId: string; scope: 'project' | 'agent' | 'task'; agentId?: string | null; taskId?: string | null; runId?: string | null }

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
    try { const r = await send(`/attachments?${qs}`, 'POST', f); stored.push(r.attachment); if (r.updated) updated++; }
    catch (e) { failed.push(`${f.name}: ${String((e as Error).message ?? e)}`); }
  }
  failed.slice(0, 3).forEach((m) => toast(m, 'bad'));
  if (failed.length > 3) toast(`…and ${failed.length - 3} more could not be added`, 'bad');
  if (!opts.quiet && stored.length) toast(stored.length === 1 ? `${stored[0].name} ${updated ? 'updated' : 'added'}` : `${stored.length} files added${updated ? ` (${updated} updated)` : ''}`);
  return stored;
}

export async function replaceFile(id: string, f: File): Promise<boolean> {
  const bad = precheck(f);
  if (bad) { toast(bad, 'bad'); return false; }
  try { await send(`/attachments/${id}`, 'PUT', f); toast(`${f.name} updated`); return true; }
  catch (e) { toast(String((e as Error).message ?? e), 'bad'); return false; }
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

const SCOPE_TAG: Record<string, string> = { project: 'all agents', agent: 'one agent', task: 'this task' };

/** One stored file: open it, replace its content, remove it. */
export function AttachmentRow({ a, agentName, onChanged, showScope = true }: { a: Attachment; agentName?: string; onChanged: () => void; showScope?: boolean }) {
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
          {showScope && <Tag tone={a.scope === 'project' ? 'info' : 'idle'}>{a.scope === 'agent' && agentName ? agentName : SCOPE_TAG[a.scope]}{a.runId && a.scope === 'project' ? ' · this run' : ''}</Tag>}
        </div>
        <div className="text-2xs text-fg-4 truncate">{fmtSize(a.size)} · {a.summary || a.kind} · {a.updatedAt !== a.createdAt ? `updated ${fmtAgo(a.updatedAt)}` : fmtAgo(a.createdAt)}</div>
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
export function TaskFiles({ taskId, workspaceId, readOnly = false }: { taskId: string; workspaceId: string; readOnly?: boolean }) {
  const { data, reload } = useQuery<Attachment[]>(`/attachments?taskId=${taskId}`, [taskId]);
  const [busy, setBusy] = useState(false);
  const add = async (files: File[]) => { setBusy(true); await uploadFiles(files, { workspaceId, scope: 'task', taskId }); setBusy(false); reload(); };
  const list = data ?? [];
  return (
    <div>
      {list.length === 0 && <div className="mb-3"><Muted>Nothing attached. Agents working this task see what you add here — a screenshot of a bug, a spec, a script.</Muted></div>}
      {list.length > 0 && <ul className="-mx-2 mb-2">{list.map((a) => <AttachmentRow key={a.id} a={a} showScope={false} onChanged={reload} />)}</ul>}
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

type Audience = 'all' | 'run' | string;   // 'all' = the whole office, 'run' = only the current run, else an agent id

/** The office's reference files, split into project-wide and agent-specific, with add, replace and remove. */
export function ReferencesPanel({ workspaceId, runId, officeName }: { workspaceId: string; runId?: string | null; officeName?: string }) {
  const { agents } = useOfficeAgents();
  const { data, reload } = useQuery<Attachment[]>(`/attachments?workspaceId=${workspaceId}`, [workspaceId]);
  const [audience, setAudience] = useState<Audience>('all');
  const [busy, setBusy] = useState(false);
  const members = (agents ?? []).filter((a: any) => (a.memberships ?? []).some((m: any) => m.active));
  const nameOf = (id: string | null) => members.find((a: any) => a.id === id)?.name ?? (agents ?? []).find((a: any) => a.id === id)?.name;
  const refs = (data ?? []).filter((a) => a.scope !== 'task');
  const project = refs.filter((a) => a.scope === 'project');
  const byAgent = refs.filter((a) => a.scope === 'agent');
  const add = async (files: File[]) => {
    setBusy(true);
    const t: Target = audience === 'all' ? { workspaceId, scope: 'project' } : audience === 'run' ? { workspaceId, scope: 'project', runId } : { workspaceId, scope: 'agent', agentId: audience };
    await uploadFiles(files, t);
    setBusy(false); reload();
  };
  return (
    <Panel title={<>Reference files{refs.length > 0 && <span className="ml-2 chip">{refs.length}</span>}</>}
      action={<span className="text-2xs text-fg-4 hidden sm:inline">agents get a short list and open only what applies</span>} bodyClass="px-4 pb-4">
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-5 [&>*]:min-w-0">
        <div className="space-y-4">
          <div>
            <div className="eyebrow mb-1">Project-wide · every agent{officeName ? ` in ${officeName}` : ''}</div>
            {project.length === 0 && <Muted>None yet. Add a design.md, spec.md or coding standards and every agent is told they exist.</Muted>}
            <ul className="-mx-2">{project.map((a) => <AttachmentRow key={a.id} a={a} onChanged={reload} />)}</ul>
          </div>
          <div>
            <div className="eyebrow mb-1">Agent-specific</div>
            {byAgent.length === 0 && <Muted>None. Use these for what only one agent needs, such as the developer's coding standards.</Muted>}
            <ul className="-mx-2">{byAgent.map((a) => <AttachmentRow key={a.id} a={a} agentName={nameOf(a.agentId)} onChanged={reload} />)}</ul>
          </div>
        </div>
        <div className="rounded-xl border border-line bg-raised/40 p-3.5 self-start space-y-3">
          <label className="block">
            <span className="field-label">Who should get it</span>
            <Select className="input input-sm w-full" value={audience} onChange={(e) => setAudience(e.target.value)}>
              <option value="all">Every agent (project-wide)</option>
              {runId && <option value="run">Every agent, this run only</option>}
              {members.map((a: any) => <option key={a.id} value={a.id}>Only {a.name}</option>)}
            </Select>
          </label>
          <DropZone onFiles={add} busy={busy} />
          <p className="text-2xs text-fg-4 leading-relaxed">Re-adding a file with the same name updates it. A new or changed file is announced to the PM and reaches agents with their next prompt — nothing running is restarted.</p>
        </div>
      </div>
    </Panel>
  );
}

/** Create a task for the running agents, optionally with files already attached. */
export function NewTaskModal({ workspaceId, runId, initialFiles = [], onClose, onCreated }: { workspaceId: string; runId: string; initialFiles?: File[]; onClose: () => void; onCreated?: (taskId: string) => void }) {
  const [title, setTitle] = useState(() => (initialFiles[0] ? `Look into ${initialFiles[0].name.replace(/\.[^.]+$/, '')}` : ''));
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<File[]>(initialFiles);
  const [priority, setPriority] = useState<'normal' | 'urgent'>('normal');
  const [busy, setBusy] = useState(false);
  const problems = files.map(precheck).filter(Boolean) as string[];
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    const t = await act(post(`/runs/${runId}/tasks`, { title: title.trim(), description: description.trim(), priority: priority === 'urgent' ? 0 : 1 }), 'Task created — the next free agent picks it up');
    if (t?.id) {
      if (files.length) await uploadFiles(files.filter((f) => !precheck(f)), { workspaceId, scope: 'task', taskId: t.id }, { quiet: true });
      onCreated?.(t.id); onClose();
    }
    setBusy(false);
  };
  return (
    <Modal title="New task" onClose={onClose} width="max-w-xl"
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!title.trim() || busy} onClick={submit}>{busy ? 'Creating…' : 'Create task'}</button></>}>
      <div className="space-y-4">
        <p className="text-sm text-fg-2">Add work to the run in progress. The PM reviews the brief, then whichever eligible agent is free takes it — running work isn't interrupted.</p>
        <label className="block"><span className="field-label">Title</span>
          <input className="input w-full" autoFocus value={title} maxLength={200} placeholder="e.g. Fix the login button misalignment" onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }} /></label>
        <label className="block"><span className="field-label">What should happen <span className="normal-case tracking-normal text-fg-4">(optional)</span></span>
          <textarea className="input w-full min-h-[5.5rem]" value={description} placeholder="Describe the problem or the change. Attach a screenshot, a spec or a script below." onChange={(e) => setDescription(e.target.value)} /></label>
        <div>
          <span className="field-label">Priority</span>
          <Segmented value={priority} options={['normal', 'urgent'] as const} onChange={setPriority} />
        </div>
        <div>
          <span className="field-label">Files <span className="normal-case tracking-normal text-fg-4">(only agents on this task see them)</span></span>
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
          <DropZone compact onFiles={(f) => setFiles((cur) => [...cur, ...f])} label={files.length ? 'Add more files' : undefined} />
          {problems.map((p) => <div key={p} className="text-xs text-bad mt-1.5">{p} — it will be skipped.</div>)}
        </div>
      </div>
    </Modal>
  );
}

/** Attach files to a chosen task, or to an agent / the office as references. */
export function AddFilesModal({ workspaceId, runId, mode, onClose, onDone }: { workspaceId: string; runId: string | null; mode: 'reference' | 'task'; onClose: () => void; onDone?: () => void }) {
  const { agents } = useOfficeAgents();
  const { data: detail } = useQuery<any>(runId ? `/runs/${runId}` : null, [runId]);
  const tasks = (detail?.tasks ?? []).filter((t: any) => !['done', 'cancelled'].includes(t.status));
  const members = (agents ?? []).filter((a: any) => (a.memberships ?? []).some((m: any) => m.active));
  const [target, setTarget] = useState(mode === 'task' ? '' : 'all');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (mode === 'task' && !target && tasks[0]) setTarget(tasks[0].id); }, [tasks.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = async () => {
    setBusy(true);
    const t: Target = mode === 'task' ? { workspaceId, scope: 'task', taskId: target }
      : target === 'all' ? { workspaceId, scope: 'project' } : target === 'run' ? { workspaceId, scope: 'project', runId } : { workspaceId, scope: 'agent', agentId: target };
    const stored = await uploadFiles(files, t);
    setBusy(false);
    if (stored.length) { onDone?.(); onClose(); }
  };
  return (
    <Modal title={mode === 'task' ? 'Attach files to a task' : 'Add reference files'} onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!files.length || !target || busy} onClick={go}>{busy ? 'Uploading…' : `Add ${files.length || ''} file${files.length === 1 ? '' : 's'}`}</button></>}>
      <div className="space-y-4">
        <label className="block">
          <span className="field-label">{mode === 'task' ? 'Task' : 'Who should get it'}</span>
          {mode === 'task' ? (
            tasks.length ? <Select className="input w-full" value={target} onChange={(e) => setTarget(e.target.value)}>{tasks.map((t: any) => <option key={t.id} value={t.id}>{t.title}</option>)}</Select>
              : <Muted>There are no open tasks. Create one first.</Muted>
          ) : (
            <Select className="input w-full" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="all">Every agent (project-wide)</option>
              {runId && <option value="run">Every agent, this run only</option>}
              {members.map((a: any) => <option key={a.id} value={a.id}>Only {a.name}</option>)}
            </Select>
          )}
        </label>
        {files.length > 0 && (
          <ul className="space-y-1">{files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-2 text-sm rounded-lg border border-line px-2.5 py-1.5">
              <Paperclip size={13} className="text-fg-3 shrink-0" /><span className="truncate flex-1">{f.name}</span><span className="text-2xs text-fg-4">{fmtSize(f.size)}</span>
              <button className="text-fg-4 hover:text-fg" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}><X size={13} /></button>
            </li>))}</ul>
        )}
        <DropZone onFiles={(f) => setFiles((cur) => [...cur, ...f])} />
        {mode === 'reference' && <p className="text-xs text-fg-3">Manage or remove references any time under <Link to="/" className="underline underline-offset-2" onClick={onClose}>Dashboard → Reference files</Link>.</p>}
      </div>
    </Modal>
  );
}

/** The + menu on Live activity. */
export function AddMenu({ workspaceId, runId, onChanged }: { workspaceId: string; runId: string | null; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<null | 'task' | 'reference' | 'attach' | 'upload'>(null);
  const box = useRef<HTMLDivElement>(null);
  const quick = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const pick = (d: typeof dialog) => { setOpen(false); setDialog(d); };
  const items: { key: NonNullable<typeof dialog>; icon: React.ElementType; label: string; hint: string; needsRun?: boolean }[] = [
    { key: 'task', icon: ListPlus, label: 'Create a task', hint: 'Agents pick it up when free', needsRun: true },
    { key: 'reference', icon: FileText, label: 'Add reference files', hint: 'To every agent, one agent, or this run', },
    { key: 'attach', icon: Paperclip, label: 'Attach files to a task', hint: 'Screenshots, specs, scripts', needsRun: true },
    { key: 'upload', icon: UploadCloud, label: 'Upload project documents', hint: 'Quick add, project-wide' },
  ];
  return (
    <div className="relative" ref={box}>
      <button className="btn btn-primary btn-icon" aria-haspopup="menu" aria-expanded={open} aria-label="Add a task, reference or file" title="Add a task, reference or file" onClick={() => setOpen((o) => !o)}><Plus size={16} /></button>
      {open && (
        <div role="menu" className="animate-rise absolute right-0 top-full mt-2 z-40 w-72 rounded-xl border border-line-strong bg-surface shadow-pop p-1.5">
          {items.map((it) => {
            const off = !!it.needsRun && !runId;
            return (
              <button key={it.key} role="menuitem" disabled={off} onClick={() => (it.key === 'upload' ? (setOpen(false), quick.current?.click()) : pick(it.key))}
                className="w-full flex items-start gap-3 px-2.5 py-2 rounded-lg text-left hover:bg-raised disabled:opacity-45 disabled:hover:bg-transparent">
                <span className="w-7 h-7 shrink-0 rounded-md border border-line bg-sunken grid place-items-center text-fg-2"><it.icon size={14} /></span>
                <span className="min-w-0"><span className="block text-sm text-fg">{it.label}</span><span className="block text-2xs text-fg-4">{off ? 'Needs a run in progress' : it.hint}</span></span>
              </button>
            );
          })}
        </div>
      )}
      <input ref={quick} type="file" multiple accept={ACCEPT} className="hidden" onChange={async (e) => {
        const f = Array.from(e.target.files ?? []); e.target.value = '';
        if (f.length && (await uploadFiles(f, { workspaceId, scope: 'project' })).length) onChanged?.();
      }} />
      {dialog === 'task' && runId && <NewTaskModal workspaceId={workspaceId} runId={runId} onClose={() => setDialog(null)} onCreated={onChanged} />}
      {dialog === 'reference' && <AddFilesModal workspaceId={workspaceId} runId={runId} mode="reference" onClose={() => setDialog(null)} onDone={onChanged} />}
      {dialog === 'attach' && <AddFilesModal workspaceId={workspaceId} runId={runId} mode="task" onClose={() => setDialog(null)} onDone={onChanged} />}
    </div>
  );
}
