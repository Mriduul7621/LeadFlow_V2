# Scheduled Activities — Server-Authoritative Calendar (Step 5C)

> PostgreSQL is the single source of truth. All scheduled activities are stored in `scheduled_activities` and enforced server-side with the same visibility model as leads. Asia/Dhaka is the business timezone. No `localStorage`, `localDb`, or client-derived lead-field calendar exists.

---

## 1. Data model

### Table `scheduled_activities` (039_scheduled_activities.ts)

| Column | Type | Constraints |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `lead_id` | UUID FK → `leads(id)` | `NOT NULL`, `ON DELETE CASCADE` |
| `activity_type` | VARCHAR(30) | `CHECK IN ('call','meeting','follow_up')`, `NOT NULL` |
| `title` | VARCHAR(255) | nullable |
| `scheduled_at` | TIMESTAMP | `NOT NULL` — UTC instant of the scheduled event (displayed in `Asia/Dhaka`) |
| `duration_minutes` | INTEGER | `NULL` or `>0 AND <=1440` |
| `remarks` | TEXT | nullable |
| `status` | VARCHAR(30) | `IN ('scheduled','completed','cancelled')`, default `scheduled` |
| `created_by` | UUID FK → `users(id)` | `ON DELETE SET NULL` |
| `assigned_to` | UUID FK → `users(id)` | `ON DELETE SET NULL` (denormalized from lead for convenience) |
| `created_at` / `updated_at` | TIMESTAMP | `DEFAULT NOW()` |

Indexes: `lead_id`, `scheduled_at`, `(lead_id, scheduled_at)`, `status`, `type`, `created_by`, `assigned_to`, `(scheduled_at, status)`.

**Idempotent migration** — safe to run on every cold start. No schema change was made to `leads`; the calendar does not fabricate events from `nextCallDate`/`meetingDate` client-side.

---

## 2. API — `server/routes/production.routes.ts`

All routes require `Authorization: Bearer <JWT>` and enforce `leads.view` (read) or `leads.edit` (write) via the existing `hasPermissionCode` request-scoped memo (one JOIN, memoized per request, fail-closed on missing definition/DB error, ADMIN bypass preserved).

Visibility is inherited from the **parent lead** via `resolveCallerVisibility` + `isLeadAccessible` (`Own` → only caller, `DownTeam` → reporting subtree, `FullTeam` → department, `Organization`/`ADMIN` → all). A scheduled activity is visible iff its `lead_id` lead is visible. Soft-deleted leads hide their activities (404).

Business time `Asia/Dhaka` is used for `from`/`to` filtering: `?from=YYYY-MM-DD&to=YYYY-MM-DD` are interpreted as Dhaka midnights (`dhakaStartUtc(from) ≤ scheduled_at < dhakaStartUtc(to+1)`). `Server-Timing` header includes `scheduled.create` etc. In dev-demo (`!DATABASE_URL && !production`) the `fallbackStore.scheduledActivities` mirror is used.

| Method | Path | Query / Body | Authz | Description |
|---|---|---|---|---|
| `GET` | `/api/scheduled-activities` | `?from=&to=&leadId=&activityType=&status=&limit=&offset=` | `leads.view` + visibility | Calendar list, ordered `scheduled_at ASC`. `leadId` accepts `leads.id` or `lead_code`. `limit` 1..200 default 50. Returns `{success, data:[], pagination:{limit,offset,total}}`. |
| `GET` | `/api/scheduled-activities/:id` | — | `leads.view` + visibility | Single item, 404 if lead invisible or soft-deleted. |
| `POST` | `/api/scheduled-activities` | `{leadId, activityType, scheduledAt, title?, remarks?, durationMinutes?, status?}` | `leads.edit` + visibility | Creates activity. Validates `leadId` (404 if invisible), `activityType`, `scheduledAt` ISO, `duration` 1..1440, `status`. Persists `assigned_to` from lead for convenience. |
| `PUT` | `/api/scheduled-activities/:id` | Partial `{activityType, scheduledAt, title, remarks, durationMinutes, status}` | `leads.edit` + visibility | Patch update, 404 if invisible. `updated_at = NOW()`. |
| `DELETE` | `/api/scheduled-activities/:id` | — | `leads.edit` + visibility | Hard delete, 404 if invisible. |
| `GET` | `/api/leads/:id/scheduled-activities` | — | `leads.view` + visibility | Convenience: all activities for a lead, ordered `scheduled_at ASC`. |

