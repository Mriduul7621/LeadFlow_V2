# Performance Fix Phase 2 — Startup request contention

## Change

The `usePermissions` hook now waits on the existing shell-startup gate before fetching the signed-in user's optional permission metadata. On the first Dashboard visit, the gate is released after the critical `GET /api/dashboard` settles. On other protected routes, `AppLayout` releases the gate for that route. If the component unmounts while waiting, it checks cancellation before starting the request.

This removes one non-KPI request from the initial Dashboard request burst. It does not change the authentication gate, KPI data authority, server-side authorization, session cache, or in-flight GET coalescing.

## Build evidence

The latest preview build emits separate chunks: entry `720.77 kB` minified (`221.78 kB` gzip), spreadsheet `424.73 kB` (`141.75 kB` gzip), chart `304.57 kB` (`94.57 kB` gzip), and Dashboard route `31.38 kB` (`8.85 kB` gzip). Do not assume spreadsheet/chart chunks are part of the initial transfer without checking the browser network trace.

## Validation

- Preview build must compile.
- Regression source guard: `server/tests/perf-startup-permissions.test.ts`.
- On device, sign out/in, open Dashboard, then review Performance Diagnostics and compare `GET /api/dashboard` with the permissions request.
- Repeat with a non-Dashboard route as the first protected route to ensure the gate does not hang.

## Next

Capture fresh-login timings. If browser duration is high while `Server-Timing` is low, investigate network/connection contention. If server timing is high, profile the backend spans and SQL. Profile the 720 kB entry chunk before further code-splitting changes.

## Field diagnostics follow-up — 14 Oct 2026

The user-provided preview and production snapshots each captured roughly 29 completed `GET /api/roles` requests in a short diagnostic session, mostly 0.5–0.9 s each. This repetition is abnormal: the session cache and GET coalescing should prevent repeated role reads on every render/navigation.

Code trace found the feedback loop: `adminService.getRoles()` successfully fetched roles, wrote the local role cache, and that generic cache writer emitted `ROLES_CACHE_CHANGED_EVENT`. `FeatureGate` listens to the same event and calls `getRoles()` again, repeating the cycle. Phase 2 now makes role-cache notification opt-out for read refreshes and disables the event for successful GETs; role save/delete mutations still notify mounted gates. A regression guard is added at `server/tests/perf-role-cache-loop.test.ts`.

The single `GET /api/leads` sample was 2.292 s total, with `Server-Timing` showing 1.4046 s in `authz.caller`, 397.7 ms in `db.query`, and 212.1 ms in `db.qualitySignals`. This is a separate backend latency candidate; measure several requests after the role-loop fix before changing authorization or query behavior. The sample size is one, so do not treat it as a stable baseline.
