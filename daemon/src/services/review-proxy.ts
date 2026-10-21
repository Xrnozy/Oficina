import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';

// The window the owner reviews in. Oficina cannot edit the project's pages, so the app under review is served through
// a small local proxy that adds the review widget to every HTML page. The widget reads the review from, and sends the
// owner's decision to, the proxy's own /__oficina/* routes. One proxy per task lives across review rounds: after a
// rejection the same tab waits for the next round and reloads itself when it is ready.

export interface ReviewHooks {
  /** What the widget shows right now (the engine reads it from the task and its pending approval). */
  state(): Record<string, unknown>;
  /** The owner's decision. `page` is where in the app they were. */
  decide(approve: boolean, reason: string, page: string): { ok: true } | { error: string; status: number };
}

interface ReviewProxy {
  taskId: string; server: http.Server; port: number; token: string; target: URL | null; hooks: ReviewHooks;
  lastSeen: number; closeTimer: NodeJS.Timeout | null;
}
const proxies = new Map<string, ReviewProxy>();
const WIDGET_PATH = '/__oficina/widget.js';
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/i;

let widgetSource: string | null = null;
const widget = (): string => (widgetSource ??= fs.readFileSync(new URL('./review-widget.js', import.meta.url), 'utf8'));

const hostIsLocal = (host: string | undefined): boolean => {
  const m = host?.match(/^(\[[^\]]+\]|[^:]+)(?::\d+)?$/);
  return !!m && LOOPBACK.test(m[1]!);
};

const WAITING_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="4"><title>Waiting for the app</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f8fa;color:#1b1f24}main{max-width:30rem;padding:24px}@media(prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}}</style></head>
<body><main><h1 style="font-size:1.25rem;margin:0 0 .5rem">The app is not running right now</h1><p style="margin:0">Oficina starts it again for each review. This page checks every few seconds, and the review panel shows what is happening.</p></main></body></html>`;

function inject(html: string, token: string): string {
  const tag = `<script src="${WIDGET_PATH}?t=${token}" defer></script>`;
  const i = html.toLowerCase().lastIndexOf('</body>');
  return i >= 0 ? html.slice(0, i) + tag + html.slice(i) : html + tag;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function handleOwn(p: ReviewProxy, req: http.IncomingMessage, res: http.ServerResponse, path: string): void {
  const origin = `http://${req.headers.host}`;
  if (path === WIDGET_PATH) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    res.end(widget());
    return;
  }
  if (req.headers['x-oficina-token'] !== p.token) return json(res, 403, { error: 'this page is not part of the review' });
  if (path === '/__oficina/state' && req.method === 'GET') {
    p.lastSeen = Date.now();
    return json(res, 200, p.hooks.state());
  }
  if (path === '/__oficina/decide' && req.method === 'POST') {
    if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: 'requests from other sites are not accepted' });
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 20_000) req.destroy(); });
    req.on('end', () => {
      let b: { approve?: unknown; reason?: unknown; page?: unknown } = {};
      try { b = JSON.parse(raw || '{}'); } catch { return json(res, 400, { error: 'bad request' }); }
      const r = p.hooks.decide(b.approve === true, String(b.reason ?? '').trim().slice(0, 4000), String(b.page ?? '').slice(0, 300));
      if ('error' in r) return json(res, r.status, { error: r.error });
      json(res, 200, { ok: true });
    });
    return;
  }
  json(res, 404, { error: 'not found' });
}

/** Headers for the app: it must see itself as the host, not the proxy. */
function toTarget(headers: http.IncomingHttpHeaders, p: ReviewProxy, extra: Record<string, string> = {}): http.OutgoingHttpHeaders {
  const t = p.target!;
  const out: http.OutgoingHttpHeaders = { ...headers, host: t.host, ...extra };
  const back = new RegExp(`^https?://(127\\.0\\.0\\.1|localhost|\\[::1\\]):${p.port}`, 'i');
  for (const k of ['origin', 'referer'] as const) if (typeof out[k] === 'string') out[k] = (out[k] as string).replace(back, t.origin);
  return out;
}

