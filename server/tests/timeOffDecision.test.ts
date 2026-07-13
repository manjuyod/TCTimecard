import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mergeTimeOffTutorSnapshot,
  safeFetchFranchiseContact,
  validateLockedTimeOffDecision
} from '../services/timeOffDecision';
import { TimeOffRecord } from '../types/timeoff';

const request = {
  id: 42,
  franchiseId: 6,
  tutorId: 123,
  status: 'pending'
} as TimeOffRecord;

describe('locked time-off decision validation', () => {
  it('takes an externally committed decision as truth', () => {
    assert.equal(
      validateLockedTimeOffDecision({ ...request, status: 'approved' }, 6, 999),
      'already_decided'
    );
  });

  it('prevents authenticated tutor self-approval', () => {
    assert.equal(validateLockedTimeOffDecision(request, 6, 123), 'self_approval');
  });

  it('allows an admin to decide a public row without a tutor id', () => {
    assert.equal(validateLockedTimeOffDecision({ ...request, tutorId: null }, 6, 123), null);
  });

  it('turns a franchise-directory failure into retryable missing routing', async () => {
    assert.equal(
      await safeFetchFranchiseContact(async () => {
        throw new Error('directory unavailable');
      }),
      null
    );
  });

  it('enriches legacy authenticated rows from the tutor directory', () => {
    const enriched = mergeTimeOffTutorSnapshot(
      { ...request, firstName: '', lastName: '', tutorName: '', tutorEmail: '' },
      { tutorId: 123, firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' }
    );
    assert.equal(enriched.tutorName, 'Ada Lovelace');
    assert.equal(enriched.tutorEmail, 'ada@example.com');
  });
});
