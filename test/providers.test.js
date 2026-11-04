import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import * as stripe from '../src/providers/stripe.js';
import * as whop from '../src/providers/whop.js';
import * as generic from '../src/providers/generic.js';
import * as shopify from '../src/providers/shopify.js';

const now = Date.parse('2026-11-04T12:00:00Z');
const seconds = now / 1000;
const end = '2026-12-04T12:00:00.000Z';
const raw = Buffer.from('{"test":"raw bytes: café"}');
const secret = 'offline-test-secret';
const sign = (key, body, encoding = 'hex') => createHmac('sha256', key).update(body).digest(encoding);
const stripeHeader = timestamp => ({ 'stripe-signature': `t=${timestamp},v1=${sign(secret, `${timestamp}.${raw}`)}` });
const whopHeader = timestamp => ({ 'webhook-id': 'msg_123', 'webhook-timestamp': String(timestamp),
  'webhook-signature': `v1,${sign(secret, `msg_123.${timestamp}.${raw}`, 'base64')}` });
const whopSecret = `whsec_${Buffer.from(secret).toString('base64')}`;

for (const [name, provider, key, headers] of [
  ['stripe', stripe, secret, stripeHeader(seconds)],
  ['whop', whop, whopSecret, whopHeader(seconds)],
  ['generic', generic, secret, { 'x-signature': sign(secret, raw) }],
  ['shopify', shopify, secret, { 'x-shopify-hmac-sha256': sign(secret, raw, 'base64') }],
]) {
  test(`${name}: authentic raw body passes and altered body/secret/header fail`, () => {
    assert.equal(provider.verify(raw, headers, key, now), true);
    assert.equal(provider.verify(Buffer.concat([raw, Buffer.from(' ')]), headers, key, now), false);
    assert.equal(provider.verify(raw, headers, `${key}wrong`, now), false);
    assert.equal(provider.verify(raw, {}, key, now), false);
    assert.equal(provider.verify(raw, headers, '', now), false);
  });
}

for (const [name, provider, key, header] of [
  ['stripe', stripe, secret, stripeHeader], ['whop', whop, whopSecret, whopHeader],
]) {
  test(`${name}: stale and future timestamps fail; five-minute boundary passes`, () => {
    for (const offset of [-301, 301]) assert.equal(provider.verify(raw, header(seconds + offset), key, now), false);
    for (const offset of [-300, 300]) assert.equal(provider.verify(raw, header(seconds + offset), key, now), true);
  });
}

test('Stripe accepts rotated v1 signatures and rejects malformed signatures/timestamps', () => {
  const headers = stripeHeader(seconds);
  headers['stripe-signature'] += ',v1=not-hex';
  assert.equal(stripe.verify(raw, headers, secret, now), true);
  headers['stripe-signature'] += `,t=${seconds}`;
  assert.equal(stripe.verify(raw, headers, secret, now), false);
  assert.equal(stripe.verify(raw, { 'stripe-signature': 't=oops,v1=abcd' }, secret, now), false);
});

test('Whop accepts multiple signatures but authenticates the message ID', () => {
  const headers = whopHeader(seconds);
  headers['webhook-signature'] = `v1,bad v2,ignored ${headers['webhook-signature']}`;
  assert.equal(whop.verify(raw, headers, whopSecret, now), true);
  assert.equal(whop.verify(raw, { ...headers, 'webhook-id': 'tampered' }, whopSecret, now), false);
  assert.equal(whop.verify(raw, headers, 'whsec_', now), false);
});

test('Generic and Shopify have no timestamp authentication; old headers do not imply freshness', () => {
  assert.equal(generic.verify(raw, { 'x-signature': sign(secret, raw), 'webhook-timestamp': '1' }, secret, now), true);
  assert.equal(shopify.verify(raw, { 'x-shopify-hmac-sha256': sign(secret, raw, 'base64'),
    'x-shopify-triggered-at': '1970-01-01T00:00:01Z' }, secret, now), true);
});

test('Strict HMAC decoding rejects invalid suffixes and short digests', () => {
  for (const value of ['abcd', `${sign(secret, raw)}zz`, []]) {
    assert.equal(generic.verify(raw, { 'x-signature': value }, secret), false);
  }
  assert.equal(shopify.verify(raw, { 'x-shopify-hmac-sha256': `${sign(secret, raw, 'base64')}!` }, secret), false);
});

const stripeEvent = (type = 'customer.subscription.created', extra = {}) => ({
  id: 'evt_123', type, created: seconds,
  data: { object: { status: 'active', metadata: { email: ' Alice@Example.com ' },
    current_period_end: Date.parse(end) / 1000, ...extra } },
});

