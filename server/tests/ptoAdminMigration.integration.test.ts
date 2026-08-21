import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import { createPostgresPtoStore } from '../services/pto';

const enabled = process.env.RUN_PTO_POSTGRES_TESTS === '1';
const containerName = `timecard-pto-admin-test-${process.pid}`;
const migrations = [
  '0010_shared_pto.sql',
  '0011_pto_admin_invariants.sql',
  '0013_persistent_pto_profile_links.sql'
].map((file) =>
  readFileSync(path.resolve(__dirname, `../db/migrations/${file}`), 'utf8')
);
let pool: Pool | undefined;

const docker = (args: string[], timeout = 120_000): string =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout }).trim();

const waitForPostgres = async (candidate: Pool): Promise<void> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await candidate.query('SELECT 1');
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
};

const discovery = (accounts: Array<{
  id: number;
  franchiseId: number;
  firstName: string;
  lastName: string;
  email: string | null;
  isDeleted: boolean;
  provider: string;
  crmId: string;
}> = []) => ({
  accounts,
  attemptedAt: '2026-08-19T20:00:00.000Z',
  completedAt: '2026-08-19T20:00:01.000Z',
  error: null
});

const reset = async (): Promise<void> => {
  assert.ok(pool);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await pool.query(`
    CREATE TABLE public.time_off_requests (
      id BIGSERIAL PRIMARY KEY, franchiseid INTEGER NOT NULL, tutorid BIGINT,
      bridge_flag BOOLEAN, bridge_profile_id BIGINT, first_name TEXT, last_name TEXT, email TEXT,
      start_at TIMESTAMPTZ NOT NULL, end_at TIMESTAMPTZ NOT NULL, type TEXT NOT NULL,
      status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), duration_hours NUMERIC,
      partial_day BOOLEAN, leave_time TIME, return_time TIME, public_metadata JSONB
    )
  `);
  for (const migration of migrations) await pool.query(migration);
};

before(async () => {
  if (!enabled) return;
  docker(['run', '--detach', '--rm', '--name', containerName, '--env', 'POSTGRES_PASSWORD=pto_test_password',
    '--env', 'POSTGRES_DB=pto_test', '--publish', '127.0.0.1::5432', 'postgres:17-alpine']);
  const portOutput = docker(['port', containerName, '5432/tcp']);
  const port = Number(portOutput.slice(portOutput.lastIndexOf(':') + 1));
  pool = new Pool({ host: '127.0.0.1', port, database: 'pto_test', user: 'postgres', password: 'pto_test_password' });
  await waitForPostgres(pool);
});

beforeEach(async () => {
  if (enabled) await reset();
});

after(async () => {
  if (!enabled) return;
  await pool?.end();
  try { docker(['rm', '--force', containerName], 30_000); } catch { /* disposable */ }
});

test('confirmed merge deduplicates cycle grants while combining adjustments into a negative balance', { skip: !enabled }, async () => {
  assert.ok(pool);
  const profiles = await pool.query<{ id: string }>(`
    INSERT INTO public.pto_profiles (first_name, last_name, identity_status)
    VALUES ('Shared', 'Tutor', 'confirmed'), ('Shared', 'Tutor', 'pending') RETURNING id
  `);
  const [targetId, sourceId] = profiles.rows.map((row) => row.id);
  const memberships = await pool.query<{ id: string; profile_id: string }>(`
    INSERT INTO public.pto_profile_centers (profile_id, franchiseid, tutor_id, active)
    VALUES ($1, 10, 100, TRUE), ($2, 20, 200, TRUE) RETURNING id, profile_id
  `, [targetId, sourceId]);
  await pool.query('SELECT public.pto_get_or_create_cycle($1, CURRENT_DATE)', [targetId]);
  const sourceCycle = await pool.query<{ id: string }>(
    'SELECT public.pto_get_or_create_cycle($1, CURRENT_DATE) AS id', [sourceId]
  );
  await pool.query(`
    INSERT INTO public.pto_ledger_entries
      (profile_id, cycle_id, event_type, balance_delta, idempotency_key, metadata)
    VALUES ($1, $2, 'adjustment', -6, 'admin:test-negative', '{"reason":"import correction"}')
  `, [sourceId, sourceCycle.rows[0].id]);
  const candidate = await pool.query<{ id: string }>(`
    INSERT INTO public.pto_profile_match_candidates (left_profile_id, right_profile_id)
    VALUES (LEAST($1::BIGINT, $2::BIGINT), GREATEST($1::BIGINT, $2::BIGINT)) RETURNING id
  `, [targetId, sourceId]);

  const merged = await pool.query<{ profile_id: string }>(
    'SELECT public.pto_admin_decide_alias($1, $2, $3, $4) AS profile_id',
    [candidate.rows[0].id, 'confirm', 'admin-10', 10]
  );
  const balance = await pool.query<{ available_days: string; grant_count: string }>(
    'SELECT available_days::TEXT, grant_count::TEXT FROM public.pto_profile_balance($1, CURRENT_DATE)',
    [merged.rows[0].profile_id]
  );
  assert.equal(Number(balance.rows[0].available_days), -1);
  assert.equal(Number(balance.rows[0].grant_count), 1);
  assert.equal(memberships.rows.length, 2);
  const tutorView = await createPostgresPtoStore(pool).getTutorProfile({ franchiseId: 20, tutorId: 200 });
  assert.equal(tutorView.profile?.id, merged.rows[0].profile_id);
  assert.equal(tutorView.memberships.length, 2);
  const adminStore = createPostgresPtoStore(pool);
  const adminDetail = await adminStore.getAdminProfile({ franchiseId: 20, profileId: merged.rows[0].profile_id });
  assert.equal(adminDetail?.id, merged.rows[0].profile_id);
  assert.equal(adminDetail?.memberships.length, 2);
  const adminRoster = await adminStore.listAdminProfiles({ franchiseId: 20, search: '', page: 1, pageSize: 25 });
  assert.deepEqual(adminRoster.items.map((item) => item.id), [merged.rows[0].profile_id]);

  const repeated = await pool.query<{ profile_id: string }>(
    'SELECT public.pto_admin_decide_alias($1, $2, $3, $4) AS profile_id',
    [candidate.rows[0].id, 'confirm', 'admin-10', 10]
  );
  assert.equal(repeated.rows[0].profile_id, merged.rows[0].profile_id);
  const audit = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::TEXT AS count FROM public.pto_audit_events WHERE event_type = 'alias_confirmed'"
  );
  assert.equal(audit.rows[0].count, '1');
});

test('unrelated center cannot mutate an alias and rejected decisions are audited once', { skip: !enabled }, async () => {
  assert.ok(pool);
  const profiles = await pool.query<{ id: string }>(`
    INSERT INTO public.pto_profiles (first_name, last_name)
    VALUES ('Auth', 'One'), ('Auth', 'One') RETURNING id
  `);
  await pool.query('INSERT INTO public.pto_profile_centers (profile_id, franchiseid, tutor_id) VALUES ($1, 10, 1), ($2, 20, 2)',
    [profiles.rows[0].id, profiles.rows[1].id]);
  const candidate = await pool.query<{ id: string }>(`
    INSERT INTO public.pto_profile_match_candidates (left_profile_id, right_profile_id)
    VALUES ($1, $2) RETURNING id
  `, [profiles.rows[0].id, profiles.rows[1].id]);

  await assert.rejects(
    pool.query('SELECT public.pto_admin_decide_alias($1, $2, $3, $4)', [candidate.rows[0].id, 'reject', 'outsider', 99]),
    /not authorized/i
  );
  await pool.query('SELECT public.pto_admin_decide_alias($1, $2, $3, $4)',
    [candidate.rows[0].id, 'reject', 'admin-20', 20]);
  const event = await pool.query<{ event_type: string; actor_id: string }>(
    "SELECT event_type, actor_id FROM public.pto_audit_events WHERE event_type = 'alias_rejected'"
  );
  assert.deepEqual(event.rows, [{ event_type: 'alias_rejected', actor_id: 'admin-20' }]);
});