function forward(p: ReviewProxy, req: http.IncomingMessage, res: http.ServerResponse): void {
  const t = p.target;
  const wantsHtml = String(req.headers.accept ?? '').includes('text/html');
  if (!t) {
    if (!wantsHtml) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('The app is not running.'); return; }
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(inject(WAITING_PAGE, p.token));
    return;
  }
  const up = http.request({ hostname: t.hostname, port: t.port || 80, method: req.method, path: req.url, headers: toTarget(req.headers, p, { 'accept-encoding': 'identity' }) }, (ur) => {
    const headers = { ...ur.headers };
    const loc = headers.location;
    if (typeof loc === 'string' && loc.startsWith(t.origin)) headers.location = `http://${req.headers.host}${loc.slice(t.origin.length)}`;
    const isHtml = /text\/html/i.test(String(headers['content-type'] ?? '')) && !headers['content-encoding'];
    if (!isHtml) { res.writeHead(ur.statusCode ?? 502, headers); ur.pipe(res); return; }
    const chunks: Buffer[] = [];
    ur.on('data', (c: Buffer) => chunks.push(c));
    ur.on('end', () => {
      const body = Buffer.from(inject(Buffer.concat(chunks).toString('utf8'), p.token), 'utf8');
      delete headers['transfer-encoding']; delete headers.etag;
      headers['content-length'] = String(body.length); headers['cache-control'] = 'no-store';
      res.writeHead(ur.statusCode ?? 502, headers);
      res.end(body);
    });
  });
  up.on('error', () => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'content-type': wantsHtml ? 'text/html; charset=utf-8' : 'text/plain' });
    res.end(wantsHtml ? inject(WAITING_PAGE, p.token) : 'The app did not answer.');
  });
  req.pipe(up);
}

/** Live reload sockets (Vite, webpack, Next) go straight through. */
function tunnel(p: ReviewProxy, req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
  const t = p.target;
  if (!t) { socket.destroy(); return; }
  const up = net.connect(Number(t.port || 80), t.hostname, () => {
    const headers = toTarget(req.headers, p);
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(headers)) for (const x of Array.isArray(v) ? v : [v]) if (x != null) lines.push(`${k}: ${x}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
  socket.on('close', () => up.destroy());
}

/** Create the review window for a task, or point the existing one at the (new) app address. Resolves to the proxy's address. */
export async function ensureReviewProxy(taskId: string, appUrl: string | null, hooks: ReviewHooks): Promise<string> {
  let p = proxies.get(taskId);
  if (p?.closeTimer) { clearTimeout(p.closeTimer); p.closeTimer = null; }
  if (!p) {
    const created: ReviewProxy = { taskId, server: http.createServer(), port: 0, token: crypto.randomBytes(16).toString('hex'), target: null, hooks, lastSeen: 0, closeTimer: null };
    created.server.on('request', (req, res) => {
      if (!hostIsLocal(req.headers.host)) { res.writeHead(403); res.end('localhost only'); return; }
      const path = (req.url ?? '/').split('?')[0]!;
      if (path.startsWith('/__oficina/')) handleOwn(created, req, res, path); else forward(created, req, res);
    });
    created.server.on('upgrade', (req, socket, head) => {
      if (!hostIsLocal(req.headers.host)) { socket.destroy(); return; }
      tunnel(created, req, socket as net.Socket, head);
    });
    created.server.unref();
    await new Promise<void>((resolve, reject) => { created.server.once('error', reject); created.server.listen(0, '127.0.0.1', resolve); });
    created.port = (created.server.address() as net.AddressInfo).port;
    proxies.set(taskId, created);
    p = created;
  }
  p.hooks = hooks;
  p.target = appUrl ? new URL(appUrl) : null;
  return `http://127.0.0.1:${p.port}`;
}

export function setReviewTarget(taskId: string, appUrl: string | null): void {
  const p = proxies.get(taskId);
  if (p) p.target = appUrl ? new URL(appUrl) : null;
}

export const reviewProxyBase = (taskId: string): string | null => { const p = proxies.get(taskId); return p ? `http://127.0.0.1:${p.port}` : null; };

/** True while a review tab is open and polling, so the next round reloads that tab instead of opening another. */
export const reviewTabOpen = (taskId: string): boolean => { const p = proxies.get(taskId); return !!p && Date.now() - p.lastSeen < 8000; };

/** Close the review window after `afterMs` (the widget shows its final message first). */
export function closeReviewProxy(taskId: string, afterMs = 0): void {
  const p = proxies.get(taskId);
  if (!p || p.closeTimer) return;
  const close = () => { proxies.delete(taskId); p.server.closeAllConnections?.(); p.server.close(); };
  if (afterMs <= 0) close(); else { p.closeTimer = setTimeout(close, afterMs); p.closeTimer.unref(); }
}

export function closeAllReviewProxies(): void { for (const id of [...proxies.keys()]) closeReviewProxy(id); }
process.on('exit', () => { try { closeAllReviewProxies(); } catch { /* shutting down */ } });
