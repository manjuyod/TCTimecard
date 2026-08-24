export interface PtoHttpError {
  status: 400 | 403 | 404 | 409 | 422 | 500;
  error: string;
  code: string;
}

const byCode: Record<string, PtoHttpError> = {
  PTO_CENTER_DISABLED: { status: 409, error: 'PTO is disabled for this center', code: 'PTO_CENTER_DISABLED' },
  PTO_IDENTITY_UNRESOLVED: { status: 422, error: 'PTO identity is unresolved', code: 'PTO_IDENTITY_UNRESOLVED' },
  PTO_NO_BALANCE: { status: 409, error: 'No PTO balance is available', code: 'PTO_NO_BALANCE' },
  PTO_INSUFFICIENT_BALANCE: { status: 409, error: 'Insufficient PTO balance', code: 'PTO_INSUFFICIENT_BALANCE' },
  PTO_LINK_STALE: { status: 409, error: 'This PTO account link changed; refresh and try again', code: 'PTO_LINK_STALE' },
  PTO_ACCOUNT_ALREADY_LINKED: { status: 409, error: 'This CRM account belongs to another PTO profile', code: 'PTO_ACCOUNT_ALREADY_LINKED' },
  PTO_CENTER_ACCOUNT_CONFLICT: { status: 409, error: 'This PTO profile already has an account for that center', code: 'PTO_CENTER_ACCOUNT_CONFLICT' },
  PTO_LINK_FORBIDDEN: { status: 403, error: 'Not authorized to manage this PTO account group', code: 'PTO_LINK_FORBIDDEN' },
  PTO_SPLIT_RECONCILIATION_REQUIRED: { status: 409, error: 'Adjustment reconciliation is required before unlinking', code: 'PTO_SPLIT_RECONCILIATION_REQUIRED' },
  PTO_DISCOVERY_STALE: { status: 409, error: 'The discovered CRM account is stale; refresh discovery first', code: 'PTO_DISCOVERY_STALE' }
};

const patterns: Array<[RegExp, PtoHttpError]> = [
  [/PTO_CENTER_DISABLED/i, byCode.PTO_CENTER_DISABLED],
  [/PTO_LINK_STALE/i, byCode.PTO_LINK_STALE],
  [/PTO_ACCOUNT_ALREADY_LINKED/i, byCode.PTO_ACCOUNT_ALREADY_LINKED],
  [/PTO_CENTER_ACCOUNT_CONFLICT/i, byCode.PTO_CENTER_ACCOUNT_CONFLICT],
  [/PTO_LINK_FORBIDDEN/i, byCode.PTO_LINK_FORBIDDEN],
  [/PTO_SPLIT_RECONCILIATION_REQUIRED/i, byCode.PTO_SPLIT_RECONCILIATION_REQUIRED],
  [/PTO_DISCOVERY_STALE/i, byCode.PTO_DISCOVERY_STALE],
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
