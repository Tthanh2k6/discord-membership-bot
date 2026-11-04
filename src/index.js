import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { config as environmentConfig, requireDiscordConfig } from './config.js';
import { openStore } from './db.js';
import { createServer } from './server.js';
import { createDiscordAdapter, formatOrder } from './discord.js';
import { reconcile, startReconciler } from './reconcile.js';
import { createQueue } from './queue.js';

/** Boot the server and return an orderly shutdown function. */
export async function start(config = environmentConfig, logger = console) {
  if (!config.dryRun) requireDiscordConfig(config);
  const store = openStore(config.dbPath);
  const enqueue = createQueue();
  let client, server, stopReconciler;
  let closing;
  const close = () => closing ??= (async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await stopReconciler?.();
    client?.destroy();
    await enqueue(() => store.close());
  })();
  try {
    let actions;
    if (config.dryRun) {
      actions = {
        grantRole: async id => logger.log(`[DRY_RUN] grant role: ${id}`),
        revokeRole: async id => logger.log(`[DRY_RUN] revoke role: ${id}`),
        postOrder: async order => logger.log(`[DRY_RUN] ${formatOrder(order)}`),
      };
    } else {
      ({ client, actions } = createDiscordAdapter({ config, store, enqueue, logger }));
      await client.login(config.discordToken);
    }
    const run = () => enqueue(() => reconcile(store, actions, { logger }));
    await run();
    stopReconciler = startReconciler(run, config.reconcileMinutes, logger);
    server = createServer({ config, store, actions, enqueue, logger });
    server.listen(config.port);
    await once(server, 'listening');
    logger.log(`${config.dryRun ? 'DRY_RUN ' : ''}Listening on port ${server.address().port}`);
    return { server, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = process.argv.includes('--dry-run') ? { ...environmentConfig, dryRun: true } : environmentConfig;
  try {
    const app = await start(config);
    const stop = () => app.close().catch(() => { process.exitCode = 1; });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch {
    console.error('Startup failed. Check environment values, database path, Discord credentials and port availability.');
    process.exitCode = 1;
  }
}
