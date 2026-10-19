import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { post, useQuery, useWsConnected } from './api';
import { OfficeSwitcher, useOffice, useOfficeApprovals } from './office';
import {
  Activity, Bookmark, Building2, ChevronRight, GitCommitHorizontal, Clock, Command, Cpu, FileText, Inbox, LayoutDashboard, MessagesSquare,
  Library, ListChecks, Menu, Moon, Pause, Play, Plug, Route, Search, Square, Sun, TriangleAlert, Workflow, X,
  type LucideIcon,
} from 'lucide-react';

// ---------------- status vocabulary ----------------------------------------
// Five tones only. Colour carries meaning, never decoration.

export type Tone = 'ok' | 'info' | 'warn' | 'bad' | 'idle';

const STATUS_TONE: Record<string, Tone> = {
  running: 'ok', done: 'ok', pass: 'ok', approved: 'ok', active: 'ok', working: 'ok', coding: 'ok', resolved: 'ok', enabled: 'ok', closed: 'ok', applied: 'ok',
  planning: 'info', testing: 'info', undone: 'idle', interrupted: 'warn',
  'in-progress': 'info', 'in-review': 'info', verifying: 'info', reviewing: 'info', assigned: 'info', fixing: 'info',
  'dod-review': 'warn', paused: 'warn', pausing: 'warn', waiting: 'warn', 'waiting-input': 'warn', pending: 'warn',
  'changes-requested': 'warn', 'blocked-quota': 'warn', reopened: 'warn', unreviewed: 'warn', 'half-open': 'warn',
  blocked: 'bad', fail: 'bad', failed: 'bad', error: 'bad', escalated: 'bad', stopped: 'bad', open: 'bad', rejected: 'bad',
  cancelled: 'idle', backlog: 'idle', ready: 'idle', idle: 'idle', draft: 'idle', wontfix: 'idle', disabled: 'idle',
};

export const TONE_TEXT: Record<Tone, string> = { ok: 'text-ok', info: 'text-info', warn: 'text-warn', bad: 'text-bad', idle: 'text-fg-3' };
export const TONE_BG: Record<Tone, string> = { ok: 'bg-ok', info: 'bg-info', warn: 'bg-warn', bad: 'bg-bad', idle: 'bg-fg-4' };
const TONE_CHIP: Record<Tone, string> = {
  ok: 'text-ok bg-ok/[0.08] border-ok/20',
  info: 'text-info bg-info/[0.08] border-info/20',
  warn: 'text-warn bg-warn/[0.08] border-warn/20',
  bad: 'text-bad bg-bad/[0.08] border-bad/20',
  idle: 'text-fg-3 bg-raised border-line',
};

export const toneOf = (s?: string | null): Tone => STATUS_TONE[s ?? ''] ?? 'idle';