test('Stripe normalizes created, updated, deleted and cancel-at-period-end', () => {
  assert.deepEqual(stripe.normalize(stripeEvent()), { email: 'alice@example.com', provider: 'stripe',
    status: 'active', current_period_end: end, updated_at: new Date(now).toISOString() });
  assert.equal(stripe.normalize(stripeEvent('customer.subscription.updated', { cancel_at_period_end: true })).status, 'canceled');
  assert.equal(stripe.normalize(stripeEvent('customer.subscription.deleted')).status, 'canceled');
  assert.equal(stripe.normalize(stripeEvent('customer.subscription.updated', { status: 'past_due' })).status, 'expired');
  assert.equal(stripe.normalize(stripeEvent('customer.subscription.updated', { status: 'trialing' })).status, 'expired');
  assert.equal(stripe.normalize(stripeEvent('customer.subscription.updated', { status: 'unpaid', cancel_at_period_end: true })).status, 'expired');
});

test('Stripe supports expanded customer email and item-level periods', () => {
  const row = stripe.normalize(stripeEvent('customer.subscription.updated', {
    metadata: {}, customer: { email: 'Buyer@Example.com' }, current_period_end: undefined,
    items: { data: [{ current_period_end: Date.parse(end) / 1000 }] },
  }));
  assert.equal(row.email, 'buyer@example.com');
  assert.equal(row.current_period_end, end);
});

test('Stripe paid subscription invoice uses the paid line period, ignoring one-off invoices', () => {
  const event = stripeEvent('invoice.paid', { customer_email: 'Buyer@Example.com',
    lines: { data: [{ type: 'subscription', period: { end: Date.parse(end) / 1000 } }] } });
  assert.equal(stripe.normalize(event).status, 'active');
  assert.equal(stripe.normalize(event).email, 'buyer@example.com');
  assert.equal(stripe.normalize(event).current_period_end, end);
  event.data.object.lines.data[0] = { type: 'invoiceitem', period: { end: seconds } };
  assert.equal(stripe.normalize(event), null);
});

test('Stripe ignores unsupported events and rejects missing email or period', () => {
  assert.equal(stripe.normalize({ type: 'customer.created' }), null);
  assert.throws(() => stripe.normalize(stripeEvent('customer.subscription.created', { metadata: {}, customer: 'cus_123' })), /Email/);
  assert.throws(() => stripe.normalize(stripeEvent('customer.subscription.created', { current_period_end: null })), /period/);
});

test('Whop mapping and membership valid/invalid events normalize', () => {
  const event = { type: 'membership.went_valid', created_at: seconds,
    data: { user: { email: ' Person@Example.com ' }, renewal_period_end: end } };
  assert.equal(whop.normalize(event).email, 'person@example.com');
  assert.equal(whop.normalize(event).status, 'active');
  event.data.cancel_at_period_end = true;
  assert.equal(whop.normalize(event).status, 'canceled');
  event.type = 'membership.went_invalid';
  assert.equal(whop.normalize(event).status, 'expired');
  assert.equal(whop.normalize({ type: 'unknown' }), null);
  assert.throws(() => whop.normalize({ type: 'membership.went_valid', data: {} }), /Email/);
});

test('Generic enforces email, supported status and ISO period', () => {
  const event = { email: ' Alice@Example.COM ', status: 'active', current_period_end: end };
  assert.equal(generic.normalize(event, now).email, 'alice@example.com');
  for (const status of ['canceled', 'expired']) assert.equal(generic.normalize({ ...event, status }, now).status, status);
  for (const invalid of [{ email: 'bad' }, { status: 'trialing' }, { current_period_end: 'garbage' }, { current_period_end: seconds }]) {
    assert.throws(() => generic.normalize({ ...event, ...invalid }, now));
  }
});

test('Shopify projects exactly five fields and sums quantities, omitting contact data', () => {
  const order = { id: 1, name: '#1001', total_price: '29.00', currency: 'USD',
    line_items: [{ quantity: 2 }, { quantity: 3 }], email: 'private@example.com', phone: '+12345678',
    shipping_address: { address1: 'Secret Street' }, customer: { first_name: 'Alice', last_name: 'Private', email: 'secret@example.com' } };
  assert.deepEqual(shopify.normalize(order), { orderName: '#1001', total: '29.00', currency: 'USD', itemCount: 5, customerFirstName: 'Alice' });
  assert.equal(shopify.normalize(order, 'orders/updated'), null);
  assert.equal(shopify.normalize({ ...order, customer: null }).customerFirstName, 'Guest');
  assert.throws(() => shopify.normalize({ ...order, line_items: [{ quantity: -1 }] }));
});
