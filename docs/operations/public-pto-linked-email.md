# Public PTO linked-email resolution

Migration: `server/db/migrations/0018_public_pto_linked_email.sql`.

The public resolver now combines its existing registered-email candidates with
explicitly linked discovered accounts. Linked candidates require an active
account, a `linked` decision, an agreeing CRM identity mapping, an active
canonical profile, and an active membership in the requested PTO-enabled center.
The account's own center can differ and need not be enabled. Emails are trimmed
and lowercased. Candidates from both sources are deduplicated by canonical
profile ID; zero or multiple identities retain the existing error.

No email aliases are backfilled. The authenticated resolver branch and
`pto_authenticated_linked_profile` are unchanged. The public form continues to
submit directly to PostgreSQL without the Time Card application running.

## Permissions

The new `pto_public_linked_email_profiles(integer, text)` helper returns only
eligible canonical IDs for the supplied center/email. It is a read-only `STABLE`
`SECURITY DEFINER` function with a pinned `pg_catalog, pg_temp` search path and
schema-qualified database objects. PUBLIC execution is revoked; execution is
granted to `timeoff_form_app` if that role exists. This follows PostgreSQL's
[security-definer guidance](https://www.postgresql.org/docs/17/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY).

The existing resolver remains `SECURITY INVOKER`. No table/column/sequence
grants, role memberships, request policies, or RLS settings change. In
particular, the form role receives no direct access to the discovery registry,
link decisions, or CRM identity table. Apply using the existing function owner
with read access to the helper's PTO tables. Other non-owner database roles
that call the public branch need an explicit EXECUTE grant on this helper;
the migration does not grant it to every database user.

If the public-form role is provisioned after this migration, its provisioning
step must run this single grant as the helper owner:

```sql
GRANT EXECUTE ON FUNCTION public.pto_public_linked_email_profiles(INTEGER, TEXT)
TO timeoff_form_app;
```

## Isolated verification

Docker must be running. From the Time Card repository in PowerShell:

```powershell
$env:RUN_PTO_POSTGRES_TESTS = '1'
node --test --import tsx server/tests/ptoPublicLinkedEmail.integration.test.ts
node node_modules/typescript/bin/tsc -p server/tsconfig.json --noEmit
```

The test starts and removes its own PostgreSQL 17 container on a random
loopback port. It does not consume application connection URLs or import CRM
access. It applies the existing PTO/time-off migration chain plus 0018 and uses
synthetic fixtures, including the reported profile 6 / Corp 68 / account 95 /
center 6 / tutor 1247 case. A real restricted `timeoff_form_app` login exercises
resolution and the request/reservation triggers. Other cases use that same
role with transaction-local role switching and rollback.

The fixture explicitly supplies existing lookup/reservation privileges and a
representative public-submit RLS policy; it does not introspect live grants.
Its reservation prerequisites include column-level UPDATE on profile `id`
for existing `SELECT FOR UPDATE` locking. Migration 0018 itself adds only the
helper EXECUTE grant. Tests compare table ACLs/RLS flags and existing function
ownership/ACLs, and check rejection of direct identity-table reads/writes.

## Apply separately

This work does **not** apply the migration to live Neon. No live Neon or CRM
queries were used during implementation or verification.

1. Review 0018 and run the isolated verification above.
2. In a separate deployment session, configure `POSTGRES_URL` for the intended
   database using its migration/function-owner credentials. The runner also
   supports `DATABASE_URL`, but `POSTGRES_URL` takes precedence.
3. Check `public.schema_migrations` against `server/db/migrations` and confirm
   the earlier migrations are already recorded and **0018 is the only pending
   migration**. The runner applies every pending SQL file.
4. Run `npm run db:migrate`. The runner applies 0018 and records its filename
   in one transaction, including the helper creation and privilege changes.
5. Using the form role, run this read-only smoke check with a known eligible
   center/email (parameters below are placeholders):

```sql
BEGIN READ ONLY;
SELECT public.pto_resolve_profile(
  :center_id, NULL, NULL, :'linked_email', 'public', NULL, NULL
);
ROLLBACK;
```

No Time Card or public-form code deployment is required for this database fix.
Keep 0018 in migration history; any later rollback should be another reviewed
migration restoring the prior public branch and removing the helper grant.
