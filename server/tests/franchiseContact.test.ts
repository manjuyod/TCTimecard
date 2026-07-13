import assert from 'node:assert/strict';
import test from 'node:test';
import { mapFranchiseContactRow } from '../services/franchiseContact';

test('franchise contact mapping includes admin recipient and GmailID', () => {
  assert.deepEqual(
    mapFranchiseContactRow(
      6,
      { FranchiseName: 'Anthem', FranchiesEmail: 'admin@example.com', GmailID: 'calendar@example.com' }
    ),
    { id: 6, name: 'Anthem', email: 'admin@example.com', gmailId: 'calendar@example.com' }
  );
});
