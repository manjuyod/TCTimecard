import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Pool, PoolClient } from 'pg';
import {
  startTimeOffChangesDatabase,
  readMigration,
  timeOffChangesDatabaseEnabled as enabled,
  TimeOffChangesDatabase
} from './helpers/timeOffChangesDatabase';

let database: TimeOffChangesDatabase | undefined;
let formPool: Pool | undefined;
const migrationName = '0018_public_pto_linked_email.sql';
const resolverSignature = 'public.pto_resolve_profile(integer,bigint,bigint,text,text,text,text)';
const linkedSignature = 'public.pto_authenticated_linked_profile(integer,bigint)';
const helperSignature = 'public.pto_public_linked_email_profiles(integer,text)';
let originalResolver: string;
let originalAuthenticated: string;
let originalResolverAcl: unknown;
let originalTableAcls: unknown;

async function definition(pool: Pool, signature: string): Promise<string> {
  return (await pool.query('SELECT pg_get_functiondef($1::regprocedure) AS def', [signature]))
    .rows[0].def.replace(/\r\n/g, '\n');
}

async function tableAcls(pool: Pool): Promise<unknown> {
  return (await pool.query(`
    SELECT relname, relacl, relrowsecurity, relforcerowsecurity FROM pg_class
    WHERE relnamespace = 'public'::regnamespace ORDER BY relname
  `)).rows;
}

before(async () => {
  if (!enabled) return;
  database = await startTimeOffChangesDatabase();
  const db = database.pool;
  originalResolver = await definition(db, resolverSignature);
  originalAuthenticated = await definition(db, linkedSignature);
  originalResolverAcl = (await db.query('SELECT proacl, proowner FROM pg_proc WHERE oid = $1::regprocedure',
    [resolverSignature])).rows;
  // The role belongs to the public-form deployment and may not exist yet.
  await db.query(readMigration(migrationName));
  await db.query(`
    CREATE ROLE timeoff_form_app LOGIN PASSWORD 'isolated_form_test' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    CREATE ROLE unrelated_app NOLOGIN;
    GRANT USAGE ON SCHEMA public TO timeoff_form_app, unrelated_app;
    -- Existing public PTO lookup privileges; deliberately no access to the
    -- discovery registry, link decisions, or CRM identity mappings.
    GRANT SELECT ON public.pto_profiles, public.pto_profile_centers,
      public.pto_profile_emails, public.pto_profile_aliases,
      public.pto_center_settings TO timeoff_form_app;
    -- Model the existing privileges needed by the invoker-rights reservation
    -- triggers, individually named rather than granting every PTO table.
    GRANT SELECT, INSERT, UPDATE ON public.time_off_requests,
      public.pto_entitlement_cycles, public.pto_request_allocations TO timeoff_form_app;
    GRANT SELECT, INSERT ON public.pto_ledger_entries TO timeoff_form_app;
    GRANT SELECT ON public.pto_policies TO timeoff_form_app;
    -- Existing reservation code locks canonical profile rows FOR UPDATE;
    -- PostgreSQL requires UPDATE on at least one column for that lock.
    GRANT UPDATE (id) ON public.pto_profiles TO timeoff_form_app;
    GRANT USAGE ON SEQUENCE public.time_off_requests_id_seq,
      public.pto_entitlement_cycles_id_seq, public.pto_request_allocations_id_seq,
      public.pto_ledger_entries_id_seq TO timeoff_form_app;

    -- Preserve the public form's center/flow boundary for request inserts.
    ALTER TABLE public.time_off_requests ENABLE ROW LEVEL SECURITY;
    CREATE POLICY fixture_public_requests ON public.time_off_requests
      TO timeoff_form_app
      USING (current_setting('app.flow', TRUE) = 'public_submit'
        AND franchiseid = NULLIF(current_setting('app.franchise_id', TRUE), '')::INTEGER)
      WITH CHECK (current_setting('app.flow', TRUE) = 'public_submit'
        AND franchiseid = NULLIF(current_setting('app.franchise_id', TRUE), '')::INTEGER
        AND status = 'pending' AND decision_token_hash IS NOT NULL
        AND decision_token_used_at IS NULL);
  `);
  originalTableAcls = await tableAcls(db);
  // Reapply after role provisioning; no table/sequence/RLS privileges may change.
  await db.query(readMigration(migrationName));
  const client = await db.connect();
  try { await seed(client); } finally { client.release(); }
  formPool = new Pool({
    host: '127.0.0.1', port: db.options.port, database: db.options.database,
    user: 'timeoff_form_app', password: 'isolated_form_test', max: 1
  });
});

