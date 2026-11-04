# Discord membership bot: code reference

## 1. Purpose

An offline-testable portfolio demo that maps paid subscriptions to one Discord guild role and posts minimal Shopify order alerts. Runtime: Node 24, ES modules, node:sqlite and the installed discord.js v14. `SPEC.md` is the feature contract; `README.md` is intentionally not implemented.

## 2. File map

```text
.env.example
agent.md
CODEBASE.md
package.json
package-lock.json
src/
  access.js
  commands.js
  config.js
  db.js
  discord.js
  index.js
  queue.js
  reconcile.js
  server.js
  validation.js
  providers/
    generic.js
    shopify.js
    signatures.js
    stripe.js
    whop.js
scripts/
  register-commands.js
  send-test-webhook.js
test/
  access.test.js
  commands-discord.test.js
  config-startup.test.js
  providers.test.js
  server.test.js
  store-reconcile.test.js
```

## 3. Runtime flow and interfaces

`start(config, logger)` opens storage, constructs logging or Discord actions, reconciles existing links, starts the timer, and listens on HTTP. It returns `{ server, close }`; shutdown drains HTTP, stops the timer, destroys the Discord client, drains queued mutations and closes SQLite.

`createServer({ store, actions, config, logger, now, enqueue })` creates an unbound HTTP server. A delivery follows raw body limit → signature verification → JSON parsing → queued duplicate lookup → provider normalization → store update → linked role synchronization or order alert → event completion. External action errors return 500 and leave the event retryable. Stored subscription state also enables periodic repair after a failed role call.

`createQueue()` serializes asynchronous work and keeps processing after rejection. Startup passes the same queue to the HTTP server, slash commands and periodic reconciliation. `actions` implements three asynchronous operations: `grantRole(discordId)`, `revokeRole(discordId)` and `postOrder(order)`.

`syncLink(store, actions, link, now)` applies one entitlement. `reconcile(store, actions, { now, logger })` visits every stored link, isolates per-member errors and returns counts for `checked`, `grant`, `keep`, `revoke`, `failed`. `startReconciler(work, minutes, logger)` returns an asynchronous stop function; timer runs never overlap.

## 4. Storage and access rules

`openStore(path)` creates parent directories and SQLite tables, using WAL and a 5-second busy timeout. Store methods are `link`, `getLink`, `listLinks`, `linksForEmail`, `subscriptionsFor`, `upsertSubscription`, `hasEvent`, `recordEvent`, `close`.

| Table | Columns and constraints |
| --- | --- |
| links | `discord_id TEXT PRIMARY KEY`, `email TEXT NOT NULL`, `linked_at TEXT NOT NULL`; email index |
| subscriptions | `email`, `provider`, `status`, `current_period_end`, `updated_at`; all non-null text; primary key `(email, provider)`; status constrained to active/canceled/expired |
| events | `id TEXT PRIMARY KEY`, `provider TEXT NOT NULL`, `received_at TEXT NOT NULL` |

Emails are trimmed and lowercase. Dates are canonical ISO strings; provider Unix seconds are normalized. Event IDs are namespaced as `provider:id`. Older subscription updates are ignored by timestamp. Equal timestamps allow replay of failed deliveries.

`decideAccess(row, now)` returns grant for active future periods, keep for canceled future periods, otherwise revoke (including at the exact end). `selectSubscription(rows, now)` chooses the longest valid entitlement across providers. The role adapter ensures the role exists for both grant and keep, including when a canceled subscriber first links during their paid period. Its role operations check current member state before calling Discord.

## 5. Webhook protocols

All four routes are POST `/webhooks/{provider}` and enabled only with a configured secret. `GET /health` returns `{ "ok": true }`. Other routes/methods return 404; bad signatures 401; malformed payloads 400; bodies over 1 MiB 413; processing failures 500; accepted, ignored and duplicate deliveries 200. A completed duplicate does not repeat external actions.

| Provider | Authentication and mapping |
| --- | --- |
| Stripe | `Stripe-Signature`: one `t` and any valid `v1`; SHA-256 HMAC hex of `t.rawBody`, constant-time comparison, ±300 seconds. Supports subscription created/updated/deleted and subscription invoice.paid. IDs and creation timestamps come from the signed event. |
| Whop | Standard Webhooks `webhook-id`, `webhook-timestamp`, space-separated `v1,<base64>` signatures. Decode `whsec_<base64>`; sign `id.timestamp.rawBody`; ±300 seconds. Valid membership grants, invalid membership expires. |
| Generic | `X-Signature`: hex SHA-256 HMAC over raw bytes. Body requires `email`, `status`, `current_period_end` ISO. Optional signed `id` and `updated_at`; without ID, deduplicate using body SHA-256. |
| Shopify | `X-Shopify-Hmac-Sha256`: base64 SHA-256 HMAC over raw bytes; `X-Shopify-Topic: orders/create`. Deduplicate by signed order ID, or body hash if absent. Return only orderName, total, currency, summed itemCount and customerFirstName. |

