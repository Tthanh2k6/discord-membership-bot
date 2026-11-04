import { hmac, matches, fresh } from './signatures.js';
import { PayloadError, subscription } from '../validation.js';

/** Verify all v1 signatures to support Stripe secret rotation. */
export function verify(raw, headers, secret, now = Date.now()) {
  const header = headers['stripe-signature'];
  if (!secret || typeof header !== 'string') return false;
  const fields = header.split(',').map(part => part.trim().split('='));
  const timestamps = fields.filter(([key]) => key === 't');
  if (timestamps.length !== 1 || !fresh(timestamps[0][1], now)) return false;
  const digest = hmac(secret, Buffer.concat([Buffer.from(`${timestamps[0][1]}.`), raw]));
  return fields.some(([key, value]) => key === 'v1' && matches(digest, value, 'hex'));
}

/**
 * Normalize supported events. Subscription webhooks need metadata.email (or an
 * expanded customer.email); a customer ID alone cannot resolve email offline.
 * Invoice periods come from subscription lines, not the invoice creation date.
 */
export function normalize(event) {
  if (!['customer.subscription.created', 'customer.subscription.updated',
    'customer.subscription.deleted', 'invoice.paid'].includes(event.type)) return null;
  const data = event.data?.object;
  if (!data || typeof event.id !== 'string' || !event.id) throw new PayloadError('Missing Stripe event data');
  const email = data.customer_email ?? data.customer?.email ?? data.metadata?.email
    ?? data.subscription_details?.metadata?.email ?? data.parent?.subscription_details?.metadata?.email;
  let end = data.current_period_end ?? data.items?.data?.[0]?.current_period_end;
  let status;
  if (event.type === 'invoice.paid') {
    const lines = data.lines?.data?.filter(line => line.type === 'subscription'
      || line.subscription || line.parent?.subscription_item_details);
    if (!lines?.length) return null; // One-off invoices do not confer membership.
    end = Math.max(...lines.map(line => line.period?.end ?? 0));
    if (!end) throw new PayloadError('Missing invoice subscription period');
    status = 'active';
  } else if (event.type === 'customer.subscription.deleted' || data.status === 'canceled'
    || (data.status === 'active' && data.cancel_at_period_end)) {
    status = 'canceled';
  } else {
    status = data.status === 'active' ? 'active' : 'expired';
  }
  if (!Number.isFinite(event.created)) throw new PayloadError('Missing Stripe event timestamp');
  return subscription(email, 'stripe', status, end, event.created);
}
