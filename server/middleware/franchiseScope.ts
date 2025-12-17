import { Request } from 'express';
import { AuthSessionData } from '../auth/types';

const SELECTOR_ALLOWED_FRANCHISE_IDS = new Set([1, 2, 3]);

const parseFranchiseId = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
};

const extractRequestedFranchiseId = (
  req: Request
): { value: number | null; raw: unknown; hasValue: boolean } => {
  const raw =
    (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>).franchiseId : undefined) ??
    (req.params as Record<string, unknown>).franchiseId ??
    (req.query as Record<string, unknown>).franchiseId;

  const hasValue =
    raw !== undefined &&
    raw !== null &&
    (typeof raw === 'number' || (typeof raw === 'string' && raw.trim().length > 0));

  return {
    value: parseFranchiseId(raw),
    raw,
    hasValue
  };
};

const formatUserIdentifier = (auth: AuthSessionData | undefined | null): string => {
  if (!auth) return 'unknown';
  const accountId = Number.isFinite(Number(auth.accountId)) ? Number(auth.accountId) : auth.accountId;
  const display = auth.displayName?.trim();
  const base = `${auth.accountType ?? 'UNKNOWN'}#${accountId ?? 'unknown'}`;
  return display ? `${base}(${display})` : base;
};

export interface FranchiseScopeResult {
  franchiseId: number | null;
  selectorAllowed: boolean;
  sessionFranchiseId: number | null;
  providedFranchiseId: number | null;
  error?: { status: number; message: string };
}

export const enforceFranchiseScope = (
  req: Request,
  options?: { requireFranchiseId?: boolean; requiredMessage?: string }
): FranchiseScopeResult => {
  const auth = req.session.auth;
  const sessionFranchiseId = parseFranchiseId(auth?.franchiseId);
  const { value: providedFranchiseId, hasValue } = extractRequestedFranchiseId(req);
  const selectorAllowed =
    auth?.accountType === 'ADMIN' &&
    sessionFranchiseId !== null &&
    SELECTOR_ALLOWED_FRANCHISE_IDS.has(sessionFranchiseId);

  let franchiseId: number | null = null;

  if (selectorAllowed) {
    if (hasValue && providedFranchiseId === null) {
      return {
        franchiseId: null,
        selectorAllowed,
        sessionFranchiseId,
        providedFranchiseId,
        error: { status: 400, message: options?.requiredMessage ?? 'franchiseId is required' }
      };
    }
    franchiseId = providedFranchiseId ?? sessionFranchiseId;
  } else {
    franchiseId = sessionFranchiseId;

    if (
      hasValue &&
      providedFranchiseId !== null &&
      sessionFranchiseId !== null &&
      providedFranchiseId !== sessionFranchiseId
    ) {
      console.warn(
        `FRANCHISE_SCOPE_OVERRIDE path=${req.originalUrl} provided=${providedFranchiseId} enforced=${sessionFranchiseId} user=${formatUserIdentifier(auth)}`
      );
    }
  }

  if ((options?.requireFranchiseId ?? false) && franchiseId === null) {
    return {
      franchiseId: null,
      selectorAllowed,
      sessionFranchiseId,
      providedFranchiseId,
      error: { status: 400, message: options?.requiredMessage ?? 'franchiseId is required' }
    };
  }

  if (franchiseId !== null) {
    if (req.body && typeof req.body === 'object') {
      (req.body as Record<string, unknown>).franchiseId = franchiseId;
    }
    (req.query as Record<string, unknown>).franchiseId = franchiseId;
    (req.params as Record<string, unknown>).franchiseId =
      (req.params as Record<string, unknown>).franchiseId ?? franchiseId;
  }

  return { franchiseId, selectorAllowed, sessionFranchiseId, providedFranchiseId };
};
