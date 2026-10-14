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
