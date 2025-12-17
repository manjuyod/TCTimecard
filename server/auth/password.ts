import crypto from 'crypto';

export interface PasswordRecord {
  password?: string | null;
  passwordHash?: string | null;
}

export interface PasswordComparisonResult {
  valid: boolean;
  needsRehash: boolean;
}

const safeEqual = (a: string, b: string): boolean => {
  const aBuffer = Buffer.from(a ?? '', 'utf8');
  const bBuffer = Buffer.from(b ?? '', 'utf8');
  const length = Math.max(aBuffer.length, bBuffer.length, 1);

  const normalizedA = Buffer.alloc(length);
  const normalizedB = Buffer.alloc(length);
  aBuffer.copy(normalizedA);
  bBuffer.copy(normalizedB);

  const matches = crypto.timingSafeEqual(normalizedA, normalizedB);
  return matches && aBuffer.length === bBuffer.length;
};

export const comparePassword = (provided: string, record: PasswordRecord): PasswordComparisonResult => {
  if (record.passwordHash) {
    // Future: verify bcrypt hash and flag rehash as needed once PasswordHash is available.
  }

  if (record.password === undefined || record.password === null) {
    return { valid: false, needsRehash: false };
  }

  const valid = safeEqual(provided, record.password);
  return { valid, needsRehash: valid && !record.passwordHash };
};
