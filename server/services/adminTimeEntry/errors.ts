export class AdminTimeEntryError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public fieldErrors?: Record<string, string>,
  ) {
    super(message);
  }
}
export const invalid = (message: string, field?: string): never => {
  throw new AdminTimeEntryError(
    'INVALID_INPUT',
    message,
    400,
    field ? { [field]: message } : undefined,
  );
};
export function positiveId(
  value: unknown,
  field: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    invalid(`${field} must be a positive integer`, field);
}
export function reasonText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length < 5 ||
    value.trim().length > 2000
  )
    invalid('Reason must contain 5–2000 characters', 'reason');
  return (value as string).trim();
}