test('three-way confirmed aliases resolve every center to one canonical grant and balance', { skip: !enabled }, async () => {
  assert.ok(pool);
  const profiles = await pool.query<{ id: string }>(`
    INSERT INTO public.pto_profiles (first_name, last_name)
    VALUES ('Chain', 'Tutor'), ('Chain', 'Tutor'), ('Chain', 'Tutor') RETURNING id
  `);
  const [first, second, third] = profiles.rows.map((row) => row.id);
  await pool.query(`INSERT INTO public.pto_profile_centers (profile_id, franchiseid, tutor_id)
    VALUES ($1, 10, 101), ($2, 20, 202), ($3, 30, 303)`, [first, second, third]);
  await pool.query('SELECT public.pto_get_or_create_cycle(id, CURRENT_DATE) FROM public.pto_profiles');
  const thirdCycle = await pool.query<{ id: string }>(`
    SELECT id FROM public.pto_entitlement_cycles WHERE profile_id = $1 AND CURRENT_DATE BETWEEN starts_on AND ends_on
  `, [third]);
  await pool.query(`INSERT INTO public.pto_ledger_entries
    (profile_id, cycle_id, event_type, balance_delta, idempotency_key, metadata)
    VALUES ($1, $2, 'adjustment', -1, 'chain-adjustment', '{"reason":"chain"}')`,
    [third, thirdCycle.rows[0].id]);
  const candidates = await pool.query<{ id: string }>(`
    INSERT INTO public.pto_profile_match_candidates (left_profile_id, right_profile_id)
    VALUES ($1, $2), ($2, $3), ($1, $3) RETURNING id
  `, [first, second, third]);
  await pool.query('SELECT public.pto_admin_decide_alias($1, $2, $3, $4)',
    [candidates.rows[0].id, 'confirm', 'admin-10', 10]);
  await pool.query('SELECT public.pto_admin_decide_alias($1, $2, $3, $4)',
    [candidates.rows[1].id, 'confirm', 'admin-30', 30]);
  const redundant = await pool.query<{ profile_id: string }>(
    'SELECT public.pto_admin_decide_alias($1, $2, $3, $4) AS profile_id',
    [candidates.rows[2].id, 'confirm', 'admin-20', 20]
  );

  const canonical = await pool.query<{ canonical_id: string }>(
    'SELECT public.pto_canonical_profile_id($1) AS canonical_id', [third]
  );
  const current = await pool.query<{ available_days: string; grant_count: string }>(
    'SELECT available_days::TEXT, grant_count::TEXT FROM public.pto_profile_balance($1, CURRENT_DATE)', [first]
  );
  assert.equal(canonical.rows[0].canonical_id, first);
  assert.equal(redundant.rows[0].profile_id, first);
  assert.deepEqual(current.rows[0], { available_days: '4.00', grant_count: '1' });
  const tutor = await createPostgresPtoStore(pool).getTutorProfile({ franchiseId: 30, tutorId: 303 });
  assert.equal(tutor.profile?.id, first);
});

test('split moves center allocations and provenance emails, creates one entitlement, and audits idempotently', { skip: !enabled }, async () => {
  assert.ok(pool);
  const profile = await pool.query<{ id: string }>(`
    INSERT INTO public.pto_profiles (first_name, last_name, identity_status)
    VALUES ('Split', 'Tutor', 'confirmed') RETURNING id
  `);
  const profileId = profile.rows[0].id;
  await pool.query('INSERT INTO public.pto_profile_centers (profile_id, franchiseid, tutor_id) VALUES ($1, 10, 10)', [profileId]);
  const membership = await pool.query<{ id: string }>(
    'INSERT INTO public.pto_profile_centers (profile_id, franchiseid, tutor_id) VALUES ($1, 20, 20) RETURNING id', [profileId]
  );
  await pool.query(`
    INSERT INTO public.pto_profile_emails (profile_id, franchiseid, email, source, source_membership_id)
    VALUES ($1, 20, 'split@example.com', 'crm', $2)
  `, [profileId, membership.rows[0].id]);
  const cycle = await pool.query<{ id: string }>('SELECT public.pto_get_or_create_cycle($1, CURRENT_DATE) AS id', [profileId]);
  const request = await pool.query<{ id: string }>(`
    INSERT INTO public.time_off_requests
      (franchiseid, tutorid, start_at, end_at, type, status, public_metadata)
    VALUES (20, 20, NOW(), NOW() + INTERVAL '1 day', 'pto', 'draft', '{}') RETURNING id
  `);
  const allocation = await pool.query<{ id: string }>(`
    INSERT INTO public.pto_request_allocations (request_id, cycle_id, charged_days, state)
    VALUES ($1, $2, 1, 'consumed') RETURNING id
  `, [request.rows[0].id, cycle.rows[0].id]);
  await pool.query(`
    INSERT INTO public.pto_ledger_entries
      (profile_id, cycle_id, request_id, allocation_id, event_type, balance_delta, reserved_delta, idempotency_key)
    VALUES ($1, $2, $3, $4, 'consume', -1, 0, 'consume:split-test')
  `, [profileId, cycle.rows[0].id, request.rows[0].id, allocation.rows[0].id]);

  const detached = await pool.query<{ profile_id: string }>(
    'SELECT public.pto_admin_detach_membership($1, $2, $3, $4) AS profile_id',
    [profileId, membership.rows[0].id, 'admin-10', 10]
  );
  const newProfileId = detached.rows[0].profile_id;
  const moved = await pool.query<{ profile_id: string; email_profile_id: string; grants: string }>(`
    SELECT cycle.profile_id, email.profile_id AS email_profile_id,
      (SELECT COUNT(*)::TEXT FROM public.pto_ledger_entries ledger
       WHERE ledger.profile_id = $1 AND ledger.event_type = 'grant') AS grants
    FROM public.pto_request_allocations allocation
    JOIN public.pto_entitlement_cycles cycle ON cycle.id = allocation.cycle_id
    JOIN public.pto_profile_emails email ON email.source_membership_id = $2
    WHERE allocation.id = $3
  `, [newProfileId, membership.rows[0].id, allocation.rows[0].id]);
  assert.deepEqual(moved.rows[0], { profile_id: newProfileId, email_profile_id: newProfileId, grants: '1' });
  const repeated = await pool.query<{ profile_id: string }>(
    'SELECT public.pto_admin_detach_membership($1, $2, $3, $4) AS profile_id',
    [profileId, membership.rows[0].id, 'admin-10', 10]
  );
  assert.equal(repeated.rows[0].profile_id, newProfileId);
  await assert.rejects(
    pool.query('SELECT public.pto_admin_detach_membership($1, $2, $3, $4)',
      [profileId, membership.rows[0].id, 'outsider', 99]),
    /not authorized/i
  );
  const audits = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::TEXT AS count FROM public.pto_audit_events WHERE event_type = 'membership_detached'"
  );
  assert.equal(audits.rows[0].count, '1');
});

test('PostgreSQL store syncs by stable tutor ID, preserves manual email, and never duplicates the cycle grant', { skip: !enabled }, async () => {
  assert.ok(pool);
  const store = createPostgresPtoStore(pool);
  const tutor = {
    id: 700, franchiseId: 70, firstName: 'Roster', lastName: 'Tutor',
    email: 'first@example.com', isDeleted: false
  };
  await store.runInTransaction((tx) => tx.syncRoster({
    franchiseId: 70, activate: true, actorId: 'admin-70', tutors: [tutor], discovery: discovery()
  }));
  const membership = await pool.query<{ id: string; profile_id: string }>(
    'SELECT id, profile_id FROM public.pto_profile_centers WHERE franchiseid = 70 AND tutor_id = 700'
  );
  await store.runInTransaction((tx) => tx.addEmail({
    profileId: membership.rows[0].profile_id,
    membershipId: membership.rows[0].id,
    email: 'manual@example.com', actorId: 'admin-70', actorFranchiseId: 70
  }));
  await store.runInTransaction((tx) => tx.syncRoster({
    franchiseId: 70, activate: false, actorId: 'admin-70',
    tutors: [{ ...tutor, email: 'updated@example.com' }], discovery: discovery()
  }));

  const stored = await pool.query<{ source: string; email: string }>(`
    SELECT source, email FROM public.pto_profile_emails
    WHERE profile_id = $1 AND active ORDER BY source, email
  `, [membership.rows[0].profile_id]);
  assert.deepEqual(stored.rows, [
    { source: 'crm', email: 'updated@example.com' },
    { source: 'manual', email: 'manual@example.com' }
  ]);
  const grants = await pool.query<{ count: string }>(`
    SELECT COUNT(*)::TEXT AS count FROM public.pto_ledger_entries
    WHERE profile_id = $1 AND event_type = 'grant'
  `, [membership.rows[0].profile_id]);
  assert.equal(grants.rows[0].count, '1');
});