export function Dot({ tone, live = false, className = '' }: { tone: Tone; live?: boolean; className?: string }) {
  return <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${TONE_BG[tone]} ${live ? 'animate-pulse2' : ''} ${className}`} />;
}

export function StatusChip({ value, tone }: { value: string; tone?: Tone }) {
  const t = tone ?? toneOf(value);
  const live = ['running', 'working', 'in-progress', 'verifying', 'fixing'].includes(value);
  return <span className={`chip ${TONE_CHIP[t]}`}><Dot tone={t} live={live} />{value.replace(/-/g, ' ')}</span>;
}

export function Tag({ children, tone = 'idle', mono = false, title }: { children: React.ReactNode; tone?: Tone; mono?: boolean; title?: string }) {
  return <span title={title} className={`chip ${TONE_CHIP[tone]} ${mono ? 'font-mono' : ''}`}>{children}</span>;
}

const SEV: Record<string, { tone: Tone; bars: number }> = {
  critical: { tone: 'bad', bars: 4 }, high: { tone: 'bad', bars: 3 }, medium: { tone: 'warn', bars: 2 }, low: { tone: 'idle', bars: 1 },
};
export function SevChip({ sev }: { sev: string }) {
  const s = SEV[sev] ?? SEV.low;
  return (
    <span className={`chip ${TONE_CHIP[s.tone]} ${sev === 'critical' ? '!bg-bad/20' : ''}`} title={`severity: ${sev}`}>
      <span className="flex items-end gap-[2px] h-2.5" aria-hidden>
        {[1, 2, 3, 4].map((i) => <span key={i} className={`w-[2px] rounded-sm ${i <= s.bars ? 'bg-current' : 'bg-current opacity-20'}`} style={{ height: `${25 + i * 18.75}%` }} />)}
      </span>
      {sev}
    </span>
  );
}

// Spec §8.6 observability levels.
const OBS_LABEL: Record<string, string> = { full: 'Full', actions: 'Actions', 'status-only': 'Status only', manual: 'Manual', whitebox: 'Full', graybox: 'Actions', blackbox: 'Status only' };
export function ObsBadge({ level }: { level?: string }) {
  return <span className="chip" title="Observability level — how much of this agent's work the Office can see">{OBS_LABEL[level ?? ''] ?? level ?? 'unknown'}</span>;
}

// ---------------- formatting -----------------------------------------------

export function fmtTime(ts?: string | null): string {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return ts; }
}
export function fmtAgo(ts?: string | null): string {
  if (!ts) return '—';
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function fmtIn(ts?: string | null): string {
  if (!ts) return '—';
  const s = (Date.parse(ts) - Date.now()) / 1000;
  if (Number.isNaN(s)) return '—';
  if (s <= 0) return 'now';
  if (s < 3600) return `in ${Math.ceil(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `in ${Math.floor(s / 86400)}d`;
}
export function fmtUsd(n?: number | null): string {
  return `$${(n ?? 0).toFixed(2)}`;
}
export function fmtNum(n?: number | null): string {
  const v = n ?? 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  return v.toLocaleString();
}
export const pct = (v?: number | null) => `${Math.round((v ?? 0) * 100)}%`;
/** "pm" → "PM", "qa" → "QA", "developer" → "Developer". */
export const roleLabel = (n?: string) => (!n ? '' : n.length <= 3 ? n.toUpperCase() : n[0].toUpperCase() + n.slice(1));

// ---------------- shared data hook -----------------------------------------

export function useCurrentRun() {
  const q = useQuery<any[]>('/runs');
  const { office } = useOffice();
  // runs belong to an office; the page follows the one chosen in the sidebar
  const runs = office ? q.data?.filter((r) => r.workspaceId === office.id) : q.data;
  const run = runs?.find((r) => !['done', 'stopped'].includes(r.status)) ?? runs?.[0] ?? null;
  return { run, runs, loading: q.loading };
}

// ---------------- toasts + action helper -----------------------------------

type ToastT = { id: number; text: string; tone: Tone };
let toastId = 0;
const toastSubs = new Set<(t: ToastT[]) => void>();
let toasts: ToastT[] = [];
export function toast(text: string, tone: Tone = 'ok') {
  const t = { id: ++toastId, text, tone };
  toasts = [...toasts, t].slice(-4);
  toastSubs.forEach((f) => f(toasts));
  setTimeout(() => { toasts = toasts.filter((x) => x.id !== t.id); toastSubs.forEach((f) => f(toasts)); }, tone === 'bad' ? 6000 : 3200);
}
/** Run a mutation; surface failures instead of swallowing them. */
export async function act<T>(p: Promise<T>, ok?: string): Promise<T | undefined> {
  try { const r = await p; if (ok) toast(ok); return r; }
  catch (e) { toast(String((e as Error)?.message ?? e), 'bad'); return undefined; }
}
function Toasts() {
  const [list, setList] = useState<ToastT[]>(toasts);
  useEffect(() => { toastSubs.add(setList); return () => { toastSubs.delete(setList); }; }, []);
  return (
    <div className="fixed bottom-4 right-4 z-[70] flex flex-col gap-2 pointer-events-none" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="animate-rise pointer-events-auto flex items-center gap-2.5 bg-raised border border-line-strong shadow-pop rounded-lg pl-3 pr-4 py-2.5 text-sm text-fg max-w-sm">
          <Dot tone={t.tone} />{t.text}
        </div>
      ))}
    </div>
  );
}

