import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/db.js';
import { reconcile, startReconciler } from '../src/reconcile.js';
import { createQueue } from '../src/queue.js';
import { maskEmail } from '../src/validation.js';

const now = Date.parse('2026-11-04T12:00:00Z');
const row = (email, status = 'active') => ({ email, provider: 'generic', status,
  current_period_end: '2026-12-01T00:00:00Z', updated_at: '2026-11-04T12:00:00Z' });

test('SQLite normalizes links, replaces links and namespaces event IDs', t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  store.link('one', ' Buyer@Example.COM ');
  assert.equal(store.getLink('one').email, 'buyer@example.com');
  store.link('one', 'other@example.com');
  assert.equal(store.linksForEmail('buyer@example.com').length, 0);
  assert.equal(store.listLinks().length, 1);
  store.recordEvent('generic', 'same'); store.recordEvent('generic', 'same');
  assert.equal(store.hasEvent('generic', 'same'), true);
  assert.equal(store.hasEvent('stripe', 'same'), false);
  assert.equal(maskEmail(' Buyer@Example.COM '), 'b***@example.com');
});

test('SQLite retains state across reopening and ignores older provider updates', t => {
  const dir = mkdtempSync(join(tmpdir(), 'membership-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'nested', 'bot.db');
  let store = openStore(path);
  try {
    store.link('one', 'buyer@example.com');
    store.upsertSubscription(row(' Buyer@Example.COM '));
    store.upsertSubscription({ ...row('buyer@example.com', 'expired'), updated_at: '2026-11-03T00:00:00Z' });
    store.recordEvent('stripe', 'evt_1');
    store.close(); store = openStore(path);
    assert.equal(store.getLink('one').email, 'buyer@example.com');
    assert.equal(store.subscriptionsFor('buyer@example.com')[0].status, 'active');
    assert.equal(store.hasEvent('stripe', 'evt_1'), true);
  } finally { store.close(); }
});

test('reconcile grants paid/canceled links, revokes ended/missing and isolates failures', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  for (const [id, status] of [['active', 'active'], ['canceled', 'canceled'], ['expired', 'expired'], ['fail', 'active']]) {
    store.link(id, `${id}@example.com`); store.upsertSubscription(row(`${id}@example.com`, status));
  }
  store.link('missing', 'missing@example.com');
  const calls = []; const errors = [];
  const actions = { grantRole: async id => { if (id === 'fail') throw new Error('private@example.com'); calls.push(['grant', id]); },
    revokeRole: async id => calls.push(['revoke', id]) };
  const summary = await reconcile(store, actions, { now, logger: { error: message => errors.push(message) } });
  assert.deepEqual(summary, { checked: 5, grant: 1, keep: 1, revoke: 2, failed: 1 });
  assert.deepEqual(calls, [['grant', 'active'], ['grant', 'canceled'], ['revoke', 'expired'], ['revoke', 'missing']]);
  assert.match(errors[0], /f\*\*\*@example.com/);
  assert.doesNotMatch(errors.join(''), /fail@example|private@example/);
});

test('reconciliation removes active roles at the exact end boundary without a new webhook', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  store.link('member', 'buyer@example.com'); store.upsertSubscription(row('buyer@example.com'));
  const calls = [];
  await reconcile(store, { grantRole: async () => assert.fail('must revoke'), revokeRole: async id => calls.push(id) },
    { now: Date.parse('2026-12-01T00:00:00Z') });
  assert.deepEqual(calls, ['member']);
});

test('queue preserves ordering after a failed operation', async () => {
  const enqueue = createQueue(); const calls = [];
  const first = enqueue(async () => { calls.push(1); throw new Error('retry'); });
  const second = enqueue(async () => calls.push(2));
  await assert.rejects(first, /retry/); await second;
  assert.deepEqual(calls, [1, 2]);
});

test('periodic reconciliation does not overlap and stop waits for the current run', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0, finish;
  const stop = startReconciler(() => { calls++; return new Promise(resolve => { finish = resolve; }); }, 1);
  t.mock.timers.tick(60_000); await Promise.resolve();
  t.mock.timers.tick(120_000); await Promise.resolve();
  assert.equal(calls, 1);
  const stopped = stop(); finish(); await stopped;
  t.mock.timers.tick(60_000); await Promise.resolve();
  assert.equal(calls, 1);
});
