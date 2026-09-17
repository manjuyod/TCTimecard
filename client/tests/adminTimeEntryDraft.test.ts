import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWallTime, formatMinutes, editorReducer } from '../src/lib/adminTimeEntry';

test('correction wall time uses the center timezone, including UTC date rollover', () => {
  const result = resolveWallTime('2026-09-15', '18:15', 'America/Los_Angeles');
  assert.equal(result.options[0]?.iso, '2026-09-16T01:15:00.000Z');
});
test('daylight saving gaps are rejected and folds require an offset choice', () => {
  assert.match(resolveWallTime('2026-03-08', '02:30', 'America/Los_Angeles').error ?? '', /does not exist/i);
  const fold = resolveWallTime('2026-11-01', '01:30', 'America/Los_Angeles');
  assert.deepEqual(fold.options.map(option => option.iso).sort(), ['2026-11-01T08:30:00.000Z', '2026-11-01T09:30:00.000Z']);
});
test('editing clears the reviewed preview and duplicate-operation identity', () => {
  const next = editorReducer({ step: 'reviewing', generation: 1, preview: {} as never,
    operationId: 'operation', error: null, returnStep: 'editing' }, { type: 'edit' });
  assert.equal(next.step, 'editing');
  assert.equal(next.preview, null);
  assert.equal(next.operationId, null);
  assert.equal(next.generation, 2);
});
test('late preview responses cannot re-enable an outdated save', () => {
  const state = { step: 'editing' as const, generation: 2, preview: null,
    operationId: null, error: null, returnStep: 'editing' as const };
  assert.equal(editorReducer(state, { type: 'previewed', generation: 1, preview: {} as never }), state);
  assert.equal(formatMinutes(null), 'Unavailable');
});
