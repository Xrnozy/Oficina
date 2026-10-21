// The API is local-only: a web page in the owner's browser (or a DNS-rebinding page) must not be able to drive it,
// and an API failure must answer instead of taking the daemon down.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-apisec-'));
const { createServer, isAllowedOrigin, isLocalHostHeader } = await import('../src/api/server.ts');
const { run } = await import('../src/db.ts');
const { WebSocket } = await import('ws');

const port = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const server = createServer(port, 'no-ui-here');
await new Promise((r) => server.once('listening', r));
fs.mkdirSync(path.join(process.env.OFFICE_DATA_DIR, 'blobs'), { recursive: true });
fs.writeFileSync(path.join(process.env.OFFICE_DATA_DIR, 'secret.log'), 'not for the web');

function request(method, url, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => resolve({ status: res.statusCode, body: s }));
    });
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}

test('only loopback Host headers and the app\'s own origins are accepted', () => {
  for (const h of ['localhost:4780', '127.0.0.1:4780', '[::1]:4780', 'localhost']) assert.equal(isLocalHostHeader(h), true, h);
  for (const h of ['evil.example:4780', 'localhost.evil.example', '127.0.0.1.nip.io:4780', undefined]) assert.equal(isLocalHostHeader(h), false, String(h));
  assert.equal(isAllowedOrigin(undefined, 4780), true);                       // tray, scripts, curl
  assert.equal(isAllowedOrigin('http://localhost:4780', 4780), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:5173', 4780), true);         // the Vite dev server
  for (const o of ['https://evil.example', 'http://localhost:3000', 'null', 'http://localhost.evil.example:4780']) assert.equal(isAllowedOrigin(o, 4780), false, o);
});

test('a DNS-rebinding request (foreign Host) is refused, reads included', async () => {
  const r = await request('GET', '/api/workspaces', { host: `attacker.example:${port}` });
  assert.equal(r.status, 403);
});

test('a cross-site page cannot change anything; the app itself and header-less clients can', async () => {
  run(`INSERT INTO runs (id, workspace_id, goal, status) VALUES ('run-sec','ws','g','paused')`);
  const evil = await request('POST', '/api/approvals/approve-all', { origin: 'https://evil.example', 'content-type': 'text/plain' }, '{}');
  assert.equal(evil.status, 403);
  const sfs = await request('POST', '/api/runs/run-sec/stop', { 'sec-fetch-site': 'cross-site' });
  assert.equal(sfs.status, 403);
  const app = await request('POST', '/api/approvals/approve-all', { origin: `http://localhost:${port}`, 'content-type': 'application/json' }, '{}');
  assert.equal(app.status, 200, app.body);
  const tray = await request('GET', '/api/queue');
  assert.equal(tray.status, 200);
});

test('the event stream refuses a foreign page', async () => {
  const open = (origin) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin, headers: { host: `localhost:${port}` } });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('error', () => resolve('refused'));
    ws.on('unexpected-response', () => resolve('refused'));
  });
  assert.equal(await open('https://evil.example'), 'refused');
  assert.equal(await open(`http://localhost:${port}`), 'open');
});

test('blob names cannot walk out of the blob folder', async () => {
  const r = await request('GET', `/api/blobs/..%5Csecret`);
  assert.equal(r.status, 404);
  assert.doesNotMatch(r.body, /not for the web/);
});

test('a failing async route answers with a JSON error instead of crashing or hanging', async () => {
  const r = await request('POST', '/api/cli-sessions/import', { 'content-type': 'application/json' }, '{"accountId":"nope","cwd":"x"}');
  assert.equal(r.status, 400);
  const bad = await request('POST', '/api/queue', { 'content-type': 'application/json' }, '{not json');
  assert.equal(bad.status, 400);
  assert.ok(JSON.parse(bad.body).error);
});

test('a CLI backend\'s stall watchdog can be set, turned off and reset', async () => {
  const { q1: one } = await import('../src/db.ts');
  run(`INSERT INTO providers (id, name, kind, adapter_id, tier, enabled, capabilities, config) VALUES ('cli-x','X','agent','cli',2,1,'{}','{}')`);
  run(`INSERT INTO accounts (id, provider_id, label, enabled, config) VALUES ('acct-cli-x','cli-x','x',1,'{"command":"claude -p"}')`);
  const put = (v) => request('PUT', '/api/providers/cli-x', { 'content-type': 'application/json' }, JSON.stringify({ idleTimeoutSec: v }));
  const cfg = () => JSON.parse(one(`SELECT config FROM accounts WHERE id = 'acct-cli-x'`).config);
  assert.equal((await put(120)).status, 200);
  assert.equal(cfg().idleTimeoutSec, 120);
  assert.equal(cfg().command, 'claude -p', 'the rest of the backend config is kept');
  assert.equal((await put(0)).status, 200);
  assert.equal(cfg().idleTimeoutSec, 0);
  assert.equal((await put('soon')).status, 400);
  assert.equal((await put(null)).status, 200);
  assert.equal('idleTimeoutSec' in cfg(), false);
});

test.after(() => server.close());
