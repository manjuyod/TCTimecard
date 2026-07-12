# Load-Test Credential Checker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secret-safe, human-operated credential checker and discard the 23 credential candidates implicated by the first 20-user run.

**Architecture:** A dependency-injected library parses explicit credential indices and performs sequential login, optional account selection, and immediate logout. A thin CLI loads ignored credentials, calls the library, writes a secret-free ignored result, and exits nonzero for invalid/error/skipped outcomes. Tests use a local fake HTTP server only.

**Tech Stack:** Node.js 18+, native `fetch`, native `node:test`, native `node:http`, ECMAScript modules, npm scripts.

## Global Constraints

- An agent must never run the checker against production because login creates PostgreSQL session rows.
- Never print or persist identifiers, passwords, cookies, selection tokens, response bodies, or request headers.
- Check credentials sequentially in tutor-then-admin order.
- Default to four maximum consecutive failures; accept only values from one through four.
- Stop before issuing another login once the consecutive-failure guard is reached.
- Successful authentication must be followed immediately by logout.
- Automated tests must use a local fake HTTP server and no database.
- `load-tests/credentials.json` and checker result files remain ignored by Git.

---

### Task 1: Credential selector and sequential checker library

**Files:**
- Create: `load-tests/credential-checker-lib.mjs`
- Create: `load-tests/credential-checker.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `parseIndexSelector(value, label, length): number[]`
- Produces: `runCredentialChecks({ baseUrl, credentials, tutorIndices, adminIndices, maxConsecutiveFailures, fetchImpl }): Promise<CredentialCheckResult>`
- `CredentialCheckResult.entries` contains only `{ role, index, accountId, outcome, httpStatus }`.

- [ ] **Step 1: Add a failing selector test**

Create `load-tests/credential-checker.test.mjs` with:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseIndexSelector } from './credential-checker-lib.mjs';

test('parseIndexSelector expands, deduplicates, and sorts indices', () => {
  assert.deepEqual(parseIndexSelector('3,0-2,2', 'tutor', 5), [0, 1, 2, 3]);
});

test('parseIndexSelector rejects malformed and out-of-range indices', () => {
  assert.throws(() => parseIndexSelector('3-1', 'tutor', 5), /tutor range 3-1 is descending/);
  assert.throws(() => parseIndexSelector('5', 'tutor', 5), /tutor index 5 is out of range/);
  assert.throws(() => parseIndexSelector('one', 'tutor', 5), /tutor selector segment is invalid/);
});
```

- [ ] **Step 2: Run the selector test and verify RED**

Run: `node --test load-tests/credential-checker.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `credential-checker-lib.mjs`.

- [ ] **Step 3: Implement the selector parser**

Create `load-tests/credential-checker-lib.mjs` with:

```js
const assertIndex = (value, label, length) => {
  if (!Number.isInteger(value) || value < 0 || value >= length) {
    throw new Error(`${label} index ${value} is out of range 0-${Math.max(0, length - 1)}`);
  }
};

export const parseIndexSelector = (value, label, length) => {
  const input = String(value ?? '').trim();
  if (!input) return [];
  const indices = new Set();
  for (const rawSegment of input.split(',')) {
    const segment = rawSegment.trim();
    const match = /^(\d+)(?:-(\d+))?$/.exec(segment);
    if (!match) throw new Error(`${label} selector segment is invalid: ${segment}`);
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (end < start) throw new Error(`${label} range ${segment} is descending`);
    for (let index = start; index <= end; index += 1) {
      assertIndex(index, label, length);
      indices.add(index);
    }
  }
  return [...indices].sort((left, right) => left - right);
};
```

- [ ] **Step 4: Run the selector tests and verify GREEN**

Run: `node --test load-tests/credential-checker.test.mjs`

Expected: 2 tests pass and 0 fail.

- [ ] **Step 5: Add failing fake-server tests for login, selection, logout, redaction, and lockout guard**

Extend `load-tests/credential-checker.test.mjs` with a local `node:http` server helper and these assertions:

```js
import http from 'node:http';
import { once } from 'node:events';
import { runCredentialChecks } from './credential-checker-lib.mjs';

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

