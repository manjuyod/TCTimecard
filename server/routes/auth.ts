import express, { NextFunction, Request, Response } from 'express';
import { findMatchingAccounts } from '../auth/accounts';
import { LoginRateLimiter } from '../auth/rateLimiter';
import { createSelectionToken, consumeSelectionToken } from '../auth/selectionToken';
import { createAuthSession, destroySession } from '../auth/session';
import { SelectionAccount } from '../auth/types';
import { requireAuth } from '../middleware/auth';
import { SESSION_COOKIE_NAME, SESSION_SECRET } from '../config/session';
import { getPostgresPool } from '../db/postgres';

const router = express.Router();

const DEFAULT_LIMIT = 5;
const DEFAULT_COOLDOWN_MINUTES = 10;

const limiter = new LoginRateLimiter(DEFAULT_LIMIT, DEFAULT_COOLDOWN_MINUTES);

const invalidCredentials = (res: Response) => res.status(401).json({ error: 'Invalid credentials' });
const lockedOut = invalidCredentials;
const selectionExpired = (res: Response) => res.status(401).json({ error: 'Selection expired. Please log in again.' });

const normalizeIdentifier = (identifier: string): string => identifier.trim();
const isValidFranchiseId = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const ensureFranchisePayrollSettings = async (franchiseId: number | null | undefined): Promise<void> => {
  if (!isValidFranchiseId(franchiseId)) return;

  const pool = getPostgresPool();
  const existing = await pool.query('SELECT 1 FROM public.franchise_payroll_settings WHERE franchiseid = $1 LIMIT 1', [
    franchiseId
  ]);
  if (existing.rowCount) return;

  await pool.query(
    `
      INSERT INTO public.franchise_payroll_settings (franchiseid)
      VALUES ($1)
      ON CONFLICT (franchiseid) DO NOTHING
    `,
    [franchiseId]
  );
};

router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  const identifier = typeof req.body?.identifier === 'string' ? normalizeIdentifier(req.body.identifier) : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const ip = req.ip || 'unknown';

  if (!identifier || !password) {
    limiter.recordFailure(identifier || 'unknown', ip);
    invalidCredentials(res);
    return;
  }

  if (limiter.isIpBlocked(ip) || limiter.isIdentifierBlocked(identifier)) {
    lockedOut(res);
    return;
  }

  try {
    const matches = await findMatchingAccounts(identifier, password);

    if (!matches.length) {
      limiter.recordFailure(identifier, ip);
      invalidCredentials(res);
      return;
    }

    limiter.reset(identifier, ip);

    if (matches.length === 1) {
      const account = matches[0];
      if (account.accountType === 'ADMIN') {
        await ensureFranchisePayrollSettings(account.franchiseId);
      }
      const session = await createAuthSession(req, {
        accountType: account.accountType,
        accountId: account.accountId,
        franchiseId: account.franchiseId,
        displayName: account.displayName
      });

      res.status(200).json({
        requiresSelection: false,
        session
      });
      return;
    }

    const accounts: SelectionAccount[] = matches.map((match) => ({
      accountType: match.accountType,
      accountId: match.accountId,
      franchiseId: match.franchiseId,
      label: match.displayName ?? `${match.accountType} #${match.accountId}`
    }));

    const { token } = createSelectionToken(accounts, SESSION_SECRET);

    res.status(200).json({
      requiresSelection: true,
      selectionToken: token,
      accounts
    });
  } catch (err) {
    next(err);
  }
});

router.post('/select-account', async (req: Request, res: Response, next: NextFunction) => {
  const selectionToken = typeof req.body?.selectionToken === 'string' ? req.body.selectionToken : '';
  const selectedAccount = req.body?.selectedAccount;
  const accountType = typeof selectedAccount?.accountType === 'string' ? selectedAccount.accountType : '';
  const accountIdRaw = selectedAccount?.accountId;
  const accountId = typeof accountIdRaw === 'number' ? accountIdRaw : Number(accountIdRaw);

  if (!selectionToken || !accountType || !Number.isFinite(accountId)) {
    selectionExpired(res);
    return;
  }

  try {
    const payload = consumeSelectionToken(selectionToken, SESSION_SECRET);
    if (!payload) {
      selectionExpired(res);
      return;
    }

    const account = payload.accounts.find(
      (entry) => entry.accountType === accountType && entry.accountId === accountId
    );
    if (!account) {
      selectionExpired(res);
      return;
    }

    if (account.accountType === 'ADMIN') {
      await ensureFranchisePayrollSettings(account.franchiseId);
    }

    const session = await createAuthSession(req, {
      accountType: account.accountType,
      accountId: account.accountId,
      franchiseId: account.franchiseId,
      displayName: account.label
    });

    res.status(200).json({ session });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, (req: Request, res: Response) => {
  res.status(200).json({ session: req.session.auth });
});

router.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await destroySession(req);
    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/'
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
