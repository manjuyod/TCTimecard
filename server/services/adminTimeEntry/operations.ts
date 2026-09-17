import type { Pool } from 'pg';
import type {
  AdminActor,
  AdminOperationResult,
  OperationDeps,
  OperationRequest,
} from './contracts';
import { createHash } from 'node:crypto';
import { canonicalJsonStringify } from '../scheduleSnapshot';
import {
  verifyAdminPreviewIntegrity,
  assertAdminPreviewFresh,
} from './previewToken';
import { AdminTimeEntryError, invalid, positiveId } from './errors';
import { allowedAdminTimeEntryActions, normalizeCorrection } from './policy';
import { revisionForEntry } from './revision';
import { validPreservedEntry } from './preview';
import {
  appendOperationAudit,
  assertRestoreSnapshot,
  createMissingDay,
  findOperation,
  readEntryById,
  writeApprovedDay,
  writeCorrectedChildren,
  writeDayStatus,
} from './repository';
import type { StoredOperation } from './repository';
export function assertOperationId(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    invalid('operationId must be a UUID', 'operationId');
}
function replay(
  stored: StoredOperation | null,
  actor: AdminActor,
  hash: string,
): AdminOperationResult | null {
  if (!stored) return null;
  if (
    stored.actorId !== actor.accountId ||
    stored.franchiseId !== actor.franchiseId ||
    stored.commandHash !== hash
  )
    throw new AdminTimeEntryError(
      'OPERATION_CONFLICT',
      'Operation ID was already used for a different operation',
      409,
    );
  return stored.result;
}
export async function commitAdminOperation(
  actor: AdminActor,
  input: OperationRequest,
  deps: OperationDeps,
): Promise<AdminOperationResult> {
  const command = verifyAdminPreviewIntegrity(input.previewToken, deps.secret);
  positiveId(actor.accountId, 'accountId');
  positiveId(actor.franchiseId, 'franchiseId');
  if (
    command.actor.accountId !== actor.accountId ||
    command.actor.franchiseId !== actor.franchiseId
  )
    throw new AdminTimeEntryError(
      'OPERATION_CONFLICT',
      'Preview belongs to a different admin or center',
      409,
    );
  assertOperationId(input.operationId);
  const hash = createHash('sha256')
    .update(canonicalJsonStringify(command))
    .digest('hex');
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    let previous = replay(
      await findOperation(client, input.operationId),
      actor,
      hash,
    );
    if (previous) {
      await client.query('COMMIT');
      return previous;
    }
    let now = deps.now();
    assertAdminPreviewFresh(command, now);
    let dayId = command.entryId,
      created = false;
    if (dayId === null) {
      if (
        command.action !== 'correct' ||
        command.expectedRevision !== 'missing'
      )
        invalid('Invalid missing-day command');
      dayId = await createMissingDay(client, command);
      if (dayId === null) {
        previous = replay(
          await findOperation(client, input.operationId),
          actor,
          hash,
        );
        if (previous) {
          await client.query('COMMIT');
          return previous;
        }
        throw new AdminTimeEntryError(
          'ENTRY_CHANGED',
          'Another entry was created; reload the entry',
          409,
        );
      }
      created = true;
    }
    const day = await readEntryById(client, actor.franchiseId, dayId, true);
    if (
      !day ||
      day.tutorId !== command.tutorId ||
      day.workDate !== command.workDate ||
      day.timezone !== command.timezone
    )
      throw new AdminTimeEntryError('NOT_FOUND', 'Entry not found', 404);
    previous = replay(
      await findOperation(client, input.operationId),
      actor,
      hash,
    );
    if (previous) {
      await client.query('COMMIT');
      return previous;
    }
    // Waiting for the parent lock can outlast the preview. Replay recovery
    // remains available, but a newly applied command must still be fresh.
    now = deps.now();
    assertAdminPreviewFresh(command, now);
    if (!created && revisionForEntry(day) !== command.expectedRevision)
      throw new AdminTimeEntryError(
        'ENTRY_CHANGED',
        'This entry changed while you were reviewing it',
        409,
      );
    if (
      !allowedAdminTimeEntryActions(created ? null : day, true).includes(
        command.action,
      )
    )
      throw new AdminTimeEntryError(
        'INVALID_ENTRY_STATE',
        'Entry state does not allow this action',
        409,
      );
    if (command.action === 'correct') {
      const correction = normalizeCorrection(
        {
          franchiseId: actor.franchiseId,
          tutorId: command.tutorId,
          workDate: command.workDate,
          expectedRevision: command.expectedRevision,
          ...command.correction!,
        },
        { day: created ? null : day, timezone: day.timezone, now },
      );
      await writeCorrectedChildren(client, day, correction);
      await writeApprovedDay(client, day.id, command);
    } else {
      if (command.action === 'restore') {
        if (!validPreservedEntry(day, now))
          throw new AdminTimeEntryError(
            'INVALID_ENTRY_STATE',
            'Preserved entry is invalid and cannot be restored',
            409,
          );
        await assertRestoreSnapshot(client, day);
      }
      await writeDayStatus(
        client,
        day.id,
        command.action === 'void' ? 'voided' : 'approved',
      );
    }
    const after = await readEntryById(client, actor.franchiseId, day.id, false);
    if (
      !after ||
      after.clockState !== 0 ||
      after.sessions.some((s) => s.endAt === null) ||
      after.breaks.some((b) => b.status === 'active') ||
      (command.action !== 'void' && !validPreservedEntry(after, now))
    )
      throw new AdminTimeEntryError(
        'INVALID_ENTRY_STATE',
        'Final entry is incomplete',
        409,
      );
    const result = await appendOperationAudit(
      client,
      input.operationId,
      hash,
      command,
      created ? null : day,
      after,
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    if (
      (error as { code?: string; constraint?: string }).code === '23505' &&
      (error as { constraint?: string }).constraint ===
        'time_entry_audit_operation_id_uniq'
    ) {
      const previous = replay(
        await findOperation(client, input.operationId),
        actor,
        hash,
      );
      if (previous) return previous;
      throw new AdminTimeEntryError(
        'OPERATION_CONFLICT',
        'Operation ID is already in use',
        409,
      );
    }
    throw error;
  } finally {
    client.release();
  }
}
export async function getAdminOperation(
  actor: AdminActor,
  operationId: string,
  pool: Pool,
): Promise<AdminOperationResult | null> {
  assertOperationId(operationId);
  positiveId(actor.accountId, 'accountId');
  positiveId(actor.franchiseId, 'franchiseId');
  const client = await pool.connect();
  try {
    const stored = await findOperation(client, operationId);
    return stored &&
      stored.actorId === actor.accountId &&
      stored.franchiseId === actor.franchiseId
      ? stored.result
      : null;
  } finally {
    client.release();
  }
}
