import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { APP_ORIGIN } from '../config/appOrigin';
import { getPostgresPool } from '../db/postgres';
import { getFranchisePayrollSettings } from '../payroll/payPeriodResolution';
import type { NormalizedTimeOffSubmission, TimeOffRecord, TimeOffSubmissionInput } from '../types/timeoff';
import type {
  TimeOffAmendment,
  TimeOffChangeActor,
  TimeOffChangeCommand,
  TimeOffChangeDetail,
  TimeOffChangeOperationAction,
  TimeOffChangeOperationActor,
  TimeOffChangeOutcome,
  TimeOffChangePreview,
  TimeOffChangeReceipt
} from '../types/timeOffChanges';
import { fetchFranchiseContact, FranchiseContact } from './franchiseContact';
import { getFranchiseSettings } from './franchiseSettings';
import { canonicalJsonStringify } from './scheduleSnapshot';
import { buildRecoveryTimeOffEventId, buildTimeOffCalendarEvent } from './googleCalendar';
import {
  applyApprovedTimeOffChange,
  mapApprovedChangeDatabaseError,
  quoteApprovedTimeOffChange,
  retryTimeOffChangeTransaction
} from './pto/timeOffChanges';
import { TimeOffChangeError } from './timeOffChangeErrors';
import { buildTimeOffChangeEmails } from './timeOffChangeEmail';
import {
  findAmendment,
  findExpiredAmendments,
  findTimeOffChangeReplay,
  findTimeOffOverlapCandidates,
  hashTimeOffChangeCommand,
  insertAmendment,
  insertTimeOffChangeDeliveries,
  isTimeOffChangeKeyConflict,
  lockPendingAmendment,
  lockTimeOffChangeRequest,
  persistTimeOffChangeOperation,
  readTimeOffChangeDetail,
  closeAmendment,
  type TimeOffChangeDeliveryInput
} from './timeOffChangeRepository';
import {
  findOverlappingTimeOff,
  getTimeOffChangeActions,
  isAmendmentActionable,
  normalizeTimeOffChangeReason,
  resolveTimeOffOffsets,
  validateApprovedTimeOffChange
} from './timeOffChangePolicy';
import { appendTimeOffAudit } from './timeOffRepository';

export interface TimeOffChangeDeps {
  pool: Pool;
  resolveTimezone: (franchiseId: number) => Promise<string>;
  resolveNoticeRequired: (franchiseId: number) => Promise<boolean>;
  /** Center routing (name, email, Gmail identity); `null` when unavailable. */
  resolveContact: (franchiseId: number) => Promise<FranchiseContact | null>;
  overlapEnabled: () => boolean;
  appOrigin: string;
  /** Best-effort nudge to the delivery worker after a commit. */
  wake?: () => void;
  newId?: () => string;
}

const DEFAULT_EXPIRY_LIMIT = 100;
const VERSION_PATTERN = /^[1-9][0-9]{0,18}$/;
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;
const MAX_BIGINT = 9223372036854775807n;

const OUTCOMES: Record<TimeOffChangeOperationAction, TimeOffChangeOutcome> = {
  propose: 'proposed',
  withdraw: 'withdrawn',
  approve_amendment: 'approved',
  deny_amendment: 'denied',
  admin_edit: 'edited',
  cancel: 'cancelled',
  expire: 'expired'
};
const AUDIT_ACTIONS: Record<TimeOffChangeOperationAction, string> = {
  propose: 'change_proposed',
  withdraw: 'change_withdrawn',
  approve_amendment: 'change_approved',
  deny_amendment: 'change_denied',
  admin_edit: 'approved_edited',
  cancel: 'approved_cancelled',
  expire: 'change_expired'
};

const failure = (code: string, message: string, status: TimeOffChangeError['status'], details?: Record<string, unknown>) =>
  new TimeOffChangeError(code, message, status, details);
const invalidInput = (message: string) => failure('TIME_OFF_INVALID_INPUT', message, 400);
const notFound = () => failure('TIME_OFF_NOT_FOUND', 'Time off request not found', 404);

