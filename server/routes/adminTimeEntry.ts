import { Router, type Request, type Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { enforceFranchiseScope } from '../middleware/franchiseScope';
import { getPostgresPool } from '../db/postgres';
import {
  fetchLatestScheduleSnapshots,
  scheduleCandidateKey,
} from '../services/scheduleSource';
import type {
  AdminActor,
  AdminTimeEntryRouteDeps,
  CorrectionInput,
  DayFilters,
} from '../services/adminTimeEntry/contracts';
import {
  AdminTimeEntryError,
  invalid,
  positiveId,
  reasonText,
} from '../services/adminTimeEntry/errors';
import { validWorkDate } from '../services/adminTimeEntry/policy';
import { validateDayFilters } from '../services/adminTimeEntry/pagination';
import {
  getAdminDetail,
  getAdminDetailById,
  listAdminDays,
  readHistory,
} from '../services/adminTimeEntry/repository';
import {
  listAdminTutors,
  requireActiveTutor,
} from '../services/adminTimeEntry/directory';
import {
  previewCorrection,
  previewStatusOperation,
} from '../services/adminTimeEntry/preview';
import {
  assertOperationId,
  commitAdminOperation,
  getAdminOperation,
} from '../services/adminTimeEntry/operations';
const prefix = '/time-entry/admin';
function requestInteger(
  value: unknown,
  field: string,
  defaultValue?: number,
): number {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  const parsed =
    typeof value === 'string' && /^[1-9]\d*$/.test(value)
      ? Number(value)
      : value;
  positiveId(parsed, field);
  return parsed;
}
function text(
  value: unknown,
  field: string,
  max: number,
  defaultValue?: string,
): string {
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    return invalid(`Invalid ${field}`, field);
  return value.trim();
}
function date(value: unknown, field: string): string {
  if (!validWorkDate(value)) return invalid(`Invalid ${field}`, field);
  return value;
}
function body(req: Request, fields: string[]): Record<string, any> {
  const value = req.body;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !fields.includes(k))
  )
    return invalid('Unexpected or invalid request fields');
  return value;
}
export function createAdminTimeEntryRouter(
  deps: AdminTimeEntryRouteDeps,
): Router {
  const router = Router();
  router.use(prefix, requireAdmin);
  const handle =
    (fn: (req: Request, actor: AdminActor) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        if (req.query.franchiseId !== undefined)
          requestInteger(req.query.franchiseId, 'franchiseId');
        if (req.body?.franchiseId !== undefined)
          requestInteger(req.body.franchiseId, 'franchiseId');
        const scope = enforceFranchiseScope(req, { requireFranchiseId: true });
        if (scope.error)
          throw new AdminTimeEntryError(
            'INVALID_INPUT',
            scope.error.message,
            scope.error.status,
          );
        positiveId(scope.franchiseId, 'franchiseId');
        const actor = {
          accountId: req.session.auth!.accountId,
          franchiseId: scope.franchiseId,
        };
        positiveId(actor.accountId, 'accountId');
        res.json(await fn(req, actor));
      } catch (error) {
        if (error instanceof AdminTimeEntryError)
          res.status(error.status).json({
            error: error.message,
            code: error.code,
            ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
          });
        else if ((error as { status?: number }).status === 404)
          res.status(404).json({ error: 'Entry not found', code: 'NOT_FOUND' });
        else
          res.status(500).json({
            error: 'Unable to process time entry request',
            code: 'INTERNAL_ERROR',
          });
      }
    };
  router.get(
    `${prefix}/tutors`,
    handle(async (req, actor) => {
      const limit = requestInteger(req.query.limit, 'limit', 50);
      if (limit > 100) invalid('Limit must be at most 100', 'limit');
      const search =
        req.query.search === undefined
          ? ''
          : typeof req.query.search === 'string' &&
              req.query.search.length <= 200
            ? req.query.search
            : invalid('Invalid search', 'search');
      return deps.listTutors({
        franchiseId: actor.franchiseId,
        search,
        cursor:
          req.query.cursor === undefined
            ? undefined
            : text(req.query.cursor, 'cursor', 2000),
        limit,
      });
    }),
  );
  router.get(
    `${prefix}/days`,
    handle(async (req, actor) => {
      const filters: DayFilters = {
        franchiseId: actor.franchiseId,
        start: date(req.query.start, 'start'),
        end: date(req.query.end, 'end'),
        tutorId:
          req.query.tutorId === undefined
            ? undefined
            : requestInteger(req.query.tutorId, 'tutorId'),
        status:
          req.query.status === undefined
            ? 'all'
            : (text(req.query.status, 'status', 20) as DayFilters['status']),
        cursor:
          req.query.cursor === undefined
            ? undefined
            : text(req.query.cursor, 'cursor', 2000),
        limit: requestInteger(req.query.limit, 'limit', 50),
      };
      validateDayFilters(filters);
      return deps.listDays(filters);
    }),
  );
  router.get(
    `${prefix}/tutor/:tutorId/day/:workDate`,
    handle((req, actor) =>
      deps.getDetail({
        franchiseId: actor.franchiseId,
        tutorId: requestInteger(req.params.tutorId, 'tutorId'),
        workDate: date(req.params.workDate, 'workDate'),
      }),
    ),
  );
  router.get(
    `${prefix}/day/:id/history`,
    handle((req, actor) => {
      const limit = requestInteger(req.query.limit, 'limit', 20);
      if (limit > 100) invalid('Limit must be at most 100', 'limit');
      return deps.getHistory(
        actor.franchiseId,
        requestInteger(req.params.id, 'dayId'),
        req.query.beforeId === undefined
          ? null
          : requestInteger(req.query.beforeId, 'beforeId'),
        limit,
      );
    }),
  );
  router.get(
    `${prefix}/operations/:operationId`,
    handle(async (req, actor) => {
      assertOperationId(req.params.operationId);
      const result = await deps.getOperation(actor, req.params.operationId);
      if (!result)
        throw new AdminTimeEntryError('NOT_FOUND', 'Operation not found', 404);
      return result;
    }),
  );
  router.post(
    `${prefix}/corrections/preview`,
    handle((req, actor) => {
      const b = body(req, [
        'franchiseId',
        'tutorId',
        'workDate',
        'expectedRevision',
        'sessions',
        'breaks',
        'reason',
      ]);
      positiveId(b.tutorId, 'tutorId');
      if (
        !Array.isArray(b.sessions) ||
        b.sessions.length < 1 ||
        b.sessions.length > 20 ||
        !Array.isArray(b.breaks) ||
        b.breaks.length > 100
      )
        invalid('Provide 1–20 complete sessions and at most 100 breaks');
      for (const s of b.sessions) {
        if (
          !s ||
          typeof s !== 'object' ||
          Object.keys(s).some((k) => !['id', 'startAt', 'endAt'].includes(k))
        )
          invalid('Invalid session fields');
        if (s.id !== null) positiveId(s.id, 'sessionId');
        text(s.startAt, 'startAt', 100);
        text(s.endAt, 'endAt', 100);
      }
      for (const item of b.breaks) {
        if (
          !item ||
          typeof item !== 'object' ||
          Object.keys(item).some(
            (k) =>
              ![
                'id',
                'breakType',
                'payTreatment',
                'status',
                'startTime',
                'endTime',
                'durationMinutes',
                'note',
              ].includes(k),
          )
        )
          invalid('Invalid break fields');
      }
      const input: CorrectionInput = {
        franchiseId: actor.franchiseId,
        tutorId: b.tutorId,
        workDate: date(b.workDate, 'workDate'),
        expectedRevision: text(b.expectedRevision, 'expectedRevision', 100),
        sessions: b.sessions,
        breaks: b.breaks,
        reason: reasonText(b.reason),
      };
      return deps.previewCorrection(actor, input);
    }),
  );
  for (const action of ['void', 'restore'] as const)
    router.post(
      `${prefix}/day/:id/${action}/preview`,
      handle((req, actor) => {
        const b = body(req, ['franchiseId', 'expectedRevision', 'reason']);
        const input = {
          franchiseId: actor.franchiseId,
          dayId: requestInteger(req.params.id, 'dayId'),
          expectedRevision: text(b.expectedRevision, 'expectedRevision', 100),
          reason: reasonText(b.reason),
        };
        return action === 'void'
          ? deps.previewVoid(actor, input)
          : deps.previewRestore(actor, input);
      }),
    );
  router.post(
    `${prefix}/operations`,
    handle((req, actor) => {
      const b = body(req, ['franchiseId', 'operationId', 'previewToken']);
      assertOperationId(b.operationId);
      return deps.commit(actor, {
        operationId: b.operationId,
        previewToken: text(b.previewToken, 'previewToken', 180000),
      });
    }),
  );
  return router;
}
const previewDeps = () => ({
  getDetail: getAdminDetail,
  getById: getAdminDetailById,
  requireActiveTutor,
  getSchedule: async (key: any) =>
    (await fetchLatestScheduleSnapshots([key])).get(
      scheduleCandidateKey(key),
    ) ?? null,
  now: () => new Date(),
  secret: process.env.SESSION_SECRET ?? '',
});
export default createAdminTimeEntryRouter({
  listTutors: listAdminTutors,
  listDays: listAdminDays,
  getDetail: getAdminDetail,
  getHistory: readHistory,
  previewCorrection: (actor, input) =>
    previewCorrection(actor, input, previewDeps()),
  previewVoid: (actor, input) =>
    previewStatusOperation('void', actor, input, previewDeps()),
  previewRestore: (actor, input) =>
    previewStatusOperation('restore', actor, input, previewDeps()),
  commit: (actor, input) =>
    commitAdminOperation(actor, input, {
      pool: getPostgresPool(),
      now: () => new Date(),
      secret: process.env.SESSION_SECRET ?? '',
    }),
  getOperation: (actor, id) => getAdminOperation(actor, id, getPostgresPool()),
});
