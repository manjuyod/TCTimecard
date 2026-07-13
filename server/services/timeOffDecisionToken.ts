import { createHash, randomBytes } from 'node:crypto';

export const DEFAULT_EMAIL_DECISION_REASON = 'Email correspondence';
export const TIME_OFF_DECISION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CreatedTimeOffDecisionToken {
  rawToken: string;
  tokenHash: string;
  expiresAt: string;
}

export function createTimeOffDecisionToken(nowIso = new Date().toISOString()): CreatedTimeOffDecisionToken {
  const rawToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(new Date(nowIso).getTime() + TIME_OFF_DECISION_TOKEN_TTL_MS).toISOString();
  return { rawToken, tokenHash: hashTimeOffDecisionToken(rawToken), expiresAt };
}

export async function issueTimeOffDecisionToken(
  nowIso: string,
  persist: (tokenHash: string, expiresAt: string) => Promise<boolean>
): Promise<CreatedTimeOffDecisionToken | null> {
  const created = createTimeOffDecisionToken(nowIso);
  const stored = await persist(created.tokenHash, created.expiresAt);
  return stored ? created : null;
}

export function hashTimeOffDecisionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export function isAcceptedTimeOffDecisionToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{32,128}$/.test(value);
}

export function isTimeOffDecisionTokenExpired(expiresAt: string, nowIso = new Date().toISOString()): boolean {
  const expiry = new Date(expiresAt).getTime();
  const now = new Date(nowIso).getTime();
  return !Number.isFinite(expiry) || !Number.isFinite(now) || now >= expiry;
}

export function normalizeEmailDecisionReason(reason: string | null | undefined): string {
  return reason?.trim() || DEFAULT_EMAIL_DECISION_REASON;
}
