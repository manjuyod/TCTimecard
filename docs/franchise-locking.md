# Franchise Locking Verification

## Franchise 6 (no selector access)
- Sign in as an admin whose session franchiseId is 6.
- Visit Admin Dashboard, Approvals, and Pay Period Summary; confirm franchise selector cards are hidden and data loads automatically.
- Attempt to refresh those pages and ensure results remain scoped to franchise 6.

## Franchise 6 request tampering
- With the same session, capture an Approvals or Pay Period API request in devtools.
- Resend the request with `franchiseId` set to a different value in the query string or JSON body (e.g., 2 or 99).
- Confirm the response still returns franchise 6 data and the server logs a `FRANCHISE_SCOPE_OVERRIDE` line showing the enforced franchise.

## Franchise 1/2/3 selector access
- Sign in as an admin with session franchiseId 1, 2, or 3.
- Verify franchise selector UI is visible on Admin Dashboard, Approvals, and Pay Period Summary and defaults to the session franchise.
- Change the franchiseId and apply filters; confirm the pages reload data for the selected franchise without errors.