function defaultDeps(): Omit<TimeOffChangeDeps, 'pool'> & { pool?: Pool } {
  return {
    resolveTimezone: async (franchiseId) => (await getFranchisePayrollSettings(franchiseId)).timezone,
    resolveNoticeRequired: async (franchiseId) => (await getFranchiseSettings(franchiseId)).timeOffNoticeRequired,
    resolveContact: async (franchiseId) => {
      try {
        return await fetchFranchiseContact(franchiseId);
      } catch (error) {
        console.error('[timeoff-changes] franchise contact lookup failed', error instanceof Error ? error.message : String(error));
        return null;
      }
    },
    overlapEnabled: () => ['1', 'true', 'yes', 'y', 'on'].includes(
      String(process.env.ENFORCE_TIMEOFF_OVERLAP ?? '').trim().toLowerCase()
    ),
    appOrigin: APP_ORIGIN
  };
}

export function createTimeOffChangeService(overrides: Partial<TimeOffChangeDeps> = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const pool = () => deps.pool ?? getPostgresPool();
  const newId = deps.newId ?? randomUUID;

  async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function withClient<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool().connect();
    try {
      return await work(client);
    } finally {
      client.release();
    }
  }

  async function execute(command: TimeOffChangeCommand): Promise<TimeOffChangeReceipt> {
    const reasons = validateCommand(command);
    const inputHash = hashTimeOffChangeCommand(command);
    const franchiseId = command.actor.franchiseId;
    const [timezone, noticeRequired, contact] = await Promise.all([
      deps.resolveTimezone(franchiseId),
      deps.resolveNoticeRequired(franchiseId),
      deps.resolveContact(franchiseId)
    ]);
    const context: CommandContext = { command, reasons, inputHash, timezone, noticeRequired, contact };
    let receipt: TimeOffChangeReceipt;
    try {
      receipt = await retryTimeOffChangeTransaction(() => withTransaction((client) => runCommand(client, context)));
    } catch (error) {
      if (isTimeOffChangeKeyConflict(error)) return recoverReplay(command, inputHash, timezone);
      throw mapError(error);
    }
    deps.wake?.();
    return receipt;
  }

  async function recoverReplay(command: TimeOffChangeCommand, inputHash: string, timezone: string): Promise<TimeOffChangeReceipt> {
    return withClient(async (client) => {
      const detail = await readTimeOffChangeDetail(client, command.requestId, timezone);
      if (!detail || !visible(command.actor, detail.request)) throw notFound();
      const replay = await findTimeOffChangeReplay(client, command.actor, command.idempotencyKey, inputHash);
      if (!replay) throw failure('TIME_OFF_IDEMPOTENCY_MISMATCH', 'This idempotency key is already in use', 409);
      return replay;
    });
  }

  async function runCommand(client: PoolClient, context: CommandContext): Promise<TimeOffChangeReceipt> {
    const { command, timezone } = context;
    const { actor, nowIso } = command;
    const locked = await lockTimeOffChangeRequest(client, command.requestId, timezone);
    if (!locked || !visible(actor, locked.request)) throw notFound();
    const replay = await findTimeOffChangeReplay(client, actor, command.idempotencyKey, context.inputHash);
    if (replay) return replay;

    if (command.expectedVersion !== locked.version) {
      throw failure('TIME_OFF_VERSION_CONFLICT', 'This time off changed; refresh and review it again', 409);
    }
    const request = locked.request;
    if (request.status !== 'approved') {
      throw failure('TIME_OFF_INVALID_STATE', 'Only approved time off can be changed or cancelled here', 409);
    }
    if (Date.parse(request.startAt) <= Date.parse(nowIso)) {
      throw failure('TIME_OFF_START_DEADLINE', 'This time off has already started and is view-only', 409);
    }

    let version = locked.version;
    let pending = await lockPendingAmendment(client, request.id);
    if ('amendmentId' in command) {
      if (!pending || pending.id !== command.amendmentId) {
        const target = await findAmendment(client, request.id, command.amendmentId);
        if (!target) throw failure('TIME_OFF_AMENDMENT_NOT_FOUND', 'Change request not found', 404);
        throw failure('TIME_OFF_AMENDMENT_CLOSED', 'This change request is no longer pending', 409);
      }
      if (!isAmendmentActionable(request, pending, nowIso)) {
        throw failure('TIME_OFF_AMENDMENT_EXPIRED', 'This change request expired before it was reviewed', 409);
      }
      if (pending.baseVersion !== version) {
        throw failure('TIME_OFF_VERSION_CONFLICT', 'This change request no longer matches the request', 409);
      }
    } else if (pending && !isAmendmentActionable(request, pending, nowIso)) {
      // Reads already report this proposal expired; persist that before acting.
      version = await expireLocked(client, { request, version, calendarId: locked.calendarId, amendment: pending, nowIso,
        contact: context.contact });
      pending = null;
    }

    assertActionAllowed(actor, request, pending, command.action, nowIso);
    const base: OperationBase = {
      client, actor, idempotencyKey: command.idempotencyKey, inputHash: context.inputHash, nowIso,
      changeReason: context.reasons.changeReason ?? null, contact: context.contact, request, version,
      calendarId: locked.calendarId
    };
    switch (command.action) {
      case 'propose': {
        const value = await validatedChange(client, { request, proposed: command.proposed, actor, context });
        const amendment = await insertAmendment(client, {
          requestId: request.id,
          baseVersion: nextVersion(version),
          proposed: value,
          timezone,
          changeReason: context.reasons.changeReason as string,
          proposedBy: actor.accountId
        });
        return finishOperation({ ...base, action: 'propose', amendment, after: request });
      }
      case 'withdraw': {
        const amendment = await closeAmendment(client, {
          id: (pending as TimeOffAmendment).id, status: 'withdrawn', decidedByType: 'TUTOR', decidedBy: actor.accountId,
          decisionReason: null
        });
        return finishOperation({ ...base, action: 'withdraw', amendment, after: request });
      }
      case 'deny_amendment': {
        const amendment = await closeAmendment(client, {
          id: (pending as TimeOffAmendment).id, status: 'denied', decidedByType: 'ADMIN', decidedBy: actor.accountId,
          decisionReason: context.reasons.denialReason as string
        });
        return finishOperation({ ...base, action: 'deny_amendment', amendment, after: request,
          decisionReason: context.reasons.denialReason });
      }
      case 'approve_amendment': {
        const proposal = pending as TimeOffAmendment;
        if (proposal.timezone !== timezone) {
          throw failure('TIME_OFF_TIMEZONE_CHANGED',
            'The center time zone changed after this proposal; ask the tutor to submit it again', 409);
        }
        const validation = validateApprovedTimeOffChange({
          request,
          proposed: amendmentInput(proposal),
          actor: { kind: 'TUTOR', accountId: proposal.proposedBy, franchiseId: actor.franchiseId },
          timezone: proposal.timezone,
          noticeRequired: context.noticeRequired,
          nowIso,
          submittedAt: proposal.createdAt
        });
        if (!validation.valid) {
          throw failure('TIME_OFF_CHANGE_NO_LONGER_VALID', validation.errors[0], 409, { errors: validation.errors });
        }
        await assertNoOverlap(client, request, validation.value);
        const amendment = await closeAmendment(client, {
          id: proposal.id, status: 'approved', decidedByType: 'ADMIN', decidedBy: actor.accountId, decisionReason: null
        });
        return finishOperation({ ...base, action: 'approve_amendment', amendment, target: validation.value,
          after: withTarget(request, validation.value) });
      }
      case 'admin_edit': {
        const value = await validatedChange(client, { request, proposed: command.proposed, actor, context });
        const superseded = pending ? await closeAmendment(client, {
          id: pending.id, status: 'superseded', decidedByType: 'ADMIN', decidedBy: actor.accountId,
          decisionReason: 'Replaced by an administrator edit'
        }) : null;
        return finishOperation({ ...base, action: 'admin_edit', amendment: null, superseded, target: value,
          after: withTarget(request, value) });
      }
      case 'cancel': {
        const superseded = pending ? await closeAmendment(client, {
          id: pending.id, status: 'superseded', decidedByType: actor.kind, decidedBy: actor.accountId,
          decisionReason: 'Closed by cancellation'
        }) : null;
        return finishOperation({ ...base, action: 'cancel', amendment: null, superseded,
          after: { ...request, status: 'cancelled' } });
      }
    }
  }

  async function validatedChange(client: PoolClient, input: {
    request: TimeOffRecord;
    proposed: TimeOffSubmissionInput;
    actor: TimeOffChangeActor;
    context: CommandContext;
  }): Promise<NormalizedTimeOffSubmission> {
    const validation = validateApprovedTimeOffChange({
      request: input.request,
      proposed: input.proposed,
      actor: input.actor,
      timezone: input.context.timezone,
      noticeRequired: input.context.noticeRequired,
      nowIso: input.context.command.nowIso
    });
    if (!validation.valid) {
      throw failure('TIME_OFF_INVALID_CHANGE', validation.errors[0], 400, { errors: validation.errors });
    }
    await assertNoOverlap(client, input.request, validation.value);
    return validation.value;
  }

  async function assertNoOverlap(client: PoolClient, request: TimeOffRecord, value: NormalizedTimeOffSubmission) {
    if (!deps.overlapEnabled() || request.tutorId === null) return;
    const candidates = await findTimeOffOverlapCandidates(client, {
      tutorId: request.tutorId, requestId: request.id, startAt: value.startAt, endAt: value.endAt
    });
    if (findOverlappingTimeOff(request.id, value, candidates).length > 0) {
      throw failure('TIME_OFF_OVERLAP', 'This change overlaps other pending or approved time off', 409);
    }
  }

  async function expireLocked(client: PoolClient, input: {
    request: TimeOffRecord;
    version: string;
    calendarId: string | null;
    amendment: TimeOffAmendment;
    nowIso: string;
    contact: FranchiseContact | null;
  }): Promise<string> {
    const amendment = await closeAmendment(client, {
      id: input.amendment.id, status: 'expired', decidedByType: 'SYSTEM', decidedBy: 0,
      decisionReason: 'Expired before review'
    });
    const receipt = await finishOperation({
      client,
      actor: { kind: 'SYSTEM', accountId: 0, franchiseId: input.request.franchiseId },
      idempotencyKey: `expire:${amendment.id}`,
      inputHash: createHash('sha256')
        .update(canonicalJsonStringify({ action: 'expire', requestId: input.request.id, amendmentId: amendment.id,
          expectedVersion: input.version }))
        .digest('hex'),
      nowIso: input.nowIso,
      changeReason: null,
      contact: input.contact,
      request: input.request,
      version: input.version,
      calendarId: input.calendarId,
      action: 'expire',
      amendment,
      after: input.request
    });
    return receipt.version;
  }

  async function finishOperation(input: OperationBase & {
    action: TimeOffChangeOperationAction;
    amendment: TimeOffAmendment | null;
    superseded?: TimeOffAmendment | null;
    target?: NormalizedTimeOffSubmission;
    after: TimeOffRecord;
    decisionReason?: string;
  }): Promise<TimeOffChangeReceipt> {
    const { client, actor, request, changeReason } = input;
    const operationId = newId();
    const resultVersion = nextVersion(input.version);
    const superseded = input.superseded ?? null;
    const deliveries = planTimeOffChangeDeliveries({
      operationId,
      action: input.action,
      actor,
      at: input.nowIso,
      targetVersion: resultVersion,
      before: request,
      after: input.after,
      amendment: input.amendment,
      supersededAmendment: superseded,
      changeReason,
      decisionReason: input.decisionReason ?? null,
      calendarId: input.calendarId,
      center: input.contact,
      appOrigin: deps.appOrigin
    }, newId);
    const receipt: TimeOffChangeReceipt = {
      operationId,
      requestId: request.id,
      version: resultVersion,
      amendmentId: input.amendment?.id ?? superseded?.id ?? null,
      outcome: OUTCOMES[input.action],
      deliveryIds: deliveries.map((delivery) => delivery.id)
    };
    await persistTimeOffChangeOperation(client, {
      id: operationId,
      requestId: request.id,
      actorType: actor.kind,
      actorId: actor.accountId,
      franchiseId: request.franchiseId,
      action: input.action,
      amendmentId: receipt.amendmentId,
      expectedVersion: input.version,
      resultVersion,
      idempotencyKey: input.idempotencyKey,
      inputHash: input.inputHash,
      before: snapshot(request, input.version, input.action === 'propose' ? null : input.amendment ?? superseded, 'before'),
      after: snapshot(input.after, resultVersion, input.amendment ?? superseded, 'after'),
      target: input.target ?? null,
      changeReason,
      response: receipt
    });
    const applied = await applyApprovedTimeOffChange(client, operationId);
    if (applied !== resultVersion) {
      throw failure('TIME_OFF_VERSION_CONFLICT', 'This time off changed; refresh and review it again', 409);
    }
    await appendTimeOffAudit({
      requestId: request.id,
      action: AUDIT_ACTIONS[input.action],
      actorAccountType: actor.kind,
      actorAccountId: actor.kind === 'SYSTEM' ? null : actor.accountId,
      previousStatus: request.status,
      newStatus: input.after.status,
      metadata: {
        operationId,
        franchiseId: request.franchiseId,
        amendmentId: input.amendment?.id ?? null,
        supersededAmendmentId: superseded?.id ?? null,
        version: resultVersion,
        changeReason,
        decisionReason: input.decisionReason ?? null,
        before: effectiveFields(request),
        after: effectiveFields(input.after)
      }
    }, client);
    await insertTimeOffChangeDeliveries(client, operationId, request.id, deliveries);
    return receipt;
  }

  async function preview(input: {
    actor: TimeOffChangeActor;
    requestId: number;
    proposed: TimeOffSubmissionInput;
    nowIso: string;
  }): Promise<TimeOffChangePreview> {
    validateActor(input.actor);
    if (!Number.isSafeInteger(input.requestId) || input.requestId <= 0) throw invalidInput('Invalid request id');
    const [timezone, noticeRequired] = await Promise.all([
      deps.resolveTimezone(input.actor.franchiseId),
      deps.resolveNoticeRequired(input.actor.franchiseId)
    ]);
    try {
      return await withClient(async (client) => {
        const detail = await readTimeOffChangeDetail(client, input.requestId, timezone);
        if (!detail || !visible(input.actor, detail.request)) throw notFound();
        const action = input.actor.kind === 'TUTOR' ? 'propose' : 'admin_edit';
        assertActionAllowed(input.actor, detail.request, detail.pendingAmendment, action, input.nowIso);
        const validation = validateApprovedTimeOffChange({
          request: detail.request, proposed: input.proposed, actor: input.actor, timezone, noticeRequired, nowIso: input.nowIso
        });
        if (!validation.valid) {
          throw failure('TIME_OFF_INVALID_CHANGE', validation.errors[0], 400, { errors: validation.errors });
        }
        const quote = await quoteApprovedTimeOffChange(client, input.requestId, validation.value);
        const pto = quote.tracked && quote.cycles.length === 0 && quote.warnings.length === 0 ? null : quote;
        const warnings = [...(pto?.warnings ?? [])];
        if (deps.overlapEnabled() && detail.request.tutorId !== null) {
          const candidates = await findTimeOffOverlapCandidates(client, {
            tutorId: detail.request.tutorId, requestId: detail.request.id,
            startAt: validation.value.startAt, endAt: validation.value.endAt
          });
          if (findOverlappingTimeOff(detail.request.id, validation.value, candidates).length > 0) {
            warnings.push('This change overlaps other pending or approved time off.');
          }
        }
        return {
          version: detail.version,
          normalized: validation.value,
          resolvedOffsets: resolveTimeOffOffsets(validation.value, timezone),
          pto,
          warnings
        };
      });
    } catch (error) {
      throw mapError(error);
    }
  }

  async function detail(actor: TimeOffChangeActor, requestId: number, nowIso: string): Promise<TimeOffChangeDetail> {
    validateActor(actor);
    if (!Number.isSafeInteger(requestId) || requestId <= 0) throw invalidInput('Invalid request id');
    const timezone = await deps.resolveTimezone(actor.franchiseId);
    return withClient(async (client) => {
      const read = await readTimeOffChangeDetail(client, requestId, timezone);
      if (!read || !visible(actor, read.request)) throw notFound();
      const pending = read.pendingAmendment;
      const expired = pending !== null && !isAmendmentActionable(read.request, pending, nowIso);
      return {
        ...read,
        pendingAmendment: pending && expired ? { ...pending, status: 'expired' } : pending,
        allowedActions: getTimeOffChangeActions({ actor, request: read.request, amendment: pending, nowIso })
      };
    });
  }

  async function expire(nowIso: string, limit = DEFAULT_EXPIRY_LIMIT): Promise<number> {
    const candidates = await findExpiredAmendments(pool(), nowIso, limit);
    const contacts = new Map<number, Promise<FranchiseContact | null>>();
    const timezones = new Map<number, Promise<string>>();
    let expired = 0;
    for (const candidate of candidates) {
      try {
        if (!contacts.has(candidate.franchiseId)) contacts.set(candidate.franchiseId, deps.resolveContact(candidate.franchiseId));
        if (!timezones.has(candidate.franchiseId)) timezones.set(candidate.franchiseId, deps.resolveTimezone(candidate.franchiseId));
        const [contact, timezone] = await Promise.all([contacts.get(candidate.franchiseId), timezones.get(candidate.franchiseId)]);
        const done = await retryTimeOffChangeTransaction(() => withTransaction(async (client) => {
          const locked = await lockTimeOffChangeRequest(client, candidate.requestId, timezone as string);
          if (!locked) return false;
          const pending = await lockPendingAmendment(client, candidate.requestId);
          if (!pending || pending.id !== candidate.amendmentId || isAmendmentActionable(locked.request, pending, nowIso)) {
            return false;
          }
          await expireLocked(client, { request: locked.request, version: locked.version, calendarId: locked.calendarId,
            amendment: pending, nowIso, contact: contact ?? null });
          return true;
        }));
        if (done) expired += 1;
      } catch (error) {
        console.error('[timeoff-changes] amendment expiry failed', candidate.amendmentId,
          error instanceof Error ? error.message : String(error));
      }
    }
    if (expired > 0) deps.wake?.();
    return expired;
  }

  return { execute, preview, detail, expire };
}

