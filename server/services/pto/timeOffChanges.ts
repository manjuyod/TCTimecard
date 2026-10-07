import type { PoolClient } from 'pg';
import type { NormalizedTimeOffSubmission } from '../../types/timeoff';
import { TimeOffChangeError } from '../timeOffChangeErrors';
import { mapPtoHttpError } from './errors';

export type TimeOffReplacementQuoteReason =
  | 'eligible'
  | 'insufficient_balance'
  | 'center_disabled'
  | 'identity_unresolved'
  | 'identity_conflict'
  | 'reconciliation_required';

export interface TimeOffReplacementQuote {
  eligible: boolean;
  reason: TimeOffReplacementQuoteReason | string;
  tracked: boolean;
  cycles: Array<{ cycleStart: string; oldDays: number; newDays: number; availableDays: number; availableAfter: number }>;
  warnings: string[];
}

type Queryable = Pick<PoolClient, 'query'>;

/**
 * Quotes replacing (or, with `null`, cancelling) an approved request. The
 * request's own active consumption is credited per entitlement cycle; nothing
 * is reserved or written.
 */
export async function quoteApprovedTimeOffChange(
  client: Queryable,
  requestId: number,
  proposed: NormalizedTimeOffSubmission | null
): Promise<TimeOffReplacementQuote> {
  const result = await client.query<{ quote: Record<string, unknown> }>(
    'SELECT public.pto_preview_approved_change($1, $2::JSONB) AS quote',
    [requestId, proposed]
  );
  const quote = result.rows[0]?.quote ?? {};
  const cycles = Array.isArray(quote.cycles) ? quote.cycles as Array<Record<string, unknown>> : [];
  return {
    eligible: quote.eligible === true,
    reason: String(quote.reason ?? 'eligible'),
    tracked: quote.tracked !== false,
    cycles: cycles.map((cycle) => ({
      cycleStart: String(cycle.cycleStart),
      oldDays: Number(cycle.oldDays),
      newDays: Number(cycle.newDays),
      availableDays: Number(cycle.availableDays),
      availableAfter: Number(cycle.availableAfter)
    })),
    warnings: Array.isArray(quote.warnings) ? quote.warnings.map(String) : []
  };
}

/**
 * Applies a persisted operation to its request through the guarded database
 * transition and returns the request's new version.
 */
export async function applyApprovedTimeOffChange(client: Queryable, operationId: string): Promise<string> {
  try {
    const result = await client.query<{ version: string }>(
      'SELECT public.time_off_apply_approved_change($1::UUID)::TEXT AS version',
      [operationId]
    );
    return String(result.rows[0].version);
  } catch (error) {
    const mapped = mapApprovedChangeDatabaseError(error);
    if (mapped) throw Object.assign(mapped, { cause: error });
    throw error;
  }
}

const OWN_CODES: Array<[RegExp, string, string, 409 | 422]> = [
  [/TIME_OFF_PTO_RECONCILIATION_REQUIRED/, 'TIME_OFF_PTO_RECONCILIATION_REQUIRED',
    'This paid request predates PTO tracking; its dates or type need PTO reconciliation first', 422],
  [/TIME_OFF_PTO_IDENTITY_CONFLICT/, 'TIME_OFF_PTO_IDENTITY_CONFLICT',
    'PTO identity for this request no longer matches its recorded balance', 422],
  [/TIME_OFF_VERSION_CONFLICT/, 'TIME_OFF_VERSION_CONFLICT', 'This request changed; refresh and try again', 409],
  [/TIME_OFF_INVALID_STATE/, 'TIME_OFF_INVALID_STATE', 'This request can no longer be changed', 409],
  [/TIME_OFF_CHANGE_GUARD/, 'TIME_OFF_INVALID_STATE', 'This request can no longer be changed', 409]
];

/** Maps database accounting/guard failures to `{code, status}` domain errors. */
export function mapApprovedChangeDatabaseError(error: unknown): TimeOffChangeError | null {
  const message = error instanceof Error ? error.message : '';
  for (const [pattern, code, text, status] of OWN_CODES) {
    if (pattern.test(message)) return new TimeOffChangeError(code, text, status);
  }
  // Database guards raise bare codes such as PTO_CENTER_DISABLED as the message.
  const raisedCode = /^(PTO_[A-Z_]+)\b/.exec(message)?.[1];
  const pto = mapPtoHttpError(raisedCode ? { code: raisedCode } : error);
  if (pto && pto.code !== 'PTO_INTERNAL_ERROR') return new TimeOffChangeError(pto.code, pto.error, pto.status);
  return null;
}

const RETRYABLE_SQLSTATES = new Set(['40P01', '40001']);
const MAX_TRANSACTION_ATTEMPTS = 3;

/**
 * Runs a whole database-only transaction, retrying deadlocks and
 * serialization failures; three attempts in total. The callback must open and
 * close its own transaction and reuse the same idempotency key on each attempt.
 */
export async function retryTimeOffChangeTransaction<T>(work: (attempt: number) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work(attempt);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      const cause = ((error as { cause?: { code?: string } } | null)?.cause)?.code;
      const retryable = RETRYABLE_SQLSTATES.has(code ?? '') || RETRYABLE_SQLSTATES.has(cause ?? '');
      if (!retryable || attempt >= MAX_TRANSACTION_ATTEMPTS) throw error;
    }
  }
}
