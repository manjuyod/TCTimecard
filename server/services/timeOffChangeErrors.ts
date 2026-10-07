export type TimeOffChangeErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500;

/** A domain failure carrying the `{error, code}` HTTP contract from the spec. */
export class TimeOffChangeError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: TimeOffChangeErrorStatus = 400,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'TimeOffChangeError';
  }
}

export const isTimeOffChangeError = (error: unknown): error is TimeOffChangeError =>
  error instanceof TimeOffChangeError;
