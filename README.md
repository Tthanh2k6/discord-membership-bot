# discord-membership-bot

A Discord bot that gives a paid role to members with an active subscription and takes it away when the paid period ends. It also posts new store orders into a channel.

I built it as a working example of a request I keep seeing on freelance boards: "connect my Whop / Stripe / Stan Store subscriptions to my Discord server so I stop adding and kicking people by hand".

## What it does

- Receives payment webhooks from **Stripe**, **Whop**, or any tool that can send a signed JSON request (Zapier, Make, Stan Store through Zapier).
- Members run `/link email:you@example.com` once. After that the bot keeps their role in sync with their subscription.
- A canceled subscription keeps the role until the end of the period the member already paid for. When it expires, the role is removed.
- A reconcile pass runs at startup and every hour (configurable), so a missed webhook does not leave someone with access they no longer pay for.
- `/status` tells a member when their access ends. `/sync` lets an admin (Manage Roles) force a full reconcile.
- **Shopify** `orders/create` webhooks become a short alert in a channel: order number, total, item count and first name. No email, phone or address goes into Discord.

## How it is built

- Node.js 24, plain JavaScript ES modules. The only dependency is `discord.js` v14.
- `node:http` for the webhook server, `node:crypto` for signature checks, `node:sqlite` for storage. No Express, no ORM.
- Every webhook signature is checked with a constant-time compare. Stripe and Whop requests older than 5 minutes are rejected. Duplicate event IDs are ignored, so provider retries do not double-apply.
- The bot only asks for the `Guilds` intent. It needs no privileged intents.
- 57 tests with `node:test`. They run offline without a Discord token.

```
src/
  index.js            wiring; --dry-run logs actions instead of logging in to Discord
  server.js           POST /webhooks/{stripe,whop,generic,shopify}, GET /health
  providers/          signature checks and payload mapping per provider
  access.js           grant / keep / revoke decision
  reconcile.js        periodic full sync
  commands.js         /link, /status, /sync
  discord.js          discord.js adapter (roles, channel posts, slash commands)
  db.js               SQLite tables: links, subscriptions, processed events
scripts/
  register-commands.js   registers the slash commands for your server
  send-test-webhook.js   sends signed sample webhooks to a local server
```

## Try it locally (no Discord account needed)

```bash
npm install
npm test
cp .env.example .env          # fake values are fine for the demo
npm run demo                  # starts the server in dry-run mode
npm run send-test-webhook     # in a second terminal
```

The demo terminal prints what the bot would do, for example:

```
[DRY_RUN] New order #DEMO-1001: 29.00 USD | 2 items | Demo
```

## Run it for real

1. Create an application and bot at the Discord Developer Portal. Invite it with the `bot` and `applications.commands` scopes and the **Manage Roles**, **View Channel** and **Send Messages** permissions.
2. In Server Settings → Roles, drag the bot's role **above** the paid role. Discord will not let a bot assign a role higher than its own.
3. Fill in `.env` with the real IDs and the webhook secrets of the providers you use. Leave a secret empty to turn that route off. Set `DRY_RUN=0`.
4. `npm run register-commands`, then `npm start`.
5. Point each provider's webhook at `https://your-host/webhooks/<provider>`. Railway, Render, Fly.io or a small VPS all work. The SQLite file needs a persistent disk.

### Provider notes

- **Stripe:** subscribe to `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` and `invoice.paid`. The member's email comes from `metadata.email` or an expanded customer object.
- **Whop:** subscribe to `membership.went_valid` and `membership.went_invalid`. Field names live in one function, `mapMembership` in `src/providers/whop.js`. Check it against a real payload from your Whop dashboard before going live.
- **Generic (Zapier, Make, Stan Store):** send `{"email": "...", "status": "active|canceled|expired", "current_period_end": "2026-12-01T00:00:00Z"}` with header `X-Signature` = hex HMAC-SHA256 of the raw body using `GENERIC_WEBHOOK_SECRET`.
- **Shopify:** create an `orders/create` webhook and copy its signing secret into `SHOPIFY_WEBHOOK_SECRET`.

## Limits

- One server and one paid role per instance. Several tiers would need a small change in `access.js` and the config.
- This is a portfolio project. It has not run against a live paying community yet.

## License

MIT
