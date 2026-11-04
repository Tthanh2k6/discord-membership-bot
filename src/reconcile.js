import { decideAccess, selectSubscription } from './access.js';
import { maskEmail } from './validation.js';

/**
 * Ensure one linked member has the correct role. A retained entitlement also
 * grants a missing role (for example when linking after cancellation).
 */
export async function syncLink(store, actions, link, now = Date.now()) {
  const row = selectSubscription(store.subscriptionsFor(link.email), now);
  const decision = decideAccess(row, now);
  await (decision === 'revoke' ? actions.revokeRole(link.discord_id) : actions.grantRole(link.discord_id));
  return decision;
}

/** Reconcile all links, isolating member errors so other members still sync. */
export async function reconcile(store, actions, { now = Date.now(), logger = console } = {}) {
  const summary = { checked: 0, grant: 0, keep: 0, revoke: 0, failed: 0 };
  for (const link of store.listLinks()) {
    summary.checked++;
    try {
      summary[await syncLink(store, actions, link, now)]++;
    } catch {
      summary.failed++;
      logger.error(`Role sync failed for ${link.discord_id} (${maskEmail(link.email)}); will retry.`);
    }
  }
  return summary;
}

/** Start a non-overlapping periodic job; stop() waits for its current run. */
export function startReconciler(work, minutes = 60, logger = console) {
  let running;
  const timer = setInterval(() => {
    if (running) return;
    running = Promise.resolve().then(work).catch(() => logger.error('Reconciliation failed; will retry.'))
      .finally(() => { running = undefined; });
  }, minutes * 60_000);
  timer.unref();
  return async () => { clearInterval(timer); await running; };
}
