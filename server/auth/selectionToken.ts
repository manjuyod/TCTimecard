import crypto from 'crypto';
import { SelectionAccount } from './types';

const issuedTokens = new Map<
  string,
  {
    expiresAt: number;
    used: boolean;
    accounts: SelectionAccount[];
  }
>();

const SELECTION_TOKEN_TTL_MS = 5 * 60 * 1000;

const sign = (payload: string, secret: string): string => {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
};

const pruneExpired = (now: number) => {
  for (const [tokenId, record] of issuedTokens) {
    if (record.expiresAt <= now || record.used) {
      issuedTokens.delete(tokenId);
    }
  }
};

export interface SelectionTokenPayload {
  tokenId: string;
  expiresAt: number;
  accounts: SelectionAccount[];
}

export const createSelectionToken = (
  accounts: SelectionAccount[],
  secret: string
): { token: string; expiresAt: number } => {
  const now = Date.now();
  pruneExpired(now);

  const tokenId = crypto.randomUUID();
  const expiresAt = now + SELECTION_TOKEN_TTL_MS;
  const payload: SelectionTokenPayload = { tokenId, expiresAt, accounts };
  const payloadBase64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = sign(payloadBase64, secret);
  const token = `${payloadBase64}.${signature}`;

  issuedTokens.set(tokenId, { expiresAt, used: false, accounts });

  return { token, expiresAt };
};

export const consumeSelectionToken = (token: string, secret: string): SelectionTokenPayload | null => {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadBase64, signature] = parts;
  if (!payloadBase64 || !signature) {
    return null;
  }

  const expectedSignature = sign(payloadBase64, secret);
  const providedSig = Buffer.from(signature);
  const expectedSigBuffer = Buffer.from(expectedSignature);
  if (providedSig.length !== expectedSigBuffer.length || !crypto.timingSafeEqual(providedSig, expectedSigBuffer)) {
    return null;
  }

  let payload: SelectionTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadBase64, 'base64url').toString('utf8')) as SelectionTokenPayload;
  } catch {
    return null;
  }

  const now = Date.now();
  pruneExpired(now);

  const record = issuedTokens.get(payload.tokenId);
  if (!record || record.used || record.expiresAt <= now) {
    return null;
  }

  issuedTokens.delete(payload.tokenId);
  return payload;
};
