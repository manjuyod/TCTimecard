import express, { NextFunction, Request, Response } from 'express';
import { APP_ORIGIN } from '../config/appOrigin';
import { getPostgresPool } from '../db/postgres';
import { requireAdmin, requireTutor } from '../middleware/auth';
import { enforceFranchiseScope } from '../middleware/franchiseScope';
import { getFranchisePayrollSettings } from '../payroll/payPeriodResolution';
import { fetchFranchiseContact, FranchiseContact } from '../services/franchiseContact';
import {
  decideTimeOffRequest,
  retryTimeOffNotification,
  safeFetchFranchiseContact,
  TimeOffDecisionResult
} from '../services/timeOffDecision';
import { fetchTimeOffTutorById, fetchTimeOffTutorsByIds, TutorDirectoryIdentity } from '../services/timeOffDirectory';
import { sendTimeOffGmailDwd } from '../services/timeOffEmail';
import { buildTimeOffPolicy, normalizeTimeOffSubmission } from '../services/timeOffPolicy';
import {
  appendTimeOffAudit,
  cancelPendingTimeOff,
  checkTimeOffOverlap,
  createAuthenticatedTimeOff,
  fetchTimeOffById,
  listAdminPendingTimeOff,
  listLatestNotificationFailures,
  listTutorTimeOff,
  NotificationFailureRow
} from '../services/timeOffRepository';
import { sendAdminRequestNotification } from '../services/timeOffWorkflow';
import { NormalizedTimeOffSubmission, TimeOffNotificationResult, TimeOffRecord } from '../types/timeoff';

const MAX_TIME_OFF_DURATION_HOURS = 336;

export interface TimeOffRouteDeps {
  nowIso: () => string;
  resolveTimezone: (franchiseId: number) => Promise<string>;
  fetchTutor: (tutorId: number) => Promise<TutorDirectoryIdentity | null>;
  fetchTutors: (tutorIds: number[]) => Promise<Map<number, TutorDirectoryIdentity>>;
  fetchCenter: (franchiseId: number) => Promise<FranchiseContact | null>;
  checkOverlap: (tutorId: number, startAt: string, endAt: string) => Promise<boolean>;
  createRequest: (args: {
    franchiseId: number;
    tutorId: number;
    firstName: string;
    lastName: string;
    email: string;
    submission: NormalizedTimeOffSubmission;
    timezone: string;
  }) => Promise<TimeOffRecord>;
  listTutor: (tutorId: number, limit: number, timezone: string) => Promise<TimeOffRecord[]>;
  listAdminPending: (franchiseId: number, limit: number, timezone: string) => Promise<TimeOffRecord[]>;
  fetchById: (requestId: number, timezone: string) => Promise<TimeOffRecord | null>;
  cancelRequest: (requestId: number, tutorId: number, timezone: string) => Promise<TimeOffRecord | null>;
  appendAudit: typeof appendTimeOffAudit;
  sendAdminNotification: (
    request: TimeOffRecord,
    center: FranchiseContact | null,
    actorId: number
  ) => Promise<TimeOffNotificationResult>;
  decideRequest: (args: {
    requestId: number;
    franchiseId: number;
    actorId: number;
    decision: 'approve' | 'deny';
    reason: string | null;
    timezone: string;
  }) => Promise<TimeOffDecisionResult>;
  listNotificationFailures: (franchiseId: number) => Promise<NotificationFailureRow[]>;
  retryNotification: typeof retryTimeOffNotification;
}

