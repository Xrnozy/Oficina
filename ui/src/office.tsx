import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2 } from 'lucide-react';
import { useQuery } from './api';
import { Select } from './Select';

// The current office. An office is a workspace: its own agents, roles' desks, workflows and runs.
// Every page that shows agents, flows or runs follows this choice, which is remembered per browser.

export interface OfficeRow {
  id: string; name: string; purpose: string; settings: Record<string, any>;
  repoIds: string[]; memory_scope?: string;
}

interface Ctx { offices: OfficeRow[] | null; office: OfficeRow | null; setOfficeId: (id: string) => void; reload: () => void }
const OfficeCtx = createContext<Ctx>({ offices: null, office: null, setOfficeId: () => undefined, reload: () => undefined });

const KEY = 'oc-office';
const readSaved = (): string => { try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; } };

export function OfficeProvider({ children }: { children: React.ReactNode }) {
  const { data: offices, reload } = useQuery<OfficeRow[]>('/workspaces');
  const [id, setId] = useState(readSaved);
  const setOfficeId = useCallback((next: string) => {
    setId(next);
    try { localStorage.setItem(KEY, next); } catch { /* private mode */ }
  }, []);
  // a deleted or unknown office falls back to the first one
  const office = useMemo(() => offices?.find((o) => o.id === id) ?? offices?.[0] ?? null, [offices, id]);
  const value = useMemo(() => ({ offices, office, setOfficeId, reload }), [offices, office, setOfficeId, reload]);
  return <OfficeCtx.Provider value={value}>{children}</OfficeCtx.Provider>;
}

export const useOffice = () => useContext(OfficeCtx);

/** Does this agent (from /agents) hold an active desk in the office? */
export const agentInOffice = (a: { memberships?: { active?: number | boolean; workspace_id?: string }[] }, officeId?: string | null): boolean =>
  !!officeId && (a.memberships ?? []).some((m) => !!m.active && m.workspace_id === officeId);

/** The agents of the current office only. `all` is everyone, for pages that need to look others up. */
export function useOfficeAgents() {
  const { office } = useOffice();
  const q = useQuery<any[]>('/agents');
  const mine = useMemo(() => (q.data ?? []).filter((a) => agentInOffice(a, office?.id)), [q.data, office?.id]);
  return { ...q, agents: mine, all: q.data ?? [] };
}

/** Requests waiting in the current office's queue (typed in the tray or the dashboard). */
export function useOfficeQueue() {
  const { office } = useOffice();
  return useQuery<{ id: string; text: string; source: string; createdAt: string }[]>(office ? `/queue?workspaceId=${office.id}` : null, [office?.id]);
}

/** Approvals ("Needs you") raised by runs of the current office, plus any that belong to no run. */
export function useOfficeApprovals() {
  const { office } = useOffice();
  const a = useQuery<any[]>('/approvals');
  const r = useQuery<any[]>('/runs');
  const data = useMemo(() => {
    if (!a.data || !office) return a.data;
    const mine = new Set((r.data ?? []).filter((x) => x.workspaceId === office.id).map((x) => x.id as string));
    return a.data.filter((x) => !x.run_id || mine.has(x.run_id));
  }, [a.data, r.data, office]);
  return { ...a, data };
}

/** Sidebar switcher: pick the office every page follows. */
export function OfficeSwitcher() {
  const { offices, office, setOfficeId } = useOffice();
  if (!offices || !office) return null;
  return (
    <div className="px-2.5 pb-1">
      <div className="flex items-center gap-2 h-9 pl-2.5 pr-2 rounded-lg border border-line bg-surface hover:border-line-strong transition-colors focus-within:border-fg/60">
        <Building2 size={14} strokeWidth={1.75} className="text-fg-3 shrink-0" />
        <Select aria-label="Office" value={office.id} onChange={(e) => setOfficeId(e.target.value)}
          className="flex-1 min-w-0 h-full bg-transparent text-[13px] font-medium text-fg outline-none">
          {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </Select>
      </div>
      <Link to="/office" className="block px-1 pt-1 text-2xs text-fg-4 hover:text-fg">Manage offices →</Link>
    </div>
  );
}

// ---- portable files -------------------------------------------------------

export const fileSlug = (s: string) => s.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'export';

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function readJsonFile(f: File): Promise<any> {
  try { return JSON.parse(await f.text()); } catch { throw new Error(`${f.name} is not valid JSON`); }
}
