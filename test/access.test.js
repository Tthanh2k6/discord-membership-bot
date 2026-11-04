import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAccess, selectSubscription } from '../src/access.js';

const now = Date.parse('2026-11-04T12:00:00Z');
for (const [label, row, expected] of [
  ['missing', null, 'revoke'],
  ['active future', { status: 'active', current_period_end: '2026-12-01T00:00:00Z' }, 'grant'],
  ['canceled future', { status: 'canceled', current_period_end: '2026-12-01T00:00:00Z' }, 'keep'],
  ['expired future', { status: 'expired', current_period_end: '2026-12-01T00:00:00Z' }, 'revoke'],
  ['active past', { status: 'active', current_period_end: '2026-01-01T00:00:00Z' }, 'revoke'],
  ['canceled past', { status: 'canceled', current_period_end: '2026-01-01T00:00:00Z' }, 'revoke'],
  ['exact boundary', { status: 'active', current_period_end: '2026-11-04T12:00:00Z' }, 'revoke'],
  ['invalid date', { status: 'active', current_period_end: 'invalid' }, 'revoke'],
  ['unknown status', { status: 'trialing', current_period_end: '2026-12-01T00:00:00Z' }, 'revoke'],
]) {
  test(`access: ${label} -> ${expected}`, () => {
    assert.equal(decideAccess(row, now), expected);
    assert.equal(decideAccess(row, new Date(now)), expected);
  });
}

test('another provider cannot revoke an active paid entitlement', () => {
  const active = { status: 'active', current_period_end: '2026-12-01T00:00:00Z' };
  const expired = { status: 'expired', current_period_end: '2027-01-01T00:00:00Z' };
  assert.equal(selectSubscription([expired, active], now), active);
  assert.equal(selectSubscription([], now), null);
});
