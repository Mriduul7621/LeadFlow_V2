# UI Localization, Design Modernization & Dashboard UX

This document describes the UI/UX + localization + visual-design changes in the
"modernize LeadFlow dashboard UX, localization and visual design" change set.
It is intentionally a **presentation-layer** change: business rules, data
authority, auth/session/JWT behavior, RBAC, hierarchy, lead CRUD, bulk import,
follow-up queue, `lead_activities` immutability, `scheduled_activities`
semantics, completion/cancel transactions, and dashboard KPI authority are all
unchanged.

---

## 1. Goals

1. Remove developer-facing wording from *visible* UI (keep it only in comments,
   docs, tests, and logs).
2. Replace the duplicated Dashboard date inputs with a single professional
   date-range control.
3. Move the embedded Task Calendar to the **last** Dashboard section while
   keeping a compact "Open Calendar" action and the `/task-calendar` route.
4. Keep Today & Tomorrow driven by the server follow-up queue +
   `scheduled_activities` (never the full lead list).
5. Clean up the global header (no "Dhaka Standard Time", no persistent Sync).
6. Provide a pre-login EN / বাংলা language selector persisted through the
   language store.
7. Complete EN / বাংলা localization across all active routes, never translating
   user-entered or business data.
8. Audit/migrate hardcoded visible English into the translation system and add
   source guards against reintroducing it.
9. Modernize the visual system around the Shanta Life brand palette.
10. Subtle gradients only; 120–180 ms motion; preserve PR #19 performance gains.
11. Responsive behavior including Bangla text, mobile date selector, calendar,
    tables and sidebar.
12. Accessibility (contrast, non-color-only status, labels, keyboard-accessible
    selectors, visible focus).
13. Performance/architecture guards (no aggressive polling, no full-list
    dashboard/calendar fetches, no N+1, no client-side authz, no local-authority
    caching of DB business data).
14. Source guards covering the above.

---

## 2. Design tokens (visual system)

Centralized in `src/index.css` under Tailwind v4 `@theme`:

| Token                | Value    | Purpose                          |
| -------------------- | -------- | -------------------------------- |
| `--color-brand-accent` | `#F3702B` | accent (orange)                |
| `--color-brand-primary`| `#978C21` | primary brand (olive/gold)     |
| `--color-brand-blue`   | `#0359B3` | info / blue                    |
| `--color-brand-dark`   | `#3C3C3C` | neutral text                  |
| `--color-card`         | `#FFFFFF` | surfaces                       |

Component classes (`card`, `card-premium`, `btn-primary`, `btn-secondary`,
`btn-ghost`, `btn-danger`, `input-standard`, `label-standard`, `badge`,
`table-base`, …) consume these tokens so pages don't scatter raw hex values.
The focus ring (`:focus-visible`) is centralized for keyboard accessibility.

### Motion & gradients
- Transitions use 120–180 ms durations (`duration-150`); subtle shadows only.
- Gradients are limited to thin KPI accent bars (`from-brand-blue to-brand-blue/60`, etc.).

---

## 3. Localization architecture

- **Single dictionary**: `src/modules/shared/utils/translations.ts` holds
  `translations.en` and `translations.bn` (mirrored key sets — a source guard
  verifies parity).
- **Hook**: `useTranslation()` returns `{ t, language, setLanguage, activityLabel }`.
  `t(key, variables?)` resolves against the active dictionary with
  `{placeholder}` interpolation.
- **Persistence**: `src/store/languageStore.ts` persists under
  `leadflow-language`, so the selection survives login, navigation, refresh and
  route changes.
- **Business data is never translated**: customer names, employee IDs, emails,
  phone numbers, product/policy codes, campaign names, remarks, uploaded data,
  and admin-configurable option values (lead statuses, areas, products, etc.)
  stay verbatim. Only static UI chrome goes through `t()`.
- `activityTypeLabelKey()` + `activityLabel()` map scheduled-activity types
  (`call`, `meeting`, `follow_up`, `task`) to localized labels.

### Pre-login language selector
`Login.tsx` renders an EN / বাংলা switcher before authentication. It calls
`setLanguage('en' | 'bn')` from the same language store used everywhere else.

---

## 4. Dashboard

`src/modules/dashboard/pages/Dashboard.tsx`

- **Date authority**: the server remains authoritative for KPI aggregation. The
  UI only chooses *which* bounds to request. `TODAY`, `ALL`, and `CUSTOM`
  (`startDate`/`endDate`) map to native server periods; `WTD`, `MTD`, `LMTD`,
  `YTD` are resolved in the UI to explicit **Asia/Dhaka** date bounds and sent
  through the existing server `CUSTOM` query (`resolveRange()`). Business-date
  boundaries remain Asia/Dhaka.
