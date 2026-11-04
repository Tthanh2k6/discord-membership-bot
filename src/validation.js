/** A rejected webhook payload (safe to expose as a generic HTTP 400). */
export class PayloadError extends Error {}

/** Normalize and validate an email without logging its contents. @param {unknown} value */
export function normalizeEmail(value) {
  if (typeof value !== 'string') throw new PayloadError('Email is required');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new PayloadError('Invalid email');
  }
  return email;
}

/** Mask an email for logs. @param {string} email */
export function maskEmail(email) {
  const [local, domain] = normalizeEmail(email).split('@');
  return `${local[0]}***@${domain}`;
}

/** Convert an ISO timestamp or Unix seconds to canonical ISO. @param {unknown} value */
export function periodEnd(value) {
  const date = typeof value === 'number'
    ? new Date(value * 1000)
    : new Date(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? value : NaN);
  if (!Number.isFinite(date.getTime())) throw new PayloadError('Invalid current_period_end');
  return date.toISOString();
}

/** Validate the common subscription shape. Times are stored as ISO strings. */
export function subscription(email, provider, status, end, updatedAt = new Date().toISOString()) {
  if (!['active', 'canceled', 'expired'].includes(status)) throw new PayloadError('Invalid status');
  return {
    email: normalizeEmail(email), provider, status,
    current_period_end: periodEnd(end), updated_at: periodEnd(updatedAt),
  };
}

/** Require an object decoded from JSON. @param {Buffer|string} raw */
export function parsePayload(raw) {
  try {
    const value = JSON.parse(raw.toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new PayloadError('Invalid JSON object');
  }
}
