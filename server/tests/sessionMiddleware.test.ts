import assert from 'node:assert/strict';
import { test } from 'node:test';
import session, { SessionData, Store } from 'express-session';
import {
  FailClosedSessionStore,
  SessionStoreUnavailableError,
  buildSessionOptions,
  createPostgresSessionStore
} from '../config/sessionMiddleware';
import { SESSION_COOKIE_NAME, SESSION_SAME_SITE, SESSION_SECURE, SESSION_TTL_MS } from '../config/session';

class FailingStore extends Store {
  get(_sid: string, callback: (err: unknown, session?: SessionData | null) => void): void {
    callback(new Error('database unavailable'));
  }

  set(_sid: string, _value: SessionData, callback?: (err?: unknown) => void): void {
    callback?.(new Error('database unavailable'));
  }

  destroy(_sid: string, callback?: (err?: unknown) => void): void {
    callback?.(new Error('database unavailable'));
  }
}

test('session options preserve the existing rolling cookie contract', () => {
  const store = new session.MemoryStore();
  const options = buildSessionOptions(store);

  assert.equal(options.store, store);
  assert.equal(options.name, SESSION_COOKIE_NAME);
  assert.equal(options.resave, false);
  assert.equal(options.rolling, true);
  assert.equal(options.saveUninitialized, false);

  const cookie = options.cookie;
  assert.ok(cookie && typeof cookie !== 'function', 'cookie should be a plain options object');
  const cookieOpts = cookie as Exclude<typeof cookie, Function>;
  assert.equal(cookieOpts.httpOnly, true);
  assert.equal(cookieOpts.secure, SESSION_SECURE);
  assert.equal(cookieOpts.sameSite, SESSION_SAME_SITE);
  assert.equal(cookieOpts.maxAge, SESSION_TTL_MS);
});

test('the production store is explicit and never falls back to MemoryStore', () => {
  const fakePool = { query: async () => ({ rows: [] }) };
  const store = createPostgresSessionStore(fakePool as never);

  assert.ok(store instanceof FailClosedSessionStore);
  assert.ok(!(store instanceof session.MemoryStore));
});

test('store read errors become safe 503 errors', async () => {
  const store = new FailClosedSessionStore(new FailingStore());
  const error = await new Promise<unknown>((resolve) => {
    store.get('sid', (err) => resolve(err));
  });

  assert.ok(error instanceof SessionStoreUnavailableError);
  assert.equal((error as SessionStoreUnavailableError).status, 503);
  assert.equal((error as Error).message, 'Session service unavailable');
});

test('store write errors become safe 503 errors', async () => {
  const store = new FailClosedSessionStore(new FailingStore());
  const error = await new Promise<unknown>((resolve) => {
    store.set('sid', { cookie: { originalMaxAge: null } } as SessionData, (err) => resolve(err));
  });

  assert.ok(error instanceof SessionStoreUnavailableError);
  assert.equal((error as SessionStoreUnavailableError).status, 503);
});
