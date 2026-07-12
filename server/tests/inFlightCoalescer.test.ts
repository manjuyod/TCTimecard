import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInFlightCoalescer } from '../services/inFlightCoalescer';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

test('identical active keys share one calculation', async () => {
  const gate = deferred<number>();
  const coalescer = createInFlightCoalescer<number>();
  let calls = 0;
  const work = () => {
    calls += 1;
    return gate.promise;
  };

  const first = coalescer.run('77:2026-02-03', work);
  const second = coalescer.run('77:2026-02-03', work);
  assert.equal(calls, 1);
  assert.equal(coalescer.size, 1);

  gate.resolve(42);
  assert.deepEqual(await Promise.all([first, second]), [42, 42]);
  assert.equal(coalescer.size, 0);
});

test('different keys run independently', async () => {
  const coalescer = createInFlightCoalescer<number>();
  let calls = 0;
  const values = await Promise.all([
    coalescer.run('77:current', async () => ++calls),
    coalescer.run('88:current', async () => ++calls)
  ]);

  assert.equal(calls, 2);
  assert.deepEqual(values.sort(), [1, 2]);
});

test('failed work is removed so a later request can retry', async () => {
  const coalescer = createInFlightCoalescer<number>();
  let calls = 0;

  await assert.rejects(
    coalescer.run('77:current', async () => {
      calls += 1;
      throw new Error('temporary failure');
    }),
    /temporary failure/
  );
  assert.equal(coalescer.size, 0);

  const result = await coalescer.run('77:current', async () => ++calls);
  assert.equal(result, 2);
});
