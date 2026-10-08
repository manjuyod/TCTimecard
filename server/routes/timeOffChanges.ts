import express, { NextFunction, Request, Response } from 'express';
import { isTimeOffChangesEnabled } from '../config/timeOffChanges';
import { getPostgresPool } from '../db/postgres';
import { requireAdmin, requireTutor } from '../middleware/auth';
import { enforceFranchiseScope } from '../middleware/franchiseScope';
import { getFranchisePayrollSettings } from '../payroll/payPeriodResolution';
import { isTimeOffChangeError } from '../services/timeOffChangeErrors';
import {
  AdminTimeOffListQuery,
  AdminTimeOffStatusFilter,
  listAdminTimeOffRequests,
  listPendingTimeOffAmendments,
  listTimeOffChangeDeliveries,
  retryTimeOffChangeDelivery,
  TimeOffAmendmentQueueItem,
  TimeOffChangeListItem
} from '../services/timeOffChangeRepository';
import { createTimeOffChangeService, TimeOffChangeService } from '../services/timeOffChanges';
import { localDateForTimeZone } from '../services/timeOffPolicy';
import type { TimeOffSubmissionInput } from '../types/timeoff';
import type {
  TimeOffChangeActor,
  TimeOffChangeCommand,
  TimeOffChangeDelivery,
  TimeOffChangePage
} from '../types/timeOffChanges';

