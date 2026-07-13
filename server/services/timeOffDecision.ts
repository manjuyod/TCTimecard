import { Pool, PoolClient } from 'pg';
import { getPostgresPool } from '../db/postgres';
import { getFranchisePayrollSettings } from '../payroll/payPeriodResolution';
import { TimeOffNotificationResult, TimeOffRecord } from '../types/timeoff';
import { fetchFranchiseContact, FranchiseContact } from './franchiseContact';
import {
  buildGcalClientForSubject,
  buildTimeOffCalendarEvent,
  insertOrVerifyTimeOffEvent
} from './googleCalendar';
import {
  appendTimeOffAudit,
  fetchPendingTimeOffByDecisionTokenHash,
  findPendingTimeOffDecisionFranchiseId,
  fetchTimeOffById,
  storeTimeOffDecisionToken,
  updateTimeOffDecision
} from './timeOffRepository';
import { sendTimeOffGmailDwd } from './timeOffEmail';
import { sendRequesterDecisionNotification } from './timeOffWorkflow';
import { fetchTimeOffTutorById, TutorDirectoryIdentity } from './timeOffDirectory';
import {
  hashTimeOffDecisionToken,
  issueTimeOffDecisionToken,
  isAcceptedTimeOffDecisionToken,
  normalizeEmailDecisionReason
} from './timeOffDecisionToken';

export interface TimeOffEmailDecisionPreviewDeps {
  findFranchiseId: (tokenHash: string, nowIso: string) => Promise<number | null>;
  resolveTimezone: (franchiseId: number) => Promise<string>;
  fetchPending: (tokenHash: string, nowIso: string, timezone: string) => Promise<TimeOffRecord | null>;
}

const defaultEmailDecisionPreviewDeps: TimeOffEmailDecisionPreviewDeps = {
  findFranchiseId: (tokenHash, nowIso) => findPendingTimeOffDecisionFranchiseId({ tokenHash, nowIso }),
  resolveTimezone: async (franchiseId) => (await getFranchisePayrollSettings(franchiseId)).timezone,
  fetchPending: (tokenHash, nowIso, timezone) =>
    fetchPendingTimeOffByDecisionTokenHash({ tokenHash, nowIso, timezone })
};

export async function previewTimeOffEmailDecision(
  args: { rawToken: string; nowIso: string },
  deps: TimeOffEmailDecisionPreviewDeps = defaultEmailDecisionPreviewDeps
): Promise<TimeOffRecord | null> {
  if (!isAcceptedTimeOffDecisionToken(args.rawToken)) return null;
  const tokenHash = hashTimeOffDecisionToken(args.rawToken);
  const franchiseId = await deps.findFranchiseId(tokenHash, args.nowIso);
  if (franchiseId === null) return null;
  const timezone = await deps.resolveTimezone(franchiseId);
  return deps.fetchPending(tokenHash, args.nowIso, timezone);
}

export interface TimeOffEmailDecisionDeps {
  findFranchiseId: (tokenHash: string, nowIso: string) => Promise<number | null>;
  resolveTimezone: (franchiseId: number) => Promise<string>;
  decideLocked: (args: {
    tokenHash: string;
    franchiseId: number;
    actorAccountType: 'ADMIN_EMAIL';
    actorId: null;
    decision: 'approve' | 'deny';
    reason: string;
    timezone: string;
    nowIso: string;
  }) => Promise<TimeOffDecisionResult>;
}

const defaultEmailDecisionDeps: TimeOffEmailDecisionDeps = {
  findFranchiseId: (tokenHash, nowIso) => findPendingTimeOffDecisionFranchiseId({ tokenHash, nowIso }),
  resolveTimezone: async (franchiseId) => (await getFranchisePayrollSettings(franchiseId)).timezone,
  decideLocked: (args) => decideTimeOffRequestByToken(args)
};

export async function decideTimeOffByEmailToken(
  args: {
    rawToken: string;
    nowIso: string;
    decision: 'approve' | 'deny';
    reason: string | null;
  },
  deps: TimeOffEmailDecisionDeps = defaultEmailDecisionDeps
): Promise<TimeOffDecisionResult> {
  if (!isAcceptedTimeOffDecisionToken(args.rawToken)) return { kind: 'not_found' };
  const tokenHash = hashTimeOffDecisionToken(args.rawToken);
  const franchiseId = await deps.findFranchiseId(tokenHash, args.nowIso);
  if (franchiseId === null) return { kind: 'not_found' };
  const timezone = await deps.resolveTimezone(franchiseId);
  return deps.decideLocked({
    tokenHash,
    franchiseId,
    actorAccountType: 'ADMIN_EMAIL',
    actorId: null,
    decision: args.decision,
    reason: normalizeEmailDecisionReason(args.reason),
    timezone,
    nowIso: args.nowIso
  });
}

