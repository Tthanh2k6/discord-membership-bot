# Spec: discord-membership-bot (portfolio demo)

Goal: a Discord bot that gives a paid role to members with an active subscription and removes it when the paid period ends. Second feature: post new store orders into a channel. Built for the common freelance request "connect my Whop / Stripe / Stan Store subscriptions to my Discord server".

## Constraints
- Node.js 24, ES modules (`"type": "module"`), plain JavaScript with JSDoc.
- Only dependency: `discord.js` v14 (already installed). Use `node:http`, `node:crypto`, `node:sqlite` (DatabaseSync), `node:test`. No express, no dotenv (read `process.env`; document `node --env-file=.env`).
- No network access needed for tests. Everything testable without a real Discord token.

## Layout
```
src/
  config.js          read env, validate, export frozen config
  db.js              node:sqlite store: links(discord_id, email, linked_at), subscriptions(email, provider, status, current_period_end, updated_at), events(id PRIMARY KEY, provider, received_at) for idempotency
  providers/stripe.js   verify Stripe-Signature (t=,v1= ; HMAC-SHA256 hex of `${t}.${rawBody}`, 5 min tolerance, timingSafeEqual) + normalize customer.subscription.created|updated|deleted and invoice.paid
  providers/whop.js     verify Standard Webhooks headers (webhook-id, webhook-timestamp, webhook-signature "v1,<base64>"; secret "whsec_<base64>"; HMAC-SHA256 of `${id}.${ts}.${rawBody}`) + normalize membership.went_valid / membership.went_invalid (field names behind one mapping function, documented as "check against your Whop dashboard payload")
  providers/generic.js  X-Signature: hex HMAC-SHA256 of raw body with shared secret; JSON {email, status: active|canceled|expired, current_period_end ISO}. Covers Stan Store / anything via Zapier or Make.
  providers/shopify.js  X-Shopify-Hmac-Sha256 base64 HMAC of raw body; normalize orders/create into {orderName, total, currency, itemCount, customerFirstName}. Never include email/phone/address in the alert.
  access.js          pure decision logic: given subscription row + now → "grant" | "keep" | "revoke". Canceled keeps access until current_period_end. Expired/past end → revoke.
  server.js          node:http server: POST /webhooks/stripe|whop|generic|shopify, GET /health. Raw body, 1 MB limit, 401 on bad signature, 200 on duplicate event id (idempotent), 404 otherwise. Calls an injected `actions` object (grantRole, revokeRole, postOrder) so tests use fakes.
  discord.js         real adapter: discord.js Client (Guilds intent only, no privileged intents), implements actions + slash commands
  commands.js        slash command definitions + handlers: /link email:<email> (ephemeral reply, stores link, immediately syncs role), /status (ephemeral: active until <date> or not linked), /sync (admin only, Manage Roles permission: reconcile everyone)
  reconcile.js       loop over links, apply access decision, grant/revoke; run every RECONCILE_MINUTES (default 60)
  index.js           wire everything; DRY_RUN=1 → no Discord login, actions just log (for local demo)
scripts/
  register-commands.js  PUT guild commands via REST
  send-test-webhook.js  sign and POST sample payloads to the local server (generic + shopify) for the demo
test/                node:test unit tests: each provider (valid sig, bad sig, stale timestamp), access logic table, server routes with fake actions (idempotency, 401, 404, order alert has no PII), reconcile with fake actions
.env.example         every variable with a comment, fake values only
README.md            written later by Claude
```

## Env
DISCORD_TOKEN, DISCORD_APP_ID, GUILD_ID, MEMBER_ROLE_ID, ORDERS_CHANNEL_ID, PORT=8787, DB_PATH=./data/bot.db, STRIPE_WEBHOOK_SECRET, WHOP_WEBHOOK_SECRET, GENERIC_WEBHOOK_SECRET, SHOPIFY_WEBHOOK_SECRET, RECONCILE_MINUTES=60, DRY_RUN.
A provider route is enabled only if its secret is set.

## Rules
- Emails stored lowercase and trimmed. Log emails masked (j***@gmail.com).
- Role changes only if the bot's role is above MEMBER_ROLE_ID; on Discord error 50013 log a clear message.
- `npm test` = `node --test`. `npm start` = `node --env-file-if-exists=.env src/index.js`. `npm run demo` = DRY_RUN server.
