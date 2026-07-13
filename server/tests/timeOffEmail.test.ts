import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildAdminApprovalEmail,
  buildRequesterDecisionEmail,
  resolveGmailDwdCredentials,
  sendTimeOffGmailDwd
} from '../services/timeOffEmail';

describe('time-off email', () => {
  it('copies the source admin template exactly', () => {
    const payload = buildAdminApprovalEmail({
      to: 'admin@example.com',
      requesterName: 'Ada Lovelace',
      requesterEmail: 'ada@example.com',
      centerName: 'Anthem',
      startLabel: '2026-07-26',
      endLabel: '2026-07-27',
      absenceLabel: 'Paid Time Off',
      reason: 'Family vacation out of town',
      reviewUrl: 'https://example.com/admin/approvals?requestId=10',
      approveUrl: 'https://example.com/admin/approvals?requestId=10&action=approve',
      denyUrl: 'https://example.com/admin/approvals?requestId=10&action=deny'
    });

    assert.equal(payload.subject, 'Time Off Request: Ada Lovelace (Anthem)');
    assert.equal(
      payload.text,
      [
        'Time off request for Ada Lovelace <ada@example.com>',
        'Center: Anthem',
        'Dates: 2026-07-26 through 2026-07-27',
        'Absence: Paid Time Off',
        'Reason: Family vacation out of town',
        '',
        'Review: https://example.com/admin/approvals?requestId=10',
        'Approve: https://example.com/admin/approvals?requestId=10&action=approve',
        'Deny: https://example.com/admin/approvals?requestId=10&action=deny'
      ].join('\n')
    );
    assert.equal(
      payload.html,
      '<p><strong>Time off request for Ada Lovelace</strong></p><p>ada@example.com</p><ul><li>Center: Anthem</li><li>Dates: 2026-07-26 through 2026-07-27</li><li>Absence: Paid Time Off</li></ul><p>Family vacation out of town</p><p><a href="https://example.com/admin/approvals?requestId=10">Review</a> | <a href="https://example.com/admin/approvals?requestId=10&amp;action=approve">Approve</a> | <a href="https://example.com/admin/approvals?requestId=10&amp;action=deny">Deny</a></p>'
    );
  });

  it('copies the source requester decision template exactly', () => {
    const payload = buildRequesterDecisionEmail({
      to: 'ada@example.com',
      requesterName: 'Ada Lovelace',
      decision: 'approved',
      startLabel: '2026-07-26',
      endLabel: '2026-07-27',
      reason: 'Email correspondence'
    });

    assert.equal(payload.subject, 'Time Off Request Approved');
    assert.equal(
      payload.text,
      'Ada Lovelace,\n\nYour time off request for 2026-07-26 through 2026-07-27 was approved.\nReason: Email correspondence'
    );
    assert.equal(
      payload.html,
      '<p>Ada Lovelace,</p><p>Your time off request for 2026-07-26 through 2026-07-27 was <strong>approved</strong>.</p><p>Reason: Email correspondence</p>'
    );
  });

  it('requires the split email service-account credential', () => {
    assert.throws(
      () =>
        resolveGmailDwdCredentials({
          GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'legacy@example.com', private_key: 'legacy' })
        }),
      /GOOGLE_EMAIL_SERVICE_ACCOUNT_JSON is required/
    );

    assert.deepEqual(
      resolveGmailDwdCredentials({
        GOOGLE_EMAIL_SERVICE_ACCOUNT_JSON: JSON.stringify({
          client_email: 'email-service@example.com',
          private_key: 'line-one\\nline-two'
        })
      }),
      { clientEmail: 'email-service@example.com', privateKey: 'line-one\nline-two' }
    );
  });

  it('logs safely without credentials when log-only is enabled', async () => {
    const payload = buildRequesterDecisionEmail({
      to: 'ada@example.com',
      requesterName: 'Ada Lovelace',
      decision: 'denied',
      startLabel: '2026-07-26',
      endLabel: '2026-07-27',
      reason: 'Coverage is unavailable'
    });

    const result = await sendTimeOffGmailDwd(payload, {
      logOnly: true,
      dwdSubject: '',
      nowIso: '2026-07-12T18:00:00.000Z'
    });

    assert.equal(result.mode, 'log_only');
    assert.equal(result.sentAt, '2026-07-12T18:00:00.000Z');
  });

  it('redacts decision tokens from log-only console output', async () => {
    const token = 'A'.repeat(43);
    const payload = buildAdminApprovalEmail({
      to: 'admin@example.com',
      requesterName: 'Ada Lovelace',
      requesterEmail: 'ada@example.com',
      centerName: 'Anthem',
      startLabel: '2026-07-26',
      endLabel: '2026-07-27',
      absenceLabel: 'Paid Time Off',
      reason: 'Family vacation out of town',
      reviewUrl: `https://timecard.example.com/timeoff/decision#token=${token}`,
      approveUrl: `https://timecard.example.com/timeoff/decision#token=${token}&action=approve`,
      denyUrl: `https://timecard.example.com/timeoff/decision#token=${token}&action=deny`
    });
    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => logged.push(String(value));
    try {
      const result = await sendTimeOffGmailDwd(payload, {
        logOnly: true,
        dwdSubject: '',
        nowIso: '2026-07-12T18:00:00.000Z'
      });
      assert.equal(result.payload.text.includes(token), true);
    } finally {
      console.log = originalLog;
    }

    assert.equal(logged.some((entry) => entry.includes(token)), false);
    assert.equal(logged.some((entry) => entry.includes('[decision-link-redacted]')), true);
  });
});
