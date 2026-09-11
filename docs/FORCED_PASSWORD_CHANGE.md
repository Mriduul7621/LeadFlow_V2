# Forced First-Login Password Change

This document describes the three distinct password flows in LeadFlow and,
in particular, the forced first-login password-change flow that was repaired
by this change.

## The three password flows (kept deliberately separate)

| # | Flow | Endpoint | Who | Current-password check | Sets forced flag |
|---|------|----------|-----|------------------------|------------------|
| 1 | **Admin reset** | `POST /api/users/:id/reset-password` | ADMIN / SUPERADMIN only | no | sets `must_change_password = TRUE` |
| 2 | **Normal self-service change** | `POST /api/auth/change-password` | authenticated self (or admin) | yes — verifies `currentPassword` | clears `must_change_password = FALSE` |
| 3 | **Forced first-login change** | `POST /api/auth/change-required-password` | authenticated self only (server-derived) | no — the temporary-password session is already authenticated | requires the flag to be `TRUE`, then clears it atomically |

These must never be collapsed into one route. In particular, the forced
first-login flow must **not** depend on:

- `users.edit` (canonical Action Permission)
- an ADMIN / SUPERADMIN role
- Settings **Feature Access**
- the generic employee edit route (`PUT /api/users/:id`)

### Root cause this change fixes

`AppLayout`'s forced-password modal previously completed the change by calling
`userService.updateUser(user.id, { password, mustChangePassword: false })`,
which routes through `PUT /api/users/:id`. That route requires the `users.edit`
Action Permission and rejects password writes from non-admins. A freshly
provisioned (non-admin) employee therefore could never satisfy the forced
first-login requirement. The modal now calls the dedicated
`POST /api/auth/change-required-password` endpoint instead.

## Server-authoritative flag

The forced-password flag is `users.must_change_password` (`BOOLEAN`, default
`FALSE`) in PostgreSQL. It is the single source of truth:

- `mapUserRow` maps `mustChangePassword: row.must_change_password === true`
  (there is no hardcoded `false`).
- `POST /api/auth/login` returns the real flag.
- `GET /api/auth/session` returns the real flag.
- User creation persists `must_change_password = true` when the client
  requests it (the admin "Add Employee" flow always sends `true`).
- Admin reset persists `must_change_password = true`.
- No `localStorage` / `localDb` value may override the server truth. The
  client cache (`leadflow-auth`, `localDb`) is only ever a read-back of a
  server-confirmed profile.

## Endpoint contract

### `POST /api/auth/change-required-password`

Request (bearer token required; the caller is derived from the token — **no
target id is read from the body**):

```json
{ "newPassword": "..." }
```

Behaviour (fail closed everywhere):

1. `requireAuth` verifies the bearer token.
2. The caller is looked up in PostgreSQL (by `id` / `employee_id` / `email`
   from the token claims). Missing caller → `404`.
3. If `must_change_password !== true` → `409` and the password is **not**
   changed through this endpoint.
4. Password strength: minimum 6 characters (matching the forced-change UI),
   hashed with the existing bcrypt policy (10 rounds).
5. The hash update and `must_change_password = FALSE` happen in **one**
   `UPDATE` (atomic).
6. A security-safe audit event `required-password-change-completed` is
   recorded (best-effort) with **no** password material.
7. Returns `{ success: true, data: <safeUser> }` — the same `mapUserRow`
   profile as login/session, with `mustChangePassword: false` and no
   password hash.

## Client flow

1. `AppLayout` renders a full-screen forced-password modal whenever
   `user.mustChangePassword` is `true`, replacing the normal app shell (so
   normal navigation is blocked while the flag is set).
2. On submit, it calls `userService.changeRequiredPassword(newPassword)`,
   which `POST`s the dedicated endpoint.
3. On success the store's user is replaced with the server-returned profile
   (`setUser(updatedUser)`), `mustChangePassword` becomes `false`, and the
   modal closes — no full app reload.
4. On failure the modal stays open and the forced flag remains `true`; the
   user cannot silently proceed.
5. **Logout remains usable** from within the modal.

## Security boundaries

- Self-only: the target is always the authenticated caller; a client-supplied
  `userId`/`employeeId` is ignored, so one user can never change another's
  password through this route.
- No admin/permission/feature gate: the route is `requireAuth` only, so it
  works even when the caller has no `users.edit` grant and the Settings module
  is hidden.
- Fail closed when the flag is `false` (`409`).
- No plaintext password is logged; no bcrypt hash is ever returned.
- Admin reset (`POST /users/:id/reset-password`) remains ADMIN-only and is a
  completely separate route.

## Known future hardening (intentionally deferred)

Server-wide enforcement that blocks **all** normal business endpoints while
`must_change_password = TRUE` is **not** implemented in this change. The UI
blocks navigation (the forced modal replaces the app shell), and the dedicated
required-password endpoint, `logout`, and `GET /api/auth/session` remain
usable. A small, compatible server-side middleware that rejects ordinary
business endpoints for a forced user — while whitelisting
`/api/auth/change-required-password`, `/api/auth/session`, and logout — is a
candidate for future hardening if a broader auth-middleware change is ever
undertaken.
