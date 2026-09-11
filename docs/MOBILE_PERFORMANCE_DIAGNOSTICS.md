# Mobile Performance Diagnostics (TEMPORARY, ADMIN-ONLY)

A temporary, read-only diagnostics panel that lets an **Admin** see recent API
request timings from inside the app — built specifically for diagnosing
production latency from an **Android mobile browser** when no laptop is
available.

> **Status:** diagnostic tooling only. It never modifies business data, adds
> no server endpoint, stores nothing in PostgreSQL, and sends nothing
> off-device. See [How to remove this feature](#how-to-remove-this-feature).

---

## What it is

| | |
|---|---|
| Route | `/settings/performance-diagnostics` |
| Who can open it | `ADMIN` / `SUPERADMIN` only |
| Data source | Client-side timing metadata collected from requests the app already makes |
| Storage | **In-memory only** for the current app session — cleared on logout |
| Server changes | **None** (no new endpoint, no DB schema change) |

The sidebar entry ("Performance Diagnostics", under **System**) is visible to
admins only. The route itself is additionally gated: a non-admin who types the
URL is redirected to `/settings`.

## How to open it on mobile

1. Log in with an **Admin** account.
2. Open the sidebar (☰ in the top bar on a phone).
3. Scroll to the **System** section → tap **Performance Diagnostics**.
4. Or type `/settings/performance-diagnostics` directly in the address bar.

## How to perform a fresh-login test

This is the most useful test for "is it slow for everyone or just after idle?"

1. Open the diagnostics page first (so you know where it is).
2. **Log out** completely (diagnostics are wiped on logout — that is by design).
3. Log back in and **note the login feel** — the login request is recorded.
4. Navigate to Dashboard, Workbench, Scheduled Activities / Follow-up Queue —
   one at a time, waiting for each page to finish.
5. Return to Performance Diagnostics. Requests are numbered; the first request
   after app load is badged **"1st after app load"**, everything after that is
   a **subsequent request** (warm). Comparing a first request against a
   subsequent request to the same endpoint tells you whether the slowness is a
   first-hit effect or constant.

> The panel never claims "cold start" or blames any infrastructure layer — it
> only shows measured numbers.

## Which numbers to copy / share

Tap **Copy summary** and paste the plain-text result into your report/chat. It
contains, for each recent request: the endpoint, duration in ms, HTTP status,
and the Server-Timing value when the server sent one — plus the slowest
request, average, and the counts of requests over 1 s and over 3 s. Sensitive
values are never included (see [Privacy](#privacy-safeguards)).

## What the columns mean

| Field | Meaning |
|---|---|
| **Total duration** | Time measured in the browser from just before the request was sent until the full response was received (and, for app data requests, until the body finished reading). This is what the user experiences per request. |
| **Server-Timing** | A header the backend already sends (e.g. `total;dur=2610`) describing how long the **server** says it worked. `Server: 2.61 s` next to a `2.84 s` total means almost all of it was server-side. |
| **Status** | `200`, `404`, … or `network error` (the request never got a response — offline, DNS, timeout at the connection level). |
| **Response size** | `content-length` when the server provides it. May be "not provided" for streamed/compressed responses. |
| **Pending** | The request is still in flight right now. |

## How to read frontend/network vs backend delay

Compare **Total duration** with **Server-Timing** on the same row:

- **Server-Timing ≈ total** (the panel shows a hint when the server share is
  ≥ ~70 %) → the backend itself took most of the time (server processing /
  database). Example: total 2.84 s, `Server: 2.61 s`.
- **Server-Timing much smaller than total** (hint shown when the server share
  is ≤ ~40 % on a slow request) → most of the delay was on the client/network
  path: mobile radio, DNS/TLS, transfer, or rendering. Try the same page on
  Wi-Fi vs mobile data to separate network from device.
- **`network error` rows** → the request did not reach the server at all;
  check the browser's online/offline badge at the top of the panel.

Color coding of durations: **green** < 500 ms · **amber** 500 ms–1 s ·
**orange** 1–3 s · **red** > 3 s.

These are observations, not diagnoses — the panel deliberately avoids claiming
an infrastructure cause (e.g. it never says "cold start").

## Privacy safeguards

The recorder lives in the centralized API layer and stores **only request
metadata**:

- ✅ Stored: sanitized endpoint path, HTTP method, status code, durations,
  Server-Timing text, content-length, timestamps, sequence number, short
  network-error messages (e.g. "Failed to fetch").
- ❌ Never stored: Authorization header, JWT/token, passwords, request bodies,
  response bodies, cookies, customer names/phones/emails, environment values.
- URLs are sanitized **default-deny**: only known-safe query keys (`page`,
  `limit`, `status`, `from`, `to`, …) keep their values — everything else
  (including search terms) is replaced with `…`. A lead name typed into search
  can therefore never appear in the panel or the copied summary.
- In-memory only: no PostgreSQL, no localStorage, no sessionStorage, no
  network transmission. Cleared on **logout**, on **login**, on the **Clear
  diagnostics** button, and whenever a **different authenticated session** is
  detected — a new user can never inherit the previous user's diagnostics.

These guarantees are enforced by tests in
`server/tests/perf-diagnostics-source-guards.test.ts`.

## Buttons

- **Copy summary** — copies the paste-safe plain-text report (mobile-friendly;
  works even without the async clipboard API via a fallback).
- **Refresh** — re-reads the current in-memory data. The list also updates
  live automatically; no requests are made by this page itself.
- **Clear diagnostics** — wipes the recorded entries immediately.

## How to remove this feature later

The feature is intentionally small and isolated. Revert its merge commit (or
delete the additions):

- `src/modules/shared/api/diagnostics.ts` (the recorder — delete)
- `src/modules/settings/pages/PerformanceDiagnostics.tsx` (the page — delete)
- `src/modules/auth/components/AdminRoute.tsx` (the gate — delete)
- `src/lib/apiClient.ts` — remove the `instrumentedDiagnostics` wrapper and
  the diagnostics import (the auth patch itself is original behavior)
- `src/modules/shared/api/http.ts` — remove the single
  `noteApiBodySettled(response)` call + import
- `src/App.tsx` — remove the lazy import and the
  `/settings/performance-diagnostics` route (+ `AdminRoute` import)
- `src/layouts/AppLayout.tsx` — remove the admin-only sidebar entry (+ the
  `Gauge` icon import)
- `server/tests/perf-diagnostics-source-guards.test.ts` — delete
- this document — delete

No server or database changes need to be reverted — there are none.
