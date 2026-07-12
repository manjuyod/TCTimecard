import assert from 'node:assert/strict';
import { setImmediate as waitImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { createGracefulShutdown } from '../services/gracefulShutdown';

test('graceful shutdown is idempotent and closes resources before exit', async () => {
  let closeCalls = 0;
  let closeCallback: ((error?: Error) => void) | undefined;
  let resourceCloses = 0;
  const exitCodes: number[] = [];
  const server = {
    close(callback: (error?: Error) => void) {
      closeCalls += 1;
      closeCallback = callback;
      return server;
    }
  };

  const shutdown = createGracefulShutdown({
    server: server as never,
    closeResources: async () => { resourceCloses += 1; },
    exit: (code) => { exitCodes.push(code); },
    timeoutMs: 60_000,
    log: { info: () => undefined, error: () => undefined }
  });

  shutdown('SIGTERM');
  shutdown('SIGINT');
  assert.equal(closeCalls, 1);

  closeCallback?.();
  await waitImmediate();
  assert.equal(resourceCloses, 1);
  assert.deepEqual(exitCodes, [0]);
});
