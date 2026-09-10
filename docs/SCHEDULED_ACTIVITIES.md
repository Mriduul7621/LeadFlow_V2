# Scheduled Activities — Server-Authoritative Calendar (Step 5C)

> PostgreSQL is the single source of truth. `scheduled_activities` holds **planned** work (PENDING/SCHEDULED, mutable); `lead_activities` holds **completed** immutable history. Completion is an atomic `BEGIN … COMMIT` that creates exactly one `lead_activities` row and marks the scheduled row `COMPLETED`. Asia/Dhaka is the business timezone. No `localStorage`, `localDb`, or client-derived lead-field calendar exists.

---

## 1. Data model

### Table `scheduled_activities` (039_scheduled_activities.ts — idempotent)

| Column | Type | Constraints |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `lead_id` | UUID FK → `leads(id)` | `NOT NULL`, `ON DELETE CASCADE` |
| `activity_type` | VARCHAR(30) | `CHECK IN ('call','meeting','follow_up','task')` lowercase, `NOT NULL` |
| `title` | VARCHAR(255) | nullable |
| `scheduled_at` | TIMESTAMP | `NOT NULL` — UTC instant (displayed in `Asia/Dhaka`) |
| `duration_minutes` | INTEGER | `NULL` or `>0 AND <=1440` |
| `remarks` | TEXT | nullable |
| `status` | VARCHAR(30) | `CHECK IN ('scheduled','completed','cancelled')`, default `scheduled` |
| `priority` | VARCHAR(20) | `CHECK IN ('LOW','NORMAL','MEDIUM','HIGH')`, default `NORMAL` |
| `meeting_type` | VARCHAR(255) | nullable |
| `location` | VARCHAR(255) | nullable |
| `created_by` | UUID FK → `users(id)` | `ON DELETE SET NULL` — server-derived, never trusted from client |
| `assigned_to` | UUID FK → `users(id)` | `ON DELETE SET NULL` — defaults to lead's `assigned_to`; client-supplied value allowed only when caller has `leads.assign` and target is within caller's visibility (narrowing rule) |
| `updated_by` | UUID FK → `users(id)` | `ON DELETE SET NULL` — server-derived on every mutation |
| `completed_at` | TIMESTAMP | nullable — server time of completion |
| `completed_by` | UUID FK → `users(id)` | nullable — server-derived actor of completion |
| `completed_activity_id` | UUID FK → `lead_activities(id)` | nullable — link to the single immutable history row created on completion |
| `created_at` / `updated_at` | TIMESTAMP | `DEFAULT NOW()` |

Indexes: `lead_id`, `scheduled_at`, `(lead_id, scheduled_at)`, `status`, `activity_type`, `created_by`, `assigned_to`, `updated_by`, `completed_by`, `completed_activity_id`, `priority`.

**Idempotency** — migration creates the table with the new columns and then runs `ALTER TABLE … ADD COLUMN IF NOT EXISTS` for each new column (`priority`, `meeting_type`, `location`, `updated_by`, `completed_at`, `completed_by`, `completed_activity_id`) plus `DO $$` that drops/recreates the `activity_type` check to widen to `task`. Re-running never fails and backfills existing installs. No change was made to `leads`; the calendar never derives events from `nextCallDate`/`meetingDate` client-side.

**Planned vs Completed** — `scheduled_activities.status='scheduled'` is the only mutable state. `completed`/`cancelled` are terminal and immutable via `PUT` (409). `COMPLETED` rows carry `completed_at/by/activity_id`; `CANCELLED` rows preserve the row with `status='cancelled'` (soft-cancel, no hard delete). Hard `DELETE` is retained for compatibility but also respects immutability (only `scheduled` can be hard-deleted, 409 otherwise).

---

## 2. API — `server/routes/production.routes.ts`

All routes require `Authorization: Bearer <JWT>` and enforce `leads.view` (read) or `leads.edit` (write) via the existing `hasPermissionCode` request-scoped memo (one JOIN, memoized per request, fail-closed on missing definition/DB error, ADMIN bypass preserved).

Visibility is inherited from the **parent lead** via `resolveCallerVisibility` + `isLeadAccessible` (`Own` → only caller, `DownTeam` → reporting subtree, `FullTeam` → department, `Organization`/`ADMIN` → all). A scheduled activity is visible iff its `lead_id` lead is visible. Soft-deleted leads hide their activities (404). Server-derived actor fields (`created_by`, `updated_by`, `completed_by`) are never trusted from the client body — they are set from `getCallerDbInfo(req).id`.