export type TimeOffChangeService = ReturnType<typeof createTimeOffChangeService>;

interface OperationBase {
  client: PoolClient;
  actor: TimeOffChangeOperationActor;
  idempotencyKey: string;
  inputHash: string;
  nowIso: string;
  changeReason: string | null;
  contact: FranchiseContact | null;
  request: TimeOffRecord;
  version: string;
  calendarId: string | null;
}

interface CommandContext {
  command: TimeOffChangeCommand;
  reasons: { changeReason?: string; denialReason?: string };
  inputHash: string;
  timezone: string;
  noticeRequired: boolean;
  contact: FranchiseContact | null;
}

function visible(actor: TimeOffChangeOperationActor, request: TimeOffRecord): boolean {
  if (request.franchiseId !== actor.franchiseId) return false;
  return actor.kind !== 'TUTOR' || (request.tutorId !== null && request.tutorId === actor.accountId);
}

function assertActionAllowed(
  actor: TimeOffChangeActor,
  request: TimeOffRecord,
  pending: TimeOffAmendment | null,
  action: TimeOffChangeCommand['action'],
  nowIso: string
): void {
  if (getTimeOffChangeActions({ actor, request, amendment: pending, nowIso }).includes(action)) return;
  const adminOnly = action === 'approve_amendment' || action === 'deny_amendment' || action === 'admin_edit';
  if (actor.kind === 'ADMIN' && adminOnly && request.tutorId !== null && request.tutorId === actor.accountId) {
    throw failure('TIME_OFF_SELF_APPROVAL', 'You cannot approve or directly edit your own time off', 403);
  }
  if ((actor.kind === 'TUTOR') === adminOnly || (actor.kind === 'ADMIN' && (action === 'propose' || action === 'withdraw'))) {
    throw failure('TIME_OFF_FORBIDDEN', 'This action is not available to you', 403);
  }
  if (request.status !== 'approved') {
    throw failure('TIME_OFF_INVALID_STATE', 'Only approved time off can be changed or cancelled here', 409);
  }
  if (Date.parse(request.startAt) <= Date.parse(nowIso)) {
    throw failure('TIME_OFF_START_DEADLINE', 'This time off has already started and is view-only', 409);
  }
  if (action === 'propose' && pending) {
    throw failure('TIME_OFF_AMENDMENT_PENDING', 'Withdraw the pending change before proposing another', 409);
  }
  throw failure('TIME_OFF_AMENDMENT_CLOSED', 'There is no pending change request to act on', 409);
}

