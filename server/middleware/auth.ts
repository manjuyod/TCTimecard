import { NextFunction, Request, Response } from 'express';
import { AuthSessionData } from '../auth/types';
import { destroySession, isSessionExpired } from '../auth/session';

const notAuthenticated = (res: Response) => res.status(401).json({ error: 'Not authenticated' });
const forbidden = (res: Response) => res.status(403).json({ error: 'Forbidden' });

const updateLastSeen = (req: Request, auth: AuthSessionData, next: NextFunction) => {
  req.session.auth = { ...auth, lastSeenAt: new Date().toISOString() };
  req.session.save((err) => {
    if (err) next(err);
    else next();
  });
};

export const requireAuth = (req: Request, res: Response, next: NextFunction): void => {
  const auth = req.session.auth;
  if (!auth) {
    notAuthenticated(res);
    return;
  }

  if (isSessionExpired(auth)) {
    destroySession(req)
      .catch(() => undefined)
      .finally(() => notAuthenticated(res));
    return;
  }

  updateLastSeen(req, auth, next);
};

const ensureAuth = (req: Request, res: Response, next: NextFunction, handler: (auth: AuthSessionData) => void) => {
  requireAuth(req, res, () => {
    const sessionAuth = req.session.auth;
    if (!sessionAuth) {
      notAuthenticated(res);
      return;
    }
    handler(sessionAuth);
  });
};

export const requireTutor = (req: Request, res: Response, next: NextFunction): void => {
  ensureAuth(req, res, next, (auth) => {
    if (auth.accountType !== 'TUTOR') {
      forbidden(res);
      return;
    }
    next();
  });
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
  ensureAuth(req, res, next, (auth) => {
    if (auth.accountType !== 'ADMIN') {
      forbidden(res);
      return;
    }
    next();
  });
};

export const touchActiveSession = (req: Request, _res: Response, next: NextFunction): void => {
  const auth = req.session.auth;
  if (!auth) {
    next();
    return;
  }

  if (isSessionExpired(auth)) {
    destroySession(req)
      .catch(() => undefined)
      .finally(() => next());
    return;
  }

  updateLastSeen(req, auth, next);
};
