import React, { useState } from 'react';
import { del, post, put, useQuery } from '../api';
import { Empty, Modal, Muted, PageHeader, Panel, StatusChip, Tag, act, fmtAgo, roleLabel } from '../components';
import { Copy, FolderInput, Link2, Pencil, Plus, Puzzle, RefreshCw, ShieldCheck, Trash2, TriangleAlert, X } from 'lucide-react';

// Skills: imported (SKILL.md folders — scanned, then approved by you) or
// written here (general = reusable anywhere, role = for one kind of work).
// A skill reaches an agent only when it is enabled, approved, has stored
// content and is attached to the agent or its role — and only for relevant
// work. "Last applied" is read from what was actually sent to agents.

const KINDS = ['implement', 'fix', 'test', 'doc', 'qa', 'review', 'analyse', 'plan', 'prompt', 'prompt-review', 'accept'];

interface Draft { id?: string; name: string; category: 'general' | 'role'; description: string; purpose: string; useCases: string; instructions: string; constraints: string; expectedOutput: string; kinds: string[]; keywords: string }
const EMPTY: Draft = { name: '', category: 'general', description: '', purpose: '', useCases: '', instructions: '', constraints: '', expectedOutput: '', kinds: [], keywords: '' };

function SkillEditor({ initial, onClose, onSaved }: { initial: Draft; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Draft>(initial);
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setD({ ...d, [k]: e.target.value });
  const body = { ...d, keywords: d.keywords.split(',').map((k) => k.trim()).filter(Boolean) };
  return (
    <Modal width="max-w-2xl" title={d.id ? `Edit ${initial.name}` : 'New skill'} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!d.name.trim() || !d.instructions.trim()} onClick={async () => {
        const r = await act(d.id ? put(`/skills/${d.id}`, body) : post('/skills', body), d.id ? 'Saved as a new version' : 'Skill created');
        if (r) onSaved();
      }}>Save</button>
    </>}>
      <div className="space-y-3">
        <div className="grid grid-cols-[1fr_10rem] gap-3">
          <label className="block"><span className="field-label">Name</span><input className="input w-full" value={d.name} onChange={set('name')} /></label>
          <label className="block"><span className="field-label">Category</span>
            <select className="input w-full" value={d.category} onChange={set('category')}><option value="general">General (any role)</option><option value="role">Role-specific</option></select>
          </label>
        </div>
        <label className="block"><span className="field-label">Purpose</span><input className="input w-full" value={d.purpose} onChange={set('purpose')} placeholder="What this skill achieves" /></label>
        <label className="block"><span className="field-label">When to use</span><input className="input w-full" value={d.useCases} onChange={set('useCases')} placeholder="Intended use cases" /></label>
        <label className="block"><span className="field-label">Instructions</span><textarea className="input w-full h-40 mono text-xs" value={d.instructions} onChange={set('instructions')} placeholder="What the agent should do when the skill applies" /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="field-label">Constraints</span><textarea className="input w-full h-20 text-xs" value={d.constraints} onChange={set('constraints')} /></label>
          <label className="block"><span className="field-label">Expected output</span><textarea className="input w-full h-20 text-xs" value={d.expectedOutput} onChange={set('expectedOutput')} /></label>
        </div>
        <div>
          <span className="field-label">Only for these kinds of work <span className="text-fg-4 font-normal">(none = all)</span></span>
          <div className="flex flex-wrap gap-1">{KINDS.map((k) => (
            <button key={k} type="button" onClick={() => setD({ ...d, kinds: d.kinds.includes(k) ? d.kinds.filter((x) => x !== k) : [...d.kinds, k] })} className={`chip cursor-pointer ${d.kinds.includes(k) ? '!bg-fg !text-canvas !border-fg' : ''}`}>{k}</button>
          ))}</div>
        </div>
        <label className="block"><span className="field-label">Only when the task mentions <span className="text-fg-4 font-normal">(comma-separated keywords; empty = always)</span></span><input className="input w-full" value={d.keywords} onChange={set('keywords')} placeholder="e.g. sql, database" /></label>
        <p className="text-xs text-fg-4">Delivered in the prompt to every provider, and only when relevant — so it costs tokens only where it helps. It adds guidance; it never replaces the approved prompt's requirements.</p>
      </div>
    </Modal>
  );
}

