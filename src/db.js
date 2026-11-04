import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeEmail, subscription } from './validation.js';

/** Open a SQLite store. Use :memory: in offline tests. @param {string} [path] */
export function openStore(path = './data/bot.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS links (
      discord_id TEXT PRIMARY KEY, email TEXT NOT NULL, linked_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS links_email ON links(email);
    CREATE TABLE IF NOT EXISTS subscriptions (
      email TEXT NOT NULL, provider TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'canceled', 'expired')),
      current_period_end TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(email, provider)
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, received_at TEXT NOT NULL
    );
  `);
  return {
    /** Save or replace a member's email link. */
    link(discordId, email, now = new Date().toISOString()) {
      db.prepare(`INSERT INTO links VALUES (?, ?, ?) ON CONFLICT(discord_id)
        DO UPDATE SET email=excluded.email, linked_at=excluded.linked_at`)
        .run(discordId, normalizeEmail(email), now);
    },
    getLink: discordId => db.prepare('SELECT * FROM links WHERE discord_id=?').get(discordId),
    listLinks: () => db.prepare('SELECT * FROM links ORDER BY discord_id').all(),
    linksForEmail: email => db.prepare('SELECT * FROM links WHERE email=?').all(normalizeEmail(email)),
    subscriptionsFor: email => db.prepare('SELECT * FROM subscriptions WHERE email=?').all(normalizeEmail(email)),
    /** Ignore older provider updates; retries with the same timestamp are safe. */
    upsertSubscription(row) {
      const value = subscription(row.email, row.provider, row.status, row.current_period_end, row.updated_at);
      db.prepare(`INSERT INTO subscriptions VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(email, provider) DO UPDATE SET status=excluded.status,
        current_period_end=excluded.current_period_end, updated_at=excluded.updated_at
        WHERE excluded.updated_at >= subscriptions.updated_at`)
        .run(value.email, value.provider, value.status, value.current_period_end, value.updated_at);
    },
    // Namespace IDs so unrelated providers cannot collide.
    hasEvent: (provider, id) => Boolean(db.prepare('SELECT 1 FROM events WHERE id=?').get(`${provider}:${id}`)),
    recordEvent(provider, id, now = new Date().toISOString()) {
      db.prepare('INSERT OR IGNORE INTO events VALUES (?, ?, ?)').run(`${provider}:${id}`, provider, now);
    },
    close: () => db.close(),
  };
}
