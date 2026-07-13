import { TimeOffNotificationResult } from '../types/timeoff';
import {
  buildAdminApprovalEmail,
  buildRequesterDecisionEmail,
  TimeOffEmailPayload
} from './timeOffEmail';

export interface NotificationRequestSummary {
  id: number;
  franchiseId: number;
  firstName: string;
  lastName: string;
  email: string;
  startLabel: string;
  endLabel: string;
  absenceLabel: string;
  reason: string;
}

export interface NotificationCenter {
  name: string;
  email: string | null;
  gmailId: string | null;
}

export interface NotificationDeps {
  send: (payload: TimeOffEmailPayload, dwdSubject: string) => Promise<unknown>;
  audit: (action: string, metadata: Record<string, unknown>) => Promise<void>;
}

export function buildAuthenticatedApprovalLinks(appOrigin: string, rawDecisionToken: string) {
  const review = new URL('/timeoff/decision', ensureTrailingSlash(appOrigin));
  review.hash = new URLSearchParams({ token: rawDecisionToken }).toString();
  const approve = new URL(review.toString());
  approve.hash = new URLSearchParams({ token: rawDecisionToken, action: 'approve' }).toString();
  const deny = new URL(review.toString());
  deny.hash = new URLSearchParams({ token: rawDecisionToken, action: 'deny' }).toString();
  return { reviewUrl: review.toString(), approveUrl: approve.toString(), denyUrl: deny.toString() };
}

export async function sendAdminRequestNotification(
  input: {
    request: NotificationRequestSummary;
    center: NotificationCenter;
    appOrigin: string;
    rawDecisionToken: string;
  },
  deps: NotificationDeps
): Promise<TimeOffNotificationResult> {
  const googleIdentityEmail = input.center.gmailId?.trim() || '';
  const recipient = input.center.email?.trim() || googleIdentityEmail;
  const links = buildAuthenticatedApprovalLinks(input.appOrigin, input.rawDecisionToken);
  const payload = buildAdminApprovalEmail({
    to: recipient,
    requesterName: requesterName(input.request),
    requesterEmail: input.request.email,
    centerName: input.center.name,
    startLabel: input.request.startLabel,
    endLabel: input.request.endLabel,
    absenceLabel: input.request.absenceLabel,
    reason: input.request.reason,
    ...links
  });
  return attemptNotification(
    'admin_request',
    'admin_email_sent',
    'admin_email_failed',
    payload,
    googleIdentityEmail,
    'The request was saved, but the admin notification failed. An administrator can retry it.',
    deps
  );
}

export async function sendRequesterDecisionNotification(
  input: {
    request: NotificationRequestSummary;
    decision: 'approved' | 'denied';
    decisionReason: string;
    gmailId: string | null;
  },
  deps: NotificationDeps
): Promise<TimeOffNotificationResult> {
  const googleIdentityEmail = input.gmailId?.trim() || '';
  const payload = buildRequesterDecisionEmail({
    to: input.request.email,
    requesterName: requesterName(input.request),
    decision: input.decision,
    startLabel: input.request.startLabel,
    endLabel: input.request.endLabel,
    reason: input.decisionReason
  });
  return attemptNotification(
    'requester_decision',
    'requester_email_sent',
    'requester_email_failed',
    payload,
    googleIdentityEmail,
    'The decision was saved, but the requester notification failed. An administrator can retry it.',
    deps
  );
}

async function attemptNotification(
  kind: TimeOffNotificationResult['kind'],
  successAction: string,
  failureAction: string,
  payload: TimeOffEmailPayload,
  googleIdentityEmail: string,
  warning: string,
  deps: NotificationDeps
): Promise<TimeOffNotificationResult> {
  const baseMetadata = {
    notificationKind: kind,
    googleIdentityEmail,
    recipient: payload.to,
    emailSubject: payload.subject
  };
  try {
    if (!googleIdentityEmail) throw new Error('Franchise GmailID is not configured.');
    if (!payload.to.trim()) throw new Error('Notification recipient email is not configured.');
    await deps.send(payload, googleIdentityEmail);
    await deps.audit(successAction, { ...baseMetadata, notificationStatus: 'sent' });
    return { kind, status: 'sent' };
  } catch (error) {
    await deps.audit(failureAction, {
      ...baseMetadata,
      notificationStatus: 'failed',
      error: error instanceof Error ? error.message : String(error)
    });
    return { kind, status: 'failed', warning };
  }
}

function requesterName(request: Pick<NotificationRequestSummary, 'firstName' | 'lastName'>): string {
  return `${request.firstName} ${request.lastName}`.trim() || 'Tutor';
}

function ensureTrailingSlash(origin: string): string {
  return origin.endsWith('/') ? origin : `${origin}/`;
}