test('discovery sync creates pending decisions without overwriting excluded or linked decisions', { skip: !enabled }, async () => {
  assert.ok(pool);
  const store = createPostgresPtoStore(pool);
  const localTutor = {
    id: 6801, franchiseId: 68, firstName: 'Ada', lastName: 'Lovelace',
    email: 'ada@center68.example', isDeleted: false
  };
  const remoteAccount = {
    id: 200, franchiseId: 2, firstName: 'Ada', lastName: 'Lovelace',
    email: 'ada@center2.example', isDeleted: false,
    provider: 'timecard-center:2', crmId: '200'
  };
  const sync = () => store.runInTransaction((tx) => tx.syncRoster({
    franchiseId: 68,
    activate: true,
    actorId: 'admin-68',
    tutors: [localTutor],
    discovery: discovery([remoteAccount])
  }));

  await sync();
  const account = await pool.query<{ id: string }>(`
    SELECT id FROM public.pto_discovered_tutor_accounts
    WHERE provider = 'timecard-center:2' AND crm_id = '200'
  `);
  const pending = await pool.query<{ status: string; version: number }>(`
    SELECT status, version FROM public.pto_profile_link_decisions WHERE account_id = $1
  `, [account.rows[0]?.id]);
  assert.deepEqual(pending.rows, [{ status: 'pending', version: 1 }]);

  await pool.query(`
    UPDATE public.pto_profile_link_decisions SET status = 'excluded', version = 7 WHERE account_id = $1
  `, [account.rows[0].id]);
  await sync();
  const excluded = await pool.query<{ status: string; version: number }>(`
    SELECT status, version FROM public.pto_profile_link_decisions WHERE account_id = $1
  `, [account.rows[0].id]);
  assert.deepEqual(excluded.rows, [{ status: 'excluded', version: 7 }]);

  await pool.query(`
    UPDATE public.pto_profile_link_decisions SET status = 'linked', version = 8 WHERE account_id = $1
  `, [account.rows[0].id]);
  await sync();
  const linked = await pool.query<{ status: string; version: number }>(`
    SELECT status, version FROM public.pto_profile_link_decisions WHERE account_id = $1
  `, [account.rows[0].id]);
  assert.deepEqual(linked.rows, [{ status: 'linked', version: 8 }]);

  const remoteMaterialization = await pool.query<{ memberships: string; cycles: string }>(`
    SELECT
      (SELECT COUNT(*)::TEXT FROM public.pto_profile_centers WHERE franchiseid = 2 AND tutor_id = 200) AS memberships,
      (SELECT COUNT(*)::TEXT FROM public.pto_entitlement_cycles cycle
       JOIN public.pto_profile_crm_ids crm ON crm.profile_id = cycle.profile_id
       WHERE crm.provider = 'timecard-center:2' AND crm.crm_id = '200') AS cycles
  `);
  assert.deepEqual(remoteMaterialization.rows[0], { memberships: '0', cycles: '0' });
});

test('candidate-owning center reads typed masked accounts and only its activation groups', { skip: !enabled }, async () => {
  assert.ok(pool);
  const store = createPostgresPtoStore(pool);
  const local = { id: 5101, franchiseId: 51, firstName: 'Candidate', lastName: 'Owner',
    email: 'local@center51.example', isDeleted: false };
  const remote = { id: 5202, franchiseId: 52, firstName: 'Candidate', lastName: 'Owner',
    email: 'remote@center52.example', isDeleted: false,
    provider: 'timecard-center:52', crmId: '5202' };
  await store.syncRoster({ franchiseId: 51, activate: true, actorId: 'admin-51',
    tutors: [local], discovery: discovery([remote]) });
  const profile = await pool.query<{ profile_id: string }>(`
    SELECT profile_id FROM public.pto_profile_centers WHERE franchiseid = 51 AND tutor_id = 5101
  `);
  const groupAdmin = await store.getAdminProfile({ franchiseId: 51, profileId: profile.rows[0].profile_id });
  const candidateAdmin = await store.getAdminProfile({ franchiseId: 52, profileId: profile.rows[0].profile_id });
  const unrelated = await store.getAdminProfile({ franchiseId: 99, profileId: profile.rows[0].profile_id });
  const groupAccounts = (groupAdmin as unknown as { accounts?: Array<Record<string, unknown>> })?.accounts;
  const candidateAccounts = (candidateAdmin as unknown as { accounts?: Array<Record<string, unknown>> })?.accounts;

  assert.equal(unrelated, null);
  assert.equal(groupAccounts?.length, 2);
  assert.equal(candidateAccounts?.length, 2);
  assert.equal(groupAccounts?.find((item) => item.franchiseId === 52)?.displayEmail, 'r***@center52.example');
  assert.equal(candidateAccounts?.find((item) => item.franchiseId === 52)?.displayEmail, 'remote@center52.example');
  assert.equal(candidateAccounts?.find((item) => item.franchiseId === 52)?.status, 'pending');

  const preview = await store.previewActivation(52, [{
    id: 5202, franchiseId: 52, firstName: 'Candidate', lastName: 'Owner',
    email: 'remote@center52.example', isDeleted: false
  }], discovery());
  const candidateGroups = (preview as unknown as {
    candidateGroups?: Array<{ profileId: string; account: { franchiseId: number; tutorId: number } }>;
  }).candidateGroups;
  assert.deepEqual(candidateGroups, [{
    profileId: profile.rows[0].profile_id,
    profileName: 'Candidate Owner',
    account: (candidateAccounts ?? []).find((item) => item.franchiseId === 52)
  }]);
});

test('dormant account link is authorized, idempotent, versioned, and reused by later activation', { skip: !enabled }, async () => {
  assert.ok(pool);
  const store = createPostgresPtoStore(pool);
  const localTutor = { id: 101, franchiseId: 1, firstName: 'Dormant', lastName: 'Tutor',
    email: 'one@example.com', isDeleted: false };
  const remoteAccount = { id: 202, franchiseId: 2, firstName: 'Dormant', lastName: 'Tutor',
    email: 'two@example.com', isDeleted: false, provider: 'timecard-center:2', crmId: '202' };
  await store.runInTransaction((tx) => tx.syncRoster({
    franchiseId: 1, activate: true, actorId: 'admin-1', tutors: [localTutor],
    discovery: discovery([remoteAccount])
  }));
  const rows = await pool.query<{ profile_id: string; account_id: string; version: number }>(`
    SELECT center.profile_id, account.id AS account_id, decision.version
    FROM public.pto_profile_centers center
    JOIN public.pto_profiles profile ON profile.id = center.profile_id
    JOIN public.pto_profile_link_decisions decision ON decision.profile_id = profile.id
    JOIN public.pto_discovered_tutor_accounts account ON account.id = decision.account_id
    WHERE center.franchiseid = 1 AND center.tutor_id = 101
      AND account.provider = 'timecard-center:2' AND account.crm_id = '202'
  `);
  const input = {
    profileId: rows.rows[0].profile_id,
    accountId: rows.rows[0].account_id,
    actorId: 'admin-1',
    actorFranchiseId: 1,
    expectedVersion: rows.rows[0].version,
    idempotencyKey: '00000000-0000-4000-8000-000000000001'
  };

  await assert.rejects(
    (store as never as { previewAccountLink(value: typeof input): Promise<unknown> })
      .previewAccountLink({ ...input, actorFranchiseId: 99 }),
    /not authorized|PTO_LINK_FORBIDDEN/i
  );
  const preview = await (store as never as {
    previewAccountLink(value: typeof input): Promise<{ mode: string; version: number; afterBalances: Array<{ availableDays: number }> }>;
  }).previewAccountLink(input);
  assert.equal(preview.mode, 'link');
  assert.equal(preview.version, 1);
  assert.equal(preview.afterBalances[0].availableDays, 5);

  const linked = await store.runInTransaction((tx) =>
    (tx as never as { linkAccount(value: typeof input): Promise<{ canonicalProfileId: string; decisionVersion: number }> })
      .linkAccount(input)
  );
  const repeated = await store.runInTransaction((tx) =>
    (tx as never as { linkAccount(value: typeof input): Promise<{ canonicalProfileId: string; decisionVersion: number }> })
      .linkAccount(input)
  );
  assert.deepEqual(repeated, linked);
  assert.equal(linked.canonicalProfileId, rows.rows[0].profile_id);
  assert.equal(linked.decisionVersion, 2);
  await assert.rejects(
    store.runInTransaction((tx) =>
      (tx as never as { linkAccount(value: typeof input): Promise<unknown> }).linkAccount({
        ...input, actorId: 'outsider', actorFranchiseId: 99
      })
    ),
    /PTO_LINK_FORBIDDEN|not authorized|idempotency/i
  );
  await assert.rejects(
    store.runInTransaction((tx) =>
      (tx as never as { linkAccount(value: typeof input): Promise<unknown> }).linkAccount({
        ...input, idempotencyKey: '00000000-0000-4000-8000-000000000002'
      })
    ),
    /PTO_LINK_STALE|stale/i
  );

  const dormant = await pool.query<{ profile_id: string; memberships: string; emails: string }>(`
    SELECT crm.profile_id,
      (SELECT COUNT(*)::TEXT FROM public.pto_profile_centers WHERE franchiseid = 2 AND tutor_id = 202) AS memberships,
      (SELECT COUNT(*)::TEXT FROM public.pto_profile_emails WHERE franchiseid = 2) AS emails
    FROM public.pto_profile_crm_ids crm
    WHERE crm.provider = 'timecard-center:2' AND crm.crm_id = '202'
  `);
  assert.deepEqual(dormant.rows[0], { profile_id: rows.rows[0].profile_id, memberships: '0', emails: '0' });

  const duplicateRemote = { ...remoteAccount, id: 203, crmId: '203', email: 'duplicate@example.com' };
  await store.syncRoster({ franchiseId: 1, activate: false, actorId: 'admin-1', tutors: [localTutor],
    discovery: discovery([remoteAccount, duplicateRemote]) });
  const duplicateDecision = await pool.query<{ account_id: string; version: number }>(`
    SELECT decision.account_id, decision.version
    FROM public.pto_profile_link_decisions decision
    JOIN public.pto_discovered_tutor_accounts account ON account.id = decision.account_id
    WHERE decision.profile_id = $1 AND account.franchiseid = 2 AND account.tutor_id = 203
  `, [rows.rows[0].profile_id]);
  await assert.rejects(
    store.runInTransaction((tx) =>
      (tx as never as { linkAccount(value: typeof input): Promise<unknown> }).linkAccount({
        ...input,
        accountId: duplicateDecision.rows[0].account_id,
        expectedVersion: duplicateDecision.rows[0].version,
        idempotencyKey: '00000000-0000-4000-8000-000000000004'
      })
    ),
    /PTO_CENTER_ACCOUNT_CONFLICT|center.*linked account/i
  );

  await store.runInTransaction((tx) => tx.syncRoster({
    franchiseId: 2, activate: true, actorId: 'admin-2', tutors: [{
      id: 202, franchiseId: 2, firstName: 'Dormant', lastName: 'Tutor',
      email: 'two@example.com', isDeleted: false
    }], discovery: discovery()
  }));
  const activated = await pool.query<{ canonical_profile_id: string; grants: string }>(`
    SELECT public.pto_canonical_profile_id(center.profile_id) AS canonical_profile_id,
      (SELECT COUNT(*)::TEXT FROM public.pto_ledger_entries ledger
       WHERE public.pto_canonical_profile_id(ledger.profile_id) = public.pto_canonical_profile_id(center.profile_id)
         AND ledger.event_type = 'grant') AS grants
    FROM public.pto_profile_centers center WHERE center.franchiseid = 2 AND center.tutor_id = 202
  `);
  assert.deepEqual(activated.rows[0], { canonical_profile_id: rows.rows[0].profile_id, grants: '1' });
});

