import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { parseIndexSelector, runCredentialChecks } from './credential-checker-lib.mjs';

const startServer = async (handler) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, 'close');
    }
  };
};

const credential = (role, accountId, identifier) => ({
  identifier,
  password: `secret-${accountId}`,
  selectedAccount: { accountType: role, accountId },
  writeActions: []
});

test('parseIndexSelector expands, deduplicates, and sorts indices', () => {
  assert.deepEqual(parseIndexSelector('3,0-2,2', 'tutor', 5), [0, 1, 2, 3]);
});

test('parseIndexSelector rejects malformed and out-of-range indices', () => {
  assert.throws(() => parseIndexSelector('3-1', 'tutor', 5), /tutor range 3-1 is descending/);
  assert.throws(() => parseIndexSelector('5', 'tutor', 5), /tutor index 5 is out of range/);
  assert.throws(() => parseIndexSelector('one', 'tutor', 5), /tutor selector segment is invalid/);
});

test('runCredentialChecks validates direct and selected sessions then logs out without leaking secrets', async () => {
  const paths = [];
  const fixture = await startServer((req, res) => {
    paths.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/auth/login' && paths.filter((path) => path === '/api/auth/login').length === 1) {
      res.setHeader('Set-Cookie', 'timecard.sid=first; Path=/; HttpOnly');
      res.end(JSON.stringify({ session: { accountType: 'TUTOR', accountId: 11, franchiseId: 1 } }));
      return;
    }
    if (req.url === '/api/auth/login') {
      res.end(JSON.stringify({ requiresSelection: true, selectionToken: 'token-not-for-results' }));
      return;
    }
    if (req.url === '/api/auth/select-account') {
      res.setHeader('Set-Cookie', 'timecard.sid=second; Path=/; HttpOnly');
      res.end(JSON.stringify({ session: { accountType: 'ADMIN', accountId: 22, franchiseId: 1 } }));
      return;
    }
    if (req.url === '/api/auth/logout') {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });

  try {
    const result = await runCredentialChecks({
      baseUrl: fixture.baseUrl,
      credentials: {
        tutors: [credential('TUTOR', 11, 'private-tutor@example.test')],
        admins: [credential('ADMIN', 22, 'private-admin@example.test')]
      },
      tutorIndices: [0],
      adminIndices: [0],
      maxConsecutiveFailures: 4,
      fetchImpl: fetch
    });
    assert.equal(result.valid, 2);
    assert.deepEqual(paths, [
      '/api/auth/login',
      '/api/auth/logout',
      '/api/auth/login',
      '/api/auth/select-account',
      '/api/auth/logout'
    ]);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /private-|secret-|timecard\.sid|token-not-for-results/);
  } finally {
    await fixture.close();
  }
});

test('runCredentialChecks stops after four consecutive invalid logins', async () => {
  let loginRequests = 0;
  const fixture = await startServer((req, res) => {
    if (req.url === '/api/auth/login') loginRequests += 1;
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Invalid credentials' }));
  });

  try {
    const tutors = Array.from({ length: 6 }, (_, index) =>
      credential('TUTOR', index + 1, `private-${index}`)
    );
    const result = await runCredentialChecks({
      baseUrl: fixture.baseUrl,
      credentials: { tutors, admins: [] },
      tutorIndices: [0, 1, 2, 3, 4, 5],
      adminIndices: [],
      maxConsecutiveFailures: 4,
      fetchImpl: fetch
    });
    assert.equal(loginRequests, 4);
    assert.equal(result.invalid, 4);
    assert.equal(result.skipped, 2);
    assert.equal(result.stoppedByFailureGuard, true);
  } finally {
    await fixture.close();
  }
});
