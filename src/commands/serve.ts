import 'dotenv/config';
import { startServer } from '../web/server.js';
import { runSync, lastSyncSettled } from './sync.js';
import { shutdownActual } from '../clients/actual.js';
import { logger } from '../logger.js';

function resolvePort(): number {
  const raw = process.env.PORT ?? process.env.SETUP_PORT ?? '3000';
  const port = Number(raw);
  return Number.isFinite(port) && port > 0 ? port : 3000;
}

function resolveIntervalHours(): number {
  const raw = Number(process.env.SYNC_INTERVAL_HOURS ?? '0');
  if (Number.isFinite(raw) && raw > 0) return raw;
  // Always-on default; set SYNC_INTERVAL_HOURS to override.
  return 6;
}

async function main(): Promise<void> {
  const port = resolvePort();
  const server = await startServer(port);
  const intervalHours = resolveIntervalHours();

  logger.warn(
    'Dashboard is exposed without app-level auth. State-changing routes assume a ' +
      'trusted reverse proxy (Caddy LAN restriction and/or basicauth).'
  );
  logger.info(`Sync scheduler running every ${intervalHours} hour(s)`);

  let running = false;

  async function scheduledSync(): Promise<void> {
    if (running) {
      logger.warn('Skipping scheduled sync — a previous run is still in progress');
      return;
    }
    running = true;
    try {
      await runSync();
    } catch (err) {
      logger.error('Scheduled sync failed:', err instanceof Error ? err.message : String(err));
    } finally {
      running = false;
    }
  }

  // Run once shortly after startup, then on the configured interval.
  const initialTimer = setTimeout(() => void scheduledSync(), 5000);
  const intervalTimer = setInterval(
    () => void scheduledSync(),
    intervalHours * 60 * 60 * 1000
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal} — shutting down`);
    clearTimeout(initialTimer);
    clearInterval(intervalTimer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Let an in-flight sync finish (scheduled or manual) so tokens/config are
    // never left mid-write.
    await lastSyncSettled();
    await shutdownActual();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
