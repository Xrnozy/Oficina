import React, { useState } from 'react';
import { del, get, post, put, useQuery } from '../api';
import { Avatar, Dot, Empty, Modal, PageHeader, Segmented, Skeleton, Tag, act, roleLabel, toast, toneOf } from '../components';
import { agentInOffice, downloadJson, fileSlug, readJsonFile, useOffice } from '../office';
import { ArrowRight, Building2, Copy, Download, GripVertical, Pencil, Plus, ShieldAlert, Trash2, Upload, X } from 'lucide-react';

// Offices: each office is a workspace with its own agents, desks (roles) and workflows. The page
// manages them — create, clone, rename, delete, export/import — and shows the chosen office's desks.
// Dropping an agent on a desk shows a permission diff preview first.

interface DragPayload { agentId: string }

// Roles that must not be held by the same agent in one room (spec §6.4).
const SOD_PAIRS: [string, string][] = [['developer', 'reviewer']];

type Dialog = { kind: 'new' } | { kind: 'rename' } | { kind: 'delete' } | null;

export default function Office() {
  const { offices, office, setOfficeId, reload: reloadOffices } = useOffice();
  const { data: agents, reload: reloadAgents } = useQuery<any[]>('/agents');
  const { data: roles } = useQuery<any[]>('/roles');
  const [pending, setPending] = useState<{ agent: any; role: any } | null>(null);
  const [choice, setChoice] = useState<'finish' | 'handoff' | 'abort'>('finish');
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);

  const refresh = () => { reloadOffices(); reloadAgents(); };

  if (!offices) return <Skeleton rows={4} />;
  if (!office) return <Empty icon={Building2} title="No offices yet" text="Create one to start." />;

  const mine = (agents ?? []).filter((a) => agentInOffice(a, office.id));
  const others = (agents ?? []).filter((a) => !agentInOffice(a, office.id));
  const countIn = (id: string) => (agents ?? []).filter((a) => agentInOffice(a, id)).length;
  const officeName = (id: string) => offices.find((o) => o.id === id)?.name;
  const whereIs = (a: any): string => {
    const names = (a.memberships ?? []).filter((m: any) => m.active).map((m: any) => officeName(m.workspace_id)).filter(Boolean);
    return names.length ? names.join(', ') : 'no office';
  };

  const sodConflict = (a: any) => {
    const held = (a.memberships ?? []).filter((m: any) => m.active && m.workspace_id === office.id).map((m: any) => m.role);
    return SOD_PAIRS.find(([x, y]) => held.includes(x) && held.includes(y));
  };

  const onDrop = (e: React.DragEvent, role: any) => {
    e.preventDefault();
    setDragOver(null);
    try {
      const p: DragPayload = JSON.parse(e.dataTransfer.getData('application/json'));
      const agent = agents?.find((a) => a.id === p.agentId);
      if (agent && role) { setChoice('finish'); setPending({ agent, role }); }
    } catch { /* not an agent card */ }
  };

  const diffFor = (agent: any, role: any) => {
    const gains = role?.allowedActions ?? [];
    const currentRoleId = agent.memberships?.find((m: any) => m.active && m.workspace_id === office.id)?.role_id;
    const currentRole = roles?.find((r) => r.id === currentRoleId);
    const had = currentRole?.allowedActions ?? [];
    return {
      from: currentRole?.name as string | undefined,
      added: gains.filter((a: string) => !had.includes(a)),
      kept: gains.filter((a: string) => had.includes(a)),
      lost: had.filter((a: string) => !gains.includes(a)),
      inFlight: agent.status === 'working' || agent.status === 'reviewing',
    };
  };

  const removeFromOffice = async (a: any) => {
    const ms = (a.memberships ?? []).filter((m: any) => m.active && m.workspace_id === office.id);
    let warned = 0;
    for (const m of ms) {
      const r = await act<{ workflowWarnings?: string[] }>(del(`/memberships/${m.id}`));
      warned += r?.workflowWarnings?.length ?? 0;
    }
    toast(`${a.name} removed from ${office.name}${warned ? ` — ${warned} workflow step${warned === 1 ? '' : 's'} used this agent` : ''}`, warned ? 'warn' : 'ok');
    refresh();
  };

  const exportOffice = async () => {
    const bundle = await act(get(`/workspaces/${office.id}/export`));
    if (bundle) downloadJson(`${fileSlug(office.name)}.office.json`, bundle);
  };

  const importOffice = async (f: File | undefined) => {
    if (!f) return;
    try {
      const bundle = await readJsonFile(f);
      const r = await act(post<{ id: string; warnings: string[] }>('/workspaces/import', { bundle }));
      if (!r) return;
      setOfficeId(r.id);
      refresh();
      toast(r.warnings.length ? `Imported with ${r.warnings.length} note${r.warnings.length === 1 ? '' : 's'}: ${r.warnings[0]}` : 'Office imported', r.warnings.length ? 'warn' : 'ok');
    } catch (e) { toast(String((e as Error).message), 'bad'); }
  };

  return (
    <div>
      <PageHeader title="Offices" sub="An office is its own set of agents, desks and workflows. Pick one in the sidebar and every page follows it; drag agents between desks to change what they may do.">
        <label className="btn cursor-pointer"><Upload size={14} /> Import
          <input type="file" accept=".json,application/json" className="hidden" onChange={(e) => { void importOffice(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        <button className="btn btn-primary" onClick={() => setDialog({ kind: 'new' })}><Plus size={14} /> New office</button>
      </PageHeader>

      <div role="tablist" aria-label="Offices" className="flex gap-1.5 flex-wrap mb-5">
        {offices.map((o) => (
          <button key={o.id} role="tab" aria-selected={o.id === office.id} onClick={() => setOfficeId(o.id)}
            className={`h-8 px-3 rounded-lg border text-[13px] flex items-center gap-2 transition-colors ${o.id === office.id ? 'bg-fg text-canvas border-fg font-medium' : 'border-line text-fg-2 hover:border-line-strong hover:text-fg'}`}>
            {o.name}
            <span className={`num text-2xs ${o.id === office.id ? 'opacity-70' : 'text-fg-4'}`}>{countIn(o.id)}</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_300px] gap-5 items-start">
        <section className="panel">
          <div className="flex items-center gap-2.5 px-5 pt-4 pb-1 flex-wrap">
            <div className="w-8 h-8 rounded-lg bg-raised border border-line grid place-items-center"><Building2 size={15} strokeWidth={1.75} className="text-fg-3" /></div>
            <div className="min-w-0 flex-1">
              <h2 className="text-[15px] font-semibold">{office.name}</h2>
              <div className="text-xs text-fg-3 truncate">{office.purpose || 'No description.'}</div>
            </div>
            <div className="flex items-center gap-1">
              <button className="btn btn-ghost btn-xs" onClick={() => setDialog({ kind: 'rename' })} title="Rename or describe this office"><Pencil size={12} /> Rename</button>
              <button className="btn btn-ghost btn-xs" onClick={exportOffice} title="Download this office's agents and workflows as a file"><Download size={12} /> Export</button>
              <button className="btn btn-ghost btn-xs" onClick={() => setDialog({ kind: 'delete' })} title="Delete this office"><Trash2 size={12} /> Delete</button>
            </div>
          </div>
          <div className="px-5 pb-1 flex gap-1.5 flex-wrap">
            <Tag>{mine.length} agent{mine.length === 1 ? '' : 's'}</Tag>
            {office.memory_scope === 'isolated' && <Tag>isolated memory</Tag>}
            {(office.repoIds ?? []).map((r: string) => <Tag key={r} mono>{r}</Tag>)}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-4">
            {(roles ?? []).map((role) => {
              const here = mine.filter((a) => a.memberships.some((m: any) => m.role_id === role.id && m.active && m.workspace_id === office.id));
              const key = role.id;
              const over = dragOver === key;
              return (
                <div key={role.id}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOver !== key) setDragOver(key); }}
                  onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null); }}
                  onDrop={(e) => onDrop(e, role)}
                  className={`rounded-xl border px-3.5 py-3 min-h-[92px] transition-colors ${over ? 'border-accent/70 bg-accent/[0.06] border-solid' : 'border-line border-dashed bg-sunken/40'}`}>
                  <div className="flex items-baseline gap-2 mb-2.5">
                    <span className="text-sm font-medium text-fg">{roleLabel(role.name)}</span>
                    <span className="text-2xs text-fg-4" title={(role.allowedActions ?? []).join('\n')}>{(role.allowedActions ?? []).length} permissions</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {here.map((a) => <AgentCard key={a.id} a={a} conflict={sodConflict(a)} onRemove={() => void removeFromOffice(a)} />)}
                    {!here.length && <span className={`text-xs ${over ? 'text-accent' : 'text-fg-4'}`}>{over ? 'Release to preview the move' : 'Empty desk'}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <aside className="space-y-4 xl:sticky xl:top-4">
          <section className="panel p-4">
            <h2 className="text-[13px] font-medium text-fg mb-1">Available agents <span className="text-fg-4 num">{others.length}</span></h2>
            <p className="text-xs text-fg-3 mb-3">Not in {office.name}. Drag one onto a desk to add it here.</p>
            <div className="space-y-2">
              {others.map((a) => <AgentCard key={a.id} a={a} sub={whereIs(a)} />)}
              {!others.length && <p className="text-xs text-fg-4">Every agent is already in this office.</p>}
            </div>
          </section>
          <div className="rounded-xl border border-line p-4 flex gap-3">
            <ShieldAlert size={16} className="shrink-0 mt-0.5 text-warn" />
            <p className="text-xs text-fg-3 leading-relaxed">Separation of duties is enforced at assignment: an author can't review their own work, and a reviewer can't fix what they reviewed. Cards outlined in red hold conflicting roles.</p>
          </div>
        </aside>
      </div>

      {dialog?.kind === 'new' && <NewOfficeDialog offices={offices} defaultFrom={office.id} onClose={() => setDialog(null)}
        onCreated={(id) => { setDialog(null); setOfficeId(id); refresh(); }} />}
      {dialog?.kind === 'rename' && <RenameDialog office={office} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); refresh(); }} />}
      {dialog?.kind === 'delete' && (
        <Modal title={`Delete ${office.name}?`} onClose={() => setDialog(null)} footer={<>
          <button className="btn btn-ghost" onClick={() => setDialog(null)}>Cancel</button>
          <button className="btn btn-danger" onClick={async () => {
            const next = offices.find((o) => o.id !== office.id);
            const r = await act(del(`/workspaces/${office.id}`), `${office.name} deleted`);
            if (r) { setDialog(null); if (next) setOfficeId(next.id); refresh(); }
          }}>Delete office</button>
        </>}>
          <p className="text-sm text-fg-2">Its desks and workflows are removed. The agents stay and become available to other offices. An office that has runs can't be deleted, because the runs are kept for the record.</p>
        </Modal>
      )}

      {pending && (() => {
        const d = diffFor(pending.agent, pending.role);
        const joining = !agentInOffice(pending.agent, office.id);
        return (
          <Modal title={joining ? 'Add agent to office' : 'Move agent'} onClose={() => setPending(null)} footer={<>
            <button className="btn btn-ghost" onClick={() => setPending(null)}>Cancel</button>
            <button className="btn btn-accent" onClick={async () => {
              const r = await act(post(`/agents/${pending.agent.id}/move`, { workspaceId: office.id, roleId: pending.role.id, inFlightChoice: choice }), `${pending.agent.name} ${joining ? 'added to' : 'moved to'} ${pending.role.name}`);
              if (r) { setPending(null); refresh(); }
            }}>{joining ? 'Add to office' : 'Confirm move'}</button>
          </>}>
            <div className="flex items-center gap-3 p-3 rounded-xl bg-sunken border border-line mb-4">
              <Avatar agent={pending.agent} />
              <div className="text-sm min-w-0">
                <div className="text-fg font-medium">{pending.agent.name}</div>
                <div className="text-xs text-fg-3 flex items-center gap-1.5">{d.from ? roleLabel(d.from) : joining ? `from ${whereIs(pending.agent)}` : 'Unassigned'} <ArrowRight size={11} /> <span className="text-fg">{roleLabel(pending.role.name)}</span> · {office.name}</div>
              </div>
            </div>
            <div className="space-y-3.5 text-sm">
              <DiffRow label="Gains" tone="ok" items={d.added} empty="nothing new" />
              {!!d.lost.length && <DiffRow label="Loses" tone="bad" items={d.lost} />}
              {!!d.kept.length && <DiffRow label="Keeps" tone="idle" items={d.kept} />}
              {joining && <p className="text-xs text-fg-4">The agent keeps its desk in {whereIs(pending.agent)}; it is shared between the offices until you remove it from one.</p>}
              {d.inFlight && (
                <div className="pt-1">
                  <div className="field-label">In-flight task</div>
                  <Segmented value={choice} options={['finish', 'handoff', 'abort'] as const} onChange={setChoice} />
                  <p className="text-xs text-fg-4 mt-1.5">{choice === 'finish' ? 'Finish the current task under the old role, then move.' : choice === 'handoff' ? 'Hand the task to another eligible agent now.' : 'Abort the task; its branch is kept for reference.'}</p>
                </div>
              )}
            </div>
          </Modal>
        );
      })()}
    </div>
  );
}