function validateActor(actor: TimeOffChangeActor): void {
  if (!actor || (actor.kind !== 'TUTOR' && actor.kind !== 'ADMIN')
    || !Number.isSafeInteger(actor.accountId) || actor.accountId <= 0
    || !Number.isSafeInteger(actor.franchiseId) || actor.franchiseId <= 0) {
    throw invalidInput('Invalid actor');
  }
}

function validateCommand(command: TimeOffChangeCommand): CommandContext['reasons'] {
  validateActor(command.actor);
  if (!Number.isSafeInteger(command.requestId) || command.requestId <= 0) throw invalidInput('Invalid request id');
  if (typeof command.expectedVersion !== 'string' || !VERSION_PATTERN.test(command.expectedVersion)
    || BigInt(command.expectedVersion) > MAX_BIGINT) {
    throw invalidInput('expectedVersion must be a positive decimal string');
  }
  if (typeof command.idempotencyKey !== 'string' || !KEY_PATTERN.test(command.idempotencyKey)) {
    throw invalidInput('idempotencyKey must be 8–200 letters, digits, or . _ : -');
  }
  if (Number.isNaN(Date.parse(command.nowIso))) throw invalidInput('Invalid current time');
  const reasons: CommandContext['reasons'] = {};
  switch (command.action) {
    case 'propose':
    case 'admin_edit':
      if (!command.proposed || typeof command.proposed !== 'object') throw invalidInput('proposed is required');
      reasons.changeReason = reasonOrThrow(command.changeReason, 'change');
      break;
    case 'cancel':
      reasons.changeReason = reasonOrThrow(command.changeReason, 'change');
      break;
    case 'deny_amendment':
      reasons.denialReason = reasonOrThrow(command.reason, 'denial');
      amendmentIdOrThrow(command.amendmentId);
      break;
    case 'withdraw':
    case 'approve_amendment':
      amendmentIdOrThrow(command.amendmentId);
      break;
    default:
      throw invalidInput('Unsupported action');
  }
  return reasons;
}