Error handling never falls back to memory when `DATABASE_URL` is set; `fallbackStore` is used only in dev-demo.

---

## 3. Client

### Service `src/modules/scheduledActivities/services/scheduledActivityService.ts`

Thin wrapper around `src/modules/shared/api/http.ts` (`apiRequest`). Methods:

- `list(params)` → `GET /api/scheduled-activities` (Dhaka `from`/`to`, `leadId`, `activityType`, `status`, pagination)
- `getById(id)` / `getByLead(leadId)` / `create(payload)` / `update(id, patch)` / `remove(id)`

No `localStorage`/`localDb` authority. The service is the only calendar data source.

### Dashboard `src/modules/dashboard/pages/Dashboard.tsx` (Step 5C)

- Header comment updated to Step 5C; Daily Execution is now server-authoritative.
- `loadDailyExecution` runs three parallel server calls:
  ```ts
  leadService.getFollowUpQueue({ bucket:'today' })
  leadService.getFollowUpQueue({ bucket:'upcoming' })
  scheduledActivityService.list({ from: dhakaToday, to: dhakaTomorrow })
  ```
  `dhakaToday`/`dhakaTomorrow` are derived via `toLocaleDateString('en-CA', {timeZone:'Asia/Dhaka'})`. Follow-ups are split into Today/Tomorrow via the server's `bounds.tomorrowStart`; scheduled activities are split by their Dhaka YMD.
- UI: Today/Tomorrow groups now render **follow-ups + scheduled calls/meetings** (each capped at 6). The old placeholder line *“Call and meeting scheduled activities arrive with scheduled_activities in Step 5C.”* is replaced by:
  > *“Follow-ups from the server follow-up queue and calls/meetings from server `scheduled_activities` (Asia/Dhaka, visibility-enforced) — no full lead-list fetch runs for this panel.”*
- Section desc changed to *“follow-ups + scheduled_activities (server-authoritative, Asia/Dhaka)”*.
- `TaskCalendar` embed on the right remains `<TaskCalendar embedded />`.

### Task Calendar `src/modules/auth/pages/TaskCalendar.tsx` (Step 5C)

Rewritten to be server-authoritative:

- **Removed** `leadService.getLeads()` + `buildActivities` derivation.
- **Added** `scheduledActivityService` as sole data source. `useEffect` depends on `[user, currentDate, viewMode, embedded]` and computes a Dhaka `from`/`to` window per view:
  - `embedded` (Dashboard) → 90-day window (30 days before → 60 days after today)
  - `year` → Jan 1..Dec 31, `month` → month bounds, `week` → Sun..Sat, `day` → single day
- Maps `ScheduledActivity[]` → `CalendarEvent[]` (`id`, `leadId`, `prospectName`, `type`, `title`, `date`, `remarks`, `status`).
- Type filter maps `follow_up` → UI `followup` toggle.
- Text search matches `prospectName`, `leadMobile`, `title`, `remarks` (no lead-field leakage).
- Modal shows `prospectName`, `leadStatus`, `status`, `scheduledAt` (Dhaka locale).
- `src/pages/TaskCalendar.tsx` now re-exports the authoritative module to avoid a divergent duplicate.

### Lead Detail `src/modules/leads/pages/Lead360.tsx` (Step 5C)