function NewOfficeDialog({ offices, defaultFrom, onClose, onCreated }: { offices: { id: string; name: string }[]; defaultFrom: string; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [from, setFrom] = useState<string>('');   // '' = blank
  const [busy, setBusy] = useState(false);
  const source = offices.find((o) => o.id === from);
  return (
    <Modal title="New office" onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!name.trim() || busy} onClick={async () => {
        setBusy(true);
        const r = await act(post<{ id: string; warnings: string[] }>('/workspaces', { name: name.trim(), purpose: purpose.trim(), cloneFrom: from || undefined }), `${name.trim()} created`);
        setBusy(false);
        if (r) { if (r.warnings.length) toast(r.warnings[0], 'warn'); onCreated(r.id); }
      }}>{busy ? 'Creating…' : 'Create office'}</button>
    </>}>
      <div className="space-y-4">
        <label className="block">
          <span className="field-label">Name</span>
          <input className="input w-full" autoFocus placeholder="e.g. Docs team" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className="field-label">What is it for? <span className="text-fg-4 font-normal">(optional)</span></span>
          <input className="input w-full" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
        </label>
        <div>
          <span className="field-label">Start from</span>
          <Segmented value={from ? 'copy' : 'blank'} options={['blank', 'copy'] as const} onChange={(v) => setFrom(v === 'copy' ? defaultFrom : '')} />
          {from && (
            <select className="input w-full mt-2" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Office to copy">
              {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
          <p className="text-xs text-fg-4 mt-2 flex items-start gap-1.5">
            {from ? <Copy size={12} className="mt-0.5 shrink-0" /> : <Building2 size={12} className="mt-0.5 shrink-0" />}
            {from
              ? `Copies ${source?.name}'s agents, desks and workflows. The agents are new ones — changing them here never touches ${source?.name}.`
              : 'No agents and only the built-in pipeline. Hire agents or add existing ones, then build a workflow.'}
          </p>
        </div>
      </div>
    </Modal>
  );
}

function RenameDialog({ office, onClose, onSaved }: { office: { id: string; name: string; purpose: string }; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(office.name);
  const [purpose, setPurpose] = useState(office.purpose ?? '');
  return (
    <Modal title="Rename office" onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!name.trim()} onClick={async () => {
        const r = await act(put(`/workspaces/${office.id}`, { name: name.trim(), purpose: purpose.trim() }), 'Saved');
        if (r) onSaved();
      }}>Save</button>
    </>}>
      <div className="space-y-4">
        <label className="block"><span className="field-label">Name</span><input className="input w-full" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="block"><span className="field-label">Description</span><input className="input w-full" value={purpose} onChange={(e) => setPurpose(e.target.value)} /></label>
      </div>
    </Modal>
  );
}

function AgentCard({ a, conflict, sub, onRemove }: { a: any; conflict?: [string, string]; sub?: string; onRemove?: () => void }) {
  return (
    <div draggable
      onDragStart={(e) => { e.dataTransfer.setData('application/json', JSON.stringify({ agentId: a.id } satisfies DragPayload)); e.dataTransfer.effectAllowed = 'move'; }}
      className={`group flex items-center gap-2 bg-raised border rounded-lg pl-1 pr-2.5 py-1.5 cursor-grab active:cursor-grabbing active:scale-[0.98] hover:border-line-strong transition-[border-color,transform] ${conflict ? 'border-bad/50' : 'border-line'}`}
      title={conflict ? `Separation-of-duties conflict: holds both ${conflict.join(' and ')}` : `Drag ${a.name} to a desk`}>
      <GripVertical size={13} className="text-fg-4 group-hover:text-fg-3 shrink-0" />
      <Avatar agent={a} size="sm" />
      <span className="min-w-0">
        <span className="block text-sm text-fg leading-tight truncate">{a.name}</span>
        {sub && <span className="block text-2xs text-fg-4 leading-tight truncate">{sub}</span>}
      </span>
      <Dot tone={toneOf(a.status)} live={a.status === 'working'} />
      {conflict && <ShieldAlert size={13} className="text-bad" />}
      {onRemove && (
        <button className="ml-0.5 -mr-1 p-0.5 rounded text-fg-4 hover:text-bad opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity" aria-label={`Remove ${a.name} from this office`} title="Remove from this office"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}><X size={12} /></button>
      )}
    </div>
  );
}

function DiffRow({ label, tone, items, empty }: { label: string; tone: 'ok' | 'bad' | 'idle'; items: string[]; empty?: string }) {
  return (
    <div>
      <div className="field-label">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((g) => <Tag key={g} tone={tone} mono>{tone === 'ok' ? '+ ' : tone === 'bad' ? '− ' : ''}{g}</Tag>)}
        {!items.length && <span className="text-xs text-fg-4">{empty}</span>}
      </div>
    </div>
  );
}
