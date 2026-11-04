import { Client, GatewayIntentBits, Events, PermissionFlagsBits, escapeMarkdown } from 'discord.js';
import { createCommandHandler } from './commands.js';

/** Produce an alert only from normalized, allowed order fields. */
export function formatOrder(order) {
  const clean = value => escapeMarkdown(String(value).replace(/[\r\n]/g, ' '));
  return `New order ${clean(order.orderName)}: ${clean(order.total)} ${clean(order.currency)} | `
    + `${order.itemCount} items | ${clean(order.customerFirstName)}`;
}

/** Construct the real actions around an injectable discord.js-compatible client. */
export function createDiscordActions(client, config, logger = console) {
  async function changeRole(discordId, grant) {
    try {
      const guild = await client.guilds.fetch(config.guildId);
      const [bot, role] = await Promise.all([
        guild.members.fetchMe({ force: true }), guild.roles.fetch(config.memberRoleId, { force: true }),
      ]);
      if (!role || role.id === guild.id || role.managed || bot.roles.highest.comparePositionTo(role) <= 0) {
        throw new Error('Move the bot role above MEMBER_ROLE_ID and choose an unmanaged member role.');
      }
      if (!bot.permissions.has(PermissionFlagsBits.ManageRoles)) {
        throw new Error('Give the bot Manage Roles permission.');
      }
      const member = await guild.members.fetch({ user: discordId, force: true });
      if (member.roles.cache.has(role.id) === grant) return;
      if (grant) await member.roles.add(role.id, 'Active paid subscription');
      else await member.roles.remove(role.id, 'Paid subscription ended');
    } catch (error) {
      if (error.code === 10007) return; // A linked member left the guild; retry on later reconciliations.
      if (error.code === 50013) {
        logger.error('Discord 50013: Missing Permissions. Give the bot Manage Roles and move its role above MEMBER_ROLE_ID and the target member.');
      } else {
        logger.error('Role change failed. Check Manage Roles, the member role, and bot role hierarchy.');
      }
      throw error;
    }
  }
  return {
    grantRole: discordId => changeRole(discordId, true),
    revokeRole: discordId => changeRole(discordId, false),
    async postOrder(order) {
      try {
        const channel = await client.channels.fetch(config.ordersChannelId);
        if (!channel?.isTextBased() || typeof channel.send !== 'function' || channel.guildId !== config.guildId) {
          throw new Error('ORDERS_CHANNEL_ID must be a sendable channel in GUILD_ID');
        }
        await channel.send({ content: formatOrder(order), allowedMentions: { parse: [] } });
      } catch (error) {
        logger.error(error.code === 50013
          ? 'Discord 50013: Missing Permissions. Give the bot View Channel and Send Messages in ORDERS_CHANNEL_ID.'
          : 'Order alert failed. Check ORDERS_CHANNEL_ID and channel permissions.');
        throw error;
      }
    },
  };
}

/** Build a Guilds-only client. No login occurs until the entry point calls login(). */
export function createDiscordAdapter({ config, store, enqueue, logger = console }) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const actions = createDiscordActions(client, config, logger);
  const handler = createCommandHandler({ store, actions, guildId: config.guildId, enqueue, logger });
  client.on(Events.InteractionCreate, interaction => {
    handler(interaction).catch(() => logger.error('Could not reply to a Discord interaction.'));
  });
  client.on(Events.Error, () => logger.error('Discord client error; check connectivity and configuration.'));
  return { client, actions };
}
