import { useCallback, useEffect, useRef, useState } from 'react';

export interface OfficeEvent {
  seq: number; runId: string | null; ts: string; actor: string; type: string;
  entityId: string | null; payload: Record<string, unknown>; hash: string; prevHash: string;
}

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const isJson = (res.headers.get('content-type') ?? '').includes('json');
    // the daemon's own errors are JSON; a plain-HTML 404 means it has no such route, i.e. it was started before this feature existed
    if (res.status === 404 && !isJson) throw new Error('The daemon doesn\'t know this action yet: it is still running an older version. Restart officeChain (quit it from the tray icon or close its window, then start it again) and retry.');
    const b = isJson ? await res.json().catch(() => ({})) : {};
    throw new Error(b.error ?? b.message ?? `${res.status}`);
  }
  return res.json() as Promise<T>;
}

// Concurrent GETs for the same path share one request (many components ask
// for /agents, /runs or /approvals at the same moment).
const inflight = new Map<string, Promise<any>>();
export const get = <T = any>(p: string): Promise<T> => {
  let pr = inflight.get(p);
  if (!pr) { pr = api<T>(p).finally(() => inflight.delete(p)); inflight.set(p, pr); }
  return pr;
};
export const post = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'POST', body: JSON.stringify(body ?? {}) });
export const put = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'PUT', body: JSON.stringify(body ?? {}) });
export const del = <T = any>(p: string) => api<T>(p, { method: 'DELETE' });

// Query that refetches on ws events (throttled). Pass a null path to skip.
// Like useQuery, but loads only when the path changes or reload() is called —
// not on every live-event tick. For git-heavy endpoints (diffs, previews).
export function useFetch<T = any>(path: string | null, deps: unknown[] = []): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const reload = useCallback(() => {
    if (!path) { setData(null); setLoading(false); return; }
    setLoading(true);
    get<T>(path)
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, [path]);
  useEffect(() => { reload(); }, [reload, ...deps]);
  return { data, error, loading, reload };
}

export function useQuery<T = any>(path: string | null, deps: unknown[] = []): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const tick = useThrottledTick();
  const reload = useCallback(() => {
    if (!path) { setData(null); setLoading(false); return; }
    get<T>(path)
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, [path]);
  useEffect(() => { reload(); }, [reload, tick, ...deps]);
  return { data, error, loading, reload };
}

// ---- global event bus ----------------------------------------------------
type Listener = (e: OfficeEvent) => void;
const listeners = new Set<Listener>();
const STREAM_EVENTS = new Set(['agent.output', 'agent.activity', 'agent.thinking', 'agent.diff', 'agent.heartbeat']);
let wsTickListeners = new Set<() => void>();
let ws: WebSocket | null = null;
let reconnectDelay = 500;

function ensureWs() {
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const host = import.meta.env.DEV ? 'localhost:4780' : location.host;
  ws = new WebSocket(`${proto}://${host}/ws`);
  ws.onmessage = (m) => {
    try {
      const d = JSON.parse(m.data);
      if (d.type === 'event') {
        for (const fn of listeners) fn(d.event);
        // streamed agent output changes no stored state that lists show;
        // refetching every query per output line made the UI crawl
        if (!STREAM_EVENTS.has(d.event?.type)) for (const fn of wsTickListeners) fn();
      }
    } catch { /* ignore */ }
  };
  ws.onclose = () => { ws = null; setTimeout(ensureWs, reconnectDelay = Math.min(5000, reconnectDelay * 2)); };
  ws.onopen = () => { reconnectDelay = 500; };
}
ensureWs();

export function useEvents(handler: Listener): void {
  useEffect(() => { listeners.add(handler); return () => { listeners.delete(handler); }; }, [handler]);
}

// tick increments on every ws event — cheap invalidation for queries
let tickValue = 0;
const tickSubs = new Set<(n: number) => void>();
wsTickListeners.add(() => { tickValue++; for (const f of tickSubs) f(tickValue); });
export function useWsTick(): number {
  const [t, setT] = useState(tickValue);
  useEffect(() => { const f = (n: number) => setT(n); tickSubs.add(f); return () => { tickSubs.delete(f); }; }, []);
  return t;
}

// Throttled tick (leading + trailing): at most one refetch per `ms`, and the
// last burst of events always lands so the UI never shows stale state.
export function useThrottledTick(ms = 1000): number {
  const t = useWsTick();
  const [vt, setVt] = useState(t);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const wait = ms - (Date.now() - last.current);
    if (wait <= 0) { last.current = Date.now(); setVt(t); return; }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { last.current = Date.now(); setVt(t); }, wait);
  }, [t, ms]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return vt;
}

export function useWsConnected(): boolean {
  const [c, setC] = useState(ws?.readyState === WebSocket.OPEN);
  useEffect(() => { const id = setInterval(() => setC(ws?.readyState === WebSocket.OPEN), 1500); return () => clearInterval(id); }, []);
  return c;
}
