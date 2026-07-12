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

const readJson = async (response) => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
