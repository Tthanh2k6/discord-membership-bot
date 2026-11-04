import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { normalizeEmail, PayloadError } from './validation.js';
import { decideAccess, selectSubscription } from './access.js';
import { reconcile, syncLink } from './reconcile.js';
import { createQueue } from './queue.js';

/** Guild command definitions shared by registration and the interaction adapter. */
export const commands = [
  new SlashCommandBuilder().setName('link').setDescription('Link your subscription email')
    .addStringOption(option => option.setName('email').setDescription('Email used for your subscription').setRequired(true)),
  new SlashCommandBuilder().setName('status').setDescription('Show your membership status'),
  new SlashCommandBuilder().setName('sync').setDescription('Reconcile every linked membership')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
].map(command => command.toJSON());

/** Handle slash commands with private responses and server-side authorization. */
export function createCommandHandler({ store, actions, guildId, logger = console, now = Date.now, enqueue = createQueue() }) {
  return async function handleCommand(interaction) {
    if (!interaction.isChatInputCommand() || !commands.some(command => command.name === interaction.commandName)) return;
    if (interaction.guildId !== guildId) {
      await interaction.reply({ content: 'Use this command in the configured server.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.commandName === 'sync' && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
      await interaction.reply({ content: 'Manage Roles permission is required.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const content = await enqueue(async () => {
        if (interaction.commandName === 'link') {
          const email = normalizeEmail(interaction.options.getString('email', true));
          store.link(interaction.user.id, email, new Date(now()).toISOString());
          await syncLink(store, actions, store.getLink(interaction.user.id), now());
          return 'Email linked. ' + membershipStatus(store, interaction.user.id, now());
        }
        if (interaction.commandName === 'status') return membershipStatus(store, interaction.user.id, now());
        const summary = await reconcile(store, actions, { now: now(), logger });
        return `Synced ${summary.checked} members; ${summary.failed} failed (will retry).`;
      });
      await interaction.editReply({ content, allowedMentions: { parse: [] } });
    } catch (error) {
      logger.error('Membership command failed; no email or interaction payload logged.');
      await interaction.editReply({ content: error instanceof PayloadError
        ? 'Please provide a valid email address.'
        : 'Unable to finish syncing. Please retry or ask an administrator to check the bot permissions.' });
    }
  };
}

/** Format membership without exposing the linked email in Discord messages. */
export function membershipStatus(store, discordId, now = Date.now()) {
  const link = store.getLink(discordId);
  if (!link) return 'Not linked. Use /link to link your subscription email.';
  const row = selectSubscription(store.subscriptionsFor(link.email), now);
  return decideAccess(row, now) === 'revoke' ? 'No active subscription.' : `Active until ${row.current_period_end}.`;
}
