// A rate-limited model stays out until its reset; another model on the same
// machine is used in the meantime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-limit-'));
const { run } = await import('../src/db.ts');
const { rateLimitRetryAfterSec, markRateLimited, windowBlocking } = await import('../src/services/usage.ts');
const { modelChain } = await import('../src/services/router.ts');

const noon = Date.parse('2026-10-18T12:00:00');

test('rate-limit text yields the reset delay, and ordinary errors do not', () => {
  assert.equal(rateLimitRetryAfterSec('cli exited 1: boom', noon), null);
  assert.equal(rateLimitRetryAfterSec("You've hit your limit · resets in 5 hours", noon), 5 * 3600);
  assert.equal(rateLimitRetryAfterSec('rate limited, resets at 3pm', noon), 3 * 3600);
  assert.equal(rateLimitRetryAfterSec('429 too many requests', noon), 3600);
});

test('a limited model is skipped until reset; another model is used', () => {
  run(`INSERT INTO providers (id, name, kind, adapter_id, tier, enabled) VALUES ('p','Claude','agent','cli',2,1)`);
  run(`INSERT INTO accounts (id, provider_id, label, enabled) VALUES ('acct','p','claude',1)`);
  run(`INSERT INTO models (id, provider_id, name, strength_tier) VALUES ('m-opus','p','opus','strong'), ('m-sonnet','p','sonnet','standard')`);
  markRateLimited('acct', 'm-opus', { 'retry-after': '7200' });
  assert.ok(windowBlocking('acct', 0, 'm-opus'));
  assert.equal(windowBlocking('acct', 0, 'm-sonnet'), null);

  const chain = modelChain({
    agent: { id: 'ag', name: 'Dev', settings: {}, accountId: 'acct', modelId: 'm-opus' },
    account: { id: 'acct', providerId: 'p', enabled: 1, billing: 'payg', monthlyBudgetUsd: null, config: {} },
    provider: { id: 'p', name: 'Claude', adapterId: 'cli', enabled: 1, kind: 'agent', tier: 2 },
    model: { id: 'm-opus', providerId: 'p', name: 'opus', strengthTier: 'strong', contextTokens: 1, maxOutputTokens: 1, priceIn: 0, priceOut: 0, supports: {} },
    role: { id: 'r', name: 'developer' }, membership: {},
  });
  assert.equal(chain[0].blocked, 'quota exhausted');
  assert.equal(chain.find((c) => !c.blocked)?.model?.id, 'm-sonnet');
});
