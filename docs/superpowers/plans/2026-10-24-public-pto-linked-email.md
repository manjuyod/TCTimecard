# Public PTO linked email implementation plan

**Goal:** Resolve public PTO submissions from registered emails and explicitly linked discovered-account emails, without CRM access or a running Time Card service.

**Design:** Add migration `0018_public_pto_linked_email.sql`. Keep the registered-email query and authenticated branch intact. Union registered candidates with a new read-only, restricted `SECURITY DEFINER` helper returning canonical profile IDs for an email and requested center. Require active accounts, linked decisions, agreeing CRM mappings, an active canonical profile, and an active membership in the requested enabled center. Deduplicate before requiring exactly one result. Use lowercase/trim normalization and no persistent email backfill.

**Scope:** New migration, focused PostgreSQL integration test, and separate application instructions. No prior migrations, public form code, live Neon state, or CRM data will be changed.

**Verification:** Disposable PostgreSQL 17 Docker instance, existing PTO migration chain, synthetic fixtures, actual `timeoff_form_app` login. Include cross-center links, aliases, ambiguity, normalization, invalid/inactive links, current authorization boundaries, real request reservation, and authenticated regressions.

- [x] Reproduce the reported failure with profile 6, Corp 68, and linked account 95 (center 6/tutor 1247).
- [x] Implement the additive migration; grant only helper execution to the public form role, retain invoker rights on the existing resolver, pin the helper search path, and revoke PUBLIC execution.
- [x] Run focused integration tests and related PTO regression suites, then server type checking.
- [x] Review the diff and graph impact; document separate migration application and confirm live Neon is unchanged.

GitNexus is current at `910b49e83846fac1fa42b01f42af510681ac8dab`. SQL resolver impact is UNKNOWN because the function is not indexed. Text confirmation identifies reservation and approved-request change paths; integration coverage must exercise database callers rather than rely on graph silence.

Verification: the initial isolated fixture failed with the reported public identity error; after 0018 all 45 focused cases passed, plus 63 tests in the existing PTO migration/admin/route/approved-change suites. Server type checking passed. `detect_changes(scope: all)` saw all four new files but no indexed changed symbols; that zero does not establish SQL impact. No live Neon or CRM queries were made. See `docs/operations/public-pto-linked-email.md` for the separate deployment procedure and fixture permission assumptions.
