import { clearBusySessions } from './services/cli-sessions.ts';
import { startQueueLoop } from './services/queue.ts';
import { relocateLegacy } from './services/attachments.ts';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.ts';
import { DATA_DIR, q1, run } from './db.ts';
import { reconcileOnBoot, startTimerLoop, wireEngineEvents } from './engine/engine.ts';
import { createServer } from './api/server.ts';
import { seedIfEmpty } from './seed.ts';
import { migrate } from './migrate.ts';
import { adapterHash } from './config.ts';
import { ulid, now } from './util.ts';

// Entry point: config → db → seed → engine reconcile → HTTP/WS server.

// One daemon per data folder. A second copy (e.g. an old `npm run dev`
// still watching files) would re-queue and kill the first one's work
// before failing on the port — so it stops here, before touching any state.
function acquireLock(): void {
  const lock = path.join(DATA_DIR, 'daemon.lock');
  try {
    const pid = Number(fs.readFileSync(lock, 'utf8').trim());
    if (pid && pid !== process.pid) {
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch (e: any) { alive = e?.code === 'EPERM'; }
      if (alive) {
        console.error(`[office] another Oficina daemon (pid ${pid}) is already running on ${DATA_DIR} — exiting. Stop that one first.`);
        process.exit(1);
      }
    }
  } catch { /* no lock yet */ }
  fs.writeFileSync(lock, String(process.pid));
  const release = () => { try { if (fs.readFileSync(lock, 'utf8').trim() === String(process.pid)) fs.rmSync(lock); } catch { /* gone */ } };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => { release(); process.exit(0); });
}

acquireLock();
const config = loadConfig();
seedIfEmpty(config);
migrate();
syncConfiguredProviders(config);
wireEngineEvents();
reconcileOnBoot();
startTimerLoop();
startQueueLoop();
try { const n = relocateLegacy(); if (n) console.log(`[attachments] moved ${n} reference file(s) into their repository's documents/ folder`); } catch (e) { console.warn('[attachments] relocation skipped:', String(e).slice(0, 120)); }
clearBusySessions();
createServer(config.port, config.uiDir);

// Providers declared in office.yaml are upserted so accounts/agents can point
// at them (spec 8: integrations are pinned, hash-versioned adapters).
function syncConfiguredProviders(config: ReturnType<typeof loadConfig>): void {
  for (const p of config.providers) {
    // a provider the owner removed stays removed even though office.yaml lists it
    if (q1('SELECT id FROM provider_tombstones WHERE id = ?', p.id)) continue;
    const existing = q1('SELECT id FROM providers WHERE id = ?', p.id);
    const caps = {
      models: (p.models ?? []).map((m) => m.name),
      settings: {},
      reasoningVisibility: p.adapter === 'scripted' ? 'none' : 'summary',
      observability: p.adapter === 'cli' ? 'actions' : p.adapter === 'manual' ? 'manual' : p.kind === 'agent' ? 'status-only' : 'full',
      midSessionMessages: false, suspendResume: false, webhooks: false,
      usageData: { perResponse: p.kind === 'model', accountApi: false, resetTimes: 'exact' },
      mcp: false, nativeSkills: false,
    };
    if (!existing) {
      run(`INSERT INTO providers (id, name, kind, adapter_id, adapter_version, adapter_hash, tier, enabled, capabilities, config)
           VALUES (?,?,?,?,?,?,?,1,?,?)`,
        p.id, p.name, p.kind, p.adapter, '1.0.0', adapterHash(p.adapter, '1.0.0'), p.tier ?? 1,
        JSON.stringify(caps), JSON.stringify({ baseUrl: p.baseUrl, command: p.command, ...(p.config ?? {}) }));
    }
    for (const m of p.models ?? []) {
      const mid = `${p.id}:${m.name}`;
      if (!q1('SELECT id FROM models WHERE id = ?', mid)) {
        run(`INSERT INTO models (id, provider_id, name, context_tokens, max_output_tokens, price_in, price_out, strength_tier)
             VALUES (?,?,?,?,?,?,?,?)`,
          mid, p.id, m.name, m.contextTokens ?? 128000, m.maxOutputTokens ?? 8192,
          m.priceIn ?? 0, m.priceOut ?? 0, m.strengthTier ?? 'standard');
      }
    }
  }
  void ulid; void now;
}
