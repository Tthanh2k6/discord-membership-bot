/**
 * Decide paid access at a given instant. Cancellation retains the paid period.
 * @param {{status: string, current_period_end: string}|null|undefined} row
 * @param {number|Date} [now] Epoch milliseconds or a Date.
 * @returns {'grant'|'keep'|'revoke'}
 */
export function decideAccess(row, now = Date.now()) {
  if (!row || !(Date.parse(row.current_period_end) > Number(now))) return 'revoke';
  if (row.status === 'active') return 'grant';
  if (row.status === 'canceled') return 'keep';
  return 'revoke';
}

/** Choose the longest current entitlement across providers, without one provider revoking another. */
export function selectSubscription(rows, now = Date.now()) {
  const paid = rows.filter(row => decideAccess(row, now) !== 'revoke');
  return (paid.length ? paid : rows).toSorted((a, b) =>
    Date.parse(b.current_period_end) - Date.parse(a.current_period_end))[0] ?? null;
}