Business time `Asia/Dhaka` is used for `from`/`to` filtering: `?from=YYYY-MM-DD&to=YYYY-MM-DD` are interpreted as Dhaka midnights (`dhakaStartUtc(from) ≤ scheduled_at < dhakaStartUtc(to+1)`). `Server-Timing` header includes `scheduled.create` / `scheduled.complete` etc. In dev-demo (`!DATABASE_URL && !production`) the `fallbackStore.scheduledActivities` mirror is used with the same field set.

`assignedTo` is a **narrowing filter only** — it never widens visibility. `GET /scheduled-activities?assignedTo=<employeeId|userId>` resolves the target via `resolveAssignedTo` and checks `isAssignedToAllowed(target, visibility, caller)`. If out of scope, the API returns `200 {data:[], pagination:{total:0}}` (empty, not 403) so a caller cannot probe outside their scope. For `POST`/`PUT`, client-supplied `assignedTo` is allowed only when the caller has `leads.assign` and the target is within visibility; otherwise `400`/`403`.

| Method | Path | Query / Body | Authz | Description |
|---|---|---|---|---|
| `GET` | `/api/scheduled-activities` | `?from=&to=&leadId=&activityType=&status=&priority=&assignedTo=&limit=&offset=` | `leads.view` + visibility | Calendar list, ordered `scheduled_at ASC`. `leadId` accepts `leads.id` or `lead_code`. `activityType` in `call/meeting/follow_up/task` (lowercase). `priority` in `LOW/NORMAL/MEDIUM/HIGH`. `assignedTo` narrowing filter. `limit` 1..200 default 50. Returns `{success, data:[], pagination}`. |
| `GET` | `/api/scheduled-activities/:id` | — | `leads.view` + visibility | Single item, 404 if lead invisible or soft-deleted. |
| `POST` | `/api/scheduled-activities` | `{leadId, activityType, scheduledAt, title?, remarks?, durationMinutes?, priority?, meetingType?, location?, assignedTo?}` — `status` defaults to `scheduled` and cannot be set to `completed/cancelled` on create | `leads.edit` + visibility | Creates activity. Validates `leadId` (404 if invisible), `activityType` (includes `task`), `scheduledAt` ISO, `duration` 1..1440, `priority`. Sets `created_by/updated_by` from server, `assigned_to` via narrowing rule. Returns `201 {success,data}` mapped via `mapScheduledActivityRow`. |
| `PUT` | `/api/scheduled-activities/:id` | Partial `{activityType, scheduledAt, title, remarks, durationMinutes, priority, meetingType, location, assignedTo}` — `status` cannot be changed via PUT (400) | `leads.edit` + visibility | Patch update — **only `scheduled` is editable**. `completed`/`cancelled` return `409 Cannot edit a … activity`. Sets `updated_by` server-derived. |
| `DELETE` | `/api/scheduled-activities/:id` | — | `leads.edit` + visibility | Hard delete — compatibility only. Respects immutability: only `scheduled` can be deleted (409 otherwise). Prefer `POST …/cancel` for business cancellation. |
| `POST` | `/api/scheduled-activities/:id/complete` | Optional `{remarks, status, nextFollowUpDate, nextCallDate, meetingDate, meetingType, collectedNCP, projectedNCP, sumAssured, productName, lossReason}` — for `follow_up` these reuse canonical follow-up logic; for `call/meeting/task` status is ignored and lead status is never fabricated | `leads.edit` + visibility | **Atomic completion** (`BEGIN; SELECT … FOR UPDATE;` lock, verify `scheduled`, verify lead visibility, then either full follow-up update + `lead_activities` insert, or simple `lead_activities` insert). Creates exactly one `lead_activities` row, marks scheduled `completed` with `completed_at=NOW()`, `completed_by=caller.id`, `completed_activity_id=<new id>`, `updated_by=caller.id`. On duplicate complete returns `409` without creating a second activity (rollback on error). |
| `POST` | `/api/scheduled-activities/:id/cancel` | — | `leads.edit` + visibility | **Soft-cancel** — `BEGIN; SELECT … FOR UPDATE;` verify `scheduled`, verify lead visibility, then `UPDATE scheduled_activities SET status='cancelled', updated_by=caller.id`. Only `scheduled` can be cancelled (`completed` → 409, `cancelled` → 409). Preserves row, no silent reactivate. |
| `GET` | `/api/leads/:id/scheduled-activities` | — | `leads.view` + visibility | Convenience: all activities for a lead, ordered `scheduled_at ASC`. |