test('linking active profiles retains one grant and previews a negative merged balance', { skip: !enabled }, async () => {
  assert.ok(pool);
  const store = createPostgresPtoStore(pool);
  const first = { id: 1001, franchiseId: 10, firstName: 'Active', lastName: 'Merge',
    email: 'first@example.com', isDeleted: false };
  const second = { id: 2002, franchiseId: 20, firstName: 'Active', lastName: 'Merge',
    email: 'second@example.com', isDeleted: false };
  await store.syncRoster({ franchiseId: 10, activate: true, actorId: 'admin-10',
    tutors: [first], discovery: discovery() });
  await store.syncRoster({ franchiseId: 20, activate: true, actorId: 'admin-20',
    tutors: [second], discovery: discovery() });
  const profiles = await pool.query<{ profile_id: string; franchiseid: number; membership_id: string }>(`
    SELECT profile_id, franchiseid, id AS membership_id FROM public.pto_profile_centers
    WHERE franchiseid IN (10, 20) ORDER BY franchiseid
  `);
  await store.adjustBalance({
    profileId: profiles.rows[1].profile_id,
    membershipId: profiles.rows[1].membership_id,
    cycleStart: `${new Date().getUTCFullYear()}-01-01`,
    deltaDays: -6,
    reason: 'Imported usage',
    actorId: 'admin-20',
    actorFranchiseId: 20
  });
  const remote = { ...second, provider: 'timecard-center:20', crmId: '2002' };
  await store.syncRoster({ franchiseId: 10, activate: false, actorId: 'admin-10',
    tutors: [first], discovery: discovery([remote]) });
  const decision = await pool.query<{ account_id: string; version: number }>(`
    SELECT decision.account_id, decision.version
    FROM public.pto_profile_link_decisions decision
    JOIN public.pto_discovered_tutor_accounts account ON account.id = decision.account_id
    WHERE decision.profile_id = $1 AND account.franchiseid = 20 AND account.tutor_id = 2002
  `, [profiles.rows[0].profile_id]);
  const input = {
    profileId: profiles.rows[0].profile_id,
    accountId: decision.rows[0].account_id,
    actorId: 'admin-20',
    actorFranchiseId: 20,
    expectedVersion: decision.rows[0].version,
    idempotencyKey: '00000000-0000-4000-8000-000000000003'
  };
  const preview = await (store as never as {
    previewAccountLink(value: typeof input): Promise<{ afterBalances: Array<{ availableDays: number }>; warnings: string[] }>;
  }).previewAccountLink(input);
  assert.equal(preview.afterBalances[0].availableDays, -1);
  assert.ok(preview.warnings.some((warning) => /negative/i.test(warning)));
  const result = await store.runInTransaction((tx) =>
    (tx as never as { linkAccount(value: typeof input): Promise<{ canonicalProfileId: string }> }).linkAccount(input)
  );
  const merged = await pool.query<{ centers: number[]; available_days: string; grant_count: string }>(`
    SELECT ARRAY_AGG(center.franchiseid ORDER BY center.franchiseid) AS centers,
      balance.available_days::TEXT, balance.grant_count::TEXT
    FROM public.pto_profile_centers center
    CROSS JOIN LATERAL public.pto_profile_balance($1, CURRENT_DATE) balance
    WHERE public.pto_canonical_profile_id(center.profile_id) = $1
    GROUP BY balance.available_days, balance.grant_count
  `, [result.canonicalProfileId]);
  assert.deepEqual(merged.rows[0], { centers: [10, 20], available_days: '-1.00', grant_count: '1' });
});

test('adjustment provenance is required for new writes and reconciles legacy split blockers', { skip: !enabled }, async () => {
  assert.ok(pool);
  const store = createPostgresPtoStore(pool);
  const tutor = { id: 3030, franchiseId: 30, firstName: 'Provenance', lastName: 'Tutor',
    email: 'provenance@example.com', isDeleted: false };
  await store.syncRoster({ franchiseId: 30, activate: true, actorId: 'admin-30',
    tutors: [tutor], discovery: discovery() });
  const membership = await pool.query<{ id: string; profile_id: string }>(`
    SELECT id, profile_id FROM public.pto_profile_centers WHERE franchiseid = 30 AND tutor_id = 3030
  `);
  const cycleStart = `${new Date().getUTCFullYear()}-01-01`;
  const adjustmentInput = {
    profileId: membership.rows[0].profile_id,
    membershipId: membership.rows[0].id,
    cycleStart,
    deltaDays: 0.5,
    reason: 'Center correction',
    actorId: 'admin-30',
    actorFranchiseId: 30
  };
  const adjustment = await (store.adjustBalance as never as {
    (input: typeof adjustmentInput): Promise<{ ledgerEntryId: string }>;
  })(adjustmentInput);
  const attributed = await pool.query<{ source_membership_id: string | null }>(`
    SELECT source_membership_id FROM public.pto_ledger_entries WHERE id = $1
  `, [adjustment.ledgerEntryId]);
  assert.equal(attributed.rows[0].source_membership_id, membership.rows[0].id);

  const cycle = await pool.query<{ id: string }>(`
    SELECT id FROM public.pto_entitlement_cycles WHERE profile_id = $1 AND starts_on = $2::DATE
  `, [membership.rows[0].profile_id, cycleStart]);
  const legacy = await pool.query<{ id: string }>(`
    INSERT INTO public.pto_ledger_entries
      (profile_id, cycle_id, event_type, balance_delta, idempotency_key, metadata)
    VALUES ($1, $2, 'adjustment', -0.5, 'legacy:ambiguous-adjustment', '{"reason":"legacy import"}')
    RETURNING id
  `, [membership.rows[0].profile_id, cycle.rows[0].id]);
  const accountDecision = await pool.query<{ account_id: string; version: number }>(`
    SELECT decision.account_id, decision.version
    FROM public.pto_profile_link_decisions decision
    JOIN public.pto_discovered_tutor_accounts account ON account.id = decision.account_id
    WHERE decision.profile_id = $1 AND account.franchiseid = 30 AND account.tutor_id = 3030
  `, [membership.rows[0].profile_id]);
  const unlinkInput = {
    profileId: membership.rows[0].profile_id,
    accountId: accountDecision.rows[0].account_id,
    actorId: 'admin-30',
    actorFranchiseId: 30,
    expectedVersion: accountDecision.rows[0].version,
    idempotencyKey: '00000000-0000-4000-8000-000000000010'
  };
  const preview = await (store as never as {
    previewAccountUnlink(value: typeof unlinkInput): Promise<{ ambiguousAdjustmentIds: string[] }>;
  }).previewAccountUnlink(unlinkInput);
  assert.deepEqual(preview.ambiguousAdjustmentIds, [legacy.rows[0].id]);
  await assert.rejects(
    store.runInTransaction((tx) =>
      (tx as never as { unlinkAccount(value: typeof unlinkInput): Promise<unknown> }).unlinkAccount(unlinkInput)
    ),
    /PTO_SPLIT_RECONCILIATION_REQUIRED|reconciliation/i
  );

  const provenanceInput = {
    profileId: membership.rows[0].profile_id,
    ledgerEntryId: legacy.rows[0].id,
    membershipId: membership.rows[0].id,
    actorId: 'admin-30',
    actorFranchiseId: 30,
    idempotencyKey: '00000000-0000-4000-8000-000000000011'
  };
  await assert.rejects(
    store.runInTransaction((tx) =>
      (tx as never as { assignAdjustmentProvenance(value: typeof provenanceInput): Promise<unknown> })
        .assignAdjustmentProvenance({ ...provenanceInput, actorFranchiseId: 99 })
    ),
    /not authorized|PTO_LINK_FORBIDDEN/i
  );
  await store.runInTransaction((tx) =>
    (tx as never as { assignAdjustmentProvenance(value: typeof provenanceInput): Promise<unknown> })
      .assignAdjustmentProvenance(provenanceInput)
  );
  const reconciled = await pool.query<{ source_membership_id: string | null }>(`
    SELECT source_membership_id FROM public.pto_ledger_entries WHERE id = $1
  `, [legacy.rows[0].id]);
  assert.equal(reconciled.rows[0].source_membership_id, membership.rows[0].id);
});

