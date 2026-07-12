import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

const numberEnv = (name, fallback) => {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
};

const requiredEnv = (name) => {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const BASE_URL = requiredEnv('LOAD_TEST_BASE_URL').replace(/\/$/, '');
const CREDENTIALS_FILE = requiredEnv('LOAD_TEST_CREDENTIALS_FILE');
const RESULTS_FILE = process.env.LOAD_TEST_RESULTS_FILE || 'load-test-results.json';
const USERS = numberEnv('LOAD_TEST_USERS', 200);
const DURATION_SECONDS = numberEnv('LOAD_TEST_DURATION_SECONDS', 900);
const RAMP_SECONDS = numberEnv('LOAD_TEST_RAMP_SECONDS', 60);
const TUTOR_PERCENT = numberEnv('LOAD_TEST_TUTOR_PERCENT', 90);
const THINK_MIN_MS = numberEnv('LOAD_TEST_THINK_MIN_MS', 1000);
const THINK_MAX_MS = numberEnv('LOAD_TEST_THINK_MAX_MS', 3000);
const EXPORT_CONCURRENCY = numberEnv('LOAD_TEST_EXPORT_CONCURRENCY', 3);
const ENABLE_WRITES = process.env.LOAD_TEST_ENABLE_WRITES === 'true';

if (!Number.isInteger(USERS) || USERS < 1) throw new Error('LOAD_TEST_USERS must be a positive integer');
if (TUTOR_PERCENT < 0 || TUTOR_PERCENT > 100) throw new Error('LOAD_TEST_TUTOR_PERCENT must be 0-100');
if (THINK_MAX_MS < THINK_MIN_MS) throw new Error('LOAD_TEST_THINK_MAX_MS must be >= LOAD_TEST_THINK_MIN_MS');

const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
if (!Array.isArray(credentials.tutors) || !credentials.tutors.length) throw new Error('credentials.tutors is required');
if (!Array.isArray(credentials.admins) || !credentials.admins.length) throw new Error('credentials.admins is required');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => Math.round(min + Math.random() * (max - min));
const percentile = (sorted, fraction) => sorted.length
  ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
  : 0;
const today = new Date().toISOString().slice(0, 10);
const month = today.slice(0, 7);

const samples = [];
let expectedExport429 = 0;
let unexpectedErrors = 0;
let sessionErrors = 0;

const updateCookie = (jar, response) => {
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) jar.cookie = setCookie.split(';', 1)[0];
};

const request = async (jar, label, path, init = {}, expectedStatuses = [200]) => {
  const started = performance.now();
  let status = 0;
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(jar.cookie ? { Cookie: jar.cookie } : {}),
        ...(init.headers || {})
      }
    });
    status = response.status;
    updateCookie(jar, response);
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    const durationMs = performance.now() - started;
    const isExport429 = label.startsWith('export:') && status === 429;
    if (isExport429) expectedExport429 += 1;
    else if (!expectedStatuses.includes(status)) unexpectedErrors += 1;
    if (status === 401 || status === 403) sessionErrors += 1;
    samples.push({ label, status, durationMs, export: label.startsWith('export:') });
    return { status, body, headers: response.headers };
  } catch (error) {
    unexpectedErrors += 1;
    samples.push({
      label,
      status,
      durationMs: performance.now() - started,
      export: label.startsWith('export:'),
      error: String(error)
    });
    throw error;
  }
};

const login = async (jar, credential, role) => {
  const loginResult = await request(jar, `${role}:login`, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: credential.identifier, password: credential.password })
  });
  if (loginResult.body?.session) return loginResult.body.session;
  if (!loginResult.body?.requiresSelection || !loginResult.body?.selectionToken) {
    throw new Error(`${role} login did not return a session or selection token`);
  }
  const selectedAccount = credential.selectedAccount
    ?? loginResult.body.accounts?.find((item) => item.accountType === role.toUpperCase());
  if (!selectedAccount) throw new Error(`${role} credential requires selectedAccount`);
  const selection = await request(jar, `${role}:select-account`, '/api/auth/select-account', {
    method: 'POST',
    body: JSON.stringify({
      selectionToken: loginResult.body.selectionToken,
      selectedAccount: { accountType: selectedAccount.accountType, accountId: selectedAccount.accountId }
    })
  });
  return selection.body?.session;
};

const tutorPaths = [
  ['tutor:session', '/api/auth/me'],
  ['tutor:weekly', '/api/hours/me/weekly'],
  ['tutor:pay-period', '/api/hours/me/pay-period'],
  ['tutor:monthly', `/api/hours/me/monthly?month=${month}`],
  ['tutor:clock-state', '/api/clock/me/state'],
  ['tutor:calendar', `/api/calendar/me/month?month=${month}`]
];

