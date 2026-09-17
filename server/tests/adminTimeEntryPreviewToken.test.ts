import test from 'node:test';
import assert from 'node:assert/strict';
import {
  signAdminPreview,
  verifyAdminPreviewIntegrity,
  assertAdminPreviewFresh,
} from '../services/adminTimeEntry/previewToken';
import type { AdminCommand } from '../services/adminTimeEntry/contracts';
import { testCommand } from './helpers/adminTimeEntryFixtures';
test('purpose-bound signed preview roundtrips and refuses tampering/malformed schemas', () => {
  const token = signAdminPreview(testCommand, 'secret');
  assert.deepEqual(verifyAdminPreviewIntegrity(token, 'secret'), testCommand);
  for (const malformed of [
    token + 'x',
    token + '.x',
    'x.x',
    token.replace(/^./, 'x'),
  ])
    assert.throws(() => verifyAdminPreviewIntegrity(malformed, 'secret'));
  assert.throws(() =>
    verifyAdminPreviewIntegrity(
      signAdminPreview(
        {
          ...testCommand,
          actor: { accountId: true as unknown as number, franchiseId: 77 },
        },
        'secret',
      ),
      'secret',
    ),
  );
  assert.throws(() =>
    verifyAdminPreviewIntegrity(
      signAdminPreview(
        { ...testCommand, unknownField: 'evil' } as AdminCommand,
        'secret',
      ),
      'secret',
    ),
  );
});
test('integrity verification is separate from ten-minute expiry for immutable replay recovery', () => {
  const token = signAdminPreview(testCommand, 'secret');
  const command = verifyAdminPreviewIntegrity(token, 'secret');
  assertAdminPreviewFresh(command, new Date('2026-09-16T12:09:59Z'));
  assert.throws(
    () => assertAdminPreviewFresh(command, new Date('2026-09-16T12:10:00Z')),
    { code: 'PREVIEW_EXPIRED' },
  );
  assert.equal(verifyAdminPreviewIntegrity(token, 'secret').entryId, 44);
});
