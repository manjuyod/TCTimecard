# Load-Test Credential Checker Design

## Purpose

Add a human-operated preflight tool that validates selected load-test credentials against a deployment before a stress test. The tool must identify unusable entries without printing identifiers or passwords, and it must limit failed logins so it does not trigger the application's five-failure IP cooldown.

This tool is never run by an agent against production. Successful authentication creates PostgreSQL session rows, so a human operator must launch it under the project's database-safety rule.

## Credential cleanup

Remove the candidate entries implicated by the first 20-user run from the ignored `load-tests/credentials.json` file:

- Tutor indices `0-17`.
- Admin indices `0-2` and `18-19`.

Removal is intentionally conservative: it discards all 23 candidates rather than attempting to infer the three exact failures from an aggregated result. Expected remaining counts are 821 tutors and 193 admins.

## Operator interface

Add an npm command named `credentials:check` backed by a Node script under `load-tests/`.

The checker reuses:

- `LOAD_TEST_BASE_URL`
- `LOAD_TEST_CREDENTIALS_FILE`

It adds:

- `CREDENTIAL_CHECK_TUTOR_INDICES`, accepting comma-separated indices and inclusive ranges such as `0-17,25`.
- `CREDENTIAL_CHECK_ADMIN_INDICES`, using the same syntax.
- `CREDENTIAL_CHECK_RESULTS_FILE`, defaulting to `credential-check-results.json`.
- `CREDENTIAL_CHECK_MAX_CONSECUTIVE_FAILURES`, defaulting to `4` and restricted to `1-4`.

At least one tutor or admin selector is required. Out-of-range indices and malformed selectors fail before any network request.

## Request flow

Credentials are checked sequentially in deterministic tutor-then-admin order.

For each selected entry:

1. POST `/api/auth/login` using the credential identifier and password.
2. If the response requires account selection, POST `/api/auth/select-account` with the credential's `selectedAccount` value.
3. Mark the entry valid only when an authenticated session is returned.
4. POST `/api/auth/logout` immediately after successful authentication so the temporary session is destroyed.
5. Reset the consecutive-failure counter after a successful login, matching the server's IP limiter behavior.
6. Increment the counter after an invalid login or request failure. Stop before issuing another request once the configured guard is reached.

The checker performs no application write actions beyond the unavoidable session create/delete lifecycle.

## Safe results

The ignored result file contains:

- Configuration without secrets.
- Counts for selected, valid, invalid, error, and skipped entries.
- Per-entry role, credential-array index, selected account ID, outcome, and HTTP status.
- Whether the lockout guard stopped the run.

The result and console output must never contain credential identifiers, passwords, cookies, selection tokens, response bodies, or request headers. The process exits nonzero if any credential is invalid, a request errors, or the guard stops the run.

## Testing

Use a local fake HTTP server; never call the deployment in automated tests. Tests cover:

- Selector parsing and rejection of malformed or out-of-range values.
- Direct-session and account-selection login success.
- Immediate logout after success.
- Invalid credentials reported by role/index/account ID without leaking secrets.
- Stop-before-lockout behavior after four consecutive failures.
- Result-file schema and nonzero exit behavior for failures.

The checker tests are included in the normal `npm test` command.

## Runbook

Document that a human operator should run the checker before each load stage against only the credential indices that stage will use. The runbook must repeat that this creates and deletes session rows and must not be launched by an agent.