Stripe subscription events often contain only a customer ID. Set `metadata.email` on the subscription, supply an expanded `customer.email`, or adapt an upstream integration. The bot performs no customer lookup. Subscription periods support `current_period_end` and item-level `current_period_end`. Invoices use subscription lines' paid period ends and `customer_email`; one-off invoices are ignored. Unpaid, past-due and trial states do not grant paid access. Deleted/canceled subscriptions retain the stated paid period.

Whop field names are isolated in `mapMembership(event)`: **check against your Whop dashboard payload**. The default accepts `data.user.email` or `data.email`, `data.renewal_period_end` or `data.current_period_end`, `data.cancel_at_period_end`, and `event.created_at`. If creation time is absent, use the signed delivery timestamp. Timestamps may be ISO strings or Unix seconds.

Generic and Shopify do not include an authenticated delivery timestamp in these signing protocols. Their freshness protection is persistent deduplication, not a fabricated timestamp check. Use a stable unique generic event ID for each state transition, plus an ISO `updated_at` for ordering. Shopify topic is an unsigned routing header; the bot only accepts the configured order shape and deduplicates using signed body data.

## 6. Discord commands and permissions

`createDiscordAdapter({ config, store, enqueue, logger })` returns `{ client, actions }` without logging in. The only intent is `Guilds`. Individual members are fetched via REST; no full-guild privileged member fetch is needed.

`createDiscordActions(client, config, logger)` verifies the bot has Manage Roles and its highest role is strictly above an unmanaged MEMBER_ROLE_ID before every role change. Discord 50013 produces a clear permission/hierarchy message and remains retryable. Members who left the guild are skipped until a later reconciliation. Order alerts verify the channel belongs to the configured guild, disable mentions, escape Markdown, and exclude email, phone, surname and address fields.

`commands` contains registration JSON. `createCommandHandler(...)` handles only the configured guild and always replies ephemerally. `/link email` normalizes and stores the link then syncs immediately; `/status` reports not linked, no active subscription, or active until a date; `/sync` checks Manage Roles at runtime as well as setting that default command permission and reconciles all links.

## 7. Configuration and CLI

`readConfig(env)` validates numeric values, DRY_RUN and Whop secret syntax and returns a frozen config with frozen secrets. `config` exports the process environment snapshot. `requireDiscordConfig(config, registration)` validates live credentials and snowflake IDs at the entry points, allowing library imports and tests without tokens.

Every variable is described in `.env.example`: DISCORD_TOKEN, DISCORD_APP_ID, GUILD_ID, MEMBER_ROLE_ID, ORDERS_CHANNEL_ID, PORT (8787), DB_PATH (`./data/bot.db`), four provider secrets, RECONCILE_MINUTES (60), DRY_RUN (0 unless set). Missing provider secrets disable their routes. Empty Discord credentials are valid in dry run. Only fake values are included.

| Command | Behavior |
| --- | --- |
| `node --test` / `npm test` | Offline tests |
| `npm start` | `node --env-file-if-exists=.env src/index.js` |
| `node --env-file=.env src/index.js` | Explicitly load a required .env file, no dotenv |
| `npm run demo` | Force dry run via portable `--dry-run` flag, with no login |
| `npm run register-commands` | Explicit REST PUT of guild slash commands; needs a real token and network |
| `npm run send-test-webhook -- generic` | Sign and POST a sample subscription to localhost |
| `npm run send-test-webhook -- shopify` | Sign and POST a sample order to localhost |
| `npm run send-test-webhook` | Send both samples; requires both secrets |

## 8. Verification and operational limits

Tests use fake Discord interactions/actions, temporary or in-memory SQLite and loopback HTTP. They exercise signature validity and tampering, timestamp boundaries where applicable, provider mappings, access boundaries, storage persistence, duplicate and concurrent events, retries, request limits, order privacy, slash authorization, Discord hierarchy, reconciliation, scheduling and dry-run startup. No package installation, external calls or real token are needed.

This is the requested email-linking demo: `/link` records a self-asserted email, not proof of email ownership. A production deployment needs an authenticated purchase/account linking flow before granting valuable access. The schema models one subscription per email/provider; multiple subscriptions within one provider require subscription IDs and aggregation. Live provider payloads and Discord calls have not been exercised in the offline environment.

Run one process per database. SQLite event completion and a remote Discord send cannot be atomic: a crash after sending an order but before persisting completion can duplicate an alert on retry. Role operations converge idempotently; failed subscription synchronization is retried by both delivery and reconciliation. Timestamp ordering prevents older state from replacing newer state, but conflicting events with equal provider timestamps are applied in receipt order. Generic events without `updated_at` also follow receipt order. Unsupported event types are acknowledged without consuming IDs.

## 9. Documentation changelog

- 2026-11-04: Implemented the SPEC.md demo, provider contracts, storage, actions, commands, portable scripts and offline tests; documented payload assumptions and operational limits. README.md remains reserved for its separate author.
