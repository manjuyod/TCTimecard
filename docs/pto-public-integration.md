# Public PTO Quote Integration

The public time-off form can check shared PTO eligibility through the Time Card API before it submits through its existing bridge workflow. The quote endpoint does not create a request and never returns a profile identifier or raw balance.

## Prerequisites

1. Apply migrations `0010_shared_pto.sql` through `0014_database_controlled_pto_linked_login.sql` in order.
2. Have a database engineer enable the center in `public.pto_center_settings`, then successfully sync it from **Admin → PTO Management**. Application admins cannot activate or deactivate PTO.
3. Provision a distinct high-entropy bearer token for the center. Store only its lowercase SHA-256 hash in `public.time_off_center_links.token_hash`; deliver the raw token through the deployment secret manager.
4. Keep the bearer token on the public form’s server. Browser code must call a same-origin backend proxy rather than embed the center token in JavaScript.

## Center-scoped identity and eligibility

Public email aliases remain center-scoped. A Center 2 token can resolve only an active Center 2 alias backed by an active Center 2 membership, and Center 2 itself must be database-enabled. It cannot use the same person’s Center 1 or Center 3 email. Linking accounts shares the canonical PTO pool, not the public authorization boundary.

A remembered linked account does not relax these public rules. Pending and excluded accounts are also ineligible, and discovery alone never grants public-form access. An authenticated CRM-active linked login may separately use its canonical pool from an inactive login center when another active membership sponsors that pool; the same inactive center's public token/alias remains blocked. `GET /api/pto/me` may show the tutor’s active canonical memberships and aliases, but the public quote continues to return no profile ID or balance.

## Quote request

`POST /api/pto/public/quote`

Headers:

```http
Authorization: Bearer <center-token>
Content-Type: application/json
```

Full-day body:

```json
{
  "email": "tutor@example.com",
  "startDate": "2026-12-31",
  "endDate": "2027-01-02",
  "partialDay": false
}
```

Partial-day requests also send `leaveTime` and `returnTime` as local `HH:mm` values. Dates are interpreted in the authorized center’s configured timezone and are subject to its notice policy.

An eligible response is deliberately balance-free:

```json
{
  "eligible": true,
  "reason": "eligible",
  "chargeDays": 1.5,
  "cycleAllocations": [
    { "cycleStart": "2026-01-01", "days": 1 },
    { "cycleStart": "2027-01-01", "days": 0.5 }
  ]
}
```

An ineligible identity or balance returns the same shape with `eligible: false` and one of:

- `center_disabled`
- `identity_unresolved`
- `no_balance`
- `insufficient_balance`
- `invalid_request`

The public form should hide or disable its paid option when `eligible` is false, show a generic explanation, and leave unpaid/other request types available. It must not infer or display a balance from repeated quotes.

## Submission and errors

The quote endpoint is a preflight only. After an eligible quote, the public system continues through its existing time-off bridge submission path. The PostgreSQL reservation trigger remains authoritative and can reject a race between quote and submission.

For rollout verification, quote with the alias owned by the enabled token center, submit through the bridge, approve the request, and confirm the deduction appears once in the shared canonical pool. Repeat with a different linked center only after a database engineer enables that center and only with that center’s own token and alias. An inactive center must continue to return `center_disabled` even when its tutor can request PTO through an authenticated linked login.

Handle these HTTP outcomes without exposing repository or identity details:

- `400`: malformed email, dates, partial-day times, or notice-policy violation.
- `401`: missing, inactive, or unknown center token. Stop submission and alert the integration operator.
- `409`: center disabled, no balance, insufficient balance, or a conflicting PTO state.
- `422`: the center-scoped email does not resolve exactly one active profile, or the request is invalid.
- `500`: generic PTO failure. Treat as retryable; do not submit paid time off without a fresh successful quote.

Never log the raw bearer token, place it in a URL, or return it to the browser. Token rotation is performed by inserting a new hashed link, updating the external secret, confirming successful quotes, and then setting the prior link row to `active = false`.

If a database engineer disables a center, its public aliases become ineligible immediately even though identity decisions and historical email rows remain. Disable its hashed center-link row as part of the rollback procedure; do not delete canonical profiles or alias history.
