import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, requireDiscordConfig } from '../src/config.js';
import { start } from '../src/index.js';

test('config defaults are frozen and provider routes default to disabled', () => {
  const config = readConfig({});
  assert.equal(config.port, 8787); assert.equal(config.reconcileMinutes, 60);
  assert.equal(config.dbPath, './data/bot.db'); assert.equal(config.dryRun, false);
  assert.deepEqual(Object.values(config.secrets), ['', '', '', '']);
  assert.ok(Object.isFrozen(config)); assert.ok(Object.isFrozen(config.secrets));
  assert.throws(() => requireDiscordConfig(config), /DISCORD_TOKEN/);
});

test('config rejects invalid numeric values, dry-run flags and Whop secrets', () => {
  for (const env of [{ PORT: '0' }, { PORT: '65536' }, { PORT: '8787junk' }, { RECONCILE_MINUTES: '0' },
    { RECONCILE_MINUTES: '1.5' }, { RECONCILE_MINUTES: '999999' }, { DRY_RUN: 'true' },
    { WHOP_WEBHOOK_SECRET: 'not-base64' }, { WHOP_WEBHOOK_SECRET: 'whsec_' }]) {
    assert.throws(() => readConfig(env));
  }
});

test('live config validates IDs while dry run needs no Discord credentials', () => {
  const config = readConfig({ DRY_RUN: '1', DISCORD_TOKEN: 'fake-token', DISCORD_APP_ID: '111111111111111111',
    GUILD_ID: '222222222222222222', MEMBER_ROLE_ID: '333333333333333333', ORDERS_CHANNEL_ID: '444444444444444444' });
  assert.doesNotThrow(() => requireDiscordConfig(config));
  assert.throws(() => requireDiscordConfig({ ...config, guildId: 'oops' }), /guildId/);
  assert.doesNotThrow(() => requireDiscordConfig({ ...config, memberRoleId: '', ordersChannelId: '' }, true));
});

test('dry-run startup serves health without logging in and closes cleanly', async t => {
  const logs = [];
  const app = await start({ ...readConfig({ DRY_RUN: '1' }), port: 0, dbPath: ':memory:' },
    { log: message => logs.push(message), error: message => logs.push(message) });
  t.after(() => app.close());
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/health`);
  assert.equal(response.status, 200); assert.match(logs.join(''), /DRY_RUN Listening/);
  await app.close(); await app.close();
  assert.equal(app.server.listening, false);
});