after(async () => {
  await formPool?.end();
  await database?.stop();
});

async function seed(client: PoolClient): Promise<void> {
  await client.query(`
    INSERT INTO public.pto_center_settings (franchiseid, enabled, first_activated_at)
    VALUES (68, TRUE, '2020-01-01Z'), (6, FALSE, NULL), (69, TRUE, '2020-01-01Z');
    INSERT INTO public.pto_profiles (id, first_name, last_name, identity_status)
    VALUES (6, 'Brandon', 'Millares', 'confirmed'), (7, 'Other', 'Person', 'confirmed'),
      (8, 'Alias', 'Person', 'pending');
    INSERT INTO public.pto_profile_centers (id, profile_id, franchiseid, tutor_id, active)
    VALUES (60, 6, 68, 6006, TRUE), (70, 7, 68, 7007, TRUE);
    INSERT INTO public.pto_profile_emails
      (profile_id, franchiseid, email, active, source, source_membership_id)
    VALUES (6, 68, 'millares@tutoringclub.com', TRUE, 'crm', 60);
    INSERT INTO public.pto_discovered_tutor_accounts
      (id, provider, crm_id, franchiseid, tutor_id, normalized_first_name,
       normalized_last_name, crm_snapshot, crm_active)
    VALUES (95, 'timecard-center:6', '1247', 6, 1247, 'brandon', 'millares',
      '{"email":"bmillares@tutoringclub.com"}', TRUE);
    INSERT INTO public.pto_profile_link_decisions
      (profile_id, account_id, status, decided_by, decision_franchiseid, decided_at)
    VALUES (6, 95, 'linked', 'fixture-admin', 68, NOW());
    INSERT INTO public.pto_profile_crm_ids (profile_id, provider, crm_id)
    VALUES (6, 'timecard-center:6', '1247'), (6, 'timecard-center:68', '6006');
  `);
}

async function resolve(client: PoolClient, email: string | null, center = 68): Promise<string> {
  const result = await client.query<{ id: string }>(`
    SELECT public.pto_resolve_profile($1, NULL, NULL, $2, 'public', NULL, NULL) AS id
  `, [center, email]);
  return result.rows[0].id;
}

