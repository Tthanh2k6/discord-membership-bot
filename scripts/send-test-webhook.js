import { randomUUID } from 'node:crypto';
import { config } from '../src/config.js';
import { hmac } from '../src/providers/signatures.js';

/** Send signed demo payloads to the local server only. */
async function send(provider, payload, signatureHeader, encoding, extraHeaders = {}) {
  const secret = config.secrets[provider];
  if (!secret) throw new Error(`Set the ${provider} webhook secret first`);
  const raw = JSON.stringify(payload);
  const response = await fetch(`http://127.0.0.1:${config.port}/webhooks/${provider}`, {
    method: 'POST', headers: { 'content-type': 'application/json',
      [signatureHeader]: hmac(secret, raw).toString(encoding), ...extraHeaders },
    body: raw, signal: AbortSignal.timeout(10_000),
  });
  console.log(`${provider}: HTTP ${response.status} ${await response.text()}`);
  if (!response.ok) process.exitCode = 1;
}

try {
  const provider = process.argv[2] ?? 'all';
  if (!['generic', 'shopify', 'all'].includes(provider)) throw new Error('Use generic, shopify or all');
  if (provider === 'generic' || provider === 'all') {
    await send('generic', { id: randomUUID(), email: 'demo@example.com', status: 'active',
      current_period_end: new Date(Date.now() + 30 * 86400_000).toISOString() }, 'x-signature', 'hex');
  }
  if (provider === 'shopify' || provider === 'all') {
    await send('shopify', { id: randomUUID(), name: '#DEMO-1001', total_price: '29.00', currency: 'USD',
      line_items: [{ quantity: 2 }], customer: { first_name: 'Demo' } }, 'x-shopify-hmac-sha256', 'base64',
    { 'x-shopify-topic': 'orders/create' });
  }
} catch (error) {
  console.error(`Demo request failed: ${error.message}`);
  process.exitCode = 1;
}
