import { hmac, matches, fresh } from './signatures.js';
import { subscription } from '../validation.js';

/** Verify Standard Webhooks, including multiple space-separated v1 signatures. */
export function verify(raw, headers, secret, now = Date.now()) {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatures = headers['webhook-signature'];
  if (typeof secret !== 'string'
    || !/^whsec_(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(secret)
    || !id || typeof id !== 'string'
    || typeof signatures !== 'string' || !fresh(timestamp, now)) return false;
  const key = Buffer.from(secret.slice(6), 'base64');
  if (!key.length) return false;
  const digest = hmac(key, Buffer.concat([Buffer.from(`${id}.${timestamp}.`), raw]));
  return signatures.split(/\s+/).some(part => {
    const [version, signature, extra] = part.split(',');
    return extra === undefined && version === 'v1' && matches(digest, signature, 'base64');
  });
}

/**
 * Check against your Whop dashboard payload. Keep deployment-specific field
 * names here: user.email, renewal_period_end, cancel_at_period_end, created_at.
 */
export function mapMembership(event) {
  const data = event.data ?? {};
  return {
    email: data.user?.email ?? data.email,
    end: data.renewal_period_end ?? data.current_period_end,
    canceled: data.cancel_at_period_end === true,
    updatedAt: event.created_at,
  };
}

/** Normalize Whop membership events; invalid memberships revoke immediately. */
export function normalize(event, timestamp = Date.now()) {
  if (!['membership.went_valid', 'membership.went_invalid'].includes(event.type)) return null;
  const fields = mapMembership(event);
  const status = event.type === 'membership.went_invalid' ? 'expired' : fields.canceled ? 'canceled' : 'active';
  return subscription(fields.email, 'whop', status, fields.end,
    fields.updatedAt ?? new Date(timestamp).toISOString());
}
