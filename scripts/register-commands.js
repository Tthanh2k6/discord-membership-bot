import { REST, Routes } from 'discord.js';
import { config, requireDiscordConfig } from '../src/config.js';
import { commands } from '../src/commands.js';

// Run explicitly against a real Discord guild; never invoked during tests or dry run.
try {
  requireDiscordConfig(config, true);
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  await rest.put(Routes.applicationGuildCommands(config.discordAppId, config.guildId), { body: commands });
  console.log(`Registered ${commands.length} guild commands.`);
} catch {
  console.error('Command registration failed. Check DISCORD_TOKEN, DISCORD_APP_ID and GUILD_ID.');
  process.exitCode = 1;
}