async function fixture(work: (client: PoolClient) => Promise<void>, mutation = ''): Promise<void> {
  assert.ok(database);
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    if (mutation) await client.query(mutation);
    await client.query('SET LOCAL ROLE timeoff_form_app');
    await work(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const unresolved = { code: 'P0001', message: 'Public PTO identity must resolve exactly one active profile' };

test('public linked email resolves the reported cross-center profile', { skip: !enabled }, async () => {
  assert.ok(database);
  assert.ok(formPool);
  const form = await formPool.connect();
  try {
    assert.equal((await form.query('SELECT current_user AS name')).rows[0].name, 'timeoff_form_app');
    assert.equal(await resolve(form, 'bmillares@tutoringclub.com'), '6');
  } finally { form.release(); }
});

for (const [name, email, mutation] of [
  ['registered CRM email', 'millares@tutoringclub.com', ''],
  ['registered manual email', 'manual@example.test', `INSERT INTO public.pto_profile_emails
    (profile_id, franchiseid, email, source, source_membership_id) VALUES (6,68,'manual@example.test','manual',60)`],
  ['legacy registered email without source membership', 'millares@tutoringclub.com',
    'UPDATE public.pto_profile_emails SET source_membership_id = NULL'],
  ['registered input normalization', '  MILLARES@TUTORINGCLUB.COM  ', ''],
  ['linked input and snapshot normalization', '  BMILLARES@TUTORINGCLUB.COM  ',
    `UPDATE public.pto_discovered_tutor_accounts SET crm_snapshot = '{"email":"  BMillares@TutoringClub.com  "}'`],
  ['duplicate registered and linked paths', 'bmillares@tutoringclub.com',
    `INSERT INTO public.pto_profile_emails (profile_id, franchiseid, email, source, source_membership_id)
      VALUES (6,68,'bmillares@tutoringclub.com','manual',60), (6,68,'bmillares@tutoringclub.com','crm',60)`],
  ['duplicate linked accounts', 'bmillares@tutoringclub.com', `
    INSERT INTO public.pto_discovered_tutor_accounts
      (id, provider, crm_id, franchiseid, tutor_id, normalized_first_name, normalized_last_name, crm_snapshot)
    VALUES (96,'timecard-center:69','1248',69,1248,'brandon','millares','{"email":"bmillares@tutoringclub.com"}');
    INSERT INTO public.pto_profile_crm_ids VALUES (6,'timecard-center:69','1248',NOW());
    INSERT INTO public.pto_profile_link_decisions (profile_id, account_id, status) VALUES (6,96,'linked')`],
  ['invalid link does not invalidate a registered email', 'millares@tutoringclub.com',
    `UPDATE public.pto_profile_link_decisions SET status = 'excluded'`],
  ['pending profile identity status is not a pending account decision', 'bmillares@tutoringclub.com',
    `UPDATE public.pto_profiles SET identity_status = 'pending' WHERE id = 6`]
] as const) {
  test(name, { skip: !enabled }, async () => {
    await fixture(async (client) => assert.equal(await resolve(client, email), '6'), mutation);
  });
}

for (const [name, mutation, email, center] of [
  ['wrong requested center', '', 'bmillares@tutoringclub.com', 69],
  ['account center alone is not a membership', '', 'bmillares@tutoringclub.com', 6],
  ['missing requested center', '', 'bmillares@tutoringclub.com', 999],
  ['disabled requested center', 'UPDATE public.pto_center_settings SET enabled = FALSE WHERE franchiseid = 68'],
  ['inactive requested membership', 'UPDATE public.pto_profile_centers SET active = FALSE WHERE profile_id = 6'],
  ['missing requested membership', 'DELETE FROM public.pto_profile_emails; DELETE FROM public.pto_profile_centers WHERE profile_id = 6'],
  ['inactive canonical profile', 'UPDATE public.pto_profiles SET active = FALSE WHERE id = 6'],
  ['inactive discovered account', 'UPDATE public.pto_discovered_tutor_accounts SET crm_active = FALSE'],
  ['pending account', `UPDATE public.pto_profile_link_decisions SET status = 'pending'`],
  ['excluded account', `UPDATE public.pto_profile_link_decisions SET status = 'excluded'`],
  ['unlinked account', 'DELETE FROM public.pto_profile_link_decisions'],
  ['missing identity mapping', `DELETE FROM public.pto_profile_crm_ids WHERE provider = 'timecard-center:6'`],
  // Updating profile_id would fire pto_crm_assignment_decision_follow and
  // repair the decision. Delete/reinsert models an actually inconsistent row.
  ['identity mapping to different canonical profile', `DELETE FROM public.pto_profile_crm_ids WHERE provider = 'timecard-center:6';
    INSERT INTO public.pto_profile_crm_ids (profile_id, provider, crm_id) VALUES (7,'timecard-center:6','1247')`],
  ['inconsistent provider and account center', 'UPDATE public.pto_discovered_tutor_accounts SET franchiseid = 69'],
  ['inconsistent CRM and tutor identity', 'UPDATE public.pto_discovered_tutor_accounts SET tutor_id = 999'],
  ['missing snapshot email', `UPDATE public.pto_discovered_tutor_accounts SET crm_snapshot = '{}'`],
  ['blank snapshot email', `UPDATE public.pto_discovered_tutor_accounts SET crm_snapshot = '{"email":"  "}'`],
  ['unknown email', '', 'unknown@example.test'],
  ['blank input email', '', '  '],
  ['null input email', '', null],
  ['inactive registered email', 'UPDATE public.pto_profile_emails SET active = FALSE', 'millares@tutoringclub.com'],
  ['inactive registered membership', 'UPDATE public.pto_profile_centers SET active = FALSE WHERE id = 60', 'millares@tutoringclub.com'],
  ['inactive registered profile', 'UPDATE public.pto_profiles SET active = FALSE WHERE id = 6', 'millares@tutoringclub.com'],
  ['wrong center registered email', '', 'millares@tutoringclub.com', 69],
  ['ambiguity across registered and linked sources', `INSERT INTO public.pto_profile_emails
    (profile_id, franchiseid, email, source, source_membership_id) VALUES (7,68,'bmillares@tutoringclub.com','manual',70)`],
  ['ambiguity across registered sources', `INSERT INTO public.pto_profile_emails
    (profile_id, franchiseid, email, source, source_membership_id) VALUES (7,68,'millares@tutoringclub.com','manual',70)`,
    'millares@tutoringclub.com'],
  ['ambiguity across linked sources', `
    INSERT INTO public.pto_discovered_tutor_accounts
      (id, provider, crm_id, franchiseid, tutor_id, normalized_first_name, normalized_last_name, crm_snapshot)
    VALUES (96,'timecard-center:69','1248',69,1248,'other','person','{"email":"bmillares@tutoringclub.com"}');
    INSERT INTO public.pto_profile_crm_ids VALUES (7,'timecard-center:69','1248',NOW());
    INSERT INTO public.pto_profile_link_decisions (profile_id, account_id, status) VALUES (7,96,'linked')`]
] as Array<[string, string, (string | null)?, number?]>) {
  test(`rejects ${name}`, { skip: !enabled }, async () => {
    await fixture(async (client) => {
      await assert.rejects(resolve(client, email === undefined ? 'bmillares@tutoringclub.com' : email, center), unresolved);
    }, mutation);
  });
}

const aliasFixture = `
  INSERT INTO public.pto_profile_match_candidates (id, left_profile_id, right_profile_id, status)
  VALUES (80,6,8,'confirmed');
  INSERT INTO public.pto_profile_aliases (source_profile_id, target_profile_id, candidate_id) VALUES (8,6,80);
  UPDATE public.pto_profiles SET active = FALSE WHERE id = 8;
  UPDATE public.pto_profile_link_decisions SET profile_id = 8;
  UPDATE public.pto_profile_centers SET profile_id = 8 WHERE id = 60;
  INSERT INTO public.pto_profile_emails (profile_id, franchiseid, email, source, source_membership_id)
  VALUES (8,68,'bmillares@tutoringclub.com','manual',60);
`;

test('canonical aliases deduplicate decision, CRM, membership and registered paths', { skip: !enabled }, async () => {
  await fixture(async (client) => {
    assert.equal(await resolve(client, 'bmillares@tutoringclub.com'), '6');
  }, aliasFixture);
  await fixture(async (client) => {
    assert.equal(await resolve(client, 'bmillares@tutoringclub.com'), '6');
  }, aliasFixture + `UPDATE public.pto_profile_crm_ids SET profile_id = 8 WHERE provider = 'timecard-center:6'`);
});

test('an active alias cannot authorize an inactive canonical profile through a link', { skip: !enabled }, async () => {
  await fixture(async (client) => {
    await assert.rejects(resolve(client, 'bmillares@tutoringclub.com'), unresolved);
  }, aliasFixture + `DELETE FROM public.pto_profile_emails;
    UPDATE public.pto_profiles SET active = (id = 8) WHERE id IN (6,8)`);
});

test('public submission reserves PTO through the existing triggers as the form login', { skip: !enabled }, async () => {
  assert.ok(formPool);
  const client = await formPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL app.flow = 'public_submit'; SET LOCAL app.franchise_id = '68'`);
    const request = await client.query(`
      INSERT INTO public.time_off_requests
        (franchiseid, first_name, last_name, email, start_at, end_at, type, status, duration_hours,
         partial_day, decision_token_hash, public_metadata)
      VALUES (68,'Brandon','Millares','bmillares@tutoringclub.com',
        '2026-11-02T00:00:00Z','2026-11-03T00:00:00Z','pto','pending',24,FALSE,'fixture-token',
        '{"source":"public_timeoff_form","startDate":"2026-11-02","endDate":"2026-11-02"}')
      RETURNING id
    `);
    const allocations = await client.query(`
      SELECT cycle.profile_id, allocation.state, allocation.charged_days
      FROM public.pto_request_allocations allocation
      JOIN public.pto_entitlement_cycles cycle ON cycle.id = allocation.cycle_id
      WHERE allocation.request_id = $1
    `, [request.rows[0].id]);
    assert.deepEqual(allocations.rows.map((row) => [row.profile_id, row.state, Number(row.charged_days)]),
      [['6', 'reserved', 1]]);
    assert.equal((await client.query(`SELECT COUNT(*)::INTEGER AS count FROM public.pto_profile_emails`)).rows[0].count, 1);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('migration retains resolver ownership, ACLs, invoker rights and authenticated definitions', { skip: !enabled }, async () => {
  assert.ok(database);
  const db = database.pool;
  const updated = await definition(db, resolverSignature);
  const authenticatedStart = "  ELSIF p_request_source <> 'authenticated' THEN";
  assert.equal(updated.slice(updated.indexOf(authenticatedStart)),
    originalResolver.slice(originalResolver.indexOf(authenticatedStart)));
  assert.equal(await definition(db, linkedSignature), originalAuthenticated);
  assert.deepEqual((await db.query('SELECT proacl, proowner FROM pg_proc WHERE oid = $1::regprocedure',
    [resolverSignature])).rows, originalResolverAcl);
  assert.equal((await db.query('SELECT prosecdef FROM pg_proc WHERE oid = $1::regprocedure',
    [resolverSignature])).rows[0].prosecdef, false);
  assert.deepEqual(await tableAcls(db), originalTableAcls);
});

test('lookup permission is restricted to the helper, with a pinned search path', { skip: !enabled }, async () => {
  assert.ok(database);
  const db = database.pool;
  const metadata = (await db.query(`SELECT prosecdef, provolatile, proconfig FROM pg_proc WHERE oid = $1::regprocedure`,
    [helperSignature])).rows[0];
  assert.deepEqual(metadata, { prosecdef: true, provolatile: 's', proconfig: ['search_path=pg_catalog, pg_temp'] });
  for (const table of ['pto_discovered_tutor_accounts', 'pto_profile_link_decisions', 'pto_profile_crm_ids']) {
    await fixture(async (client) => {
      await assert.rejects(client.query(`SELECT * FROM public.${table}`), { code: '42501' });
    });
    await fixture(async (client) => {
      await assert.rejects(client.query(`DELETE FROM public.${table}`), { code: '42501' });
    });
  }
  const denied = await db.connect();
  try {
    await denied.query('BEGIN; SET LOCAL ROLE unrelated_app');
    await assert.rejects(denied.query(`SELECT * FROM public.pto_public_linked_email_profiles(68, 'bmillares@tutoringclub.com')`),
      { code: '42501' });
  } finally { await denied.query('ROLLBACK'); denied.release(); }
  await fixture(async (client) => {
    await assert.rejects(client.query(`UPDATE public.pto_profiles SET active = FALSE WHERE id = 6`), { code: '42501' });
  });
});

test('caller search path and temporary tables cannot shadow the privileged lookup', { skip: !enabled }, async () => {
  await fixture(async (client) => {
    await client.query(`SET LOCAL search_path = pg_temp, public;
      CREATE TEMP TABLE pto_discovered_tutor_accounts (id BIGINT);
      CREATE TEMP TABLE pto_profile_aliases (source_profile_id BIGINT, target_profile_id BIGINT)`);
    assert.equal(await resolve(client, 'bmillares@tutoringclub.com'), '6');
  });
});

test('request RLS still rejects a different center context', { skip: !enabled }, async () => {
  await fixture(async (client) => {
    await client.query(`SET LOCAL app.flow = 'public_submit'; SET LOCAL app.franchise_id = '69'`);
    await assert.rejects(client.query(`INSERT INTO public.time_off_requests
      (franchiseid, email, start_at, end_at, type, status, decision_token_hash, public_metadata)
      VALUES (68,'bmillares@tutoringclub.com','2026-11-02Z','2026-11-03Z','pto','pending','fixture-token',
        '{"source":"public_timeoff_form"}')`), { code: '42501' });
  });
});

test('authenticated resolution keeps direct membership rules and linked-login sponsorship', { skip: !enabled }, async () => {
  assert.ok(database);
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    assert.equal((await client.query(`SELECT public.pto_authenticated_linked_profile(6,1247) AS id`)).rows[0].id, '6');
    assert.equal((await client.query(`SELECT public.pto_resolve_profile(68,6006,NULL,
      'MILLARES@TUTORINGCLUB.COM','authenticated','Brandon','Millares') AS id`)).rows[0].id, '6');
    await client.query('SAVEPOINT invalid_authenticated');
    await assert.rejects(client.query(`SELECT public.pto_resolve_profile(6,1247,NULL,
      'bmillares@tutoringclub.com','authenticated','Brandon','Millares')`),
      { message: 'Authenticated PTO identity requires an active CRM membership' });
    await client.query('ROLLBACK TO SAVEPOINT invalid_authenticated');
    await client.query(`UPDATE public.pto_profile_link_decisions SET status = 'excluded'`);
    assert.equal((await client.query(`SELECT public.pto_authenticated_linked_profile(6,1247) AS id`)).rows[0].id, null);
    await assert.rejects(client.query(`SELECT public.pto_resolve_profile(68,NULL,NULL,
      'bmillares@tutoringclub.com','authenticated','Brandon','Millares')`),
      { message: 'Authenticated PTO profile requires a CRM identity' });
  } finally { await client.query('ROLLBACK'); client.release(); }
});
