import { hmac, matches } from './signatures.js';
import { PayloadError } from '../validation.js';

/** Shopify signs raw bytes; delivery timestamps are not part of this signature. */
export function verify(raw, headers, secret) {
  return Boolean(secret) && matches(hmac(secret, raw), headers['x-shopify-hmac-sha256'], 'base64');
}

/** Project only the five allowed order fields; discard contact and address data. */
export function normalize(order, topic = 'orders/create') {
  if (topic !== 'orders/create') return null;
  if (typeof order.name !== 'string' || !order.name || typeof order.total_price !== 'string'
    || !/^\d+(\.\d+)?$/.test(order.total_price) || !/^[A-Z]{3}$/.test(order.currency)
    || !Array.isArray(order.line_items)) throw new PayloadError('Invalid order');
  let itemCount = 0;
  for (const item of order.line_items) {
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 0) throw new PayloadError('Invalid item quantity');
    itemCount += item.quantity;
  }
  if (!Number.isSafeInteger(itemCount)) throw new PayloadError('Invalid item count');
  return {
    orderName: order.name.slice(0, 100), total: order.total_price, currency: order.currency,
    itemCount, customerFirstName: typeof order.customer?.first_name === 'string'
      ? order.customer.first_name.slice(0, 80) : 'Guest',
  };
}