function AttachModal({ skill, roles, agents, onClose, onSaved }: { skill: any; roles: any[]; agents: any[]; onClose: () => void; onSaved: () => void }) {
  const [target, setTarget] = useState('');
  const [pinned, setPinned] = useState(false);
  return (
    <Modal title={`Attach ${skill.name}`} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!target} onClick={async () => {
        const [k, id] = target.split(':');
        if (await act(post(`/skills/${skill.id}/attach`, { [k]: id, pinned }), 'Attached')) onSaved();
      }}>Attach</button>
    </>}>
      <label className="block"><span className="field-label">To</span>
        <select className="input w-full" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">choose…</option>
          <optgroup label="Roles (every agent holding it)">{roles.map((r) => <option key={r.id} value={`roleId:${r.id}`}>{roleLabel(r.name)}</option>)}</optgroup>
          <optgroup label="One agent">{agents.map((a) => <option key={a.id} value={`agentId:${a.id}`}>{a.name}</option>)}</optgroup>
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm mt-3"><input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> Pin this exact version (otherwise it follows your edits)</label>
    </Modal>
  );
}

export default function Skills() {
  const { data, reload } = useQuery<any>('/skills');
  const { data: roles } = useQuery<any[]>('/roles');
  const { data: agents } = useQuery<any[]>('/agents');
  const [importing, setImporting] = useState(false);
  const [importPath, setImportPath] = useState('');
  const [importResult, setImportResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [attaching, setAttaching] = useState<any>(null);
  const [cat, setCat] = useState<'all' | 'general' | 'role' | 'imported'>('all');

  const skills: any[] = data?.skills ?? [];
  const versions: any[] = data?.versions ?? [];
  const attachments: any[] = data?.attachments ?? [];
  const usage = data?.usage ?? {};
  const closeImport = () => { setImporting(false); setImportResult(null); setImportPath(''); };
  const targetName = (t: any) => t.roleId ? roleLabel((roles ?? []).find((r) => r.id === t.roleId)?.name ?? t.roleId) : (agents ?? []).find((a) => a.id === t.agentId)?.name ?? t.agentId;
  const shown = skills.filter((s) => cat === 'all' || (cat === 'imported' ? s.owner_origin === 'imported' : s.owner_origin !== 'imported' && (s.category ?? 'role') === cat));
  const missingContent = skills.filter((s) => s.owner_origin === 'imported' && !versions.some((v) => v.skill_id === s.id && v.hasContent));

  const editDraft = (s: any): Draft => {
    const v = [...versions].reverse().find((x) => x.skill_id === s.id && x.review_status === 'approved') ?? [...versions].reverse().find((x) => x.skill_id === s.id);
    const m = v?.manifest ?? {};
    return { id: s.id, name: s.name, category: s.category ?? 'role', description: s.description ?? '', purpose: m.purpose ?? '', useCases: m.useCases ?? '',
      instructions: m.instructions ?? String(v?.content ?? '').replace(/^---[\s\S]*?---\s*/, ''), constraints: m.constraints ?? '', expectedOutput: m.expectedOutput ?? '',
      kinds: m.kinds ?? [], keywords: (m.keywords ?? []).join(', ') };
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Skills" sub="Write your own skills or import SKILL.md folders, attach them to roles or agents, and see when each was actually applied.">
        <button className="btn" onClick={() => setImporting(true)}><FolderInput size={14} /> Import</button>
        <button className="btn btn-primary" onClick={() => setEditing({ ...EMPTY })}><Plus size={14} /> New skill</button>
      </PageHeader>

      {missingContent.length > 0 && (
        <div className="panel p-3 flex items-start gap-3 text-sm border-warn/30">
          <TriangleAlert size={16} className="text-warn shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-fg">{missingContent.length} imported skill(s) have no stored content, so no agent can load them: {missingContent.map((s) => s.name).join(', ')}.</div>
            <div className="text-xs text-fg-3 mt-0.5">They were imported before content was stored. Relink finds the same folders by exact content hash (in ~/.claude/skills and similar), keeping your approval; or import the folder again.</div>
          </div>
          <button className="btn btn-sm" onClick={async () => { const r = await act(post('/skills/relink', {})); if (r) { act(Promise.resolve(r), `Relinked ${r.linked.length}${r.missing.length ? ` · still missing: ${r.missing.join(', ')}` : ''}`); reload(); } }}><RefreshCw size={13} /> Relink</button>
        </div>
      )}

      <Panel title="Skills" bodyClass="pb-2" action={<div className="flex gap-1">{(['all', 'general', 'role', 'imported'] as const).map((c) => <button key={c} onClick={() => setCat(c)} className={`chip cursor-pointer ${cat === c ? '!bg-fg !text-canvas !border-fg' : ''}`}>{c}</button>)}</div>}>
        {!shown.length && <div className="px-4 pb-2"><Empty icon={Puzzle} title="No skills here yet" text="Write one with New skill, or import a folder containing SKILL.md." /></div>}
        <div className="divide-line">
          {shown.map((s: any) => {
            const vs = versions.filter((v: any) => v.skill_id === s.id);
            const att = attachments.filter((a) => a.skill_id === s.id);
            const latest = vs[vs.length - 1];
            const u = usage[s.id];
            const approved = vs.some((v) => v.review_status === 'approved');
            const stored = vs.some((v) => v.hasContent);
            return (
              <div key={s.id} className={`px-4 py-3 ${s.enabled ? '' : 'opacity-60'}`}>
                <div className="flex items-start gap-3 flex-wrap">
                  <div className="w-8 h-8 rounded-lg bg-raised border border-line grid place-items-center shrink-0"><Puzzle size={14} strokeWidth={1.75} className="text-fg-3" /></div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-fg">{s.name}</span>
                      <Tag tone={s.owner_origin === 'imported' ? 'idle' : (s.category === 'general' ? 'info' : 'ok')}>{s.owner_origin === 'imported' ? 'imported' : s.category === 'general' ? 'general' : 'role-specific'}</Tag>
                      {!stored && <Tag tone="bad">content missing</Tag>}
                      {!approved && <Tag tone="warn">not approved</Tag>}
                    </div>
                    <div className="text-xs text-fg-3 truncate">{s.description}</div>
                    <div className="text-xs mt-1 flex flex-wrap gap-1 items-center">
                      {att.map((a) => (
                        <span key={a.id} className="chip">{targetName(a.target)}{a.pinned ? ' · pinned' : ''}
                          <button className="ml-1 text-fg-4 hover:text-bad" aria-label="Detach" onClick={async () => { if (await act(del(`/skill-attachments/${a.id}`), 'Detached')) reload(); }}><X size={10} /></button>
                        </span>
                      ))}
                      {!att.length && <span className="text-fg-4">not attached</span>}
                      <span className="text-fg-4 ml-2">{u ? `applied ${u.count}× · last ${fmtAgo(u.lastAppliedAt)} (${u.agents.join(', ')})` : 'never applied yet'}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <label className="flex items-center gap-1 text-xs text-fg-3 mr-1"><input type="checkbox" checked={!!s.enabled} onChange={async (e) => { await act(post(`/skills/${s.id}/enabled`, { enabled: e.target.checked })); reload(); }} />enabled</label>
                    <button className="btn btn-xs" disabled={!approved} title={approved ? '' : 'Approve a version first'} onClick={() => setAttaching(s)}><Link2 size={12} /> Attach</button>
                    <button className="btn btn-xs btn-ghost" aria-label="Edit" onClick={() => setEditing(editDraft(s))}><Pencil size={12} /></button>
                    <button className="btn btn-xs btn-ghost" aria-label="Duplicate" onClick={async () => { if (await act(post(`/skills/${s.id}/duplicate`, {}), 'Duplicated')) reload(); }}><Copy size={12} /></button>
                    <button className="btn btn-xs btn-ghost" aria-label="Remove" onClick={async () => { if (confirm(`Remove ${s.name} and its attachments?`) && await act(del(`/skills/${s.id}`), 'Removed')) reload(); }}><Trash2 size={12} /></button>
                  </div>
                </div>
                <div className="ml-11 mt-2 space-y-1">
                  {vs.map((v: any) => (
                    <div key={v.id} className="flex items-center gap-2.5 text-xs flex-wrap">
                      <span className="mono text-fg-2">v{v.semver}</span>
                      <StatusChip value={v.review_status} />
                      {v.source_dir && <span className="mono text-fg-4 truncate max-w-[40ch]" title={v.source_dir}>{v.source_dir}</span>}
                      {v.review_status === 'unreviewed' && (<>
                        <button className="btn btn-xs btn-accent" onClick={() => act(post(`/skill-versions/${v.id}/review`, { approve: true }), `v${v.semver} approved`).then(reload)}>Approve</button>
                        <button className="btn btn-xs btn-ghost" onClick={() => act(post(`/skill-versions/${v.id}/review`, { approve: false }), `v${v.semver} rejected`).then(reload)}>Reject</button>
                      </>)}
                      {v === latest && v.content && <details className="w-full"><summary className="cursor-pointer text-fg-4">content</summary><pre className="mt-1 p-2 rounded bg-sunken border border-line whitespace-pre-wrap max-h-60 overflow-auto">{v.content}</pre></details>}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      <Panel title="By role" bodyClass="pb-2">
        <div className="divide-line">
          {(roles ?? []).map((r: any) => {
            const list = attachments.filter((a) => a.target?.roleId === r.id).map((a) => skills.find((s) => s.id === a.skill_id)?.name).filter(Boolean);
            return (
              <div key={r.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                <span className="w-40 shrink-0 font-medium text-fg">{roleLabel(r.name)}</span>
                <span className="text-xs text-fg-3 flex-1">{list.length ? list.join(', ') : <span className="text-fg-4">no skills</span>}</span>
              </div>
            );
          })}
        </div>
      </Panel>

      {editing && <SkillEditor initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {attaching && <AttachModal skill={attaching} roles={roles ?? []} agents={agents ?? []} onClose={() => setAttaching(null)} onSaved={() => { setAttaching(null); reload(); }} />}
      {importing && (
        <Modal title="Import skill" onClose={closeImport} footer={<>
          <button className="btn btn-ghost" onClick={closeImport}>{importResult?.imported ? 'Done' : 'Cancel'}</button>
          {!importResult?.imported && <button className="btn btn-accent" disabled={!importPath.trim() || busy} onClick={async () => {
            setBusy(true);
            try { setImportResult(await post('/skills/import', { path: importPath.trim() })); reload(); }
            catch (e) { setImportResult({ error: String((e as Error)?.message ?? e) }); }
            setBusy(false);
          }}>{busy ? 'Scanning…' : 'Scan & import'}</button>}
        </>}>
          <p className="text-sm text-fg-3 mb-3">Point at a folder containing <span className="mono text-fg-2">SKILL.md</span> — or a parent folder holding several. Each is scanned, its content stored, and it stays unreviewed until you approve it. Re-importing an unchanged skill keeps its approval.</p>
          <label className="block"><span className="field-label">Folder path</span>
            <input className="input w-full font-mono" autoFocus placeholder="C:\Users\you\.claude\skills" value={importPath} onChange={(e) => setImportPath(e.target.value)} />
          </label>
          {importResult?.error && <div className="mt-3 text-sm text-bad flex gap-2"><TriangleAlert size={15} className="shrink-0 mt-0.5" />{importResult.error}</div>}
          {importResult?.imported && (
            <div className="mt-3 rounded-lg border border-line bg-sunken p-3 text-sm space-y-2 max-h-72 overflow-auto">
              {importResult.imported.map((i: any) => (
                <div key={i.versionId}>
                  <div className="text-ok flex items-center gap-2"><ShieldCheck size={15} className="shrink-0" /> <span className="font-medium">{i.name}</span>{i.unchanged && <span className="text-xs text-fg-3">unchanged — approval kept</span>}</div>
                  {i.findings?.length > 0 ? <ul className="mt-1 ml-6 space-y-0.5 text-warn text-xs">{i.findings.map((f: string) => <li key={f}>· {f}</li>)}</ul> : <div className="mt-0.5 ml-6 text-xs text-fg-3">Clean scan.</div>}
                </div>
              ))}
              {importResult.errors?.map((e: string) => <div key={e} className="text-bad text-xs flex gap-1.5"><TriangleAlert size={13} className="shrink-0 mt-0.5" />{e}</div>)}
            </div>
          )}
        </Modal>
      )}
      {!skills.length && <Muted>Tip: a general skill (e.g. "small, reviewable diffs") can be attached to every role at once.</Muted>}
    </div>
  );
}