- **Single control**: one `DateRangeControl` popover with Today / WTD / MTD /
  LMTD / YTD / Custom (+ All Time as a secondary action). Default is **Today**.
- **KPIs** bind only to the `GET /api/dashboard` response
  (`totalLeads`, `statusCounts`, `followUpCounts`, `campaignStats`, `trendData`,
  `teamStats`, `converted`, `projected`, `collected`, …). No client lead list,
  no localStorage, no localDb.
- **Today & Tomorrow** panel reads the server follow-up queue
  (`leadService.getFollowUpQueue`) and `scheduledActivityService.list`
  (server-authoritative `scheduled_activities`, Asia/Dhaka). It renders
  CALL / MEETING / FOLLOW_UP / TASK with localized labels and never fetches
  `getLeads()`.
- **Calendar placement**: the embedded `TaskCalendar` is the **last** section
  (after Lead Status Distribution). A compact "Open Calendar" link sits next to
  Today & Tomorrow; `/task-calendar` remains a standalone route.
- No visible "server-authoritative", "statusCounts", "Step 4B/5/5C",
  "visibility-enforced", "PostgreSQL", or timezone-implementation wording.

---

## 5. Global header & sidebar

`src/layouts/AppLayout.tsx`

- Removed the visible "Dhaka Standard Time" label and the persistent manual
  Sync action. A compact business clock remains (no timezone wording).
- Connectivity indicator appears **only** when the database is unreachable
  (single on-mount probe via `databaseStatusService.checkDatabaseStatus()`);
  there is no permanent "Connected" noise and no polling.
- Sync / system operations moved to **Settings → System Tools** (Clear All Data
  + Check Connection) and **Settings → Network & Sync**.
- Sidebar groups (`Overview`, `My Work`, `Leads`, `Insights`, `Management`,
  `System`) and every nav label are localized. Grouping is visual only — role /
  `menuAccess` semantics are unchanged (`resolveMenuVisibility`,
  `isItemVisible`, `visibleSections`, admin bypass).

---

## 6. Localized surfaces

- **Login** — language selector, setup/login forms, validation messages, badge,
  footer, toasts.
- **Dashboard + insight pages** — `TrendCharts`, `ExecutionIntelligence`,
  `NcpProgress`, `CampaignBreakdown` (titles, subtitles, KPI cards, charts,
  tables, export toasts, drilldown popups, empty states).
- **Leads** — `LeadGenerate`, `LeadList` (table + tracking modal), `AllLeads`
  (admin archive), `LeadUpload`, `FollowUpStrategy`, `Activities`, `Lead360`.
- **Calendar** — `TaskCalendar` uses `Intl.DateTimeFormat` for locale month/day
  names and localized headers, filters, drawer, agenda and actions.
- **Management** — `UserManagement`, `TeamHierarchy`, `Settings`,
  `AdvancedFilterPanel`.

---

## 7. Performance / architecture guards

- No aggressive polling: notifications refresh at most every 60 s and roles are
  TTL-gated at 5 minutes; both pause while the tab is hidden. The session-timeout
  tick is a local inactivity check, not a network poll.
- No full lead-list fetches for the Dashboard or calendar.
- No N+1 in the localized surfaces; post-mutation list updates patch in place
  (`applyLeadUpdate`) instead of refetching everything.
- No client-side authorization; RBAC stays server-side. Session caches are
  read-through only — the DB/API remains authoritative.

---

## 8. Source guards

- `server/tests/dashboard-ux-step5b-source-guards.test.ts` (Step 5B/5C data
  authority, navigation, menuAccess).
- `server/tests/ui-localization-modernization-source-guards.test.ts` (new):
  login selector + persistence, Bangla beyond sidebar, localized surfaces,
  absent technical wording, calendar-last placement, activity types, no
  `getLeads()`, date control + CUSTOM query, PR #19 polling guards, PR #21
  scheduled-activity guards, RBAC/menuAccess regression.

Run everything with:

```bash
npm test -- --run
npx tsc --noEmit
npx vite build
npm run build
npm run verify:serverless
```

---

## 9. Out of scope (unchanged)

Daily Workbench, Manager Attention Board, Lead Scoring, RLS/security phase,
Google Sheet policy reconciliation, notification automation, SMS/email/WhatsApp,
broad DB refactor, and legacy-path deletion. PostgreSQL remains the source of
truth; auth/session/JWT, RBAC, visibility scopes (Own/DownTeam/FullTeam/
Organization), hierarchy, lead CRUD, bulk import, follow-up queue,
`lead_activities` immutability, `scheduled_activities` semantics,
completion/cancel transactions, dashboard KPI authority, PR #19 performance
hardening, and PR #21 calendar/activity architecture are all preserved.
