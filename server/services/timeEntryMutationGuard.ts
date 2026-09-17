import type { TimeEntryStatus } from '../types/timeEntry';
import type { ErrorRequestHandler } from 'express';

class VoidedDayMutationError extends Error {
  readonly status = 409;
  readonly code = 'INVALID_ENTRY_STATE';
}

export const timeEntryMutationErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (!(error instanceof VoidedDayMutationError) || res.headersSent) { next(error); return; }
  res.status(error.status).json({ error: error.message, code: error.code });
};

/** Call under the parent day lock before any ordinary time-entry mutation. */
export function assertDayNotVoided(day: { status: TimeEntryStatus } | null): void {
  if (day?.status !== 'voided') return;
  throw new VoidedDayMutationError('This entry was voided by an admin and cannot be changed here.');
}
