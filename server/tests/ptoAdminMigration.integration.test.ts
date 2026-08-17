import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import { createPostgresPtoStore } from '../services/pto';

const enabled = process.env.RUN_PTO_POSTGRES_TESTS === '1';
const containerName = `timecard-pto-admin-test-${process.pid}`;
const migrations = ['0010_shared_pto.sql', '0011_pto_admin_invariants.sql'].map((file) =>
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
    franchiseId: 70, activate: true, actorId: 'admin-70', tutors: [tutor]
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
    tutors: [{ ...tutor, email: 'updated@example.com' }]
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
    profileId: profiles.rows[0].id, cycleStart: new Date().getUTCFullYear() + '-01-01', deltaDays: -5.5,
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
  await store.syncRoster({ franchiseId: 40, activate: true, actorId: 'admin-40', tutors: [tutor] });
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
    tutors: [{ ...tutor, isDeleted: true }] });
  await assert.rejects(resolveAuthenticated, /active CRM membership/i);
  assert.equal(await membershipIsActive(), false);
  await assert.rejects(resolvePublic, /exactly one active profile/);

  await store.syncRoster({ franchiseId: 40, activate: false, actorId: 'admin-40', tutors: [tutor] });
  await store.syncRoster({ franchiseId: 40, activate: false, actorId: 'admin-40', tutors: [] });
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
    }]
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
    }]
  }));
  const member = await pool.query<{ id: string; profile_id: string }>(
    'SELECT id, profile_id FROM public.pto_profile_centers WHERE franchiseid = 60 AND tutor_id = 6060'
  );
  await store.addEmail({ profileId: member.rows[0].profile_id, membershipId: member.rows[0].id,
    email: 'same@example.com', actorId: 'admin-60', actorFranchiseId: 60 });
  await store.syncRoster({ franchiseId: 60, activate: false, actorId: 'admin-60', tutors: [{
    id: 6060, franchiseId: 60, firstName: 'Collision', lastName: 'Tutor',
    email: 'changed@example.com', isDeleted: false
  }] });
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
  ]);
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
    }]
  }));
  const member = await pool.query<{ id: string; profile_id: string }>(
    'SELECT id, profile_id FROM public.pto_profile_centers WHERE franchiseid = 90 AND tutor_id = 9090'
  );
  await store.addEmail({ profileId: member.rows[0].profile_id, membershipId: member.rows[0].id,
    email: 'audit@example.com', actorId: 'admin-90', actorFranchiseId: 90 });
  await store.adjustBalance({ profileId: member.rows[0].profile_id,
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
