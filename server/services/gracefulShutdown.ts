import type { Server } from 'node:http';

type Logger = Pick<Console, 'info' | 'error'>;

export interface GracefulShutdownOptions {
  server: Pick<Server, 'close'>;
  closeResources: () => Promise<void>;
  exit?: (code: number) => void;
  timeoutMs?: number;
  log?: Logger;
}

export const createGracefulShutdown = ({
  server,
  closeResources,
  exit = (code) => process.exit(code),
  timeoutMs = 10_000,
  log = console
}: GracefulShutdownOptions) => {
  let shuttingDown = false;

  return (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`[shutdown] ${signal} received; draining requests`);

    const forceTimer = setTimeout(() => {
      log.error('[shutdown] grace period expired; forcing exit');
      exit(1);
    }, timeoutMs);
    forceTimer.unref();

    server.close((serverError?: Error) => {
      void closeResources()
        .then(() => {
          clearTimeout(forceTimer);
          exit(serverError ? 1 : 0);
        })
        .catch((error: unknown) => {
          clearTimeout(forceTimer);
          log.error('[shutdown] resource cleanup failed', error);
          exit(1);
        });
    });
  };
};

export const installGracefulShutdown = (options: GracefulShutdownOptions): void => {
  const shutdown = createGracefulShutdown(options);
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
};