// ---------------- primitives -----------------------------------------------

export function PageHeader({ title, sub, children, back }: { title: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode; back?: { to: string; label: string } }) {
  return (
    <header className="mb-6 animate-rise">
      {back && <Link to={back.to} className="inline-flex items-center gap-1 text-xs text-fg-3 hover:text-fg mb-2 transition-colors">← {back.label}</Link>}
      <div className="flex items-end gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.02em] break-words">{title}</h1>
          {sub && <p className="text-sm text-fg-3 mt-1 max-w-[68ch]">{sub}</p>}
        </div>
        {children && <div className="flex items-center gap-2 flex-wrap">{children}</div>}
      </div>
    </header>
  );
}

export function Panel({ title, action, children, className = '', bodyClass = 'px-4 pb-4' }: { title?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={`panel min-w-0 ${className}`}>
      {title && <div className="panel-head"><h2 className="text-[13px] font-medium text-fg">{title}</h2><div className="flex-1" />{action}</div>}
      <div className={title ? bodyClass : 'p-4'}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, children }: { label: string; value: React.ReactNode; hint?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow mb-1.5">{label}</div>
      <div className="text-[26px] leading-none font-semibold tracking-[-0.03em] text-fg num">{value}</div>
      {children && <div className="mt-2.5">{children}</div>}
      {hint && <div className="text-xs text-fg-3 mt-1.5 num">{hint}</div>}
    </div>
  );
}

