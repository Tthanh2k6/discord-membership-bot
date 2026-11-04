import { createHmac, timingSafeEqual } from 'node:crypto';

/** Calculate a SHA-256 HMAC over unmodified bytes. */
export function hmac(secret, raw) {
  return createHmac('sha256', secret).update(raw).digest();
}

/** Strictly decode a signature before constant-time comparison. */
export function matches(expected, supplied, encoding) {
  if (typeof supplied !== 'string') return false;
  const valid = encoding === 'hex' ? /^[a-f\d]{64}$/i : /^[A-Za-z0-9+/]{43}=$/;
  if (!valid.test(supplied)) return false;
  const actual = Buffer.from(supplied, encoding);
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}

/** Reject timestamps over five minutes old or ahead of the local clock. */
export function fresh(timestamp, now = Date.now()) {
  return typeof timestamp === 'string' && /^\d+$/.test(timestamp)
    && Math.abs(now / 1000 - Number(timestamp)) <= 300;
}
