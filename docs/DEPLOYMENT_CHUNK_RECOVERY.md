# Recover gracefully from stale dynamic chunks after deployment

## The problem

LeadFlow ships one hashed chunk per route (Performance Phase 2 route-level
code splitting). After a new deployment, the previous deployment's hashed
files are gone from the server. Any user whose browser still runs the old
session — an open tab from before the deploy, a cached `index.html`, a
resumed mobile session — then requests chunk URLs that no longer exist:

- The dynamic `import()` for the route rejects
  (`Failed to fetch dynamically imported module`, `Importing a module
  script failed`, `error loading dynamically imported module`, …).
- Nothing in the app handled that rejection: `Suspense` covers the
  *loading* state only, and there was no error boundary anywhere.
- React unmounted the entire tree → a silent white screen that only a
  manual refresh fixed.

This happened on **every deployment** for **every user who was online at
the wrong moment** — the routine cost of shipping, not an edge case.

## Root cause

| Layer | Before | Gap |
|---|---|---|
| `Suspense` (per route, in `LazyPage`) | Renders `RouteFallback` while a chunk loads | Cannot catch a rejected import |
| Error boundaries | None in the app | A rejected lazy import unmounts the whole tree |
| Global handlers | None | Entry-script / modulepreload failures on a hard load were also unhandled |
| `vercel.json` | `/assets/*` is served as files and 404s when missing (correct — no HTML-fallback MIME trap) | Missing chunks are a clean 404, but the resulting rejection was still unhandled |

## The fix — three layers, one guarded reload

Reloading the document is the *whole* fix: a reload revalidates
`index.html`, whose hashed chunk references are current again. What was
missing is (a) recognizing this failure class, (b) triggering exactly one
reload, and (c) degrading gracefully when even that can't work. All of it
is framework-level recovery — zero changes to routes, auth, or server code.

### 1. `src/utils/chunkRecovery.ts` — detection + the guarded single reload

- `isChunkLoadError(payload)` recognizes every known stale-dynamic-import
  dialect — Chromium, Firefox, Safari, webpack `ChunkLoadError`, the Vite
  preload helper, and the "module served as `text/html`" MIME trap —
  including wrapped `PromiseRejectionEvent.reason` payloads.
  **Deliberately not matched:** bare `Failed to fetch`, HTTP 4xx/5xx API
  errors, aborts — those keep flowing to their existing offline/retry
  paths.
- `recoverFromChunkError()` performs **one** `location.reload()`, guarded
  by a cooldown marker in `sessionStorage` (in-memory fallback when
  storage is unavailable, e.g. privacy mode):
  - An automatic reload may happen at most once per **60 s window** per
    tab → a reload loop is impossible even if the new deployment itself
    is broken or the user went offline.
  - After the window elapses, a *new* deployment failure may auto-recover
    again (long-lived tabs stay covered for future deploys).
  - `force: true` (the explicit "Reload now" button) always reloads —
    user intent bypasses the guard, and a manual reload revalidates
    `index.html`, so it always offers a real way forward.

### 2. `ChunkErrorBoundary` — route content (the shell never dies)

`LazyPage` in `App.tsx` now wraps each route's `Suspense` boundary in
`ChunkErrorBoundary`:

- Chunk-shaped error → attempt the guarded auto-reload (state updates to
  a compact recovery card for the instant before the reload lands).
- Guard spent → render an explicit bilingual (**EN/BN**) "New version
  available — Reload now" card inside the content area. The sidebar and
  header stay intact and usable; nothing auto-retries behind the user's
  back.
- Any other error → `getDerivedStateFromError` returns `null`, so real
  bugs are **not** swallowed and keep their pre-existing behavior.

### 3. Global safety net — `installGlobalChunkRecovery()` in `main.tsx`

Window-level listeners for failures that never reach a React boundary:

- `unhandledrejection` — dynamic imports outside the route tree.
- `error` — script/module evaluation failures.
- Capture-phase `error` — resource load failures don't bubble and carry
  no error object; this is how a **stale entry script or modulepreload
  link** announces itself on a hard load with a cached `index.html`.

All paths funnel into the same guarded single reload.

## Behavior matrix

| Scenario | Before | After |
|---|---|---|
| Open tab from before deploy, user navigates | White screen until manual refresh | One silent reload; user continues on the new version |
| Hard load with stale cached `index.html` | Blank page (stale entry script fails) | Capture-phase handler reloads once |
| Reload didn't help (deploy broken / offline) | White screen, retry loop or dead end | Bilingual "Reload now" card; shell stays usable; no auto-retry loop |
| Ordinary network blip / API 5xx / abort | Existing offline & retry handling | **Unchanged** — not matched as chunk errors |
| Non-chunk runtime bug | Surfaces at root (no boundary) | **Unchanged** — boundary passes them through |

## What deliberately did **not** change

- Route declarations keep their exact `lazy(() => import('./…'))` shape —
  the Performance Phase 2 splitting contract and its source guards are
  untouched; no chunk graph or preload behavior changes.
- Auth, tokens, stores, `localStorage` — a plain reload is state-neutral.
- No server/Vercel changes required. (`vercel.json` already 404s missing
  `/assets/*` instead of falling back to `index.html`; a source guard now
  pins that, since an HTML fallback there would turn stale chunks into
  MIME errors that are harder to attribute.)
- No new dependencies.

## Files

| File | Change |
|---|---|
| `src/utils/chunkRecovery.ts` | **New** — signature matching, guarded single reload, global installer |
| `src/modules/shared/components/ChunkErrorBoundary.tsx` | **New** — route-level boundary + bilingual recovery card |
| `src/App.tsx` | `LazyPage` wraps `Suspense` in `ChunkErrorBoundary` (one-line wire-up) |
| `src/main.tsx` | Installs the window-level safety net at startup |
| `src/modules/shared/utils/translations.ts` | `newVersionTitle` / `newVersionBody` / `reloadNow` (EN + BN) |
| `server/tests/chunk-recovery.test.ts` | **New** — behavior + wiring source guards |
| `docs/DEPLOYMENT_CHUNK_RECOVERY.md` | **New** — this document |

## Verification

- `npm run lint` (`tsc --noEmit`) — clean.
- `tsx --test server/tests/chunk-recovery.test.ts` — signature matrix,
  cooldown/loop-prevention behavior, sessionStorage persistence, and all
  wiring source guards pass.
- Full `npm test` suite and `npm run build` (route chunks unchanged)
  pass.
- Manual matrix: deploy → keep an old tab open → navigate (one silent
  reload); hard-reload with warmed cache; throttle to offline (recovery
  card, no loop); Bengali locale renders the card in বাংলা.