export function Empty({ text, icon: Icon, title, children }: { text: string; icon?: LucideIcon; title?: string; children?: React.ReactNode }) {
  return (
    <div className="panel border-dashed px-6 py-10 flex flex-col items-center text-center">
      {Icon && <div className="w-10 h-10 rounded-xl bg-raised border border-line grid place-items-center mb-3"><Icon size={18} strokeWidth={1.75} className="text-fg-3" /></div>}
      {title && <div className="text-sm font-medium text-fg mb-1">{title}</div>}
      <p className="text-sm text-fg-3 max-w-[52ch]">{text}</p>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}

export function Muted({ children }: { children: React.ReactNode }) {
  return <div className="text-xs text-fg-4 py-1">{children}</div>;
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return <div className="space-y-2.5" aria-busy>{Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton h-9" style={{ opacity: 1 - i * 0.2 }} />)}</div>;
}

export function ProgressBar({ value, tone = 'ok', className = '', thin = false }: { value: number; tone?: Tone | 'accent'; className?: string; thin?: boolean }) {
  const v = Math.min(100, Math.max(0, (value || 0) * 100));
  const bg = tone === 'accent' ? 'bg-accent' : TONE_BG[tone];
  return (
    <div className={`${thin ? 'h-1' : 'h-1.5'} rounded-full bg-line overflow-hidden ${className}`} role="progressbar" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full ${bg} transition-[width] duration-500 ease-out`} style={{ width: `${v}%` }} />
    </div>
  );
}

/** Spend/quota bar that changes tone as it fills. */
export function Meter({ value, warnAt = 0.8 }: { value: number; warnAt?: number }) {
  return <ProgressBar value={value} tone={value >= 1 ? 'bad' : value >= warnAt ? 'warn' : 'info'} />;
}

export function Avatar({ agent, size = 'md' }: { agent?: { avatar?: string; name?: string } | null; size?: 'sm' | 'md' | 'lg' }) {
  const s = size === 'lg' ? 'w-10 h-10 text-xl rounded-xl' : size === 'sm' ? 'w-6 h-6 text-xs rounded-md' : 'w-8 h-8 text-base rounded-lg';
  const a = agent?.avatar?.trim();
  return (
    <span className={`${s} shrink-0 grid place-items-center bg-raised border border-line select-none`} aria-hidden>
      {a || <span className="text-xs font-semibold text-fg-3">{(agent?.name ?? '?').slice(0, 2).toUpperCase()}</span>}
    </span>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex p-0.5 rounded-lg bg-sunken border border-line" role="radiogroup">
      {options.map((o) => (
        <button key={o} type="button" role="radio" aria-checked={value === o} onClick={() => onChange(o)}
          className={`h-7 px-3 rounded-md text-xs font-medium transition-colors ${value === o ? 'bg-raised text-fg shadow-sm border border-line-strong' : 'text-fg-3 hover:text-fg border border-transparent'}`}>
          {o}
        </button>
      ))}
    </div>
  );
}

export function KV({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1.5">
      <dt className="text-xs text-fg-3 w-28 shrink-0">{k}</dt>
      <dd className="text-sm text-fg-2 min-w-0 flex-1">{children}</dd>
    </div>
  );
}

// ---------------- overlays -------------------------------------------------

function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
}

export function Modal({ title, onClose, children, footer, width = 'max-w-lg' }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; width?: string }) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-50 bg-fg/[0.06] flex items-start sm:items-center justify-center p-4 pt-[10vh] sm:pt-4" onClick={onClose}>
      <div role="dialog" aria-modal aria-label={title} className={`animate-rise w-full ${width} max-h-[85vh] flex flex-col bg-surface border border-line-strong rounded-2xl shadow-pop`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-4 pb-3">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button onClick={onClose} className="btn btn-ghost btn-icon btn-sm" aria-label="Close"><X size={15} /></button>
        </div>
        <div className="px-5 pb-5 overflow-auto">{children}</div>
        {footer && <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-line bg-raised/40 rounded-b-2xl">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ title, onClose, children, footer }: { title: React.ReactNode; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode }) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose}>
      <aside role="dialog" aria-modal className="animate-slide absolute right-0 top-0 h-full w-full max-w-[520px] flex flex-col bg-surface border-l border-line-strong shadow-pop" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-5 h-14 border-b border-line shrink-0">
          <div className="flex-1 min-w-0 flex items-center gap-2.5">{title}</div>
          <button onClick={onClose} className="btn btn-ghost btn-icon btn-sm" aria-label="Close"><X size={15} /></button>
        </div>
        <div className="flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer && <div className="px-5 py-3.5 border-t border-line bg-raised/40">{footer}</div>}
      </aside>
    </div>
  );
}

// ---------------- shell: navigation ----------------------------------------

const NAV: { group: string; items: { to: string; label: string; icon: LucideIcon; key?: string }[] }[] = [
  { group: 'Route', items: [
    { to: '/', label: 'Requests', icon: LayoutDashboard },
    { to: '/activity', label: 'Live activity', icon: Activity },
    { to: '/approvals', label: 'Needs you', icon: Inbox, key: 'approvals' },
    { to: '/tasks', label: 'Tasks', icon: ListChecks },
    { to: '/repo-timeline', label: 'Repo timeline', icon: GitCommitHorizontal },
    { to: '/checkpoints', label: 'Checkpoints', icon: Bookmark },
  ] },
  { group: 'Setup', items: [
    { to: '/routing', label: 'Routing', icon: Route },
    { to: '/workflow', label: 'Workflow', icon: Workflow },
    { to: '/providers', label: 'Providers', icon: Plug },
    { to: '/office', label: 'Roles', icon: Building2 },
    { to: '/agents', label: 'Agents', icon: Cpu },
  ] },
  { group: 'More', items: [
    { to: '/team', label: 'Messages', icon: MessagesSquare },
    { to: '/timeline', label: 'Run replay', icon: Clock },
    { to: '/project', label: 'Project record', icon: FileText },
    { to: '/errors', label: 'Error reports', icon: TriangleAlert, key: 'errors' },
    { to: '/skills', label: 'Skills', icon: Library },
  ] },
];

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
      <rect x="4" y="4" width="11" height="11" rx="3" className="fill-fg" />
      <rect x="17" y="4" width="11" height="11" rx="3" className="fill-lime" stroke="rgb(var(--line-strong))" strokeWidth="1" />
      <rect x="4" y="17" width="11" height="11" rx="3" className="fill-lilac" stroke="rgb(var(--line-strong))" strokeWidth="1" />
      <rect x="17" y="17" width="11" height="11" rx="3" className="fill-fg" fillOpacity=".35" />
    </svg>
  );
}

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: approvals } = useOfficeApprovals();
  const { data: errors } = useQuery<any[]>('/errors');
  const connected = useWsConnected();
  const loc = useLocation();
  useEffect(() => { onClose(); }, [loc.pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  const counts: Record<string, number> = {
    approvals: approvals?.filter((a) => a.status === 'pending').length ?? 0,
    errors: errors?.filter((e) => !['resolved', 'wontfix'].includes(e.status)).length ?? 0,
  };
  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={onClose} />}
      <nav aria-label="Main" className={`fixed lg:static z-40 inset-y-0 left-0 w-60 lg:w-56 shrink-0 bg-canvas lg:bg-transparent border-r border-line flex flex-col transition-transform duration-200 ${open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        <div className="h-14 flex items-center gap-2.5 px-4 shrink-0">
          <Logo />
          <div className="leading-tight">
            <div className="font-semibold text-[14px] text-fg tracking-[-0.01em]">officeChain</div>
            <div className="text-2xs text-fg-4">agent router</div>
          </div>
        </div>
        <OfficeSwitcher />
        <div className="flex-1 overflow-auto px-2.5 py-2 space-y-5">
          {NAV.map((g) => (
            <div key={g.group}>
              <div className="px-2 mb-1 text-2xs font-medium text-fg-4">{g.group}</div>
              <div className="space-y-px">
                {g.items.map((n) => {
                  const c = n.key ? counts[n.key] : 0;
                  return (
                    <NavLink key={n.to} to={n.to} end={n.to === '/'}
                      className={({ isActive }) => `group relative flex items-center gap-2.5 h-8 px-2 rounded-lg text-[13px] transition-colors ${isActive ? 'bg-raised text-fg' : 'text-fg-3 hover:text-fg hover:bg-raised/60'}`}>
                      {({ isActive }) => (<>
                        {isActive && <span className="absolute -left-2.5 top-1.5 bottom-1.5 w-[2px] rounded-r bg-accent" />}
                        <n.icon size={15} strokeWidth={1.75} className={isActive ? 'text-accent' : ''} />
                        {n.label}
                        {c > 0 && <span className={`ml-auto num text-2xs font-semibold min-w-5 h-5 px-1.5 rounded-md grid place-items-center ${n.key === 'approvals' ? 'bg-warn/15 text-warn' : 'bg-bad/15 text-bad'}`}>{c}</span>}
                      </>)}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="px-4 py-3 border-t border-line flex items-center gap-2 text-2xs text-fg-4">
          <Dot tone={connected ? 'ok' : 'bad'} live={!connected} />
          {connected ? 'daemon connected' : 'reconnecting…'}
          <span className="ml-auto">event-sourced</span>
        </div>
      </nav>
    </>
  );
}

// ---------------- shell: persistent run bar (spec §9) ----------------------

export function RunBar({ onMenu, onPalette }: { onMenu: () => void; onPalette: () => void }) {
  const { run, loading } = useCurrentRun();
  const { data: approvals } = useOfficeApprovals();
  const pending = approvals?.filter((a) => a.status === 'pending').length ?? 0;
  const spendFrac = run?.budget?.runUsd ? run.spentUsd / run.budget.runUsd : 0;
  return (
    <div className="h-14 shrink-0 flex items-center gap-3 px-4 lg:px-6 border-b border-line bg-canvas/80 backdrop-blur sticky top-0 z-20">
      <button className="btn btn-ghost btn-icon lg:hidden" onClick={onMenu} aria-label="Open navigation"><Menu size={16} /></button>
      {run ? (
        <div className="flex items-center gap-4 min-w-0 flex-1">
          <Link to="/" className="flex items-center gap-2.5 min-w-0 group">
            <StatusChip value={run.status} />
            <span className="text-sm text-fg truncate max-w-[28ch] group-hover:underline underline-offset-4 decoration-line-strong hidden sm:inline">{run.goal}</span>
          </Link>
          <div className="hidden md:flex items-center gap-4 text-xs text-fg-3 num">
            <span>cycle <span className="text-fg-2">{run.currentCycle}</span><span className="text-fg-4">/{run.limits?.maxCycles ?? '∞'}</span></span>
            <Link to={`/dod/${run.id}`} className="flex items-center gap-2 hover:text-fg transition-colors">
              DoD <ProgressBar value={run.progressScore} thin className="w-14" /> <span className="text-fg-2">{pct(run.progressScore)}</span>
            </Link>
            <span className="flex items-center gap-2">spend <Meter value={spendFrac} /> <span className="text-fg-2">{fmtUsd(run.spentUsd)}</span><span className="text-fg-4">/ {fmtUsd(run.budget?.runUsd)}</span></span>
          </div>
        </div>
      ) : <div className="flex-1 text-sm text-fg-3">{loading ? '' : 'No active run'}</div>}

      {pending > 0 && (
        <Link to="/approvals" className="btn btn-sm !border-warn/30 !bg-warn/10 !text-warn hover:!bg-warn/20">
          <Inbox size={13} /> {pending} <span className="hidden sm:inline">awaiting you</span>
        </Link>
      )}
      {run && <RunControls run={run} />}
      <ThemeToggle />
      <button onClick={onPalette} className="hidden sm:flex items-center gap-2 h-8 pl-2.5 pr-1.5 rounded-full border border-line bg-canvas text-xs text-fg-4 hover:text-fg-2 hover:border-line-strong transition-colors" aria-label="Open command palette">
        <Search size={13} /> <span className="mr-3">Commands</span> <span className="kbd">Ctrl</span><span className="kbd">K</span>
      </button>
    </div>
  );
}

export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    try { localStorage.setItem('oc-theme', next ? 'dark' : 'light'); } catch { /* private mode */ }
    setDark(next);
  };
  return (
    <button onClick={toggle} className="btn btn-ghost btn-icon" aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} title={dark ? 'Light mode' : 'Dark mode'}>
      {dark ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}

export function RunControls({ run, size = 'btn-sm' }: { run: any; size?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      {run.status === 'running' && <button className={`btn ${size}`} onClick={() => act(post(`/runs/${run.id}/pause`), 'Pausing at next safe point')}><Pause size={12} /> Pause</button>}
      {run.status === 'paused' && <button className={`btn btn-accent ${size}`} onClick={() => act(post(`/runs/${run.id}/resume`), 'Run resumed')}><Play size={12} /> Resume</button>}
      {['running', 'paused', 'pausing', 'dod-review'].includes(run.status) && (
        <button className={`btn btn-danger ${size}`} onClick={() => { if (confirm('Stop this run? In-flight work is abandoned and the run cannot be resumed.')) act(post(`/runs/${run.id}/stop`), 'Run stopped'); }}><Square size={11} /> Stop</button>
      )}
    </div>
  );
}

// ---------------- command palette (Ctrl+K) ---------------------------------

export function CommandPalette({ open, setOpen }: { open: boolean; setOpen: (v: boolean | ((o: boolean) => boolean)) => void }) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const nav = useNavigate();
  const { run } = useCurrentRun();
  const { data: detail } = useQuery<any>(open && run ? `/runs/${run.id}` : null, [run?.id, open]);
  const { data: agents } = useQuery<any[]>(open ? '/agents' : null, [open]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [setOpen]);
  useEffect(() => { if (open) { setQ(''); setIdx(0); } }, [open]);

  const commands = useMemo(() => {
    const c: { group: string; label: string; hint?: string; act: () => void }[] = [];
    if (run?.status === 'running') c.push({ group: 'Run', label: 'Pause run', act: () => act(post(`/runs/${run.id}/pause`), 'Pausing at next safe point') });
    if (run?.status === 'paused') c.push({ group: 'Run', label: 'Resume run', act: () => act(post(`/runs/${run.id}/resume`), 'Run resumed') });
    if (run && ['running', 'paused', 'dod-review'].includes(run.status)) c.push({ group: 'Run', label: 'Stop run', act: () => { if (confirm('Stop this run?')) act(post(`/runs/${run.id}/stop`), 'Run stopped'); } });
    if (run) c.push({ group: 'Run', label: 'Open Definition of Done', act: () => nav(`/dod/${run.id}`) });
    for (const g of NAV) for (const n of g.items) c.push({ group: 'Go to', label: n.label, act: () => nav(n.to) });
    for (const t of detail?.tasks ?? []) c.push({ group: 'Jump to task', label: t.title, hint: t.status, act: () => nav(`/tasks/${t.id}`) });
    for (const a of agents ?? []) c.push({ group: 'Message agent', label: `Message ${a.name}`, act: () => nav(`/activity?agent=${a.id}`) });
    return c;
  }, [run, detail, agents, nav]);

  const filtered = commands.filter((c) => `${c.group} ${c.label}`.toLowerCase().includes(q.toLowerCase()));
  useEffect(() => { setIdx(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector(`[data-i="${idx}"]`)?.scrollIntoView({ block: 'nearest' }); }, [idx]);

  if (!open) return null;
  const run_ = (i: number) => { const c = filtered[i]; if (c) { setOpen(false); c.act(); } };
  let lastGroup = '';
  return (
    <div className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-[2px] flex items-start justify-center p-4 pt-[14vh]" onClick={() => setOpen(false)}>
      <div className="animate-rise w-full max-w-[560px] bg-surface border border-line-strong rounded-2xl shadow-pop overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-4 border-b border-line">
          <Command size={15} className="text-fg-4" />
          <input autoFocus className="flex-1 h-12 bg-transparent text-[15px] text-fg placeholder:text-fg-4 outline-none" placeholder="Type a command, page, task or agent…"
            value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(filtered.length - 1, i + 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
              if (e.key === 'Enter') { e.preventDefault(); run_(idx); }
              if (e.key === 'Escape') setOpen(false);
            }} />
          <span className="kbd">Esc</span>
        </div>
        <div ref={listRef} className="max-h-[52vh] overflow-auto p-1.5">
          {filtered.map((c, i) => {
            const header = c.group !== lastGroup ? (lastGroup = c.group) : null;
            return (
              <React.Fragment key={`${c.group}:${c.label}:${i}`}>
                {header && <div className="px-2.5 pt-2.5 pb-1 text-2xs font-medium text-fg-4">{header}</div>}
                <button data-i={i} onMouseMove={() => setIdx(i)} onClick={() => run_(i)}
                  className={`w-full flex items-center gap-2 text-left h-9 px-2.5 rounded-lg text-sm transition-colors ${i === idx ? 'bg-raised text-fg' : 'text-fg-2'}`}>
                  <span className="truncate flex-1">{c.label}</span>
                  {c.hint && <span className="text-2xs text-fg-4">{c.hint}</span>}
                  {i === idx && <ChevronRight size={14} className="text-fg-4" />}
                </button>
              </React.Fragment>
            );
          })}
          {!filtered.length && <div className="px-3 py-6 text-center text-sm text-fg-4">No matching commands</div>}
        </div>
      </div>
    </div>
  );
}

export { Toasts };
