import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { openStore } from '../src/db.js';
import { createServer } from '../src/server.js';

const now = Date.parse('2026-11-04T12:00:00Z');
const secret = 'server-test-secret';
const payload = { id: 'evt_1', email: ' Buyer@Example.com ', status: 'active', current_period_end: '2026-12-01T00:00:00Z' };

/** Start a localhost HTTP server with isolated storage and observable fake actions. */
async function fixture(t, overrides = {}) {
  const store = openStore(':memory:');
  const calls = []; const logs = [];
  const actions = {
    grantRole: async id => calls.push(['grant', id]), revokeRole: async id => calls.push(['revoke', id]),
    postOrder: async order => calls.push(['order', order]), ...overrides.actions,
  };
  const secrets = { generic: secret, shopify: secret, stripe: secret,
    whop: `whsec_${Buffer.from(secret).toString('base64')}`, ...overrides.secrets };
  const server = createServer({ store, actions, config: { secrets }, now: () => now,
    logger: { error: message => logs.push(message) } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function post(provider, data, extraHeaders = {}, rawOverride) {
    const raw = rawOverride ?? JSON.stringify(data);
    const mac = (input, encoding = 'hex') => createHmac('sha256', secret).update(input).digest(encoding);
    let headers;
    if (provider === 'stripe') headers = { 'stripe-signature': `t=${now / 1000},v1=${mac(`${now / 1000}.${raw}`)}` };
    else if (provider === 'whop') headers = { 'webhook-id': 'msg_1', 'webhook-timestamp': String(now / 1000),
      'webhook-signature': `v1,${mac(`msg_1.${now / 1000}.${raw}`, 'base64')}` };
    else if (provider === 'shopify') headers = { 'x-shopify-hmac-sha256': mac(raw, 'base64'), 'x-shopify-topic': 'orders/create' };
    else headers = { 'x-signature': mac(raw) };
    return fetch(`${base}/webhooks/${provider}`, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: raw });
  }
  return { store, calls, logs, post, base };
}

test('health, unknown paths, unsupported methods and disabled routes', async t => {
  const f = await fixture(t, { secrets: { whop: '' } });
  const health = await fetch(`${f.base}/health`);
  assert.equal(health.status, 200); assert.deepEqual(await health.json(), { ok: true });
  for (const path of ['/missing', '/webhooks/unknown', '/webhooks/generic']) {
    assert.equal((await fetch(`${f.base}${path}`)).status, 404);
  }
  assert.equal((await f.post('whop', {})).status, 404);
  assert.equal((await f.post('unknown', {})).status, 404);
});

test('bad signatures return 401 before parsing or mutating state', async t => {
  const f = await fixture(t);
  for (const [provider, header] of [['generic', 'x-signature'], ['stripe', 'stripe-signature'],
    ['whop', 'webhook-signature'], ['shopify', 'x-shopify-hmac-sha256']]) {
    assert.equal((await f.post(provider, null, { [header]: 'bad' }, 'not-json')).status, 401);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.store.subscriptionsFor('buyer@example.com').length, 0);
});

test('valid generic delivery syncs every matching link and ignores duplicate/concurrent deliveries', async t => {
  const f = await fixture(t);
  f.store.link('member1', 'buyer@example.com'); f.store.link('member2', 'BUYER@example.com');
  const responses = await Promise.all([f.post('generic', payload), f.post('generic', payload), f.post('generic', payload)]);
  assert.deepEqual(responses.map(response => response.status), [200, 200, 200]);
  const bodies = await Promise.all(responses.map(response => response.json()));
  assert.equal(bodies.filter(body => body.duplicate).length, 2);
  assert.deepEqual(f.calls, [['grant', 'member1'], ['grant', 'member2']]);
  assert.equal(f.store.subscriptionsFor('buyer@example.com')[0].status, 'active');
});

test('generic payloads without event IDs deduplicate by signed body hash', async t => {
  const f = await fixture(t); f.store.link('member', 'buyer@example.com');
  const event = { ...payload }; delete event.id;
  assert.equal((await f.post('generic', event)).status, 200);
  assert.equal((await (await f.post('generic', event)).json()).duplicate, true);
  assert.equal(f.calls.length, 1);
});

test('failed actions return 500 without recording the event; retry succeeds', async t => {
  let attempts = 0;
  const f = await fixture(t, { actions: { grantRole: async () => {
    if (++attempts === 1) throw new Error('private@example.com');
  } } });
  f.store.link('member', 'buyer@example.com');
  assert.equal((await f.post('generic', payload)).status, 500);
  assert.equal(f.store.hasEvent('generic', payload.id), false);
  assert.equal((await f.post('generic', payload)).status, 200);
  assert.equal(f.store.hasEvent('generic', payload.id), true);
  assert.equal(attempts, 2); assert.doesNotMatch(f.logs.join(''), /private@example.com/);
});

test('cancel keeps paid access and expired revokes immediately', async t => {
  const f = await fixture(t); f.store.link('member', 'buyer@example.com');
  await f.post('generic', { ...payload, status: 'canceled' });
  await f.post('generic', { ...payload, id: 'evt_2', status: 'expired' });
  assert.deepEqual(f.calls, [['grant', 'member'], ['revoke', 'member']]);
});

test('Stripe and Whop routes authenticate, normalize and sync linked members', async t => {
  const f = await fixture(t); f.store.link('member', 'buyer@example.com');
  const event = { id: 'stripe_1', created: now / 1000, type: 'customer.subscription.created',
    data: { object: { metadata: { email: 'buyer@example.com' }, status: 'active',
      current_period_end: Date.parse(payload.current_period_end) / 1000 } } };
  assert.equal((await f.post('stripe', event)).status, 200);
  assert.equal((await f.post('whop', { type: 'membership.went_invalid',
    data: { user: { email: 'buyer@example.com' }, renewal_period_end: payload.current_period_end } })).status, 200);
  // Expiring Whop cannot revoke Stripe's active entitlement.
  assert.deepEqual(f.calls, [['grant', 'member'], ['grant', 'member']]);
  assert.equal((await f.post('stripe', { id: 'ignored', type: 'other' })).status, 200);
});

test('Shopify posts once, with no email, phone, address or surname', async t => {
  const f = await fixture(t);
  const order = { id: 123, name: '#123', total_price: '45.00', currency: 'USD', line_items: [{ quantity: 3 }],
    email: 'private@example.com', phone: '+12345678', shipping_address: { address1: 'Secret Street' },
    customer: { first_name: 'Ada', last_name: 'Private', email: 'private@example.com', phone: '+12345678' } };
  assert.equal((await f.post('shopify', order)).status, 200);
  assert.equal((await f.post('shopify', order, { 'x-shopify-webhook-id': 'changed-header' })).status, 200);
  assert.deepEqual(f.calls, [['order', { orderName: '#123', total: '45.00', currency: 'USD', itemCount: 3, customerFirstName: 'Ada' }]]);
  assert.doesNotMatch(JSON.stringify(f.calls), /email|phone|address|Private|Secret|@/);
});

test('ignored Shopify topics do not consume the later orders/create delivery', async t => {
  const f = await fixture(t);
  const order = { id: 10, name: '#10', total_price: '1.00', currency: 'USD', line_items: [] };
  assert.equal((await (await f.post('shopify', order, { 'x-shopify-topic': 'orders/updated' })).json()).ignored, true);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.post('shopify', order)).status, 200);
  assert.equal(f.calls.length, 1);
});

test('signed malformed JSON and invalid subscription payloads return 400', async t => {
  const f = await fixture(t);
  for (const raw of ['{', 'null', '[]']) assert.equal((await f.post('generic', null, {}, raw)).status, 400);
  for (const patch of [{ email: 'invalid' }, { status: 'unknown' }, { current_period_end: 'bad' }, { id: {} }]) {
    assert.equal((await f.post('generic', { ...payload, ...patch })).status, 400);
  }
  assert.equal(f.calls.length, 0);
});

test('raw request limit returns 413 above 1 MiB and accepts exactly 1 MiB', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('generic', null, {}, 'a'.repeat(1024 * 1024 + 1))).status, 413);
  const small = JSON.stringify({ ...payload, padding: '' });
  const exact = JSON.stringify({ ...payload, padding: 'x'.repeat(1024 * 1024 - Buffer.byteLength(small)) });
  assert.equal(Buffer.byteLength(exact), 1024 * 1024);
  assert.equal((await f.post('generic', null, {}, exact)).status, 200);
});
