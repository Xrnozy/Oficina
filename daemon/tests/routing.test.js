// Model routing: per work item, the cheapest option whose tier is strong
// enough, plan-billed backends first; blocked options are skipped.
import assert from 'node:assert/strict';
import test from 'node:test';
import { inferTier, marginalCost, requiredTier, routeChain } from '../src/services/routing.ts';

const opt = (name, tier, { adapter = 'anthropic', billing = 'payg', priceIn = 0, priceOut = 0, blocked } = {}) => ({
  agent: { id: 'a1', name: 'Dev', settings: {} },
  account: { id: `acct-${name}`, billing },
  provider: { id: `p-${adapter}`, adapterId: adapter },   // options on the same backend share a provider
  model: { id: `m-${name}`, name, strengthTier: tier, priceIn, priceOut },
  role: { name: 'developer' },
  blocked,
});

test('required tier follows work kind and difficulty', () => {
  assert.equal(requiredTier('implement', 1), 'fast');
  assert.equal(requiredTier('implement', 3), 'standard');
  assert.equal(requiredTier('implement', 5), 'strong');
  assert.equal(requiredTier('analyse', 2), 'fast');
  assert.equal(requiredTier('accept', 2), 'fast');            // judging a report on an easy task
  assert.equal(requiredTier('accept', 3), 'standard');
  assert.equal(requiredTier('prompt-review', 5), 'strong');
  assert.equal(requiredTier('plan', 4), 'strong');
});

test('cheapest sufficient option wins; plan-billed beats metered', () => {
  const metered = opt('sonnet', 'standard', { priceIn: 3, priceOut: 15 });
  const cli = opt('claude-cli', 'standard', { adapter: 'cli' });
  const d = routeChain([metered, cli], 'implement', 3);
  assert.equal(d.ordered[0].model.name, 'claude-cli');
  assert.equal(marginalCost(cli, 'implement'), 0);
  assert.ok(marginalCost(metered, 'implement') > 0);
});

test('a too-weak model is passed over, and an overpowered one is not preferred', () => {
  const fast = opt('haiku', 'fast', { adapter: 'cli' });
  const std = opt('sonnet', 'standard', { adapter: 'cli' });
  const strong = opt('opus', 'strong', { adapter: 'cli' });
  assert.equal(routeChain([strong, fast, std], 'implement', 3).ordered[0].model.name, 'sonnet');
  assert.equal(routeChain([strong, std, fast], 'analyse', 2).ordered[0].model.name, 'haiku');
  // nothing strong enough: the strongest available
  assert.equal(routeChain([fast, std], 'implement', 5).ordered[0].model.name, 'sonnet');
});

test('blocked options go last', () => {
  const cheap = opt('cli', 'standard', { adapter: 'cli', blocked: 'quota exhausted' });
  const paid = opt('api', 'standard', { priceIn: 1, priceOut: 5 });
  const d = routeChain([cheap, paid], 'implement', 3);
  assert.equal(d.ordered[0].model.name, 'api');
  assert.equal(d.ordered[1].model.name, 'cli');
});

test('tier is inferred from model names', () => {
  assert.equal(inferTier('claude-haiku-4-5'), 'fast');
  assert.equal(inferTier('gpt-4o-mini'), 'fast');
  assert.equal(inferTier('claude-opus-4-1'), 'strong');
  assert.equal(inferTier('swe-2-high SWE-2 High'), 'strong');
  assert.equal(inferTier('claude-sonnet-4-5'), 'standard');
  assert.equal(inferTier('normal Agent (normal)'), 'standard');
});

test('equal cost: the agent stays on its own provider instead of hopping to a fallback', () => {
  const claudeOpus = { ...opt('opus', 'strong', { adapter: 'cli' }), provider: { id: 'claude-code', adapterId: 'cli' } };
  const claudeHaiku = { ...opt('haiku', 'fast', { adapter: 'cli' }), provider: { id: 'claude-code', adapterId: 'cli' } };
  const cursor = { ...opt('composer', 'standard', { adapter: 'cli' }), provider: { id: 'cursor-agent', adapterId: 'cli' } };
  // standard work: opus (own provider) wins over the fallback's standard model
  assert.equal(routeChain([claudeOpus, cursor], 'prompt-review', 2).ordered[0].model.name, 'opus');
  // fast work: steps down within its own provider
  assert.equal(routeChain([claudeOpus, cursor, claudeHaiku], 'analyse', 2).ordered[0].model.name, 'haiku');
  // own provider unavailable: the fallback is used
  assert.equal(routeChain([{ ...claudeOpus, blocked: 'quota exhausted' }, cursor], 'prompt-review', 2).ordered[0].model.name, 'composer');
});