- Imports `scheduledActivityService`.
- `load()` now also fetches `scheduledActivityService.getByLead(id)` (visibility-enforced).
- New **Scheduled Activities** card above the Timeline:
  - Form: `activityType` (call/meeting/follow_up), `datetime-local` → ISO, `title`, `durationMinutes`, `remarks`.
  - `POST /scheduled-activities` on submit, `DELETE` per row.
  - List shows `title · type`, Dhaka `scheduledAt`, `status`, `remarks`.

---

## 4. Tests

### Integration `server/tests/scheduled-activities-integration.test.ts` (11 tests)

- **A.** happy-path create
- **B.** validation (missing lead, bad type/date/duration/status)
- **C.** visibility Own — only own lead activities
- **D.** visibility DownTeam — manager sees subordinate
- **E.** visibility Organization — admin sees all
- **F.** filtering `from`/`to` (Dhaka), `type`, `status`, `leadId`
- **G.** get single + update + delete (visibility enforced, 404 for other user)
- **H.** `GET /leads/:id/scheduled-activities` (404 for invisible lead)
- **I.** auth 401/403 (missing token, missing `leads.edit`)
- **J.** client source guards — Dashboard & TaskCalendar reference `scheduled_activities`, TaskCalendar never calls `leadService.getLeads`
- **K.** soft-delete cascade — activities invisible after lead soft-delete

All 11 use `pglite` (`DATABASE_URL=pglite://memory`), `resolveVisibility`, and `hasPermissionCode` (fail-closed, override precedence, admin bypass unchanged).

### Source guards `server/tests/dashboard-ux-step5b-source-guards.test.ts` (updated for Step 5C)

- **Header** notes Step 5C supersedes Step 5B guards **E** and **O**.
- **E.** (updated) — KPI loader still must not call `getLeads`/`localStorage`/`localDb`; asserts Dashboard never calls `leadService.getLeads` anywhere (now replaced by `scheduled_activities`).
- **O.** (updated) — Daily Execution now loads **follow-up queue + server `scheduled_activities`** (`scheduledActivityService.list`, Dhaka-aware, `from: dhakaToday`); asserts `getFollowUpQueue` still used, `scheduledActivityService` present, `scheduled_activities` referenced, old placeholder *“scheduled_activities in Step 5C”* absent, and no `buildActivities`/`getLeads`.

---

## 5. Verification

- `npm test -- --run` → **251 pass / 0 fail** (240 baseline + 11 new)
- `tsc --noEmit` → clean (no `any` leakage beyond whitelisted `leadService` fallback)
- `vite build` → success (549 kB gzipped)
- `npm run build` → `dist/server.cjs` 365 kB
- `npm run verify:serverless` → all checks pass (Vercel ESM, 50 modules including `039_scheduled_activities.js`, production honesty 503 without `DATABASE_URL`)

---

## 6. Intentionally deferred

| Item | Phase |
|---|---|
| Real trend time-series endpoint | later |
| Canonical team performance (hierarchy/team joins) | later |
| Advanced “needs attention” rules | later |
| Lead scoring / no-next-action scoring | later |
| Activity reminders / push notifications | later |

---

## 7. Why Step 5C supersedes Step 5B guards E/O

Step 5B deliberately limited Daily Execution to follow-up-queue-only and surfaced the placeholder note *“Call and meeting scheduled activities arrive with scheduled_activities in Step 5C.”* Guard **O** enforced that limitation and guard **E** ensured KPIs never used a client lead list.

Step 5C replaces the placeholder with a real, server-authoritative `scheduled_activities` table and calendar API (Asia/Dhaka, visibility-enforced). Daily Execution and Task Calendar now fetch from `scheduled_activities` instead of deriving events from lead fields. Guards **E** and **O** are therefore updated to assert the new server source and the removal of the placeholder note, while preserving their original intent (no `getLeads` authority, KPIs from `GET /api/dashboard` only).