const defaultDeps: TimeOffRouteDeps = {
  nowIso: () => new Date().toISOString(),
  resolveTimezone: async (franchiseId) => (await getFranchisePayrollSettings(franchiseId)).timezone,
  fetchTutor: fetchTimeOffTutorById,
  fetchTutors: fetchTimeOffTutorsByIds,
  fetchCenter: fetchFranchiseContact,
  checkOverlap: (tutorId, startAt, endAt) =>
    isTimeOffOverlapEnabled(process.env.ENFORCE_TIMEOFF_OVERLAP)
      ? checkTimeOffOverlap(tutorId, startAt, endAt)
      : Promise.resolve(false),
  createRequest: createAuthenticatedTimeOff,
  listTutor: listTutorTimeOff,
  listAdminPending: listAdminPendingTimeOff,
  fetchById: fetchTimeOffById,
  cancelRequest: cancelPendingTimeOff,
  appendAudit: appendTimeOffAudit,
  sendAdminNotification: async (request, center, actorId) =>
    sendAdminRequestNotification(
      {
        request: notificationSummary(request),
        center: center ?? { name: `Franchise ${request.franchiseId}`, email: null, gmailId: null },
        appOrigin: APP_ORIGIN
      },
      {
        send: (payload, subject) =>
          sendTimeOffGmailDwd(payload, { logOnly: emailLogOnly(), dwdSubject: subject }),
        audit: (action, metadata) =>
          appendTimeOffAudit({
            requestId: request.id,
            action,
            actorAccountType: 'TUTOR',
            actorAccountId: actorId,
            previousStatus: request.status,
            newStatus: request.status,
            metadata
          })
      }
    ),
  decideRequest: decideTimeOffRequest,
  listNotificationFailures: listLatestNotificationFailures,
  retryNotification: retryTimeOffNotification
};