const adminPaths = (franchiseId) => [
  ['admin:session', '/api/auth/me'],
  ['admin:pay-period', `/api/pay-period/current?franchiseId=${franchiseId}`],
  ['admin:extra-pending', `/api/extrahours/admin/pending?franchiseId=${franchiseId}&limit=20`],
  ['admin:timeoff-pending', `/api/timeoff/admin/pending?franchiseId=${franchiseId}&limit=20`],
  ['admin:entry-pending', `/api/time-entry/admin/pending?franchiseId=${franchiseId}&limit=20`],
  ['admin:summary', `/api/hours/admin/pay-period/summary?franchiseId=${franchiseId}&forDate=${today}`]
];

const renderPath = (path, session) => path
  .replaceAll('{franchiseId}', String(session.franchiseId))
  .replaceAll('{accountId}', String(session.accountId));

const runWriteAction = async (jar, credential, session, index) => {
  if (!ENABLE_WRITES || !Array.isArray(credential.writeActions) || !credential.writeActions.length) return;
  const action = credential.writeActions[index % credential.writeActions.length];
  await request(
    jar,
    `${session.accountType.toLowerCase()}:controlled-write`,
    renderPath(action.path, session),
    { method: action.method, body: action.body === undefined ? undefined : JSON.stringify(action.body) },
    action.expectedStatuses ?? [200]
  );
};

const runVirtualUser = async (index, role, deadline) => {
  await sleep((index / USERS) * RAMP_SECONDS * 1000);
  const accountList = role === 'tutor' ? credentials.tutors : credentials.admins;
  const credential = accountList[index % accountList.length];
  const jar = { cookie: '' };
  const session = await login(jar, credential, role);
  if (!session?.franchiseId) throw new Error(`${role} session has no franchiseId`);
  let iteration = 0;
  while (Date.now() < deadline) {
    const paths = role === 'tutor' ? tutorPaths : adminPaths(session.franchiseId);
    const [label, path] = paths[Math.floor(Math.random() * paths.length)];
    await request(jar, label, path);
    if (iteration > 0 && iteration % 30 === 0) await runWriteAction(jar, credential, session, iteration);
    iteration += 1;
    await sleep(randomBetween(THINK_MIN_MS, THINK_MAX_MS));
  }
};

const runExportWave = async (deadline) => {
  await sleep(RAMP_SECONDS * 1000);
  const jobs = Array.from({ length: EXPORT_CONCURRENCY }, async (_, index) => {
    const credential = credentials.admins[index % credentials.admins.length];
    const jar = { cookie: '' };
    const session = await login(jar, credential, 'admin');
    if (Date.now() >= deadline) return;
    await request(
      jar,
      'export:pay-period',
      `/api/hours/admin/pay-period/export?franchiseId=${session.franchiseId}&forDate=${today}&format=xlsx`,
      {},
      [200, 404]
    );
  });
  await Promise.all(jobs);
};

const summarizeSamples = (items) => {
  const durations = items.map((item) => item.durationMs).sort((a, b) => a - b);
  return {
    requests: items.length,
    p95: percentile(durations, 0.95),
    p99: percentile(durations, 0.99),
    statuses: Object.fromEntries(
      [...new Set(items.map((item) => item.status))]
        .sort((a, b) => a - b)
        .map((status) => [status, items.filter((item) => item.status === status).length])
    )
  };
};

const tutorUsers = Math.round(USERS * (TUTOR_PERCENT / 100));
const deadline = Date.now() + (RAMP_SECONDS + DURATION_SECONDS) * 1000;
const workers = Array.from({ length: USERS }, (_, index) =>
  runVirtualUser(index, index < tutorUsers ? 'tutor' : 'admin', deadline)
);

const workerResults = await Promise.allSettled([...workers, runExportWave(deadline)]);
const workerFailures = workerResults
  .filter((item) => item.status === 'rejected')
  .map((item) => String(item.reason));
unexpectedErrors += workerFailures.length;

const nonExportSamples = samples.filter((sample) => !sample.export);
const nonExportDurations = nonExportSamples.map((sample) => sample.durationMs).sort((a, b) => a - b);
const totalRequests = samples.length;
const unexpectedErrorRate = totalRequests ? unexpectedErrors / totalRequests : 1;
const byLabel = Object.fromEntries(
  [...new Set(samples.map((sample) => sample.label))]
    .sort()
    .map((label) => [label, summarizeSamples(samples.filter((sample) => sample.label === label))])
);
const result = {
  config: {
    users: USERS,
    tutorUsers,
    adminUsers: USERS - tutorUsers,
    durationSeconds: DURATION_SECONDS,
    exportConcurrency: EXPORT_CONCURRENCY,
    writesEnabled: ENABLE_WRITES
  },
  requests: totalRequests,
  unexpectedErrors,
  unexpectedErrorRate,
  expectedExport429,
  sessionErrors,
  workerFailures,
  nonExportLatencyMs: {
    p95: percentile(nonExportDurations, 0.95),
    p99: percentile(nonExportDurations, 0.99)
  },
  byLabel,
  passed: workerFailures.length === 0
    && unexpectedErrorRate < 0.01
    && sessionErrors === 0
    && percentile(nonExportDurations, 0.95) < 1500
    && percentile(nonExportDurations, 0.99) < 3000
};

fs.writeFileSync(RESULTS_FILE, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
