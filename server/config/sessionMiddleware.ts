import session, { SessionData, SessionOptions, Store } from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type { Pool } from 'pg';
import { getPostgresPool } from '../db/postgres';
import {
  SESSION_COOKIE_NAME,
  SESSION_SAME_SITE,
  SESSION_SECRET,
  SESSION_SECURE,
  SESSION_TTL_MS
} from './session';

const PostgresSessionStore = connectPgSimple(session);

export class SessionStoreUnavailableError extends Error {
  readonly status = 503;
  readonly cause: unknown;

  constructor(cause?: unknown) {
    super('Session service unavailable');
    this.name = 'SessionStoreUnavailableError';
    this.cause = cause;
  }
}

const unavailable = (error: unknown): SessionStoreUnavailableError =>
  error instanceof SessionStoreUnavailableError ? error : new SessionStoreUnavailableError(error);

export class FailClosedSessionStore extends Store {
  constructor(private readonly delegate: Store) {
    super();
  }

  get(sid: string, callback: (err: unknown, session?: SessionData | null) => void): void {
    this.delegate.get(sid, (error, value) => callback(error ? unavailable(error) : null, value));
  }

  set(sid: string, value: SessionData, callback?: (err?: unknown) => void): void {
    this.delegate.set(sid, value, (error) => callback?.(error ? unavailable(error) : undefined));
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    this.delegate.destroy(sid, (error) => callback?.(error ? unavailable(error) : undefined));
  }

  touch(sid: string, value: SessionData, callback?: (err?: unknown) => void): void {
    const touch = this.delegate.touch;
    if (!touch) {
      this.set(sid, value, callback);
      return;
    }
    touch.call(this.delegate, sid, value, (error?: unknown) =>
      callback?.(error ? unavailable(error) : undefined)
    );
  }
}

export const createPostgresSessionStore = (pool: Pool = getPostgresPool()): Store =>
  new FailClosedSessionStore(
    new PostgresSessionStore({
      pool,
      schemaName: 'public',
      tableName: 'user_sessions',
      createTableIfMissing: false,
      ttl: SESSION_TTL_MS / 1000,
      pruneSessionInterval: 15 * 60,
      errorLog: (...args: unknown[]) => console.error('[session-store]', ...args)
    })
  );

export const buildSessionOptions = (store: Store): SessionOptions => ({
  store,
  name: SESSION_COOKIE_NAME,
  secret: SESSION_SECRET,
  resave: false,
  rolling: true,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: SESSION_SECURE,
    sameSite: SESSION_SAME_SITE,
    maxAge: SESSION_TTL_MS
  }
});

export const createSessionMiddleware = () => session(buildSessionOptions(createPostgresSessionStore()));