export function createTimeOffRouter(overrides: Partial<TimeOffRouteDeps> = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const router = express.Router();

  router.get('/timeoff/policy', requireTutor, asyncHandler(async (req, res) => {
    const context = tutorContext(req);
    if (!context) return res.status(400).json({ error: 'Tutor context missing' });
    const timezone = await deps.resolveTimezone(context.franchiseId);
    return res.json({
      policy: buildTimeOffPolicy({
        timezone,
        nowIso: deps.nowIso(),
        maxDurationHours: MAX_TIME_OFF_DURATION_HOURS
      })
    });
  }));

  router.post('/timeoff', requireTutor, asyncHandler(async (req, res) => {
    const context = tutorContext(req);
    if (!context) return res.status(400).json({ error: 'Tutor context missing' });
    const timezone = await deps.resolveTimezone(context.franchiseId);
    const normalized = normalizeTimeOffSubmission(req.body ?? {}, {
      timezone,
      nowIso: deps.nowIso(),
      maxDurationHours: MAX_TIME_OFF_DURATION_HOURS
    });
    if (!normalized.valid) return res.status(400).json({ error: normalized.errors[0], errors: normalized.errors });
    if (await deps.checkOverlap(context.tutorId, normalized.value.startAt, normalized.value.endAt)) {
      return res.status(409).json({ error: 'Request overlaps an existing pending or approved request' });
    }

    const tutor = await deps.fetchTutor(context.tutorId);
    const fallbackName = String(req.session.auth?.displayName ?? '').trim().split(/\s+/);
    const request = await deps.createRequest({
      franchiseId: context.franchiseId,
      tutorId: context.tutorId,
      firstName: tutor?.firstName ?? fallbackName[0] ?? '',
      lastName: tutor?.lastName ?? fallbackName.slice(1).join(' '),
      email: tutor?.email ?? '',
      submission: normalized.value,
      timezone
    });
    await deps.appendAudit({
      requestId: request.id,
      action: 'created',
      actorAccountType: 'TUTOR',
      actorAccountId: context.tutorId,
      previousStatus: null,
      newStatus: 'pending',
      metadata: {
        franchiseId: request.franchiseId,
        tutorId: request.tutorId,
        source: request.source,
        startAt: request.startAt,
        endAt: request.endAt,
        type: request.type,
        absenceLabel: request.absenceLabel,
        durationHours: request.durationHours
      }
    });
    const notification = await deps.sendAdminNotification(
      request,
      await safeFetchFranchiseContact(() => deps.fetchCenter(context.franchiseId)),
      context.tutorId
    );
    return res.status(201).json({ request, notification });
  }));

  router.get('/timeoff/me', requireTutor, asyncHandler(async (req, res) => {
    const context = tutorContext(req);
    if (!context) return res.status(400).json({ error: 'Tutor context missing' });
    const timezone = await deps.resolveTimezone(context.franchiseId);
    const limit = parseLimit(req.query.limit, 200);
    return res.json({ requests: await deps.listTutor(context.tutorId, limit, timezone) });
  }));

  router.post('/timeoff/:id/cancel', requireTutor, asyncHandler(async (req, res) => {
    const context = tutorContext(req);
    const requestId = positiveInteger(req.params.id);
    if (!context) return res.status(400).json({ error: 'Tutor context missing' });
    if (!requestId) return res.status(400).json({ error: 'Invalid request id' });
    const timezone = await deps.resolveTimezone(context.franchiseId);
    const existing = await deps.fetchById(requestId, timezone);
    if (!existing || existing.tutorId !== context.tutorId) return res.status(404).json({ error: 'Request not found' });
    if (existing.status !== 'pending') return res.status(400).json({ error: 'Only pending requests can be cancelled' });
    const request = await deps.cancelRequest(requestId, context.tutorId, timezone);
    if (!request) return res.status(409).json({ error: 'Request could not be cancelled' });
    await deps.appendAudit({
      requestId,
      action: 'cancelled',
      actorAccountType: 'TUTOR',
      actorAccountId: context.tutorId,
      previousStatus: 'pending',
      newStatus: 'cancelled',
      metadata: { franchiseId: request.franchiseId, tutorId: request.tutorId, source: request.source }
    });
    return res.json({ request });
  }));

  router.get('/timeoff/admin/pending', requireAdmin, asyncHandler(async (req, res) => {
    const franchiseId = scopedFranchise(req, res);
    if (franchiseId === null) return;
    const timezone = await deps.resolveTimezone(franchiseId);
    const requests = await enrichMissingTutorSnapshots(
      await deps.listAdminPending(franchiseId, parseLimit(req.query.limit, 200), timezone),
      deps
    );
    return res.json({ requests });
  }));

  router.get('/timeoff/admin/notification-failures', requireAdmin, asyncHandler(async (req, res) => {
    const franchiseId = scopedFranchise(req, res);
    if (franchiseId === null) return;
    const failures = (await deps.listNotificationFailures(franchiseId)).map((row) => ({
      auditId: Number(row.audit_id),
      requestId: Number(row.request_id),
      at: new Date(row.at).toISOString(),
      kind: row.metadata.notificationKind,
      recipient: row.metadata.recipient,
      error: row.metadata.error
    }));
    return res.json({ failures });
  }));

  router.get('/timeoff/admin/:id', requireAdmin, asyncHandler(async (req, res) => {
    const franchiseId = scopedFranchise(req, res);
    const requestId = positiveInteger(req.params.id);
    if (franchiseId === null) return;
    if (!requestId) return res.status(400).json({ error: 'Invalid request id' });
    const request = await deps.fetchById(requestId, await deps.resolveTimezone(franchiseId));
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.franchiseId !== franchiseId) return res.status(403).json({ error: 'Request does not belong to this franchise' });
    return res.json({ request: (await enrichMissingTutorSnapshots([request], deps))[0] });
  }));

  router.post('/timeoff/:id/decide', requireAdmin, asyncHandler(async (req, res) => {
    const franchiseId = scopedFranchise(req, res);
    const requestId = positiveInteger(req.params.id);
    if (franchiseId === null) return;
    if (!requestId) return res.status(400).json({ error: 'Invalid request id' });
    const decision = req.body?.decision === 'approve' || req.body?.decision === 'deny' ? req.body.decision : null;
    if (!decision) return res.status(400).json({ error: 'decision must be approve or deny' });
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length > 2000) return res.status(400).json({ error: 'reason must be 2000 characters or fewer' });
    if (decision === 'deny' && !reason) return res.status(400).json({ error: 'reason is required when denying a request' });
    const result = await deps.decideRequest({
      requestId,
      franchiseId,
      actorId: Number(req.session.auth!.accountId),
      decision,
      reason: reason || null,
      timezone: await deps.resolveTimezone(franchiseId)
    });
    return sendDecisionResult(res, result);
  }));

  router.post('/timeoff/:id/notifications/:kind/retry', requireAdmin, asyncHandler(async (req, res) => {
    const franchiseId = scopedFranchise(req, res);
    const requestId = positiveInteger(req.params.id);
    const kind = req.params.kind;
    if (franchiseId === null) return;
    if (!requestId) return res.status(400).json({ error: 'Invalid request id' });
    if (kind !== 'admin_request' && kind !== 'requester_decision') {
      return res.status(400).json({ error: 'Invalid notification kind' });
    }
    const request = await deps.fetchById(requestId, await deps.resolveTimezone(franchiseId));
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.franchiseId !== franchiseId) return res.status(403).json({ error: 'Request does not belong to this franchise' });
    const notification = await deps.retryNotification({
      request,
      kind,
      actorId: Number(req.session.auth!.accountId),
      center: await deps.fetchCenter(franchiseId),
      appOrigin: APP_ORIGIN
    });
    return res.status(notification.status === 'sent' ? 200 : 502).json({ request, notification });
  }));

  return router;
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch(next);
  };
}

