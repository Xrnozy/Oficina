import React, { useState } from 'react';
import { post, useQuery } from '../api';
import { Avatar, Dot, Empty, Modal, PageHeader, Segmented, Skeleton, Tag, act, roleLabel, toneOf } from '../components';
import { ArrowRight, Building2, GripVertical, ShieldAlert } from 'lucide-react';

// Office view (spec §9): rooms = workspaces, agents = draggable cards.
// Dropping an agent on a room/role shows a permission diff preview first.

interface DragPayload { agentId: string }

// Roles that must not be held by the same agent in one room (spec §6.4).
const SOD_PAIRS: [string, string][] = [['developer', 'reviewer']];

export default function Office() {
  const { data: workspaces, reload, loading } = useQuery<any[]>('/workspaces');
  const { data: agents, reload: reloadAgents } = useQuery<any[]>('/agents');
  const { data: roles } = useQuery<any[]>('/roles');
  const [pending, setPending] = useState<{ agent: any; ws: any; role: any } | null>(null);
  const [choice, setChoice] = useState<'finish' | 'handoff' | 'abort'>('finish');
  const [dragOver, setDragOver] = useState<string | null>(null);

  const refresh = () => { reload(); reloadAgents(); };

  const agentsInRoom = (wsId: string) => (agents ?? []).filter((a) => a.memberships?.some((m: any) => m.workspace_id === wsId && m.active));
  const unassigned = (agents ?? []).filter((a) => !a.memberships?.some((m: any) => m.active));

  const sodConflict = (a: any, wsId: string) => {
    const held = (a.memberships ?? []).filter((m: any) => m.active && m.workspace_id === wsId).map((m: any) => m.role);
    return SOD_PAIRS.find(([x, y]) => held.includes(x) && held.includes(y));
  };

  const onDrop = (e: React.DragEvent, ws: any, role: any) => {
    e.preventDefault();
    setDragOver(null);
    try {
      const p: DragPayload = JSON.parse(e.dataTransfer.getData('application/json'));
      const agent = agents?.find((a) => a.id === p.agentId);
      if (agent && role) { setChoice('finish'); setPending({ agent, ws, role }); }
    } catch { /* not an agent card */ }
  };

  const diffFor = (agent: any, role: any) => {
    const gains = role?.allowedActions ?? [];
    const currentRoleId = agent.memberships?.find((m: any) => m.active)?.role_id;
    const currentRole = roles?.find((r) => r.id === currentRoleId);
    const had = currentRole?.allowedActions ?? [];
    return {
      from: currentRole?.name,
      added: gains.filter((a: string) => !had.includes(a)),
      kept: gains.filter((a: string) => had.includes(a)),
      lost: had.filter((a: string) => !gains.includes(a)),
      inFlight: agent.status === 'working' || agent.status === 'reviewing',
    };
  };

  if (loading) return <Skeleton rows={4} />;

  return (
    <div>
      <PageHeader title="Office" sub="Each room is a workspace; each desk is a role. Drag an agent to a desk to move it — you'll see exactly which permissions change before anything happens." />

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_300px] gap-5 items-start">
        <div className="space-y-5">
          {workspaces?.map((ws) => (
            <section key={ws.id} className="panel">
              <div className="flex items-center gap-2.5 px-5 pt-4 pb-1">
                <div className="w-8 h-8 rounded-lg bg-raised border border-line grid place-items-center"><Building2 size={15} strokeWidth={1.75} className="text-fg-3" /></div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[15px] font-semibold">{ws.name}</h2>
                  <div className="text-xs text-fg-3 truncate">{ws.purpose}</div>
                </div>
                {ws.memory_scope === 'isolated' && <Tag>isolated memory</Tag>}
                {(ws.repoIds ?? []).map((r: string) => <Tag key={r} mono>{r}</Tag>)}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-4">
                {(roles ?? []).map((role) => {
                  const here = agentsInRoom(ws.id).filter((a) => a.memberships.some((m: any) => m.role_id === role.id && m.active && m.workspace_id === ws.id));
                  const key = `${ws.id}:${role.id}`;
                  const over = dragOver === key;
                  return (
                    <div key={role.id}
                      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOver !== key) setDragOver(key); }}
                      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null); }}
                      onDrop={(e) => onDrop(e, ws, role)}
                      className={`rounded-xl border px-3.5 py-3 min-h-[92px] transition-colors ${over ? 'border-accent/70 bg-accent/[0.06] border-solid' : 'border-line border-dashed bg-sunken/40'}`}>
                      <div className="flex items-baseline gap-2 mb-2.5">
                        <span className="text-sm font-medium text-fg">{roleLabel(role.name)}</span>
                        <span className="text-2xs text-fg-4" title={(role.allowedActions ?? []).join('\n')}>{(role.allowedActions ?? []).length} permissions</span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {here.map((a) => <AgentCard key={a.id} a={a} conflict={sodConflict(a, ws.id)} />)}
                        {!here.length && <span className={`text-xs ${over ? 'text-accent' : 'text-fg-4'}`}>{over ? 'Release to preview the move' : 'Empty desk'}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <aside className="space-y-4 xl:sticky xl:top-4">
          <section className="panel p-4">
            <h2 className="text-[13px] font-medium text-fg mb-3">Unassigned <span className="text-fg-4 num">{unassigned.length}</span></h2>
            <div className="flex flex-wrap gap-2">
              {unassigned.map((a) => <AgentCard key={a.id} a={a} />)}
              {!unassigned.length && <p className="text-xs text-fg-4">Everyone has a desk.</p>}
            </div>
          </section>
          <div className="rounded-xl border border-line p-4 flex gap-3">
            <ShieldAlert size={16} className="shrink-0 mt-0.5 text-warn" />
            <p className="text-xs text-fg-3 leading-relaxed">Separation of duties is enforced at assignment: an author can't review their own work, and a reviewer can't fix what they reviewed. Cards outlined in red hold conflicting roles.</p>
          </div>
        </aside>
      </div>

      {!workspaces?.length && <Empty icon={Building2} title="No rooms yet" text="Seed the demo workspace with npm run seed, or create a workspace through the API." />}

      {pending && (() => {
        const d = diffFor(pending.agent, pending.role);
        return (
          <Modal title="Move agent" onClose={() => setPending(null)} footer={<>
            <button className="btn btn-ghost" onClick={() => setPending(null)}>Cancel</button>
            <button className="btn btn-accent" onClick={async () => {
              const r = await act(post(`/agents/${pending.agent.id}/move`, { workspaceId: pending.ws.id, roleId: pending.role.id, inFlightChoice: choice }), `${pending.agent.name} moved to ${pending.role.name}`);
              if (r) { setPending(null); refresh(); }
            }}>Confirm move</button>
          </>}>
            <div className="flex items-center gap-3 p-3 rounded-xl bg-sunken border border-line mb-4">
              <Avatar agent={pending.agent} />
              <div className="text-sm min-w-0">
                <div className="text-fg font-medium">{pending.agent.name}</div>
                <div className="text-xs text-fg-3 flex items-center gap-1.5">{d.from ? roleLabel(d.from) : 'Unassigned'} <ArrowRight size={11} /> <span className="text-fg">{roleLabel(pending.role.name)}</span> · {pending.ws.name}</div>
              </div>
            </div>
            <div className="space-y-3.5 text-sm">
              <DiffRow label="Gains" tone="ok" items={d.added} empty="nothing new" />
              {!!d.lost.length && <DiffRow label="Loses" tone="bad" items={d.lost} />}
              {!!d.kept.length && <DiffRow label="Keeps" tone="idle" items={d.kept} />}
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

function AgentCard({ a, conflict }: { a: any; conflict?: [string, string] }) {
  return (
    <div draggable
      onDragStart={(e) => { e.dataTransfer.setData('application/json', JSON.stringify({ agentId: a.id } satisfies DragPayload)); e.dataTransfer.effectAllowed = 'move'; }}
      className={`group flex items-center gap-2 bg-raised border rounded-lg pl-1 pr-2.5 py-1.5 cursor-grab active:cursor-grabbing active:scale-[0.98] hover:border-line-strong transition-[border-color,transform] ${conflict ? 'border-bad/50' : 'border-line'}`}
      title={conflict ? `Separation-of-duties conflict: holds both ${conflict.join(' and ')}` : `Drag ${a.name} to another role`}>
      <GripVertical size={13} className="text-fg-4 group-hover:text-fg-3" />
      <Avatar agent={a} size="sm" />
      <span className="text-sm text-fg">{a.name}</span>
      <Dot tone={toneOf(a.status)} live={a.status === 'working'} />
      {conflict && <ShieldAlert size={13} className="text-bad" />}
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