export type TimeOffDecisionResult =
  | { kind: 'ok'; request: TimeOffRecord; notification: TimeOffNotificationResult }
  | { kind: 'not_found' }
  | { kind: 'wrong_franchise'; request: TimeOffRecord }
  | { kind: 'already_decided'; request: TimeOffRecord }
  | { kind: 'self_approval'; request: TimeOffRecord }
  | { kind: 'calendar_failed'; request: TimeOffRecord; error: string };

export function validateLockedTimeOffDecision(
  request: TimeOffRecord,
  franchiseId: number,
  actorId: number
): 'wrong_franchise' | 'already_decided' | 'self_approval' | null {
  if (request.franchiseId !== franchiseId) return 'wrong_franchise';
  if (request.status !== 'pending') return 'already_decided';
  if (request.tutorId !== null && request.tutorId === actorId) return 'self_approval';
  return null;
}

export async function safeFetchFranchiseContact(
  fetcher: () => Promise<FranchiseContact | null>
): Promise<FranchiseContact | null> {
  try {
    return await fetcher();
  } catch (error) {
    console.error('[timeoff] franchise contact lookup failed', error instanceof Error ? error.message : String(error));
    return null;
  }
}

export function mergeTimeOffTutorSnapshot(
  request: TimeOffRecord,
  tutor: TutorDirectoryIdentity | null
): TimeOffRecord {
  if (!tutor || (request.tutorName && request.tutorEmail)) return request;
  return {
    ...request,
    firstName: request.firstName || tutor.firstName,
    lastName: request.lastName || tutor.lastName,
    tutorName: request.tutorName || `${tutor.firstName} ${tutor.lastName}`.trim(),
    tutorEmail: request.tutorEmail || tutor.email
  };
}

export async function decideTimeOffRequest(args: {
  requestId: number;
  franchiseId: number;
  actorId: number;
  decision: 'approve' | 'deny';
  reason: string | null;
  timezone: string;
  pool?: Pool;
}): Promise<TimeOffDecisionResult> {
  return decideLockedTimeOffRequest({
    pool: args.pool ?? getPostgresPool(),
    franchiseId: args.franchiseId,
    actorAccountType: 'ADMIN',
    actorId: args.actorId,
    enforceSelfApproval: true,
    decision: args.decision,
    reason: normalizeEmailDecisionReason(args.reason),
    timezone: args.timezone,
    nowIso: new Date().toISOString(),
    expectedTokenHash: null,
    lockRequest: (client) => fetchTimeOffById(args.requestId, args.timezone, client, true),
    fallbackRequestId: args.requestId
  });
}

export async function decideTimeOffRequestByToken(args: {
  tokenHash: string;
  franchiseId: number;
  actorAccountType: 'ADMIN_EMAIL';
  actorId: null;
  decision: 'approve' | 'deny';
  reason: string;
  timezone: string;
  nowIso: string;
  pool?: Pool;
}): Promise<TimeOffDecisionResult> {
  return decideLockedTimeOffRequest({
    pool: args.pool ?? getPostgresPool(),
    franchiseId: args.franchiseId,
    actorAccountType: args.actorAccountType,
    actorId: args.actorId,
    enforceSelfApproval: false,
    decision: args.decision,
    reason: normalizeEmailDecisionReason(args.reason),
    timezone: args.timezone,
    nowIso: args.nowIso,
    expectedTokenHash: args.tokenHash,
    lockRequest: (client) => fetchPendingTimeOffByDecisionTokenHash({
      tokenHash: args.tokenHash,
      nowIso: args.nowIso,
      timezone: args.timezone,
      db: client,
      forUpdate: true
    }),
    fallbackRequestId: null
  });
}

