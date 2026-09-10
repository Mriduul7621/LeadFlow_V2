# Lead Follow-up / Status Activity — server-authoritative (STEP 4A)

> Scope: the way **new** follow-up / status activity is created and read in
> LeadFlow. Nothing else about the CRM was redesigned: auth lifecycle,
> hierarchy architecture, bulk-import behaviour, RLS, dashboards and DB
> performance work are untouched (the single exception is one
> history-preservation guard in `POST /api/leads`, described in
> [Backward compatibility](#backward-compatibility)).

---

## 1. Why this exists

Before this change, recording a status change was a client-authorised
read-modify-write:

1. `leadService.updateLeadStatus()` fetched the lead, built a
   `statusHistory` entry **in the browser**, appended it to the array it had
   been given, and `POST /api/leads` wrote the whole lead back.
2. `leadService.getLead()` fetched the entire `/api/leads` list and picked
   one entry out of it client-side.

That gave PostgreSQL nothing it could trust:

| Problem | Consequence |
| --- | --- |
| actor + date came from the client | anyone could attribute an activity to another employee, or backdate it |
| full history array round-tripped | two users saving the same lead silently dropped one user's events |
| no append-only mutation | history was a column the client overwrote, not a log |
| no single-lead read | every Lead360 open transferred every visible lead |
| no dedicated activity source | "who did what when" existed only inside a JSONB blob |

## 2. The activity authority model

```
Browser (LeadList / Dashboard / Lead360)
        │  business fields ONLY: status, remarks, dates, NCP, product, …
        ▼
POST /api/leads/:id/follow-up          ← requireAuth
        │  server derives: actor = session user, event time = server clock
        │  server validates: canonical FollowUpStatus dictionary, lead edit
        │                      permission, lead visibility, live (not
        │                      soft-deleted) lead
        ▼
BEGIN
  SELECT … FROM leads WHERE … AND is_deleted = FALSE FOR UPDATE   (lock)
  UPDATE leads  … current state …, status_history = status_history || [entry]
  INSERT INTO lead_activities (…)  (append-only event)
COMMIT                                ← one failure ⇒ ROLLBACK ⇒ nothing partial
```

Three rules define the model:

1. **`lead_activities` is append-only and server-written.** No endpoint
   accepts an activity id, actor or timestamp; there is no update or delete
   route for it. A user with legitimate lead access can add an event; nobody
   can rewrite or remove one.
2. **The client never authors history.** `statusHistory`,
   `assignmentHistory`, `changedBy`, `updatedBy`, `createdBy`, `actor`,
   `date` and `timestamp` in a follow-up body are a hard `400`, not a silent
   ignore — so a client can never *believe* it forged an actor.
3. **The legacy JSONB is a mirror, not a source.** `leads.status_history` is
   still maintained (the current UI renders it) but it is appended **in SQL**
   inside the same transaction, never replaced from a request body.

### The imported spreadsheet is NOT history

`lead_activities` starts **empty** for every lead and is deliberately not
backfilled from the legacy sheet. The bulk import (Steps 1–3A) persists a
*current-state snapshot*: one row per lead, in whatever state it happened to
be in on the export day. Turning that into fabricated "activity events" would
put invented history into an audit table. The first row any lead gets in
`lead_activities` is therefore always a real, observed LeadFlow action — see
test *V*.

## 3. Migration

`server/database/migrations/037_lead_activities.ts` (registered in
`runMigrations.ts`, so it runs on the next cold start / `npm run dev`):

| column | type | notes |
| --- | --- | --- |
| `id` | `UUID PK` | `gen_random_uuid()`; the API supplies it so the mirrored history entry can carry the same id |
| `lead_id` | `UUID NOT NULL` | FK → `leads(id)` `ON DELETE CASCADE` (no orphan events) |
| `activity_type` | `VARCHAR(50) NOT NULL` | `'status_update'` today; the column exists so later activity kinds share one stream |
| `status` | `VARCHAR(255)` | resulting canonical status of the event |
| `remarks` | `TEXT` | event-scoped note |
| `next_follow_up_at` / `next_call_at` / `meeting_at` | `TIMESTAMP` | scheduled dates |
| `meeting_type` | `VARCHAR(150)` | |
| `collected_ncp` / `projected_ncp` / `sum_assured` | `NUMERIC(14,2)` | `>= 0` CHECKs, mirroring `leads` |
| `product_name` / `loss_reason` | `VARCHAR(255)` | |
| `created_by` | `UUID` | FK → `users(id)` `ON DELETE SET NULL` — **server-derived actor** |
| `created_at` | `TIMESTAMP NOT NULL` | **server-derived event time** |

Indexes: `idx_lead_activities_lead_created (lead_id, created_at DESC, id DESC)`
(the timeline query), `idx_lead_activities_created_at (created_at DESC)`
(recent activity), `idx_lead_activities_created_by (created_by)`.

Style notes: every statement is idempotent (`CREATE TABLE IF NOT EXISTS`,
guarded `pg_constraint` checks, `CREATE INDEX IF NOT EXISTS`) matching
migrations 035/036, and `down()` drops only the new table.

## 4. Endpoint contract

All three routes are on the existing mounted router
(`server/routes/production.routes.ts`), use the existing `requireAuth`, and
reuse `getCallerDbInfo` / `resolveCallerVisibility` / `isLeadAccessible` /
`hasPermissionCode` unchanged.

### `POST /api/leads/:id/follow-up`

`:id` — `lead_code` **or** lead UUID (same resolution pattern as
`DELETE /api/leads/:id`).

Request body — accepted fields (all optional; **only these are read**):

| field | type | effect |
| --- | --- | --- |
| `status` (alias `currentStatus`) | canonical status string | resolved against the FollowUpStatus dictionary; absent/blank ⇒ status unchanged. `status` wins when both are sent; two *different* values ⇒ `400` (never a silent pick) |
| `remarks` | text ≤ 4000 | stored on the activity row + history mirror |
| `nextFollowUpDate` | date | → `leads.next_follow_up_at` + `lead_activities.next_follow_up_at` |
| `nextCallDate` | date | → `custom_fields.nextCallDate` + `next_call_at` |
| `meetingDate` | date | → `custom_fields.meetingDate` + `meeting_at` |
| `meetingType` | text | → `custom_fields.meetingType` + `meeting_type` |
| `collectedNCP` | number ≥ 0 | → `custom_fields.collectedNCP` + `collected_ncp` |
| `projectedNCP` | number ≥ 0 | → `leads.expected_premium` + `projected_ncp` |
| `sumAssured` | number ≥ 0 | → `leads.expected_value` + `sum_assured` |
| `productName` | text | → `custom_fields.productName` + `product_name` |
| `lossReason` | text | → `custom_fields.lossReason` + `loss_reason` |

Partial-update semantics, applied consistently:

* **absent (`undefined`) ⇒ preserved** — a follow-up that only sets a next
  call date touches nothing else;
* **explicit `null` / blank string ⇒ that field is cleared**;
* `leads.notes` (the lead's profile note, which the import fills from
  "Final Remarks") is **never** overwritten by a follow-up remark: remarks
  are event data and live on the event.

Rejections (nothing is written):

| situation | status |
| --- | --- |
| no/invalid token | `401` |
| caller record missing, or no `leads.edit` grant (incl. explicit deny, missing definition, DB error) | `403` — fail closed |
| lead found but outside the caller's visibility scope | `403` (matches `POST /api/leads`) |
| lead absent, or soft-deleted | `404` |
| unknown status, invalid date, negative amount | `400` with the offending field named |
| any `statusHistory` / `changedBy` / `date` / … audit key in the body | `400` naming the keys |
| database failure at any point | `500`/`503`, transaction rolled back — never a success |

Status validation reuses `resolveImportStatus()` from
`server/routes/leadImport.ts` — the *same* canonical FollowUpStatus
dictionary logic the hardened bulk import uses (active `options` rows of type
`FollowUpStatus`, else the documented built-in list), so case/punctuation
variants resolve to the canonical spelling, legacy aliases keep working, and
an unknown status fails loudly instead of becoming `Untouched`.

Success response (`200`) — the committed state, read back after `COMMIT`:

```jsonc
{
  "success": true,
  "data": {
    "lead": { /* full lead read model, exactly as GET /api/leads/:id */ },
    "activity": {
      "id": "0f0c…", "activityType": "status_update",
      "status": "Follow-up Set", "date": "2026-09-10T13:31:02.221Z",
      "remarks": "…", "nextFollowUpDate": "2026-09-25T00:00:00.000Z",
      "updatedBy": "User A (EMPA)",            // composed from users on read
      "updatedByEmployeeId": "EMPA", "updatedByName": "User A"
      /* …meeting/NCP/product fields… */
    }
  }
}
```

### `GET /api/leads/:id`

`requireAuth` + `leads.view` + the caller's lead visibility; `is_deleted =
FALSE` only; returns **one** lead object in the existing read model
(`mapLeadRow`). Absent *and* not-visible both answer `404` so the endpoint
cannot be used to probe which lead codes exist.

### `GET /api/leads/:id/activities`

Same lead lookup and visibility rules (`404` otherwise). Query params:
`limit` (default 200, max 1000). Ordering is **reverse chronological**
(`created_at DESC, id DESC`) and is applied identically by every reader.
Response: `{ success: true, data: { activities: [...] } }`. It returns only
`lead_activities` rows — legacy `status_history` entries are reachable through
the lead read model, not smuggled into the audit stream.

## 5. Client changes

`src/modules/leads/services/leadService.ts`:

* `updateLeadStatus(...)` now posts **only** the business fields to
  `…/follow-up`. The `updatedBy` argument remains in the signature so the
  existing `LeadList`/`Dashboard` call sites keep compiling, and is
  deliberately never transmitted. No prior-lead fetch, no history array, no
  client timestamp. The cache is written **after** the server reports the
  commit.
* `getLead(id)` → `GET /api/leads/:id`. A server `404` returns `null` (a lead
  the server does not return is never resurrected from cache); a network or
  `5xx` failure falls back to the read-only cache, and `4xx` propagates.
* New `getLeadActivities(id)` → the authoritative stream.
* `updateLead(...)` strips `statusHistory`, `assignmentHistory`, `createdBy`,
  `updatedBy` and `timestamp` from the payload it sends to `POST /api/leads`.
* `src/services/localDb.ts`: the dead local-only `updateLeadStatus()` helper
  was **removed** — localStorage is a read cache, and an offline status write
  was exactly the "fake success" path this PR eliminates.

`src/modules/leads/pages/Lead360.tsx` (no visual redesign): the timeline's
status events now come from `GET /api/leads/:id/activities`; legacy
`status_history` entries are still rendered **only** for events that predate
the activity table, de-duplicated by the `activityId` correlation stamp (plus
a date guard), so nothing is double-shown and nothing is lost. The activity
read is independent: if it fails, the lead profile still renders from the
history it carries.

## 6. Backward compatibility

* `lead_activities` is **internal**: no direct write API exists, so PostgreSQL
  stays the only source of truth and the table cannot be poisoned.
* `leads.status_history` keeps being maintained by the server (same
  transaction, SQL-side append), so every existing consumer —
  `LeadList`, `AllLeads`, `Dashboard`, `NcpProgress` — keeps working
  unchanged. The one contract change is that it can no longer be *replaced*
  by a client payload.
* `GET /api/leads` (list) and the whole bulk-import path are behaviourally
  unchanged; `POST /api/leads` gained one guard: an **empty/absent** history
  array no longer wipes stored history (`LEAD_UPSERT_SQL` now uses the same
  preserve-on-empty `CASE` the bulk-import update already used, for both
  `status_history` and `assignment_history`). A non-empty array still writes
  exactly as before, so nothing that relied on it changed. Dev-demo (in-memory)
  mode got the equivalent guard, plus a demo activity list, so local
  development keeps working without a database.
* Assignment history keeps its existing secure path (server-side merge inside
  `POST /api/leads`); this PR does not restructure it.

## 7. Concurrency

`SELECT … FOR UPDATE` serializes follow-ups on one lead, and both the
`custom_fields` merge and the `status_history` append are expressed as SQL
against the row's current value (`||`) rather than "value the client last
saw". A lost update therefore needs a client to send a full history array —
which the follow-up endpoint rejects, and which `POST /api/leads` now ignores
when empty.

## 8. Tests & results

`server/tests/lead-follow-up-activity-integration.test.ts` — 36 tests, real
PGlite PostgreSQL + the real mounted router; the activity table is created by
**running migration 037 itself**, so the shape under test is the production
shape:

> A follow-up by a visible user · B `current_status` · C activity rows
> (+ C2 migration columns/FKs/indexes, C3 cascade delete) · D actor = session
> user (+ D2 display actor) · E spoofed `changedBy`/`updatedBy`/`createdBy`/
> `actor`/`date`/`timestamp`/`statusHistory`/`assignmentHistory` rejected with
> nothing written (+ E2) · F server timestamp + mirror correlation ·
> G `nextFollowUpDate` · H remarks (+ `notes` preserved) · I meeting fields ·
> J NCP/sum-assured/product/loss-reason (+ J2 preserve-vs-clear) ·
> K unknown status (+ K2 canonical dictionary & inactive option, K3 invalid
> date/amount) · L invisible user, L2 DownTeam manager, L3 401/404,
> L4 UUID-or-code · M missing `leads.edit` and explicit user-level deny ·
> N soft-deleted lead · O **DB failure rolls back lead update *and* insert**
> (a test-only `CHECK` trips only the activity insert) · P sequential appends
> never lose an event, P2 concurrent follow-ups all persist · Q no history
> needed from the client and none clobbered · R single-lead GET visibility ·
> S soft-deleted hidden · S2 `leads.view`/`leads.edit` fail closed ·
> V legacy imported lead (empty history) takes its first new activity ·
> X activity read honours visibility · W the pure request-contract parser ·
> Y the migration is actually wired into `runMigrations()` (a migration that
> is never registered silently never runs) and contains no backfill ·
> Y2 the `POST /api/leads` history-preservation guard + `requireAuth` on all
> three new routes.

`server/tests/lead-follow-up-client-service.test.ts` — 9 tests that drive the
**real browser modules** (`leadService`, `localDb`, `shared/api/http`,
`lib/apiClient`, `authStore`) over real HTTP against that same router and
database, recording what actually went on the wire:

> T `getLead()` issues `GET /api/leads/:id` and **never** `GET /api/leads`
> (+ T2 404 ⇒ `null`, no cache resurrection) · Q the follow-up body contains
> only business fields — asserted key-by-key against
> `statusHistory`/`assignmentHistory`/`updatedBy`/`changedBy`/`actor`/`date`/
> `timestamp` (+ Q2 profile edits too) · R activity stream comes from
> `/activities`, newest first, with the server-derived actor (+ R2 an
> imported lead's stream is empty until a real action happens) ·
> U **a rolled-back DB write rejects and leaves localStorage untouched**, then
> recovers · U2 a `400` writes nothing · U3 a lost connection is a rejection,
> never an offline success.

Commands (all green, from the branch head):

| command | result |
| --- | --- |
| `npm test` / `npm test -- --run` | **172 tests, 0 failures** (127 pre-existing + 45 new) |
| `npx tsc --noEmit` | clean |
| `npx vite build` | clean |
| `npm run build` (vite + esbuild server bundle) | clean |
| `npm run verify:serverless` | all checks pass; `037_lead_activities` is traced and compiled into the Vercel-style ESM tree |

## 9. Known limits (deliberate, for later steps)

* Only `status_update` activities are written. Notes/documents/calls still
  live on their existing paths; the table and `activity_type` exist so they
  can move onto the same stream later.
* `lead_activities` is not exposed as an org-wide feed (e.g. an
  `/activities` audit page) — out of scope here.
* `updated_by`/`updated_at` on the lead remain the "who last touched this
  row" fields; the *why/what* history is the activity stream.