test('turning off a dormant linked account excludes it without creating a profile or grant', { skip: !enabled }, async () => {
  assert.ok(pool);
  const store = createPostgresPtoStore(pool);
  const local = { id: 4101, franchiseId: 41, firstName: 'Dormant', lastName: 'Optout',
    email: 'local@example.com', isDeleted: false };
  const remote = { id: 4202, franchiseId: 42, firstName: 'Dormant', lastName: 'Optout',
    email: 'remote@example.com', isDeleted: false, provider: 'timecard-center:42', crmId: '4202' };
  await store.syncRoster({ franchiseId: 41, activate: true, actorId: 'admin-41',
    tutors: [local], discovery: discovery([remote]) });
  const candidate = await pool.query<{ profile_id: string; account_id: string; version: number }>(`
    SELECT decision.profile_id, decision.account_id, decision.version
    FROM public.pto_profile_link_decisions decision
    JOIN public.pto_discovered_tutor_accounts account ON account.id = decision.account_id
    WHERE account.franchiseid = 42 AND account.tutor_id = 4202
  `);
  const linkInput = { profileId: candidate.rows[0].profile_id, accountId: candidate.rows[0].account_id,
    actorId: 'admin-41', actorFranchiseId: 41, expectedVersion: candidate.rows[0].version,
    idempotencyKey: '00000000-0000-4000-8000-000000000012' };
  const linked = await store.runInTransaction((tx) => tx.linkAccount(linkInput));
  const unlinkInput = { ...linkInput, expectedVersion: linked.decisionVersion,
    idempotencyKey: '00000000-0000-4000-8000-000000000013' };
  const preview = await (store as never as {
    previewAccountUnlink(value: typeof unlinkInput): Promise<{ mode: string; affectedRequestIds: string[] }>;
  }).previewAccountUnlink(unlinkInput);
  assert.equal(preview.mode, 'unlink');
  assert.deepEqual(preview.affectedRequestIds, []);
  const result = await store.runInTransaction((tx) =>
    (tx as never as { unlinkAccount(value: typeof unlinkInput): Promise<{ detachedProfileId: string | null; decisionVersion: number }> })
      .unlinkAccount(unlinkInput)
  );
  assert.equal(result.detachedProfileId, null);
  assert.equal(result.decisionVersion, 3);
  const durable = await pool.query<{ status: string; version: number; identities: string; profiles: string }>(`
    SELECT decision.status, decision.version,
      (SELECT COUNT(*)::TEXT FROM public.pto_profile_crm_ids
       WHERE provider = 'timecard-center:42' AND crm_id = '4202') AS identities,
      (SELECT COUNT(*)::TEXT FROM public.pto_profiles) AS profiles
    FROM public.pto_profile_link_decisions decision WHERE decision.account_id = $1
  `, [candidate.rows[0].account_id]);
  assert.deepEqual(durable.rows[0], { status: 'excluded', version: 3, identities: '0', profiles: '1' });
});

test('three-center account opt-out moves attributable activity with compensating history', { skip: !enabled }, async () => {
  assert.ok(pool);
  const store = createPostgresPtoStore(pool);
  await pool.query(`INSERT INTO public.pto_center_settings (franchiseid, enabled)
    VALUES (1, TRUE), (2, TRUE), (3, TRUE)`);
  const profile = await pool.query<{ id: string }>(`
    INSERT INTO public.pto_profiles (first_name, last_name, identity_status)
    VALUES ('Three', 'Center', 'confirmed') RETURNING id
  `);
  const profileId = profile.rows[0].id;
  const memberships = await pool.query<{ id: string; franchiseid: number }>(`
    INSERT INTO public.pto_profile_centers (profile_id, franchiseid, tutor_id, active)
    VALUES ($1, 1, 100, TRUE), ($1, 2, 200, TRUE), ($1, 3, 300, TRUE)
    RETURNING id, franchiseid
  `, [profileId]);
  const thirdMembership = memberships.rows.find((item) => item.franchiseid === 3);
  assert.ok(thirdMembership);
  await pool.query(`INSERT INTO public.pto_profile_crm_ids (profile_id, provider, crm_id)
    VALUES ($1, 'timecard-center:1', '100'), ($1, 'timecard-center:2', '200'),
      ($1, 'timecard-center:3', '300')`, [profileId]);
  const accounts = await pool.query<{ id: string; franchiseid: number }>(`
    INSERT INTO public.pto_discovered_tutor_accounts
      (provider, crm_id, franchiseid, tutor_id, normalized_first_name, normalized_last_name, crm_snapshot)
    VALUES
      ('timecard-center:1', '100', 1, 100, 'three', 'center', '{"firstName":"Three","lastName":"Center"}'),
      ('timecard-center:2', '200', 2, 200, 'three', 'center', '{"firstName":"Three","lastName":"Center"}'),
      ('timecard-center:3', '300', 3, 300, 'three', 'center', '{"firstName":"Three","lastName":"Center"}')
    RETURNING id, franchiseid
  `);
  await pool.query(`INSERT INTO public.pto_profile_link_decisions
    (profile_id, account_id, status, decided_by, decision_franchiseid, decided_at)
    SELECT $1, id, 'linked', 'seed', franchiseid, NOW()
    FROM public.pto_discovered_tutor_accounts`, [profileId]);
  await pool.query(`INSERT INTO public.pto_profile_emails
    (profile_id, franchiseid, email, source, source_membership_id)
    VALUES ($1, 3, 'three@example.com', 'manual', $2)`, [profileId, thirdMembership.id]);
  const cycle = await pool.query<{ id: string }>(
    'SELECT public.pto_get_or_create_cycle($1, CURRENT_DATE) AS id', [profileId]
  );
  const requests = await pool.query<{ id: string }>(`
    INSERT INTO public.time_off_requests
      (franchiseid, tutorid, first_name, last_name, email, start_at, end_at, type, status, partial_day, public_metadata)
    VALUES
      (3, 300, 'Three', 'Center', 'three@example.com', NOW(), NOW(), 'pto', 'draft', FALSE, '{}'),
      (3, 300, 'Three', 'Center', 'three@example.com', NOW(), NOW(), 'pto', 'draft', FALSE, '{}')
    RETURNING id
  `);
  const allocations = await pool.query<{ id: string; request_id: string; state: string }>(`
    INSERT INTO public.pto_request_allocations (request_id, cycle_id, charged_days, state)
    VALUES ($1, $3, 0.5, 'reserved'), ($2, $3, 0.5, 'consumed')
    RETURNING id, request_id, state
  `, [requests.rows[0].id, requests.rows[1].id, cycle.rows[0].id]);
  const reserved = allocations.rows.find((item) => item.state === 'reserved');
  const consumed = allocations.rows.find((item) => item.state === 'consumed');
  assert.ok(reserved);
  assert.ok(consumed);
  await pool.query(`
    INSERT INTO public.pto_ledger_entries
      (profile_id, cycle_id, request_id, allocation_id, event_type, balance_delta,
       reserved_delta, idempotency_key, metadata, source_membership_id)
    VALUES
      ($1, $2, $3, $4, 'reserve', 0, 0.5, 'seed:reserve', '{}', NULL),
      ($1, $2, $5, $6, 'reserve', 0, 0.5, 'seed:consume-reserve', '{}', NULL),
      ($1, $2, $5, $6, 'consume', -0.5, -0.5, 'seed:consume', '{}', NULL),
      ($1, $2, NULL, NULL, 'adjustment', 1, 0, 'seed:center3-adjustment',
       '{"reason":"center correction"}', $7)
  `, [profileId, cycle.rows[0].id, reserved.request_id, reserved.id,
    consumed.request_id, consumed.id, thirdMembership.id]);
  const beforeCounts = await pool.query<{ ledger: string; audit: string }>(`
    SELECT (SELECT COUNT(*)::TEXT FROM public.pto_ledger_entries) AS ledger,
      (SELECT COUNT(*)::TEXT FROM public.pto_audit_events) AS audit
  `);
  const thirdAccount = accounts.rows.find((item) => item.franchiseid === 3);
  assert.ok(thirdAccount);
  const input = { profileId, accountId: thirdAccount.id, actorId: 'admin-2', actorFranchiseId: 2,
    expectedVersion: 1, idempotencyKey: '00000000-0000-4000-8000-000000000014' };
  const preview = await (store as never as {
    previewAccountUnlink(value: typeof input): Promise<{
      affectedRequestIds: string[]; ambiguousAdjustmentIds: string[]; afterBalances: Array<{ availableDays: number }>;
    }>;
  }).previewAccountUnlink(input);
  assert.deepEqual(preview.affectedRequestIds.sort(), requests.rows.map((item) => item.id).sort());
  assert.deepEqual(preview.ambiguousAdjustmentIds, []);
  assert.deepEqual(preview.afterBalances.map((item) => item.availableDays).sort(), [5, 5]);
  const result = await store.runInTransaction((tx) =>
    (tx as never as { unlinkAccount(value: typeof input): Promise<{ canonicalProfileId: string; detachedProfileId: string }> })
      .unlinkAccount(input)
  );

  const oldCenters = await pool.query<{ franchiseid: number }>(`
    SELECT franchiseid FROM public.pto_profile_centers
    WHERE public.pto_canonical_profile_id(profile_id) = $1 ORDER BY franchiseid
  `, [result.canonicalProfileId]);
  const newCenters = await pool.query<{ franchiseid: number }>(`
    SELECT franchiseid FROM public.pto_profile_centers WHERE profile_id = $1 ORDER BY franchiseid
  `, [result.detachedProfileId]);
  assert.deepEqual(oldCenters.rows.map((item) => item.franchiseid), [1, 2]);
  assert.deepEqual(newCenters.rows.map((item) => item.franchiseid), [3]);
  const balances = await pool.query<{ profile_id: string; granted_days: string; balance_days: string; reserved_days: string }>(`
    SELECT requested.profile_id::TEXT,
      balance.granted_days::TEXT, balance.balance_days::TEXT, balance.reserved_days::TEXT
    FROM UNNEST($1::BIGINT[]) requested(profile_id)
    CROSS JOIN LATERAL public.pto_profile_balance(requested.profile_id, CURRENT_DATE) balance
    ORDER BY requested.profile_id
  `, [[result.canonicalProfileId, result.detachedProfileId]]);
  const oldBalance = balances.rows.find((item) => item.profile_id === result.canonicalProfileId);
  const newBalance = balances.rows.find((item) => item.profile_id === result.detachedProfileId);
  assert.deepEqual(oldBalance, { profile_id: result.canonicalProfileId,
    granted_days: '5.00', balance_days: '5.00', reserved_days: '0.00' });
  assert.deepEqual(newBalance, { profile_id: result.detachedProfileId,
    granted_days: '5.00', balance_days: '5.50', reserved_days: '0.50' });
  const movement = await pool.query<{ profile_id: string; event_type: string }>(`
    SELECT profile_id::TEXT, event_type FROM public.pto_ledger_entries
    WHERE idempotency_key LIKE 'split-%' OR idempotency_key LIKE 'account-split:%' ORDER BY id
  `);
  assert.ok(movement.rows.some((item) => item.profile_id === result.canonicalProfileId && item.event_type === 'release'));
  assert.ok(movement.rows.some((item) => item.profile_id === result.detachedProfileId && item.event_type === 'reserve'));
  assert.ok(movement.rows.some((item) => item.profile_id === result.detachedProfileId && item.event_type === 'consume'));
  assert.ok(movement.rows.some((item) => item.profile_id === result.detachedProfileId && item.event_type === 'adjustment'));
  const afterCounts = await pool.query<{ ledger: string; audit: string }>(`
    SELECT (SELECT COUNT(*)::TEXT FROM public.pto_ledger_entries) AS ledger,
      (SELECT COUNT(*)::TEXT FROM public.pto_audit_events) AS audit
  `);
  assert.ok(Number(afterCounts.rows[0].ledger) > Number(beforeCounts.rows[0].ledger));
  assert.ok(Number(afterCounts.rows[0].audit) > Number(beforeCounts.rows[0].audit));
});