async function decideLockedTimeOffRequest(args: {
  pool: Pool;
  franchiseId: number;
  actorAccountType: 'ADMIN' | 'ADMIN_EMAIL';
  actorId: number | null;
  enforceSelfApproval: boolean;
  decision: 'approve' | 'deny';
  reason: string;
  timezone: string;
  nowIso: string;
  expectedTokenHash: string | null;
  lockRequest: (client: PoolClient) => Promise<TimeOffRecord | null>;
  fallbackRequestId: number | null;
}): Promise<TimeOffDecisionResult> {
  const contact = await safeFetchFranchiseContact(() => fetchFranchiseContact(args.franchiseId));
  const client = await args.pool.connect();
  let updated: TimeOffRecord | null = null;
  let calendarEventId: string | null = null;
  const decisionReason = normalizeEmailDecisionReason(args.reason);
  let locked: TimeOffRecord | null = null;

  try {
    await client.query('BEGIN');
    locked = await args.lockRequest(client);
    if (!locked) {
      await client.query('ROLLBACK');
      return { kind: 'not_found' };
    }
    if (locked.tutorId !== null && (!locked.tutorName || !locked.tutorEmail)) {
      const tutor = await fetchTimeOffTutorById(locked.tutorId).catch((error) => {
        console.error('[timeoff] tutor snapshot lookup failed', error instanceof Error ? error.message : String(error));
        return null;
      });
      locked = mergeTimeOffTutorSnapshot(locked, tutor);
    }
    const validation = locked.franchiseId !== args.franchiseId
      ? 'wrong_franchise'
      : locked.status !== 'pending'
        ? 'already_decided'
        : args.enforceSelfApproval && args.actorId !== null && locked.tutorId === args.actorId
          ? 'self_approval'
          : null;
    if (validation !== null) {
      await client.query('ROLLBACK');
      return { kind: validation, request: locked };
    }

    if (args.decision === 'approve') {
      const gmailId = contact?.gmailId?.trim();
      if (!gmailId) throw new CalendarDecisionError('Franchise GmailID is required to approve and sync to Google Calendar');
      const calendarClient = buildGcalClientForSubject(gmailId);
      const event = buildTimeOffCalendarEvent(toCalendarRequest(locked), decisionReason);
      calendarEventId = await insertOrVerifyTimeOffEvent(
        calendarClient,
        gmailId,
        event,
        locked.id,
        locked.franchiseId
      );
    }

    updated = await updateTimeOffDecision({
      client,
      requestId: locked.id,
      status: args.decision === 'approve' ? 'approved' : 'denied',
      actorId: args.actorId,
      reason: decisionReason,
      calendarEventId,
      timezone: args.timezone,
      expectedTokenHash: args.expectedTokenHash,
      nowIso: args.nowIso
    });
    if (!updated) {
      await client.query('ROLLBACK');
      const current = args.fallbackRequestId === null
        ? null
        : await fetchTimeOffById(args.fallbackRequestId, args.timezone);
      return current ? { kind: 'already_decided', request: current } : { kind: 'not_found' };
    }
    await appendTimeOffAudit(
      {
        requestId: updated.id,
        action: updated.status,
        actorAccountType: args.actorAccountType,
        actorAccountId: args.actorId,
        previousStatus: 'pending',
        newStatus: updated.status,
        metadata: {
          franchiseId: updated.franchiseId,
          tutorId: updated.tutorId,
          bridgeProfileId: updated.bridgeProfileId,
          source: updated.source,
          reason: decisionReason,
          googleCalendarEventId: updated.googleCalendarEventId
        }
      },
      client
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (locked && (error instanceof CalendarDecisionError || args.decision === 'approve')) {
      return {
        kind: 'calendar_failed',
        request: locked,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    throw error;
  } finally {
    client.release();
  }

  const decided = updated as TimeOffRecord;
  const notification = await notifyRequester(decided, contact, args.actorAccountType, args.actorId);
  return { kind: 'ok', request: decided, notification };
}

export async function retryTimeOffNotification(args: {
  request: TimeOffRecord;
  kind: TimeOffNotificationResult['kind'];
  actorId: number;
  center: FranchiseContact | null;
  appOrigin: string;
}): Promise<TimeOffNotificationResult> {
  const { sendAdminRequestNotification } = await import('./timeOffWorkflow');
  const audit = async (action: string, metadata: Record<string, unknown>) => {
    const success = action.endsWith('_sent');
    await appendTimeOffAudit({
      requestId: args.request.id,
      action: success ? 'notification_retry_sent' : 'notification_retry_failed',
      actorAccountType: 'ADMIN',
      actorAccountId: args.actorId,
      previousStatus: args.request.status,
      newStatus: args.request.status,
      metadata: { ...metadata, originalAction: action }
    });
  };
  const send = (payload: Parameters<typeof sendTimeOffGmailDwd>[0], subject: string) =>
    sendTimeOffGmailDwd(payload, { logOnly: emailLogOnly(), dwdSubject: subject });
  const summary = toNotificationSummary(args.request);

  if (args.kind === 'admin_request') {
    if (args.request.status !== 'pending') {
      const warning = 'The admin notification cannot be retried after the request has been decided or cancelled.';
      await audit('admin_email_failed', {
        notificationKind: 'admin_request',
        notificationStatus: 'failed',
        recipient: args.center?.email ?? args.center?.gmailId ?? '',
        error: warning
      });
      return { kind: 'admin_request', status: 'failed', warning };
    }
    const decisionToken = await issueTimeOffDecisionToken(
      new Date().toISOString(),
      (tokenHash, expiresAt) => storeTimeOffDecisionToken({
        requestId: args.request.id,
        tokenHash,
        expiresAt
      })
    );
    if (!decisionToken) {
      const warning = 'The request is no longer pending, so a new admin decision link was not sent.';
      await audit('admin_email_failed', {
        notificationKind: 'admin_request',
        notificationStatus: 'failed',
        recipient: args.center?.email ?? args.center?.gmailId ?? '',
        error: warning
      });
      return { kind: 'admin_request', status: 'failed', warning };
    }
    return sendAdminRequestNotification(
      {
        request: summary,
        center: args.center ?? { name: `Franchise ${args.request.franchiseId}`, email: null, gmailId: null },
        appOrigin: args.appOrigin,
        rawDecisionToken: decisionToken.rawToken
      },
      { send, audit }
    );
  }
  if (args.request.status !== 'approved' && args.request.status !== 'denied') {
    return {
      kind: 'requester_decision',
      status: 'failed',
      warning: 'The requester notification cannot be retried until the request has been decided.'
    };
  }
  return sendRequesterDecisionNotification(
    {
      request: summary,
      decision: args.request.status,
      decisionReason: args.request.decisionReason || 'Email correspondence',
      gmailId: args.center?.gmailId ?? null
    },
    { send, audit }
  );
}

async function notifyRequester(
  request: TimeOffRecord,
  contact: FranchiseContact | null,
  actorAccountType: 'ADMIN' | 'ADMIN_EMAIL',
  actorId: number | null
): Promise<TimeOffNotificationResult> {
  return sendRequesterDecisionNotification(
    {
      request: toNotificationSummary(request),
      decision: request.status as 'approved' | 'denied',
      decisionReason: request.decisionReason || 'Email correspondence',
      gmailId: contact?.gmailId ?? null
    },
    {
      send: (payload, subject) => sendTimeOffGmailDwd(payload, { logOnly: emailLogOnly(), dwdSubject: subject }),
      audit: (action, metadata) =>
        appendTimeOffAudit({
          requestId: request.id,
          action,
          actorAccountType,
          actorAccountId: actorId,
          previousStatus: request.status,
          newStatus: request.status,
          metadata
        })
    }
  );
}

function toNotificationSummary(request: TimeOffRecord) {
  return {
    id: request.id,
    franchiseId: request.franchiseId,
    firstName: request.firstName,
    lastName: request.lastName,
    email: request.tutorEmail,
    startLabel: request.startDate,
    endLabel: request.endDate,
    absenceLabel: request.absenceLabel,
    reason: request.reason || ''
  };
}

function toCalendarRequest(request: TimeOffRecord) {
  return {
    id: request.id,
    franchiseId: request.franchiseId,
    tutorId: request.tutorId,
    bridgeProfileId: request.bridgeProfileId,
    firstName: request.firstName,
    lastName: request.lastName,
    email: request.tutorEmail,
    startAt: request.startAt,
    endAt: request.endAt,
    startDate: request.startDate,
    endDate: request.endDate,
    type: request.type,
    absenceLabel: request.absenceLabel,
    reason: request.reason,
    partialDay: request.partialDay
  };
}

function emailLogOnly(): boolean {
  return String(process.env.EMAIL_LOG_ONLY ?? 'true').trim().toLowerCase() !== 'false';
}

class CalendarDecisionError extends Error {}
