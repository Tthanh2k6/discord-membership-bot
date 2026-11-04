import { hmac, matches } from './signatures.js';
import { PayloadError, subscription } from '../validation.js';

/** This protocol signs only the body; it has no authenticated timestamp. */
export function verify(raw, headers, secret) {
  return Boolean(secret) && matches(hmac(secret, raw), headers['x-signature'], 'hex');
}

/** Normalize a Zapier/Make payload. Optional id and updated_at must be in the signed body. */
export function normalize(event, now = Date.now()) {
  if (typeof event.current_period_end !== 'string') throw new PayloadError('Expected ISO current_period_end');
  return subscription(event.email, 'generic', event.status, event.current_period_end,
    event.updated_at ?? new Date(now).toISOString());
}