function reasonOrThrow(value: unknown, kind: 'change' | 'denial'): string {
  const result = normalizeTimeOffChangeReason(value, kind);
  if (!result.valid) throw invalidInput(result.error);
  return result.value;
}

function amendmentIdOrThrow(value: unknown): void {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) throw invalidInput('Invalid amendment id');
}

function mapError(error: unknown): unknown {
  if (error instanceof TimeOffChangeError) return error;
  const candidate = error as { code?: string; constraint?: string } | null;
  if (candidate?.code === '23505' && candidate.constraint === 'time_off_amendments_one_pending_idx') {
    return failure('TIME_OFF_AMENDMENT_PENDING', 'Withdraw the pending change before proposing another', 409);
  }
  return mapApprovedChangeDatabaseError(error) ?? error;
}

function nextVersion(version: string): string {
  return (BigInt(version) + 1n).toString();
}

function amendmentInput(amendment: TimeOffAmendment): TimeOffSubmissionInput {
  const value = amendment.proposed;
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

function withTarget(request: TimeOffRecord, value: NormalizedTimeOffSubmission): TimeOffRecord {
  return {
    ...request,
    startAt: value.startAt,
    endAt: value.endAt,
    startDate: value.startDate,
    endDate: value.endDate,
    partialDay: value.partialDay,
    leaveTime: value.leaveTime,
    returnTime: value.returnTime,
    type: value.type,
    absenceLabel: value.absenceLabel,
    reason: value.reason,
    notes: value.reason,
    durationHours: value.durationHours
  };
}

function effectiveFields(request: TimeOffRecord) {
  return {
    status: request.status,
    startAt: request.startAt,
    endAt: request.endAt,
    startDate: request.startDate,
    endDate: request.endDate,
    partialDay: request.partialDay,
    leaveTime: request.leaveTime,
    returnTime: request.returnTime,
    type: request.type,
    absenceLabel: request.absenceLabel,
    reason: request.reason,
    durationHours: request.durationHours
  };
}

function snapshot(
  request: TimeOffRecord,
  version: string,
  amendment: TimeOffAmendment | null,
  phase: 'before' | 'after'
): Record<string, unknown> {
  return {
    version,
    request: effectiveFields(request),
    amendment: amendment
      ? { id: amendment.id, status: phase === 'before' ? 'pending' : amendment.status, proposed: amendment.proposed,
        changeReason: amendment.changeReason }
      : null
  };
}

export interface TimeOffChangeDeliveryPlanInput {
  operationId: string;
  action: TimeOffChangeOperationAction;
  actor: TimeOffChangeOperationActor;
  at: string;
  targetVersion: string;
  before: TimeOffRecord;
  after: TimeOffRecord;
  amendment: TimeOffAmendment | null;
  supersededAmendment: TimeOffAmendment | null;
  changeReason: string | null;
  decisionReason: string | null;
  /** The request's recorded calendar; `null` for legacy approvals (adopted by the worker). */
  calendarId: string | null;
  center: FranchiseContact | null;
  appOrigin: string;
}

/**
 * Plans the calendar and email jobs for an operation. Everything is frozen
 * here; unroutable jobs are recorded as visible failures, never dropped.
 */
export function planTimeOffChangeDeliveries(
  input: TimeOffChangeDeliveryPlanInput,
  newId: () => string
): TimeOffChangeDeliveryInput[] {
  const deliveries: TimeOffChangeDeliveryInput[] = [];
  const calendarAction = input.action === 'cancel'
    ? 'delete'
    : input.action === 'approve_amendment' || input.action === 'admin_edit' ? 'upsert' : null;
  if (calendarAction) {
    const identity = input.center?.gmailId?.trim() || null;
    const { id: _originalId, ...event } = buildTimeOffCalendarEvent({
      id: input.after.id,
      franchiseId: input.after.franchiseId,
      tutorId: input.after.tutorId,
      bridgeProfileId: input.after.bridgeProfileId,
      firstName: input.after.firstName,
      lastName: input.after.lastName,
      email: input.after.tutorEmail,
      startAt: input.after.startAt,
      endAt: input.after.endAt,
      startDate: input.after.startDate,
      endDate: input.after.endDate,
      type: input.after.type,
      absenceLabel: input.after.absenceLabel,
      reason: input.after.reason,
      partialDay: input.after.partialDay
    }, input.after.decisionReason || 'Approved');
    deliveries.push({
      id: newId(),
      channel: 'calendar',
      kind: `calendar_${calendarAction}`,
      targetVersion: input.targetVersion,
      payload: {
        action: calendarAction,
        requestId: input.after.id,
        franchiseId: input.after.franchiseId,
        event: calendarAction === 'upsert' ? event : null,
        knownEventIds: input.before.googleCalendarEventId ? [input.before.googleCalendarEventId] : []
      },
      recipient: null,
      identity,
      calendarId: input.calendarId,
      recoveryEventId: buildRecoveryTimeOffEventId(input.after.id, input.targetVersion),
      dedupeKey: `${input.operationId}:calendar`,
      status: identity ? 'pending' : 'failed',
      lastError: identity ? null : 'Franchise GmailID is not configured for calendar updates.'
    });
  }
  const emails = buildTimeOffChangeEmails({
    operationId: input.operationId,
    action: input.action,
    actorKind: input.actor.kind,
    at: input.at,
    before: input.before,
    after: input.after,
    amendment: input.amendment,
    supersededAmendment: input.supersededAmendment,
    changeReason: input.changeReason,
    decisionReason: input.decisionReason
  }, input.center, input.appOrigin);
  for (const email of emails) {
    const problem = !email.recipient
      ? 'No recipient email is configured for this notification.'
      : !email.impersonationSubject ? 'Franchise GmailID is not configured for notifications.' : null;
    deliveries.push({
      id: newId(),
      channel: 'email',
      kind: email.kind,
      targetVersion: input.targetVersion,
      payload: { subject: email.subject, text: email.text, html: email.html, operationId: email.operationId },
      recipient: email.recipient || null,
      identity: email.impersonationSubject || null,
      calendarId: null,
      recoveryEventId: null,
      dedupeKey: email.dedupeKey,
      status: problem ? 'failed' : 'pending',
      lastError: problem
    });
  }
  return deliveries;
}
