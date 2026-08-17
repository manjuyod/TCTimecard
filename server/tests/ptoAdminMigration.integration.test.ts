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