Error handling never falls back to memory when `DATABASE_URL` is set; `fallbackStore` is used only in dev-demo and mirrors the same immutability/visibility/complete/cancel logic.

---

## 3. Client

### Service `src/modules/scheduledActivities/services/scheduledActivityService.ts`

- Types: `ScheduledActivityType` includes `task`; `ScheduledActivity` includes `priority`, `meetingType/meeting_type`, `location`, `updatedBy/updated_by`, `completedAt/by/activityId` plus joined lead convenience fields.
- `ScheduledActivityListParams` supports `priority` and `assignedTo` (narrowing).
- `toQuery` serializes `priority` and `assignedTo`.
- `fetchScheduledPage` is a **single-request helper** — it does one `fetch` and returns `{items, pagination}`. `list` and `listWithPagination` both delegate to it (no `apiRequest` + `fetch` double request). The old bug that called `apiRequest` then `fetch` is fixed and guarded by test `W`.
- Methods: `list`, `listWithPagination` (single request), `getById`, `getByLead`, `create` (supports `priority/meetingType/location/assignedTo`), `update` (supports same plus `priority`), `complete(id, payload?)` → `POST …/complete`, `cancel(id)` → `POST …/cancel`, `remove(id)` → `DELETE`.

No `localStorage`/`localDb` authority. The service is the only calendar data source.

### Dashboard `src/modules/dashboard/pages/Dashboard.tsx` (Step 5C)

- Header comment updated to Step 5C; Daily Execution is now server-authoritative.
- `loadDailyExecution` runs three parallel server calls:
  ```ts
  leadService.getFollowUpQueue({ bucket:'today' })
  leadService.getFollowUpQueue({ bucket:'upcoming' })
  scheduledActivityService.list({ from: dhakaToday, to: dhakaTomorrow })
  ```
  `dhakaToday`/`dhakaTomorrow` via `toLocaleDateString('en-CA', {timeZone:'Asia/Dhaka'})`. Follow-ups split via `bounds.tomorrowStart`; scheduled split by Dhaka YMD.
- UI: Today/Tomorrow groups render **follow-ups + scheduled calls/meetings/tasks** (each capped at 6) with type-specific colors (`call` sky, `meeting` amber, `task` purple, `follow_up` emerald). The old placeholder is replaced by:
  > *“Follow-ups from the server follow-up queue and calls/meetings/tasks from server `scheduled_activities` (Asia/Dhaka, visibility-enforced) — no full lead-list fetch runs for this panel.”*
- No `getLeads` is called for the calendar; performance guard `dashboard-ux-step5b-source-guards` and new `W/X` verify this.

### Task Calendar `src/modules/auth/pages/TaskCalendar.tsx` (Step 5C)

- **Removed** `leadService.getLeads()` + `buildActivities` derivation.
- **Added** `scheduledActivityService` as sole source. `useEffect` depends on `[user, currentDate, viewMode, embedded]` and computes a Dhaka `from`/`to` window per view (embedded 90-day window, year/month/week/day).
- Maps `ScheduledActivity[]` → `CalendarEvent[]` with `type` including `task`; title fallback handles `task`; week/month/day filters include `task`.
- Type filter UI now has **Calls / Meetings / Followups / Tasks** checkboxes (legend).
- Event colors: `task` purple (`bg-purple-50` etc.) alongside call/meeting/follow_up.
- Text search matches `prospectName`, `leadMobile`, `title`, `remarks` (no lead-field leakage).
- Detail modal shows `prospectName`, `leadStatus`, `status`, `scheduledAt` (Dhaka) plus **Complete / Cancel** buttons when `status==='scheduled'` (authoritative patch: `scheduledActivityService.complete/cancel` then `setEvents` patch, no full refetch; `409` handled). Completed/cancelled show badge and disable edit.
- `src/pages/TaskCalendar.tsx` re-exports the authoritative module.

### Lead Detail `src/modules/leads/pages/Lead360.tsx` (Step 5C + Blockers)

