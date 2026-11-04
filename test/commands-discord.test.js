import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, PermissionFlagsBits, GatewayIntentBits } from 'discord.js';
import { openStore } from '../src/db.js';
import { createCommandHandler, commands } from '../src/commands.js';
import { createDiscordActions, createDiscordAdapter } from '../src/discord.js';

const now = Date.parse('2026-11-04T12:00:00Z');

/** Build a minimal interaction; all replies are captured for assertions. */
function interaction(commandName, { email = ' Buyer@Example.COM ', admin = false, guildId = 'guild' } = {}) {
  const replies = [];
  return { commandName, guildId, user: { id: 'member' }, replies,
    isChatInputCommand: () => true, options: { getString: () => email },
    memberPermissions: { has: permission => admin && permission === PermissionFlagsBits.ManageRoles },
    reply: async value => replies.push(value), deferReply: async value => replies.push(value),
    editReply: async value => replies.push(value),
  };
}

test('link normalizes email, synchronizes immediately and replies privately', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  store.upsertSubscription({ email: 'buyer@example.com', provider: 'generic', status: 'canceled',
    current_period_end: '2026-12-01T00:00:00Z', updated_at: new Date(now).toISOString() });
  const granted = [];
  const handler = createCommandHandler({ store, guildId: 'guild', now: () => now,
    actions: { grantRole: async id => granted.push(id), revokeRole: async () => assert.fail() } });
  const input = interaction('link'); await handler(input);
  assert.equal(store.getLink('member').email, 'buyer@example.com');
  assert.deepEqual(granted, ['member']);
  assert.equal(input.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(input.replies[1].content, /Active until 2026-12-01/);
  assert.doesNotMatch(JSON.stringify(input.replies), /buyer@example/i);
});

test('status distinguishes not linked and linked but inactive', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  const handler = createCommandHandler({ store, actions: {}, guildId: 'guild', now: () => now });
  const unlinked = interaction('status'); await handler(unlinked);
  assert.match(unlinked.replies[1].content, /Not linked/);
  assert.equal(unlinked.replies[0].flags, MessageFlags.Ephemeral);
  store.link('member', 'buyer@example.com');
  const inactive = interaction('status'); await handler(inactive);
  assert.match(inactive.replies[1].content, /No active subscription/);
});

test('invalid email and wrong guild cannot change links', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  const handler = createCommandHandler({ store, actions: {}, guildId: 'guild', logger: { error() {} } });
  const bad = interaction('link', { email: 'invalid' }); await handler(bad);
  assert.match(bad.replies[1].content, /valid email/);
  const wrong = interaction('link', { guildId: 'other' }); await handler(wrong);
  assert.match(wrong.replies[0].content, /configured server/);
  assert.equal(store.listLinks().length, 0);
});

test('sync requires Manage Roles both in definition and at runtime', async t => {
  const store = openStore(':memory:'); t.after(() => store.close());
  const handler = createCommandHandler({ store, actions: {}, guildId: 'guild' });
  const denied = interaction('sync'); await handler(denied);
  assert.match(denied.replies[0].content, /Manage Roles/);
  assert.equal(denied.replies[0].flags, MessageFlags.Ephemeral);
  const allowed = interaction('sync', { admin: true }); await handler(allowed);
  assert.match(allowed.replies[1].content, /Synced 0 members; 0 failed/);
  assert.equal(commands.find(command => command.name === 'sync').default_member_permissions, PermissionFlagsBits.ManageRoles.toString());
});

/** Fake the REST-facing Discord objects without opening a gateway connection. */
function discordFixture({ position = 1, permission = true, errorCode, managed = false } = {}) {
  const calls = [], logs = [], held = new Set();
  const member = { roles: { cache: held,
    add: async id => { if (errorCode) throw Object.assign(new Error('private payload'), { code: errorCode }); held.add(id); calls.push(['add', id]); },
    remove: async id => { held.delete(id); calls.push(['remove', id]); },
  } };
  const guild = { id: 'guild', roles: { fetch: async () => ({ id: 'role', managed }) },
    members: { fetchMe: async () => ({ roles: { highest: { comparePositionTo: () => position } },
      permissions: { has: () => permission } }), fetch: async () => member } };
  const client = { guilds: { fetch: async () => guild }, channels: { fetch: async () => ({
    guildId: 'guild', isTextBased: () => true, send: async value => calls.push(['message', value]),
  }) } };
  const actions = createDiscordActions(client, { guildId: 'guild', memberRoleId: 'role', ordersChannelId: 'channel' },
    { error: message => logs.push(message) });
  return { actions, calls, logs, client };
}

test('Discord role adapter is idempotent for grants and revokes', async () => {
  const f = discordFixture();
  await f.actions.grantRole('member'); await f.actions.grantRole('member');
  await f.actions.revokeRole('member'); await f.actions.revokeRole('member');
  assert.deepEqual(f.calls, [['add', 'role'], ['remove', 'role']]);
});

test('Discord hierarchy, managed roles and missing permission block role mutations', async () => {
  for (const options of [{ position: 0 }, { position: -1 }, { managed: true }, { permission: false }]) {
    const f = discordFixture(options);
    await assert.rejects(f.actions.grantRole('member'));
    await assert.rejects(f.actions.revokeRole('member'));
    assert.equal(f.calls.length, 0);
  }
});

test('Discord error 50013 logs actionable permission advice without raw errors', async () => {
  const f = discordFixture({ errorCode: 50013 });
  await assert.rejects(f.actions.grantRole('member'));
  assert.match(f.logs.join(''), /50013.*Manage Roles.*above MEMBER_ROLE_ID/);
  assert.doesNotMatch(f.logs.join(''), /private payload/);
});

test('Discord order messages discard additional fields and cannot ping users', async () => {
  const f = discordFixture();
  await f.actions.postOrder({ orderName: '#1', total: '3.00', currency: 'USD', itemCount: 1,
    customerFirstName: '@everyone', email: 'private@example.com', phone: '12345', address: 'Secret Street' });
  const message = f.calls[0][1];
  assert.deepEqual(message.allowedMentions, { parse: [] });
  assert.doesNotMatch(message.content, /private@example|12345|Secret Street/);
});

test('Discord client requests only the nonprivileged Guilds intent', () => {
  const { client } = createDiscordAdapter({ config: { guildId: 'guild' }, store: {} });
  assert.equal(client.options.intents.bitfield, GatewayIntentBits.Guilds);
  client.destroy();
});