test('PostgreSQL store rejects center email ambiguity and audits authorized negative adjustments', { skip: !enabled }, async () => {
  assert.ok(pool);
  const store = createPostgresPtoStore(pool);
  const profiles = await pool.query<{ id: string }>(`
    INSERT INTO public.pto_profiles (first_name, last_name, identity_status)
    VALUES ('Email', 'One', 'confirmed'), ('Email', 'Two', 'confirmed') RETURNING id
  `);
  const memberships = await pool.query<{ id: string; profile_id: string }>(`
    INSERT INTO public.pto_profile_centers (profile_id, franchiseid, tutor_id)
    VALUES ($1, 80, 801), ($2, 80, 802) RETURNING id, profile_id
  `, [profiles.rows[0].id, profiles.rows[1].id]);
  await store.addEmail({ profileId: profiles.rows[0].id, membershipId: memberships.rows[0].id,
    email: 'ambiguous@example.com', actorId: 'admin-80', actorFranchiseId: 80 });
  await assert.rejects(
    store.addEmail({ profileId: profiles.rows[1].id, membershipId: memberships.rows[1].id,
      email: 'ambiguous@example.com', actorId: 'admin-80', actorFranchiseId: 80 }),
    /ambiguous/i
  );
  await store.adjustBalance({
    profileId: profiles.rows[0].id, membershipId: memberships.rows[0].id,
    cycleStart: new Date().getUTCFullYear() + '-01-01', deltaDays: -5.5,
    reason: 'Opening balance correction', actorId: 'admin-80', actorFranchiseId: 80
  });
  const balance = await pool.query<{ available_days: string }>(
    'SELECT available_days::TEXT FROM public.pto_profile_balance($1, CURRENT_DATE)', [profiles.rows[0].id]
  );
  assert.equal(Number(balance.rows[0].available_days), -0.5);
  const events = await pool.query<{ event_type: string }>(`
    SELECT event_type FROM public.pto_audit_events WHERE profile_id = $1 ORDER BY id
  `, [profiles.rows[0].id]);
  assert.deepEqual(events.rows.map((row) => row.event_type), ['email_added', 'balance_adjusted']);
});

test('merged profiles compete for one grant through the actual reservation path', { skip: !enabled }, async () => {
  const db = pool;
  assert.ok(db);
  await db.query('INSERT INTO public.pto_center_settings (franchiseid, enabled) VALUES (10, TRUE), (20, TRUE)');
  const profiles = await db.query<{ id: string }>(`
    INSERT INTO public.pto_profiles (first_name, last_name, identity_status)
    VALUES ('Reserve', 'Shared', 'confirmed'), ('Reserve', 'Shared', 'pending') RETURNING id
  `);
  const [first, second] = profiles.rows.map((row) => row.id);
  await db.query(`INSERT INTO public.pto_profile_centers (profile_id, franchiseid, tutor_id)
    VALUES ($1, 10, 101), ($2, 20, 202)`, [first, second]);
  await db.query(`INSERT INTO public.pto_profile_crm_ids (profile_id, provider, crm_id)
    VALUES ($1, 'timecard-center:10', '101'), ($2, 'timecard-center:20', '202')`, [first, second]);
  const candidate = await db.query<{ id: string }>(`
    INSERT INTO public.pto_profile_match_candidates (left_profile_id, right_profile_id)
    VALUES ($1, $2) RETURNING id
  `, [first, second]);
  await db.query('SELECT public.pto_admin_decide_alias($1, $2, $3, $4)',
    [candidate.rows[0].id, 'confirm', 'admin-10', 10]);
  const requests = await db.query<{ id: string; franchiseid: number; tutorid: string; created_at: Date }>(`
    INSERT INTO public.time_off_requests
      (franchiseid, tutorid, first_name, last_name, email, start_at, end_at, type, status, partial_day, public_metadata)
    VALUES
      (10, 101, 'Reserve', 'Shared', 'one@example.com', NOW(), NOW(), 'pto', 'draft', FALSE, '{}'),
      (20, 202, 'Reserve', 'Shared', 'two@example.com', NOW(), NOW(), 'pto', 'draft', FALSE, '{}')
    RETURNING id, franchiseid, tutorid, created_at
  `);
  const reserve = (row: typeof requests.rows[number]) => db.query(`
    SELECT public.pto_reserve_request(
      $1, $2, $3, NULL, $4, 'authenticated', 'Reserve', 'Shared', $5,
      DATE '2026-08-17', DATE '2026-08-19', FALSE, 72
    )
  `, [row.id, row.franchiseid, row.tutorid, `${row.franchiseid}@example.com`, row.created_at]);

  await reserve(requests.rows[0]);
  await assert.rejects(reserve(requests.rows[1]), /Insufficient shared PTO balance/);
  const allocations = await db.query<{ profile_id: string; charged_days: string }>(`
    SELECT cycle.profile_id, SUM(allocation.charged_days)::TEXT AS charged_days
    FROM public.pto_request_allocations allocation
    JOIN public.pto_entitlement_cycles cycle ON cycle.id = allocation.cycle_id
    GROUP BY cycle.profile_id
  `);
  assert.deepEqual(allocations.rows, [{ profile_id: first, charged_days: '3.00' }]);
});

