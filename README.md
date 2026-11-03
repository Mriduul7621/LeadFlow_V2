# LeadFlow V2

LeadFlow V2 is the lead management CRM used by the Shanta Life Insurance PLC field sales force. It covers lead intake (single create and bulk import), follow-up queues, scheduled activities, a daily workbench, team hierarchy and role-based access, dashboards and reporting, roadshows, and in-app notifications.

Core retained features — do not remove without an explicit product decision:

- **Task Calendar** — month view of scheduled activities and follow-ups.
- **Daily Workbench with Today / Tomorrow views** — Overdue / Today / Tomorrow buckets computed on Asia/Dhaka business days, plus scheduled activities and roadshows for the day.

## Stack

| Layer | Technology |
|---|---|
| Web app | React 19 + Vite + Tailwind CSS 4, React Router, Zustand |
| API (standalone) | Express — production entrypoint `server.ts` |
| API (serverless) | Vercel function — `api/index.ts` (same production routes as `server.ts`) |
| Database | PostgreSQL, hosted on Supabase, accessed with the `pg` driver |
| Auth | Custom JWT + bcrypt (`bcryptjs`) — **not** Supabase Auth. The app does not use the Supabase JS client or Supabase RLS; authorisation is enforced in the API and in server-side hierarchy visibility |
| Android | Capacitor — the built web app is bundled inside the APK; only the API is remote (see `docs/ANDROID_APP.md`) |
| Tests | Node test runner against an in-process PostgreSQL (PGlite) |

## Setup

Prerequisites: Node.js 22 LTS.

```bash
npm ci
cp .env.example .env   # then fill in the values below
npm run dev
```

Required environment variables (see `.env.example` for the full, commented list):

- `DATABASE_URL` — PostgreSQL connection string (Supabase Dashboard → Connect → Transaction pooler).
- `JWT_SECRET` — **required in production** and must be a strong, production-specific random value. Known weak/default values are rejected at startup. Generate one with `openssl rand -base64 48`.
- `SESSION_SECRET` — secret for session signing.

Optional: observability levels/thresholds and `TRUST_PROXY` — all documented in `.env.example`.

## Database

**The migrations in `server/database/migrations/` are the single source of truth for the schema.**

```bash
npm run migrate:production
```

Do not hand-edit the database or treat any standalone SQL file as canonical — if it disagrees with the migrations, the migrations win.

## Tests & Verification

```bash
npm test                    # full server test suite (PGlite-backed)
npx tsc --noEmit            # typecheck
npm run build               # production build (Vite client + bundled server)
npm run verify:serverless   # Vercel-style serverless build + boot smoke test
npm run smoke:production    # production smoke check
```

All of the above (plus a diff/whitespace check) run as the mandatory CI gate in `.github/workflows/ci.yml` on every pull request to `main` and on every push to `main`. A green Vercel deployment is not a substitute for this gate. See `docs/CI_RELEASE_GATE.md`.

## Deployment

- **Web + API:** Vercel, configured by `vercel.json` (Git integration). The serverless entrypoint is `api/index.ts`.
- **Android:** Capacitor build that bundles the web app inside the APK — see `docs/ANDROID_APP.md`.
- **Standalone server:** `npm run build` then `npm start` serves the bundled server (`dist/server.cjs`).

Before any production deploy, work through `docs/PRODUCTION_READINESS.md` and `docs/DEPLOYMENT.md`.

## Documentation

| Doc | What it covers |
|---|---|
| `docs/API.md` | HTTP API surface |
| `docs/DATABASE.md` | Database design |
| `docs/DEPLOYMENT.md` | Deployment procedure |
| `docs/PRODUCTION_READINESS.md` | Production readiness checks, blockers and go-live criteria |
| `docs/ANDROID_APP.md` | Capacitor Android app build and release |
| `docs/DAILY_WORKBENCH.md` | Daily Workbench behaviour (Today / Tomorrow) |
| `docs/FOLLOWUP_QUEUE.md` | Follow-up queue behaviour |
| `docs/SCHEDULED_ACTIVITIES.md` | Scheduled activities and the calendar |
| `docs/archive/` | Historical notes and changelogs — not current operating documentation |