export interface TimeOffChangeRouteDeps {
  service: Pick<TimeOffChangeService, 'execute' | 'preview' | 'detail'>;
  enabled: () => boolean;
  nowIso: () => string;
  resolveTimezone: (franchiseId: number) => Promise<string>;
  listRequests: (query: AdminTimeOffListQuery) => Promise<TimeOffChangePage<TimeOffChangeListItem>>;
  listAmendments: (query: { franchiseId: number; timezone: string; nowIso: string; cursor?: string; limit: number }) =>
    Promise<TimeOffChangePage<TimeOffAmendmentQueueItem>>;
  listDeliveries: (query: { franchiseId: number; status?: 'pending' | 'failed'; cursor?: string; limit: number }) =>
    Promise<TimeOffChangePage<TimeOffChangeDelivery>>;
  retryDelivery: (input: { franchiseId: number; deliveryId: string; nowIso: string }) => Promise<TimeOffChangeDelivery>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const STATUS_FILTERS: AdminTimeOffStatusFilter[] = ['approved', 'cancelled', 'denied', 'pending', 'all'];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_ID = /^[1-9][0-9]{0,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class InputError extends Error {}

function defaultDeps(): TimeOffChangeRouteDeps {
  let service: TimeOffChangeService | undefined;
  const lazyService = () => (service ??= createTimeOffChangeService());
  return {
    service: {
      execute: (command) => lazyService().execute(command),
      preview: (input) => lazyService().preview(input),
      detail: (actor, requestId, nowIso) => lazyService().detail(actor, requestId, nowIso)
    },
    enabled: () => isTimeOffChangesEnabled(process.env),
    nowIso: () => new Date().toISOString(),
    resolveTimezone: async (franchiseId) => (await getFranchisePayrollSettings(franchiseId)).timezone,
    listRequests: (query) => listAdminTimeOffRequests(getPostgresPool(), query),
    listAmendments: (query) => listPendingTimeOffAmendments(getPostgresPool(), query),
    listDeliveries: (query) => listTimeOffChangeDeliveries(getPostgresPool(), query),
    retryDelivery: (input) => retryTimeOffChangeDelivery(getPostgresPool(), input)
  };
}

/**
 * Approved time-off change endpoints. Mount before the existing time-off
 * router so management paths win over `/timeoff/admin/:id`.
 */
export function createTimeOffChangesRouter(overrides: Partial<TimeOffChangeRouteDeps> = {}) {
  const deps: TimeOffChangeRouteDeps = { ...defaultDeps(), ...overrides };
  const router = express.Router();

  const tutorRoute = (handler: (req: Request, res: Response, actor: TimeOffChangeActor) => Promise<unknown>) =>
    gated(deps, requireTutor, async (req, res) => {
      const actor = tutorActor(req);
      if (!actor) return res.status(400).json({ error: 'Tutor context missing', code: 'TIME_OFF_INVALID_INPUT' });
      return handler(req, res, actor);
    });
  const adminRoute = (handler: (req: Request, res: Response, actor: TimeOffChangeActor) => Promise<unknown>) =>
    gated(deps, requireAdmin, async (req, res) => {
      const actor = adminActor(req, res);
      if (!actor) return undefined;
      return handler(req, res, actor);
    });

  router.get('/timeoff/admin/change-capabilities', requireAdmin, (req, res) => {
    if (!adminActor(req, res)) return;
    res.json({ enabled: deps.enabled() });
  });

  router.get('/timeoff/admin/requests', adminRoute(async (req, res, actor) => {
    const timezone = await deps.resolveTimezone(actor.franchiseId);
    const nowIso = deps.nowIso();
    const query = req.query;
    const page = await deps.listRequests({
      franchiseId: actor.franchiseId,
      timezone,
      status: optionalEnum(query.status, STATUS_FILTERS, 'status'),
      tutorId: optionalPositiveInteger(query.tutorId, 'tutorId'),
      from: optionalDate(query.from, 'from'),
      to: optionalDate(query.to, 'to'),
      requestId: optionalPositiveInteger(query.requestId, 'requestId'),
      cursor: optionalCursor(query.cursor),
      limit: listLimit(query.limit),
      today: localDateForTimeZone(nowIso, timezone)
    });
    return res.json(page);
  }));

  router.get('/timeoff/admin/amendments', adminRoute(async (req, res, actor) => {
    const timezone = await deps.resolveTimezone(actor.franchiseId);
    return res.json(await deps.listAmendments({
      franchiseId: actor.franchiseId, timezone, nowIso: deps.nowIso(),
      cursor: optionalCursor(req.query.cursor), limit: listLimit(req.query.limit)
    }));
  }));

  router.get('/timeoff/admin/change-deliveries', adminRoute(async (req, res, actor) => res.json(await deps.listDeliveries({
    franchiseId: actor.franchiseId,
    status: optionalEnum(req.query.status, ['pending', 'failed'] as const, 'status'),
    cursor: optionalCursor(req.query.cursor),
    limit: listLimit(req.query.limit)
  }))));

  router.post('/timeoff/admin/change-deliveries/:deliveryId/retry', adminRoute(async (req, res, actor) => {
    const deliveryId = String(req.params.deliveryId);
    if (!UUID.test(deliveryId)) throw new InputError('Invalid delivery id');
    return res.json({ delivery: await deps.retryDelivery({
      franchiseId: actor.franchiseId, deliveryId, nowIso: deps.nowIso()
    }) });
  }));

  router.get('/timeoff/admin/:id/change-detail', adminRoute(async (req, res, actor) =>
    res.json(await deps.service.detail(actor, requestId(req), deps.nowIso()))));

  router.post('/timeoff/admin/:id/change-preview', adminRoute(async (req, res, actor) =>
    res.json(await deps.service.preview({ actor, requestId: requestId(req), proposed: proposedInput(req.body), nowIso: deps.nowIso() }))));

  router.post('/timeoff/admin/:id/amendments/:amendmentId/decide', adminRoute(async (req, res, actor) => {
    const decision = req.body?.decision;
    if (decision !== 'approve' && decision !== 'deny') throw new InputError('decision must be approve or deny');
    const base = commandBase(req, actor, deps);
    const amendmentId = amendmentParam(req);
    const command: TimeOffChangeCommand = decision === 'approve'
      ? { ...base, action: 'approve_amendment', amendmentId }
      : { ...base, action: 'deny_amendment', amendmentId, reason: req.body?.reason };
    return res.json(await deps.service.execute(command));
  }));

  router.post('/timeoff/admin/:id/change', adminRoute(async (req, res, actor) => res.json(await deps.service.execute({
    ...commandBase(req, actor, deps), action: 'admin_edit', proposed: proposedInput(req.body), changeReason: req.body?.changeReason
  }))));

  router.post('/timeoff/admin/:id/cancel-approved', adminRoute(async (req, res, actor) => res.json(await deps.service.execute({
    ...commandBase(req, actor, deps), action: 'cancel', changeReason: req.body?.changeReason ?? req.body?.reason
  }))));

  router.get('/timeoff/:id/change-detail', tutorRoute(async (req, res, actor) =>
    res.json(await deps.service.detail(actor, requestId(req), deps.nowIso()))));

  router.post('/timeoff/:id/change-preview', tutorRoute(async (req, res, actor) =>
    res.json(await deps.service.preview({ actor, requestId: requestId(req), proposed: proposedInput(req.body), nowIso: deps.nowIso() }))));

  router.post('/timeoff/:id/amendments', tutorRoute(async (req, res, actor) => res.status(201).json(await deps.service.execute({
    ...commandBase(req, actor, deps), action: 'propose', proposed: proposedInput(req.body), changeReason: req.body?.changeReason
  }))));

  router.post('/timeoff/:id/amendments/:amendmentId/withdraw', tutorRoute(async (req, res, actor) =>
    res.json(await deps.service.execute({ ...commandBase(req, actor, deps), action: 'withdraw', amendmentId: amendmentParam(req) }))));

  router.post('/timeoff/:id/cancel-approved', tutorRoute(async (req, res, actor) => res.json(await deps.service.execute({
    ...commandBase(req, actor, deps), action: 'cancel', changeReason: req.body?.changeReason
  }))));

  return router;
}

type Handler = (req: Request, res: Response) => Promise<unknown>;

/** Authenticates, then hides the endpoint while the feature is off, then maps domain errors. */
function gated(
  deps: TimeOffChangeRouteDeps,
  authenticate: (req: Request, res: Response, next: NextFunction) => void,
  handler: Handler
) {
  return [
    authenticate,
    (req: Request, res: Response, next: NextFunction) => {
      res.set('Cache-Control', 'no-store');
      if (!deps.enabled()) {
        res.status(404).json({ error: 'Approved time-off changes are not enabled', code: 'TIME_OFF_CHANGES_DISABLED' });
        return;
      }
      Promise.resolve(handler(req, res)).catch((error: unknown) => {
        if (error instanceof InputError) {
          res.status(400).json({ error: error.message, code: 'TIME_OFF_INVALID_INPUT' });
          return;
        }
        if (isTimeOffChangeError(error)) {
          const errors = (error.details as { errors?: unknown } | undefined)?.errors;
          res.status(error.status).json(errors ? { error: error.message, code: error.code, errors }
            : { error: error.message, code: error.code });
          return;
        }
        next(error);
      });
    }
  ];
}

function tutorActor(req: Request): TimeOffChangeActor | null {
  const auth = req.session.auth;
  const accountId = Number(auth?.accountId);
  const franchiseId = Number(auth?.franchiseId);
  return Number.isSafeInteger(accountId) && accountId > 0 && Number.isSafeInteger(franchiseId) && franchiseId > 0
    ? { kind: 'TUTOR', accountId, franchiseId }
    : null;
}

function adminActor(req: Request, res: Response): TimeOffChangeActor | null {
  const scope = enforceFranchiseScope(req, { requireFranchiseId: true, requiredMessage: 'franchiseId is required' });
  const accountId = Number(req.session.auth?.accountId);
  if (scope.error || scope.franchiseId === null || !Number.isSafeInteger(accountId) || accountId <= 0) {
    res.status(scope.error?.status ?? 400).json({ error: scope.error?.message ?? 'franchiseId is required',
      code: 'TIME_OFF_INVALID_INPUT' });
    return null;
  }
  return { kind: 'ADMIN', accountId, franchiseId: scope.franchiseId };
}

function commandBase(req: Request, actor: TimeOffChangeActor, deps: TimeOffChangeRouteDeps) {
  return {
    actor,
    requestId: requestId(req),
    expectedVersion: req.body?.expectedVersion,
    idempotencyKey: req.body?.idempotencyKey,
    nowIso: deps.nowIso()
  };
}

function requestId(req: Request): number {
  const value = String(req.params.id ?? '');
  if (!DECIMAL_ID.test(value) || !Number.isSafeInteger(Number(value))) throw new InputError('Invalid request id');
  return Number(value);
}

function amendmentParam(req: Request): string {
  const value = String(req.params.amendmentId ?? '');
  if (!DECIMAL_ID.test(value)) throw new InputError('Invalid change request id');
  return value;
}

function proposedInput(body: unknown): TimeOffSubmissionInput {
  const proposed = (body as { proposed?: unknown } | null)?.proposed;
  if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) throw new InputError('proposed is required');
  const value = proposed as Record<string, unknown>;
  return {
    startDate: value.startDate,
    endDate: value.endDate,
    partialDay: value.partialDay,
    leaveTime: value.leaveTime,
    returnTime: value.returnTime,
    type: value.type,
    reason: value.reason
  };
}

function single(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new InputError(`${name} must be a single value`);
  return value;
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], name: string): T | undefined {
  const text = single(value, name);
  if (text === undefined || text === '') return undefined;
  if (!(allowed as readonly string[]).includes(text)) throw new InputError(`Invalid ${name}`);
  return text as T;
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  const text = single(value, name);
  if (text === undefined || text === '') return undefined;
  if (!DECIMAL_ID.test(text) || !Number.isSafeInteger(Number(text))) throw new InputError(`Invalid ${name}`);
  return Number(text);
}

function optionalDate(value: unknown, name: string): string | undefined {
  const text = single(value, name);
  if (text === undefined || text === '') return undefined;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (!DATE_PATTERN.test(text) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new InputError(`Invalid ${name}`);
  }
  return text;
}

function optionalCursor(value: unknown): string | undefined {
  const text = single(value, 'cursor');
  if (text === undefined || text === '') return undefined;
  if (text.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(text)) throw new InputError('Invalid cursor');
  return text;
}

function listLimit(value: unknown): number {
  const text = single(value, 'limit');
  if (text === undefined || text === '') return DEFAULT_LIMIT;
  const limit = Number(text);
  if (!/^[0-9]+$/.test(text) || limit < 1 || limit > MAX_LIMIT) throw new InputError(`limit must be 1–${MAX_LIMIT}`);
  return limit;
}

export default createTimeOffChangesRouter();