test('deleted and missing CRM tutors cannot resolve public PTO identity after sync', { skip: !enabled }, async () => {
  const db = pool;
  assert.ok(db);
  const store = createPostgresPtoStore(db);
  const tutor = { id: 404, franchiseId: 40, firstName: 'Inactive', lastName: 'Tutor',
    email: 'inactive@example.com', isDeleted: false };
  await store.syncRoster({ franchiseId: 40, activate: true, actorId: 'admin-40',
    tutors: [tutor], discovery: discovery() });
  const resolvePublic = () => db.query(`SELECT public.pto_resolve_profile(
    40, NULL, NULL, 'inactive@example.com', 'public', 'Inactive', 'Tutor'
  )`);
  const resolveAuthenticated = () => db.query(`SELECT public.pto_resolve_profile(
    40, 404, NULL, 'inactive@example.com', 'authenticated', 'Inactive', 'Tutor'
  )`);
  const membershipIsActive = async (): Promise<boolean> => Boolean((await db.query<{ active: boolean }>(`
    SELECT active FROM public.pto_profile_centers WHERE franchiseid = 40 AND tutor_id = 404
  `)).rows[0].active);

  await resolveAuthenticated();
  assert.equal(await membershipIsActive(), true);

  await store.syncRoster({ franchiseId: 40, activate: false, actorId: 'admin-40',
    tutors: [{ ...tutor, isDeleted: true }], discovery: discovery() });
  await assert.rejects(resolveAuthenticated, /active CRM membership/i);
  assert.equal(await membershipIsActive(), false);
  await assert.rejects(resolvePublic, /exactly one active profile/);

  await store.syncRoster({ franchiseId: 40, activate: false, actorId: 'admin-40',
    tutors: [tutor], discovery: discovery() });
  await store.syncRoster({ franchiseId: 40, activate: false, actorId: 'admin-40',
    tutors: [], discovery: discovery() });
  const request = await db.query<{ id: string; created_at: Date }>(`
    INSERT INTO public.time_off_requests
      (franchiseid, tutorid, first_name, last_name, email, start_at, end_at, type, status, partial_day, public_metadata)
    VALUES (40, 404, 'Inactive', 'Tutor', 'inactive@example.com', NOW(), NOW(), 'pto', 'draft', FALSE, '{}')
    RETURNING id, created_at
  `);
  await assert.rejects(db.query(`SELECT public.pto_reserve_request(
    $1, 40, 404, NULL, 'inactive@example.com', 'authenticated', 'Inactive', 'Tutor', $2,
    DATE '2026-08-17', DATE '2026-08-17', FALSE, 24
  )`, [request.rows[0].id, request.rows[0].created_at]), /active CRM membership/i);
  assert.equal(await membershipIsActive(), false);
  const allocations = await db.query<{ count: string }>(`
    SELECT COUNT(*)::TEXT AS count FROM public.pto_request_allocations WHERE request_id = $1
  `, [request.rows[0].id]);
  assert.equal(allocations.rows[0].count, '0');
  await assert.rejects(resolvePublic, /exactly one active profile/);
});

test('legacy email provenance and CRM identity follow a detached membership through its next sync', { skip: !enabled }, async () => {
  assert.ok(pool);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await pool.query(`CREATE TABLE public.time_off_requests (
    id BIGSERIAL PRIMARY KEY, franchiseid INTEGER NOT NULL, tutorid BIGINT,
    bridge_flag BOOLEAN, bridge_profile_id BIGINT, first_name TEXT, last_name TEXT, email TEXT,
    start_at TIMESTAMPTZ NOT NULL, end_at TIMESTAMPTZ NOT NULL, type TEXT NOT NULL,
    status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), duration_hours NUMERIC,
    partial_day BOOLEAN, leave_time TIME, return_time TIME, public_metadata JSONB
  )`);
  await pool.query(migrations[0]);
  const profile = await pool.query<{ id: string }>(`
    INSERT INTO public.pto_profiles (first_name, last_name, identity_status)
    VALUES ('Legacy', 'Tutor', 'confirmed') RETURNING id
  `);
  const profileId = profile.rows[0].id;
  await pool.query(`INSERT INTO public.pto_profile_centers (profile_id, franchiseid)
    VALUES ($1, 50), ($1, 51)`, [profileId]);
  await pool.query(`INSERT INTO public.pto_profile_crm_ids (profile_id, provider, crm_id)
    VALUES ($1, 'timecard-center:51', '5151')`, [profileId]);
  await pool.query(`INSERT INTO public.pto_profile_emails (profile_id, franchiseid, email)
    VALUES ($1, 51, 'legacy@example.com')`, [profileId]);
  await pool.query(migrations[1]);
  await pool.query(migrations[2]);
  const membership = await pool.query<{ id: string }>(
    'SELECT id FROM public.pto_profile_centers WHERE profile_id = $1 AND franchiseid = 51', [profileId]
  );
  const detached = await pool.query<{ profile_id: string }>(
    'SELECT public.pto_admin_detach_membership($1, $2, $3, $4) AS profile_id',
    [profileId, membership.rows[0].id, 'admin-50', 50]
  );
  const detachedId = detached.rows[0].profile_id;
  const store = createPostgresPtoStore(pool);
  await store.runInTransaction((tx) => tx.syncRoster({
    franchiseId: 51, activate: true, actorId: 'admin-51', tutors: [{
      id: 5151, franchiseId: 51, firstName: 'Legacy', lastName: 'Tutor',
      email: 'updated@example.com', isDeleted: false
    }], discovery: discovery()
  }));
  const durable = await pool.query<{ crm_profile: string; email_profile: string; source_membership_id: string }>(`
    SELECT crm.profile_id AS crm_profile, email.profile_id AS email_profile, email.source_membership_id
    FROM public.pto_profile_crm_ids crm
    JOIN public.pto_profile_emails email ON email.email = 'legacy@example.com'
    WHERE crm.provider = 'timecard-center:51' AND crm.crm_id = '5151'
  `);
  assert.deepEqual(durable.rows[0], {
    crm_profile: detachedId,
    email_profile: detachedId,
    source_membership_id: membership.rows[0].id
  });
});

test('manual email survives a CRM collision and ambiguity is checked across every canonical linked center', { skip: !enabled }, async () => {
  assert.ok(pool);
  const store = createPostgresPtoStore(pool);
  await store.runInTransaction((tx) => tx.syncRoster({
    franchiseId: 60, activate: true, actorId: 'admin-60', tutors: [{
      id: 6060, franchiseId: 60, firstName: 'Collision', lastName: 'Tutor',
      email: 'same@example.com', isDeleted: false
    }], discovery: discovery()
  }));
  const member = await pool.query<{ id: string; profile_id: string }>(
    'SELECT id, profile_id FROM public.pto_profile_centers WHERE franchiseid = 60 AND tutor_id = 6060'
  );
  await store.addEmail({ profileId: member.rows[0].profile_id, membershipId: member.rows[0].id,
    email: 'same@example.com', actorId: 'admin-60', actorFranchiseId: 60 });
  await store.syncRoster({ franchiseId: 60, activate: false, actorId: 'admin-60', tutors: [{
    id: 6060, franchiseId: 60, firstName: 'Collision', lastName: 'Tutor',
    email: 'changed@example.com', isDeleted: false
  }], discovery: discovery() });
  const collision = await pool.query<{ email: string; source: string; active: boolean }>(`
    SELECT email, source, active FROM public.pto_profile_emails
    WHERE profile_id = $1 ORDER BY email, source
  `, [member.rows[0].profile_id]);
  assert.deepEqual(collision.rows, [
    { email: 'changed@example.com', source: 'crm', active: true },
    { email: 'same@example.com', source: 'crm', active: false },
    { email: 'same@example.com', source: 'manual', active: true }
  ]);

  const other = await pool.query<{ id: string }>(`
    INSERT INTO public.pto_profiles (first_name, last_name, identity_status)
    VALUES ('Other', 'Tutor', 'confirmed') RETURNING id
  `);
  await pool.query(`INSERT INTO public.pto_profile_centers (profile_id, franchiseid, tutor_id)
    VALUES ($1, 61, 6161), ($2, 61, 6162)`, [member.rows[0].profile_id, other.rows[0].id]);
  const otherMembership = await pool.query<{ id: string }>(
    'SELECT id FROM public.pto_profile_centers WHERE profile_id = $1 AND franchiseid = 61', [other.rows[0].id]
  );
  await pool.query(`INSERT INTO public.pto_profile_emails (profile_id, franchiseid, email, source, source_membership_id)
    VALUES ($1, 61, 'center61@example.com', 'manual', $2)`, [other.rows[0].id, otherMembership.rows[0].id]);
  await assert.rejects(store.addEmail({
    profileId: member.rows[0].profile_id, membershipId: member.rows[0].id,
    email: 'center61@example.com', actorId: 'admin-60', actorFranchiseId: 60
  }), /ambiguous/i);
});

