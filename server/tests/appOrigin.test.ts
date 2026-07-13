import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveAppOrigin } from '../config/appOrigin';
import { validateRuntimeEnv } from '../config/env';

describe('APP_ORIGIN validation', () => {
  it('normalizes an absolute deployment origin', () => {
    assert.equal(
      resolveAppOrigin({ NODE_ENV: 'production', APP_ORIGIN: 'https://timecard.tutoringclub.com/' }),
      'https://timecard.tutoringclub.com'
    );
  });

  it('rejects missing, malformed, and local production origins', () => {
    assert.throws(() => resolveAppOrigin({ NODE_ENV: 'production' }), /APP_ORIGIN is required/i);
    assert.throws(
      () => resolveAppOrigin({ NODE_ENV: 'production', APP_ORIGIN: 'timecard.tutoringclub.com' }),
      /absolute HTTP\(S\) origin/i
    );
    assert.throws(
      () => resolveAppOrigin({ NODE_ENV: 'production', APP_ORIGIN: 'http://localhost:3000' }),
      /public hostname/i
    );
    assert.throws(
      () => resolveAppOrigin({ NODE_ENV: 'production', APP_ORIGIN: 'http://127.0.0.1:3000' }),
      /public hostname/i
    );
  });

  it('keeps a local fallback for development', () => {
    assert.equal(resolveAppOrigin({ NODE_ENV: 'development' }), 'http://localhost:5173');
  });

  it('includes APP_ORIGIN in the caught production runtime validation', () => {
    assert.throws(
      () => validateRuntimeEnv({
        NODE_ENV: 'production',
        APP_ORIGIN: 'http://localhost:3000',
        SESSION_SECRET: 'session-secret',
        SCHEDULE_SNAPSHOT_SIGNING_SECRET: 'snapshot-secret'
      }),
      /public hostname/i
    );
  });
});
