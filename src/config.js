/** Read and validate environment values without requiring Discord for library imports. */
export function readConfig(env = process.env) {
  const integer = (name, fallback, max) => {
    const value = env[name] ?? String(fallback);
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
      throw new Error(`${name} must be an integer between 1 and ${max}`);
    }
    return Number(value);
  };
  if (env.DRY_RUN && !['0', '1'].includes(env.DRY_RUN)) throw new Error('DRY_RUN must be 0 or 1');
  const config = {
    discordToken: env.DISCORD_TOKEN?.trim() || '',
    discordAppId: env.DISCORD_APP_ID?.trim() || '',
    guildId: env.GUILD_ID?.trim() || '',
    memberRoleId: env.MEMBER_ROLE_ID?.trim() || '',
    ordersChannelId: env.ORDERS_CHANNEL_ID?.trim() || '',
    port: integer('PORT', 8787, 65535),
    dbPath: env.DB_PATH?.trim() || './data/bot.db',
    reconcileMinutes: integer('RECONCILE_MINUTES', 60, 35791),
    dryRun: env.DRY_RUN === '1',
    secrets: Object.freeze({
      stripe: env.STRIPE_WEBHOOK_SECRET?.trim() || '',
      whop: env.WHOP_WEBHOOK_SECRET?.trim() || '',
      generic: env.GENERIC_WEBHOOK_SECRET?.trim() || '',
      shopify: env.SHOPIFY_WEBHOOK_SECRET?.trim() || '',
    }),
  };
  if (config.secrets.whop && !/^whsec_(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(config.secrets.whop)) {
    throw new Error('WHOP_WEBHOOK_SECRET must be whsec_<base64>');
  }
  if (config.secrets.whop === 'whsec_') throw new Error('WHOP_WEBHOOK_SECRET is empty');
  return Object.freeze(config);
}

/** Validate credentials only at a live entry point. @param {ReturnType<typeof readConfig>} config */
export function requireDiscordConfig(config, registration = false) {
  if (!config.discordToken) throw new Error('DISCORD_TOKEN is required');
  const keys = registration ? ['discordAppId', 'guildId'] : ['discordAppId', 'guildId', 'memberRoleId', 'ordersChannelId'];
  for (const key of keys) {
    if (!/^\d{17,20}$/.test(config[key])) throw new Error(`A valid Discord ID is required for ${key}`);
  }
}

export const config = readConfig();