function tutorContext(req: Request): { tutorId: number; franchiseId: number } | null {
  const auth = req.session.auth;
  const tutorId = Number(auth?.accountId);
  const franchiseId = Number(auth?.franchiseId);
  return Number.isInteger(tutorId) && tutorId > 0 && Number.isInteger(franchiseId) && franchiseId > 0
    ? { tutorId, franchiseId }
    : null;
}

function scopedFranchise(req: Request, res: Response): number | null {
  const scope = enforceFranchiseScope(req, { requireFranchiseId: true, requiredMessage: 'franchiseId is required' });
  if (scope.error || scope.franchiseId === null) {
    res.status(scope.error?.status ?? 400).json({ error: scope.error?.message ?? 'franchiseId is required' });
    return null;
  }
  return scope.franchiseId;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseLimit(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 500) : fallback;
}

function notificationSummary(request: TimeOffRecord) {
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

async function enrichMissingTutorSnapshots(requests: TimeOffRecord[], deps: TimeOffRouteDeps): Promise<TimeOffRecord[]> {
  const ids = requests.filter((request) => request.tutorId && !request.tutorName).map((request) => request.tutorId as number);
  if (ids.length === 0) return requests;
  const tutors = await deps.fetchTutors(ids);
  return requests.map((request) => {
    if (request.tutorId === null || request.tutorName) return request;
    const tutor = tutors.get(request.tutorId);
    return tutor
      ? { ...request, firstName: tutor.firstName, lastName: tutor.lastName, tutorName: `${tutor.firstName} ${tutor.lastName}`.trim(), tutorEmail: tutor.email }
      : request;
  });
}

function sendDecisionResult(res: Response, result: TimeOffDecisionResult) {
  switch (result.kind) {
    case 'ok': return res.json({ request: result.request, notification: result.notification });
    case 'not_found': return res.status(404).json({ error: 'Request not found' });
    case 'wrong_franchise': return res.status(403).json({ error: 'Request does not belong to this franchise' });
    case 'self_approval': return res.status(403).json({ error: 'Self-approval is not allowed' });
    case 'already_decided': return res.status(409).json({ error: 'This request has already been decided', request: result.request });
    case 'calendar_failed':
      console.error('[timeoff] calendar sync failed', result.error);
      return res.status(502).json({ error: 'Failed to create Google Calendar event; request remains pending' });
  }
}

function emailLogOnly(): boolean {
  return String(process.env.EMAIL_LOG_ONLY ?? 'true').trim().toLowerCase() !== 'false';
}

export function isTimeOffOverlapEnabled(value: unknown): boolean {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

export default createTimeOffRouter();
