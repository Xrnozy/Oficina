// The model-tier override: a workflow step's tier wins, then the agent's own, then kind + difficulty.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-tier-'));
const { routeChain } = await import('../src/services/routing.ts');
const { modelSettings } = await import('../src/services/models.ts');

const opt = (name, tier) => ({ account: { id: `a-${name}`, billing: 'subscription' }, provider: { id: 'p', adapterId: 'cli' }, model: { id: name, name, strengthTier: tier } });
const chain = [opt('small', 'fast'), opt('mid', 'standard'), opt('big', 'strong')];

test('with no override, an easy docs task is routed to the cheapest sufficient model', () => {
  const d = routeChain(chain, 'doc', 1);
  assert.equal(d.required, 'fast');
  assert.equal(d.ordered[0].model.name, 'small');
  assert.doesNotMatch(d.reason, /set on the/);
});

test('an agent override forces the tier even for easy work, and the decision says where it came from', () => {
  const d = routeChain(chain, 'doc', 1, 'strong', 'agent');
  assert.equal(d.required, 'strong');
  assert.equal(d.ordered[0].model.name, 'big');
  assert.match(d.reason, /set on the agent/);
});

test('a workflow node override is reported as the node', () => {
  const d = routeChain(chain, 'implement', 5, 'fast', 'node');
  assert.equal(d.ordered[0].model.name, 'small');
  assert.match(d.reason, /set on the node/);
});

test('the agent tier override is read from settings and ignores junk', () => {
  assert.equal(modelSettings({ tierOverride: 'strong' }).tierOverride, 'strong');
  assert.equal(modelSettings({ tierOverride: 'enormous' }).tierOverride, null);
  assert.equal(modelSettings({}).tierOverride, null);
});