test('canonical-source admins can mutate and detach while balance components stay current-cycle consistent', { skip: !enabled }, async () => {
  assert.ok(pool);
  const profiles = await pool.query<{ id: string }>(`
    INSERT INTO public.pto_profiles (first_name, last_name, identity_status)
    VALUES ('Canonical', 'Tutor', 'confirmed'), ('Canonical', 'Tutor', 'pending') RETURNING id
  `);
  const [target, source] = profiles.rows.map((row) => row.id);
  const memberships = await pool.query<{ id: string; franchiseid: number }>(`
    INSERT INTO public.pto_profile_centers (profile_id, franchiseid, tutor_id)
    VALUES ($1, 70, 7070), ($2, 71, 7171) RETURNING id, franchiseid
  `, [target, source]);
  const candidate = await pool.query<{ id: string }>(`
    INSERT INTO public.pto_profile_match_candidates (left_profile_id, right_profile_id)
    VALUES ($1, $2) RETURNING id
  `, [target, source]);
  await pool.query('SELECT public.pto_admin_decide_alias($1, $2, $3, $4)',
    [candidate.rows[0].id, 'confirm', 'admin-70', 70]);
  const targetCycle = await pool.query<{ id: string }>(
    'SELECT public.pto_get_or_create_cycle($1, CURRENT_DATE) AS id', [target]
  );
  const sourceCycle = await pool.query<{ id: string }>(
    'SELECT public.pto_get_or_create_cycle($1, CURRENT_DATE) AS id', [source]
  );
  await pool.query(`INSERT INTO public.pto_ledger_entries
    (profile_id, cycle_id, event_type, balance_delta, reserved_delta, idempotency_key, metadata)
    VALUES
      ($1, $2, 'reserve', 0, 1, 'canonical-reserve', '{}'),
      ($3, $4, 'adjustment', -1, 0, 'canonical-adjust', '{"reason":"canonical"}')`,
    [target, targetCycle.rows[0].id, source, sourceCycle.rows[0].id]);
  const sourceMembership = memberships.rows.find((row) => row.franchiseid === 71);
  assert.ok(sourceMembership);
  const store = createPostgresPtoStore(pool);
  await store.addEmail({ profileId: target, membershipId: sourceMembership.id,
    email: 'canonical@example.com', actorId: 'admin-71', actorFranchiseId: 71 });
  const adjusted = await store.adjustBalance({ profileId: target,
    membershipId: sourceMembership.id,
    cycleStart: `${new Date().getUTCFullYear()}-01-01`, deltaDays: -0.5, reason: 'Canonical correction',
    actorId: 'admin-71', actorFranchiseId: 71 });
  assert.equal(adjusted.availableDays, 2.5);
  const view = await store.getTutorProfile({ franchiseId: 71, tutorId: 7171 });
  assert.deepEqual(view.balance, { grantedDays: 5, balanceDays: 3.5, reservedDays: 1, availableDays: 2.5 });
  const audit = await store.listAudit({ franchiseId: 71, profileId: target, page: 1, pageSize: 25 });
  assert.ok(audit.items.some((event) => event.eventType === 'alias_confirmed'));
  const detached = await store.detachMembership({ profileId: target, membershipId: sourceMembership.id,
    actorId: 'admin-71', actorFranchiseId: 71 });
  assert.notEqual(detached.detachedProfileId, target);
});

test('preview is null-safe and counts only genuine new exact-name candidates', { skip: !enabled }, async () => {
  assert.ok(pool);
  const existing = await pool.query<{ id: string }>(`
    INSERT INTO public.pto_profiles (first_name, last_name, identity_status)
    VALUES ('Preview', 'Tutor', 'pending') RETURNING id
  `);
  await pool.query(`INSERT INTO public.pto_profile_centers (profile_id, franchiseid, tutor_id)
    VALUES ($1, 80, 8001)`, [existing.rows[0].id]);
  const nullable = await pool.query<{ id: string }>(`
    INSERT INTO public.pto_profiles (first_name, last_name) VALUES ('Legacy', 'Null') RETURNING id
  `);
  await pool.query('INSERT INTO public.pto_profile_centers (profile_id, franchiseid, tutor_id) VALUES ($1, 80, NULL)',
    [nullable.rows[0].id]);
  await pool.query(`INSERT INTO public.pto_profile_crm_ids (profile_id, provider, crm_id)
    VALUES ($1, 'timecard-center:80', '8001')`, [existing.rows[0].id]);
  const preview = await createPostgresPtoStore(pool).previewActivation(80, [
    { id: 8001, franchiseId: 80, firstName: 'Preview', lastName: 'Tutor', email: null, isDeleted: false },
    { id: 8002, franchiseId: 80, firstName: 'Preview', lastName: 'Tutor', email: null, isDeleted: false }
  ], discovery([{
    id: 9001, franchiseId: 90, firstName: 'Preview', lastName: 'Tutor', email: null, isDeleted: false,
    provider: 'timecard-center:90', crmId: '9001'
  }]));
  assert.equal(preview.newMembershipCount, 1);
  assert.equal(preview.newProfileCount, 1);
  assert.equal(preview.pendingExactNameCandidateCount, 1);
});

test('activation, sync, email, and adjustment audits contain actual before and after states', { skip: !enabled }, async () => {
  assert.ok(pool);
  const store = createPostgresPtoStore(pool);
  await store.runInTransaction((tx) => tx.syncRoster({
    franchiseId: 90, activate: true, actorId: 'admin-90', tutors: [{
      id: 9090, franchiseId: 90, firstName: 'Audit', lastName: 'Tutor', email: null, isDeleted: false
    }], discovery: discovery()
  }));
  const member = await pool.query<{ id: string; profile_id: string }>(
    'SELECT id, profile_id FROM public.pto_profile_centers WHERE franchiseid = 90 AND tutor_id = 9090'
  );
  await store.addEmail({ profileId: member.rows[0].profile_id, membershipId: member.rows[0].id,
    email: 'audit@example.com', actorId: 'admin-90', actorFranchiseId: 90 });
  await store.adjustBalance({ profileId: member.rows[0].profile_id,
    membershipId: member.rows[0].id,
    cycleStart: `${new Date().getUTCFullYear()}-01-01`, deltaDays: -0.5, reason: 'Audit correction',
    actorId: 'admin-90', actorFranchiseId: 90 });
  const events = await pool.query<{ event_type: string; before_state: unknown; after_state: unknown }>(`
    SELECT event_type, before_state, after_state FROM public.pto_audit_events
    WHERE event_type IN ('center_activated_and_synced', 'email_added', 'balance_adjusted') ORDER BY id
  `);
  assert.equal(events.rows.length, 3);
  for (const event of events.rows) {
    assert.notEqual(event.before_state, null, `${event.event_type} missing before state`);
    assert.notEqual(event.after_state, null, `${event.event_type} missing after state`);
  }
  assert.deepEqual(events.rows[0].before_state, {
    enabled: false, firstActivatedAt: null, lastSuccessfulSyncAt: null, lastSyncError: null,
    lastSuccessfulRosterSyncAt: null, lastRosterSyncError: null,
    lastSuccessfulDiscoveryAt: null, lastDiscoveryError: null,
    activeTutorIds: []
  });
});

test('contradictory alias retries are rejected while same-decision retries report the stored outcome', { skip: !enabled }, async () => {
  assert.ok(pool);
  const profiles = await pool.query<{ id: string }>(`
    INSERT INTO public.pto_profiles (first_name, last_name)
    VALUES ('Retry', 'Alias'), ('Retry', 'Alias') RETURNING id
  `);
  await pool.query(`INSERT INTO public.pto_profile_centers (profile_id, franchiseid, tutor_id)
    VALUES ($1, 100, 1001), ($2, 101, 1002)`, [profiles.rows[0].id, profiles.rows[1].id]);
  const candidate = await pool.query<{ id: string }>(`
    INSERT INTO public.pto_profile_match_candidates (left_profile_id, right_profile_id)
    VALUES ($1, $2) RETURNING id
  `, [profiles.rows[0].id, profiles.rows[1].id]);
  const store = createPostgresPtoStore(pool);
  const rejected = await store.decideAlias({ candidateId: candidate.rows[0].id, decision: 'reject',
    actorId: 'admin-100', actorFranchiseId: 100 });
  assert.equal(rejected.decision, 'reject');
  const repeated = await store.decideAlias({ candidateId: candidate.rows[0].id, decision: 'reject',
    actorId: 'admin-100', actorFranchiseId: 100 });
  assert.equal(repeated.decision, 'reject');
  await assert.rejects(store.decideAlias({ candidateId: candidate.rows[0].id, decision: 'confirm',
    actorId: 'admin-100', actorFranchiseId: 100 }), /already rejected/i);
});

test('admin invariant migration reruns after its replacement functions are installed', { skip: !enabled }, async () => {
  assert.ok(pool);
  await pool.query(migrations[1]);
});
