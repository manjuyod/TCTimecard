import type { Request } from 'express';
import { AuthSessionData } from './types';

const MAX_INACTIVITY_MS = 15 * 60 * 1000;

const parseTimestamp = (value?: string | null): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const isSessionExpired = (auth: AuthSessionData, now = Date.now()): boolean => {
  const lastSeen = parseTimestamp(auth.lastSeenAt) ?? parseTimestamp(auth.createdAt) ?? 0;
  if (!lastSeen) return true;
  return now - lastSeen > MAX_INACTIVITY_MS;
};

export const refreshSessionActivity = async (req: Request): Promise<void> => {
  if (!req.session || !req.session.auth) return;
  req.session.auth.lastSeenAt = new Date().toISOString();

  await new Promise<void>((resolve, reject) => {
    req.session.save((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
};

export const destroySession = async (req: Request): Promise<void> => {
  if (!req.session) return;
  await new Promise<void>((resolve, reject) => {
    req.session.destroy((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
};

export const createAuthSession = async (
  req: Request,
  account: Omit<AuthSessionData, 'createdAt' | 'lastSeenAt'>
): Promise<AuthSessionData> => {
  const now = new Date().toISOString();

  await new Promise<void>((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) {
        reject(err);
        return;
      }

      req.session.auth = {
        ...account,
        createdAt: now,
        lastSeenAt: now
      };

      req.session.save((saveErr) => {
        if (saveErr) reject(saveErr);
        else resolve();
      });
    });
  });

  return req.session.auth!;
};

export { MAX_INACTIVITY_MS };