- Imports `scheduledActivityService`.
- `load()` fetches `scheduledActivityService.getByLead(id)` (visibility-enforced) alongside lead/notifications/activities.
- **Scheduled Activities** card above Timeline:
  - Form: `activityType` (call/meeting/follow_up/**task**), `datetime-local` → ISO, `title`, `durationMinutes`, `priority` (LOW/NORMAL/MEDIUM/HIGH), `meetingType`, `location`, `remarks`. `POST /scheduled-activities` on submit; on success patches `scheduled` state with the returned row (authoritative, no full refetch) or falls back to `getByLead`.
  - List: each row shows `title · type · priority`, Dhaka `scheduledAt`, `status`, `meetingType`, `location`, `remarks`. For `status==='scheduled'` shows **Complete / Cancel / Edit / Delete**; for `completed`/`cancelled` shows badge and disables Edit (immutability 409). Complete calls `POST …/complete` and patches the row with `scheduled` from the response (includes `completed_at/by/activity_id`) and refreshes timeline; Cancel patches `cancelled`; Edit opens an inline form (title, scheduledAt, duration, priority, meetingType, location, remarks) and `PUT` patches `updated_by` server-derived; Delete is compatibility (only `scheduled` succeeds).
  - All mutations are server-authoritative; client never trusts spoofed `created_by/completed_by` etc.

---

## 4. Tests

`server/tests/scheduled-activities-integration.test.ts` (24 tests, Step 5C + Blockers) runs under `DATABASE_URL=pglite://memory` (PGlite) and covers:

- **A** create happy path, **B** validation, **C/D/E** visibility (Own/DownTeam/Organization + query bypass), **F** range/type/status/leadId filtering (Dhaka), **G** get/update/delete with immutability (PUT status 400, only pending editable), **H** lead-scoped listing, **I** auth, **J** client source guards (TaskCalendar/Dashboard use `scheduled_activities`), **K** soft-delete cascades.
- **L** TASK end-to-end (create with `task`, list filter, uppercase `TASK` normalized).
- **M** complete atomic (one `lead_activities`, `completed_at/by/activity_id` server-derived, completed row `completed`).
- **N** duplicate complete → `409` without duplicate row.
- **O** follow-up complete reuses canonical follow-up logic (updates `leads.current_status/notes/next_follow_up_at` and history).
- **P** call/meeting/task complete does **not** fabricate status.
- **Q** cancel pending → `cancelled` preserves row, second cancel/completed cancel → `409`.
- **R** edit immutability (`scheduled` editable, `completed`/`cancelled` 409, `DELETE` 409, `PUT status` 400).
- **S** `assignedTo` narrowing never widens (Own sees only own, admin sees all, `POST` with out-of-scope `assignedTo` → 403).
- **T** invisible lead → `complete/cancel/GET` 404.
- **U** server-derived `created_by/updated_by/completed_by` not spoofable.
- **V** `priority/meeting_type/location` persisted and filterable (`PUT` and `GET?priority=`).
- **W** single-request list guard (service does not do `apiRequest` + `fetch` double request, uses `fetchScheduledPage`).
- **X** Dashboard/TaskCalendar no `getLeads` performance guard.

Step 4A/4B and PR #19 suites remain green (`npm test -- --run` → 264 pass).

---

## 5. Migration safety

- `039_scheduled_activities.ts` is rerunnable: `CREATE TABLE` with all new columns, then `ADD COLUMN IF NOT EXISTS` for `priority`, `meeting_type`, `location`, `updated_by`, `completed_at`, `completed_by`, `completed_activity_id` plus indexes and widened `activity_type` check. Existing installs get backfilled without error; new installs get the full table.
- `fallbackStore.ts` mirrors the same field set (`FallbackScheduledActivity` includes `priority`, `meetingType/meeting_type`, `location`, `updatedBy/updated_by`, `completedAt/by/activityId`) and the same complete/cancel/immutability logic for dev-demo.

---

## 6. Verification

```bash
npm test -- --run          # 264 pass (24 new Step5C + blockers)
./node_modules/.bin/tsc --noEmit
npm run build              # vite 2877 modules + esbuild 405.6kb
npm run verify:serverless  # ESM + honesty mode PASS
```

All verifications are run before pushing to `arena/01a08ceb-leadflow-v2` (PR #21, base `main`, no merge).

