import { createServer as createHttpServer } from 'node:http';
import { createHash } from 'node:crypto';
import * as stripe from './providers/stripe.js';
import * as whop from './providers/whop.js';
import * as generic from './providers/generic.js';
import * as shopify from './providers/shopify.js';
import { parsePayload, PayloadError } from './validation.js';
import { syncLink } from './reconcile.js';
import { createQueue } from './queue.js';

const providers = { stripe, whop, generic, shopify };
const MAX_BODY = 1024 * 1024;

/** Read unmodified request bytes with a strict 1 MiB bound. */
async function readBody(request) {
  const chunks = [];
  let size = 0;
  // Do not destroy the socket on a limit error: the caller must send HTTP 413.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY) {
      request.resume();
      throw Object.assign(new Error('Body too large'), { status: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Send a small JSON response, including when a client disconnects mid-request. */
function reply(response, status, body) {
  if (response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

/** Extract a stable, provider-scoped ID; body hashes cover protocols without event IDs. */
function eventId(provider, payload, headers, raw) {
  let id;
  if (provider === 'stripe') id = payload.id;
  else if (provider === 'whop') id = headers['webhook-id'];
  else if (provider === 'generic') id = payload.id;
  else id = payload.id; // Order IDs are inside the signed body, unlike Shopify delivery headers.
  if (id === undefined && ['generic', 'shopify'].includes(provider)) {
    id = createHash('sha256').update(raw).digest('hex');
  }
  if (!['string', 'number'].includes(typeof id) || !String(id).length || String(id).length > 255) {
    throw new PayloadError('Missing or invalid event ID');
  }
  return String(id);
}

/**
 * Build a server without listening or logging into Discord.
 * @param {{store: object, actions: object, config: object, logger?: object,
 * now?: () => number, enqueue?: (work: Function) => Promise<unknown>}} options
 */
export function createServer({ store, actions, config, logger = console, now = Date.now, enqueue = createQueue() }) {
  return createHttpServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') return reply(response, 200, { ok: true });
    const match = /^\/webhooks\/(stripe|whop|generic|shopify)$/.exec(request.url ?? '');
    const provider = match?.[1];
    const secret = config.secrets[provider];
    if (request.method !== 'POST' || !provider || !secret) return reply(response, 404, { error: 'Not found' });
    try {
      const raw = await readBody(request);
      if (!providers[provider].verify(raw, request.headers, secret, now())) {
        return reply(response, 401, { error: 'Invalid signature' });
      }
      const payload = parsePayload(raw);
      const id = eventId(provider, payload, request.headers, raw);
      const result = await enqueue(async () => {
        if (store.hasEvent(provider, id)) return { ok: true, duplicate: true };
        const normalized = provider === 'shopify'
          ? shopify.normalize(payload, request.headers['x-shopify-topic'] ?? '')
          : providers[provider].normalize(payload, provider === 'whop'
            ? Number(request.headers['webhook-timestamp']) * 1000 : now());
        // Unsupported event types are acknowledged without consuming a supported event's ID.
        if (!normalized) return { ok: true, ignored: true };
        if (provider === 'shopify') {
          await actions.postOrder(normalized);
        } else {
          store.upsertSubscription(normalized);
          for (const link of store.linksForEmail(normalized.email)) {
            await syncLink(store, actions, link, now());
          }
        }
        // Only acknowledge after actions succeed. Failed deliveries can be retried.
        store.recordEvent(provider, id, new Date(now()).toISOString());
        return { ok: true };
      });
      reply(response, 200, result);
    } catch (error) {
      const status = error.status === 413 ? 413 : error instanceof PayloadError ? 400 : 500;
      if (status === 500) logger.error(`Webhook processing failed (${provider}); delivery may be retried.`);
      reply(response, status, { error: status === 413 ? 'Body too large' : status === 400 ? 'Invalid payload' : 'Processing failed' });
    }
  });
}