test('runCredentialChecks validates direct and selected sessions then logs out without leaking secrets', async () => {
  const paths = [];
  const fixture = await startServer(async (req, res) => {
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
    const tutors = Array.from({ length: 6 }, (_, index) => credential('TUTOR', index + 1, `private-${index}`));
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
```

- [ ] **Step 6: Run the checker tests and verify RED**

Run: `node --test load-tests/credential-checker.test.mjs`

Expected: selector tests pass; checker tests fail because `runCredentialChecks` is not exported.

- [ ] **Step 7: Implement sequential checking and secret-safe results**

Add to `load-tests/credential-checker-lib.mjs`:

```js
const readJson = async (response) => {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
};

const updateCookie = (jar, response) => {
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) jar.cookie = setCookie.split(';', 1)[0];
};

const post = async (fetchImpl, baseUrl, jar, path, body) => {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(jar.cookie ? { Cookie: jar.cookie } : {})
    },
    body: JSON.stringify(body)
  });
  updateCookie(jar, response);
  return { status: response.status, body: await readJson(response) };
};

const checkOne = async ({ fetchImpl, baseUrl, role, index, credential }) => {
  const accountId = credential?.selectedAccount?.accountId ?? null;
  const safe = { role, index, accountId };
  const jar = { cookie: '' };
  try {
    const login = await post(fetchImpl, baseUrl, jar, '/api/auth/login', {
      identifier: credential.identifier,
      password: credential.password
    });
    if (login.status !== 200) {
      const outcome = login.status === 401 || login.status === 403 ? 'invalid' : 'error';
      return { ...safe, outcome, httpStatus: login.status };
    }
    let session = login.body?.session;
    let status = login.status;
    if (!session && login.body?.requiresSelection && login.body?.selectionToken) {
      const selection = await post(fetchImpl, baseUrl, jar, '/api/auth/select-account', {
        selectionToken: login.body.selectionToken,
        selectedAccount: credential.selectedAccount
      });
      status = selection.status;
      session = selection.body?.session;
    }
    if (!session) {
      const outcome = status === 401 || status === 403 || status === 200 ? 'invalid' : 'error';
      return { ...safe, outcome, httpStatus: status };
    }
    const logout = await post(fetchImpl, baseUrl, jar, '/api/auth/logout', {});
    if (logout.status !== 200) return { ...safe, outcome: 'error', httpStatus: logout.status };
    return { ...safe, outcome: 'valid', httpStatus: 200 };
  } catch {
    return { ...safe, outcome: 'error', httpStatus: 0 };
  }
};

