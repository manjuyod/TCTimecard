import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildAuthenticatedApprovalLinks,
  sendAdminRequestNotification,
  sendRequesterDecisionNotification
} from '../services/timeOffWorkflow';
import { TimeOffEmailPayload } from '../services/timeOffEmail';

const request = {
  id: 42,
  franchiseId: 6,
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  startLabel: '2026-07-26',
  endLabel: '2026-07-27',
  absenceLabel: 'Paid Time Off',
  reason: 'Family vacation out of town'
};

describe('authenticated time-off notification workflow', () => {
  it('builds authenticated review, approve, and deny links', () => {
    assert.deepEqual(buildAuthenticatedApprovalLinks('https://timecard.example.com/', 6, 42), {
      reviewUrl: 'https://timecard.example.com/admin/approvals?tab=timeoff&franchiseId=6&requestId=42',
      approveUrl:
        'https://timecard.example.com/admin/approvals?tab=timeoff&franchiseId=6&requestId=42&action=approve',
      denyUrl: 'https://timecard.example.com/admin/approvals?tab=timeoff&franchiseId=6&requestId=42&action=deny'
    });
  });

  it('sends the admin request from GmailID to franchise email and audits success', async () => {
    const audit: Array<{ action: string; metadata: Record<string, unknown> }> = [];
    let sent: { payload: TimeOffEmailPayload; subject: string } | undefined;
    const result = await sendAdminRequestNotification(
      {
        request,
        center: { name: 'Anthem', email: 'admin@example.com', gmailId: 'calendar@example.com' },
        appOrigin: 'https://timecard.example.com'
      },
      {
        send: async (payload, subject) => {
          sent = { payload, subject };
        },
        audit: async (action, metadata) => {
          audit.push({ action, metadata });
        }
      }
    );

    assert.deepEqual(result, { kind: 'admin_request', status: 'sent' });
    assert.equal(sent?.payload.to, 'admin@example.com');
    assert.equal(sent?.subject, 'calendar@example.com');
    assert.equal(audit[0]?.action, 'admin_email_sent');
  });

  it('saves a retryable admin notification failure when GmailID is missing', async () => {
    const audit: Array<{ action: string; metadata: Record<string, unknown> }> = [];
    const result = await sendAdminRequestNotification(
      {
        request,
        center: { name: 'Anthem', email: 'admin@example.com', gmailId: null },
        appOrigin: 'https://timecard.example.com'
      },
      {
        send: async () => assert.fail('send should not run'),
        audit: async (action, metadata) => {
          audit.push({ action, metadata });
        }
      }
    );

    assert.equal(result.status, 'failed');
    assert.match(result.warning ?? '', /saved.*notification failed/i);
    assert.equal(audit[0]?.action, 'admin_email_failed');
    assert.equal(audit[0]?.metadata.notificationKind, 'admin_request');
  });

  it('keeps a committed decision successful when requester email fails', async () => {
    const audit: Array<{ action: string; metadata: Record<string, unknown> }> = [];
    const result = await sendRequesterDecisionNotification(
      {
        request,
        decision: 'approved',
        decisionReason: 'Email correspondence',
        gmailId: 'calendar@example.com'
      },
      {
        send: async () => {
          throw new Error('gmail unavailable');
        },
        audit: async (action, metadata) => {
          audit.push({ action, metadata });
        }
      }
    );

    assert.equal(result.status, 'failed');
    assert.match(result.warning ?? '', /decision was saved.*notification failed/i);
    assert.equal(audit[0]?.action, 'requester_email_failed');
    assert.match(String(audit[0]?.metadata.error), /gmail unavailable/);
  });
});
