export interface PtoHttpError {
  status: 400 | 403 | 404 | 409 | 422 | 500;
  error: string;
  code: string;
}

const byCode: Record<string, PtoHttpError> = {
  PTO_CENTER_DISABLED: { status: 409, error: 'PTO is disabled for this center', code: 'PTO_CENTER_DISABLED' },
  PTO_IDENTITY_UNRESOLVED: { status: 422, error: 'PTO identity is unresolved', code: 'PTO_IDENTITY_UNRESOLVED' },
  PTO_NO_BALANCE: { status: 409, error: 'No PTO balance is available', code: 'PTO_NO_BALANCE' },
  PTO_INSUFFICIENT_BALANCE: { status: 409, error: 'Insufficient PTO balance', code: 'PTO_INSUFFICIENT_BALANCE' }
};

const patterns: Array<[RegExp, PtoHttpError]> = [
  [/PTO_CENTER_DISABLED/i, byCode.PTO_CENTER_DISABLED],
  [/Insufficient shared PTO balance|PTO insufficient balance/i, byCode.PTO_INSUFFICIENT_BALANCE],
  [/Actor center is not authorized for PTO/i,
    { status: 403, error: 'Not authorized for this PTO profile', code: 'PTO_FORBIDDEN' }],
  [/PTO (?:alias candidate|membership|profile|request) .*does not exist/i,
    { status: 404, error: 'PTO record was not found', code: 'PTO_NOT_FOUND' }],
  [/Only an existing manual PTO email can be removed/i,
    { status: 404, error: 'PTO email was not found', code: 'PTO_EMAIL_NOT_FOUND' }],
  [/PTO email would be ambiguous/i,
    { status: 409, error: 'PTO email conflicts with another profile', code: 'PTO_EMAIL_AMBIGUOUS' }],
  [/PTO alias candidate .* is already|PTO membership does not belong to profile|PTO identities belong to different profiles|PTO roster membership belongs to a different canonical profile/i,
    { status: 409, error: 'PTO identity state conflicts with this request', code: 'PTO_IDENTITY_CONFLICT' }],
  [/PTO email provenance membership is not active on this profile/i,
    { status: 422, error: 'PTO email provenance is invalid', code: 'PTO_EMAIL_PROVENANCE_INVALID' }],
  [/Public PTO identity|Authenticated PTO identity|Authenticated PTO profile|active CRM membership/i,
    byCode.PTO_IDENTITY_UNRESOLVED],
  [/CRM roster contained a tutor from another franchise/i,
    { status: 422, error: 'PTO roster data is invalid', code: 'PTO_ROSTER_INVALID' }],
  [/No current PTO policy|No PTO policy applies/i,
    { status: 409, error: 'PTO policy is unavailable', code: 'PTO_POLICY_UNAVAILABLE' }]
];

export function mapPtoHttpError(error: unknown, assumePto = false): PtoHttpError | null {
  const code = typeof (error as { code?: unknown })?.code === 'string'
    ? String((error as { code: string }).code)
    : '';
  if (byCode[code]) return byCode[code];
  if (assumePto && error instanceof RangeError) {
    return { status: 400, error: error.message, code: 'PTO_INVALID_REQUEST' };
  }
  const message = error instanceof Error ? error.message : '';
  for (const [pattern, mapped] of patterns) {
    if (pattern.test(message)) return mapped;
  }
  return assumePto || /\bPTO\b/i.test(message)
    ? { status: 500, error: 'PTO operation failed', code: 'PTO_INTERNAL_ERROR' }
    : null;
}