export const runCredentialChecks = async ({
  baseUrl,
  credentials,
  tutorIndices,
  adminIndices,
  maxConsecutiveFailures = 4,
  fetchImpl = fetch
}) => {
  if (!Number.isInteger(maxConsecutiveFailures) || maxConsecutiveFailures < 1 || maxConsecutiveFailures > 4) {
    throw new Error('maxConsecutiveFailures must be an integer from 1 through 4');
  }
  const selected = [
    ...tutorIndices.map((index) => ({ role: 'TUTOR', index, credential: credentials.tutors[index] })),
    ...adminIndices.map((index) => ({ role: 'ADMIN', index, credential: credentials.admins[index] }))
  ];
  const entries = [];
  let consecutiveFailures = 0;
  let stoppedByFailureGuard = false;
  for (let position = 0; position < selected.length; position += 1) {
    if (consecutiveFailures >= maxConsecutiveFailures) {
      stoppedByFailureGuard = true;
      for (const remaining of selected.slice(position)) {
        entries.push({
          role: remaining.role,
          index: remaining.index,
          accountId: remaining.credential?.selectedAccount?.accountId ?? null,
          outcome: 'skipped',
          httpStatus: 0
        });
      }
      break;
    }
    const entry = await checkOne({ fetchImpl, baseUrl, ...selected[position] });
    entries.push(entry);
    consecutiveFailures = entry.outcome === 'valid' ? 0 : consecutiveFailures + 1;
  }
  const count = (outcome) => entries.filter((entry) => entry.outcome === outcome).length;
  return {
    selected: selected.length,
    valid: count('valid'),
    invalid: count('invalid'),
    errors: count('error'),
    skipped: count('skipped'),
    stoppedByFailureGuard,
    entries
  };
};
```

- [ ] **Step 8: Run the checker tests and verify GREEN**

Run: `node --test load-tests/credential-checker.test.mjs`

Expected: 4 tests pass and 0 fail.

- [ ] **Step 9: Include load-tool tests in the normal suite**

Modify `package.json` scripts to:

```json
"test": "npm run test:server && npm run test:load-tools",
"test:server": "node --test --import tsx \"server/tests/*.test.ts\"",
"test:load-tools": "node --test \"load-tests/*.test.mjs\""
```

Run: `npm test`

Expected: all 69 existing server tests and 4 load-tool tests pass.

- [ ] **Step 10: Commit Task 1**

Before committing, run `gitnexus_detect_changes(scope: "staged")` and confirm only the new checker library/tests and npm test scripts are affected.

```bash
git add package.json load-tests/credential-checker-lib.mjs load-tests/credential-checker.test.mjs
git commit -m "test: add safe credential checking library"
```

---

### Task 2: Human-operated checker CLI and ignored result

**Files:**
- Create: `load-tests/check-credentials.mjs`
- Modify: `load-tests/credential-checker.test.mjs`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `parseIndexSelector` and `runCredentialChecks` from Task 1.
- Produces: npm command `credentials:check` and ignored JSON result selected by `CREDENTIAL_CHECK_RESULTS_FILE`.

- [ ] **Step 1: Add a failing CLI integration test**

Extend the test file with a child-process test that writes a temporary credential file, starts the fake server, and launches the CLI:

```js
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const runCli = (env) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['load-tests/check-credentials.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});

test('CLI writes a redacted result and exits nonzero for invalid credentials', async () => {
  const fixture = await startServer((req, res) => {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Invalid credentials' }));
  });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'credential-check-'));
  const credentialsFile = path.join(directory, 'credentials.json');
  const resultsFile = path.join(directory, 'results.json');
  await fs.writeFile(credentialsFile, JSON.stringify({
    tutors: [credential('TUTOR', 11, 'private-tutor@example.test')],
    admins: []
  }));
  try {
    const execution = await runCli({
      LOAD_TEST_BASE_URL: fixture.baseUrl,
      LOAD_TEST_CREDENTIALS_FILE: credentialsFile,
      CREDENTIAL_CHECK_TUTOR_INDICES: '0',
      CREDENTIAL_CHECK_ADMIN_INDICES: '',
      CREDENTIAL_CHECK_RESULTS_FILE: resultsFile
    });
    assert.equal(execution.code, 1);
    const saved = JSON.parse(await fs.readFile(resultsFile, 'utf8'));
    assert.equal(saved.invalid, 1);
    assert.doesNotMatch(`${execution.stdout}${execution.stderr}${JSON.stringify(saved)}`, /private-|secret-/);
  } finally {
    await fixture.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the CLI test and verify RED**

Run: `npm run test:load-tools`

Expected: CLI test fails because `load-tests/check-credentials.mjs` does not exist.

- [ ] **Step 3: Implement the thin CLI**

Create `load-tests/check-credentials.mjs`:

```js
import fs from 'node:fs';
import { parseIndexSelector, runCredentialChecks } from './credential-checker-lib.mjs';

const requiredEnv = (name) => {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const main = async () => {
  const baseUrl = requiredEnv('LOAD_TEST_BASE_URL').replace(/\/$/, '');
  const credentialsFile = requiredEnv('LOAD_TEST_CREDENTIALS_FILE');
  const resultsFile = process.env.CREDENTIAL_CHECK_RESULTS_FILE || 'credential-check-results.json';
  const credentials = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
  if (!Array.isArray(credentials.tutors) || !Array.isArray(credentials.admins)) {
    throw new Error('credentials must contain tutors and admins arrays');
  }
  const tutorIndices = parseIndexSelector(
    process.env.CREDENTIAL_CHECK_TUTOR_INDICES,
    'tutor',
    credentials.tutors.length
  );
  const adminIndices = parseIndexSelector(
    process.env.CREDENTIAL_CHECK_ADMIN_INDICES,
    'admin',
    credentials.admins.length
  );
  if (tutorIndices.length + adminIndices.length === 0) {
    throw new Error('at least one credential index must be selected');
  }
  const maxConsecutiveFailures = Number(process.env.CREDENTIAL_CHECK_MAX_CONSECUTIVE_FAILURES || 4);
  const result = await runCredentialChecks({
    baseUrl,
    credentials,
    tutorIndices,
    adminIndices,
    maxConsecutiveFailures,
    fetchImpl: fetch
  });
  const output = {
    config: {
      baseUrl,
      tutorIndices,
      adminIndices,
      maxConsecutiveFailures
    },
    ...result
  };
  fs.writeFileSync(resultsFile, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(output, null, 2));
  if (result.invalid > 0 || result.errors > 0 || result.skipped > 0) process.exitCode = 1;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
```

- [ ] **Step 4: Add CLI and ignore scripts**

Add to `package.json` scripts:

```json
"credentials:check": "node load-tests/check-credentials.mjs"
```

Add to `.gitignore`:

```gitignore
credential-check-results*.json
```

- [ ] **Step 5: Run CLI tests and verify GREEN**

Run: `npm run test:load-tools`

Expected: 5 tests pass and 0 fail.

- [ ] **Step 6: Run full local verification**

Run: `npm test && npm run typecheck && npm run build && node --check load-tests/check-credentials.mjs`

Expected: all tests pass; typecheck, production build, and checker syntax check exit zero. Do not run `npm run credentials:check` because that would authenticate.

- [ ] **Step 7: Commit Task 2**

Before committing, run `gitnexus_detect_changes(scope: "staged")` and confirm the affected scope is limited to the CLI, its tests, npm script, and ignored result pattern.

```bash
git add .gitignore package.json load-tests/check-credentials.mjs load-tests/credential-checker.test.mjs
git commit -m "feat: add human-operated credential checker"
```

---

### Task 3: Discard candidate credentials and document operator use

**Files:**
- Modify ignored file: `load-tests/credentials.json`
- Modify: `docs/operations/replit-200-user-runbook.md`

**Interfaces:**
- Consumes: `npm run credentials:check` from Task 2.
- Produces: 821 tutor and 193 admin credentials; documented 20-user preflight command.

- [ ] **Step 1: Mechanically remove the approved candidate entries without printing secrets**

Run this local bulk transformation. It reads and writes only the ignored credential file and prints counts only:

```powershell
$path = 'load-tests/credentials.json'
$credentials = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
$credentials.tutors = @($credentials.tutors | Select-Object -Skip 18)
$discardAdmins = [System.Collections.Generic.HashSet[int]]::new([int[]]@(0, 1, 2, 18, 19))
$nextAdmins = for ($index = 0; $index -lt $credentials.admins.Count; $index++) {
  if (-not $discardAdmins.Contains($index)) { $credentials.admins[$index] }
}
$credentials.admins = @($nextAdmins)
$credentials | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $path -Encoding utf8
Write-Output "tutors=$($credentials.tutors.Count) admins=$($credentials.admins.Count)"
```

Expected: `tutors=821 admins=193`.

- [ ] **Step 2: Verify the ignored credential schema without exposing values**

Run:

```powershell
$credentials = Get-Content -LiteralPath 'load-tests/credentials.json' -Raw | ConvertFrom-Json
if ($credentials.tutors.Count -ne 821) { throw 'expected 821 tutors' }
if ($credentials.admins.Count -ne 193) { throw 'expected 193 admins' }
$all = @($credentials.tutors) + @($credentials.admins)
$invalid = @($all | Where-Object {
  [string]::IsNullOrWhiteSpace($_.identifier) -or
  [string]::IsNullOrWhiteSpace($_.password) -or
  $null -eq $_.selectedAccount.accountId
})
if ($invalid.Count) { throw "found $($invalid.Count) invalid credentials" }
git check-ignore -q load-tests/credentials.json
if ($LASTEXITCODE -ne 0) { throw 'credentials.json is not ignored' }
Write-Output 'credential_cleanup_verification=passed'
```

Expected: `credential_cleanup_verification=passed`.

- [ ] **Step 3: Add the human-only checker procedure to the runbook**

Add before the load stages:

```markdown
## Manual credential preflight

The credential checker logs in and immediately logs out, which creates and deletes PostgreSQL session rows. Only a human operator may run it. Agents may inspect its secret-free result but must not launch it.

For the 20-user stage, validate exactly the credentials the harness will select:

```powershell
$env:LOAD_TEST_BASE_URL='https://timecard.tutoringclub.com'
$env:LOAD_TEST_CREDENTIALS_FILE=(Resolve-Path 'load-tests/credentials.json').Path
$env:CREDENTIAL_CHECK_TUTOR_INDICES='0-17'
$env:CREDENTIAL_CHECK_ADMIN_INDICES='0-2,18-19'
$env:CREDENTIAL_CHECK_MAX_CONSECUTIVE_FAILURES='4'
$env:CREDENTIAL_CHECK_RESULTS_FILE='credential-check-results-20.json'
npm run credentials:check
```

Do not begin the load stage unless every selected credential is valid and the checker exits zero. If the checker reports failures, remove only the reported role/index entries, recalculate the stage selectors, and rerun the preflight after the login cooldown has cleared.
```

- [ ] **Step 4: Verify documentation and repository hygiene**

Run: `git diff --check && git status --short --ignored load-tests/credentials.json credential-check-results-20.json`

Expected: no whitespace errors; `credentials.json` is ignored; no credential or checker-result file is staged.

- [ ] **Step 5: Commit Task 3 tracked documentation only**

Before committing, run `gitnexus_detect_changes(scope: "staged")` and confirm no code symbols or execution flows are affected.

```bash
git add docs/operations/replit-200-user-runbook.md
git commit -m "docs: add load credential preflight"
```

---

### Task 4: Final verification and operator handoff

**Files:**
- Verify all files from Tasks 1-3.

**Interfaces:**
- Consumes: complete checker, cleaned ignored credentials, and runbook.
- Produces: a verified human command; does not execute it.

- [ ] **Step 1: Run fresh automated verification**

Run: `npm test`

Expected: 69 server tests plus 5 load-tool tests pass with 0 failures.

- [ ] **Step 2: Run compiler, build, syntax, and whitespace verification**

Run: `npm run typecheck && npm run build && node --check load-tests/check-credentials.mjs && git diff --check`

Expected: every command exits zero. Existing advisory chunk-size or Browserslist warnings do not fail the build.

- [ ] **Step 3: Verify secrets remain ignored and absent from tracked diffs**

Run:

```powershell
git check-ignore -q load-tests/credentials.json
if ($LASTEXITCODE -ne 0) { throw 'credentials file is not ignored' }
$trackedSensitive = @(git ls-files 'load-tests/credentials*.json' 'load-tests/*.csv' 'credential-check-results*.json' | Where-Object { $_ -ne 'load-tests/credentials.example.json' })
if ($trackedSensitive.Count) { throw 'sensitive load-test artifacts are tracked' }
Write-Output 'sensitive_artifact_verification=passed'
```

Expected: `sensitive_artifact_verification=passed`.

- [ ] **Step 4: Run GitNexus final scope review**

Run `gitnexus_detect_changes(scope: "compare", base_ref: "40b9757")`.

Expected: only credential-checker code/tests, npm scripts, `.gitignore`, and runbook documentation are changed; no server execution flows are affected.

- [ ] **Step 5: Report the manual gate**

Report that the checker exists and local fake-server tests pass, but do not claim production credentials are valid. Provide the runbook command and ask the human operator to return `credential-check-results-20.json` for analysis before rerunning the 20-user stage.
