# UI Localization & Design Modernization — LeadFlow V2

**Branch:** `arena/01a08d25-leadflow-v2` · **Base:** latest `main` after PR #21 · **Date:** 2026-09-10

This document describes the UI/UX + localization + visual design modernization delivered in **PR: `feat: modernize LeadFlow dashboard UX, localization and visual design`**. It is strictly a polish pass — no PostgreSQL, auth/JWT, RBAC/visibility, lead CRUD/import, follow-up queue, `lead_activities` immutability, `scheduled_activities`, dashboard KPI authority, or PR #19 / PR #21 performance and calendar architecture was changed.

---

## 1. Goals & Non-Goals

**Goals**

- Remove developer-facing wording from the user-visible Dashboard and global header.
- Replace the duplicated Dashboard date filter with one unified, executive-grade control.
- Move `Task Calendar` to the last Dashboard section; keep `Today & Tomorrow` as the primary daily execution surface.
- Keep `Today & Tomorrow` server-authoritative and type-rich (CALL / MEETING / FOLLOW_UP / TASK).
- Strip `Dhaka Standard Time` and the persistent header **Sync** affordance; relocate genuine system sync to **Settings → System Tools**.
- Complete `EN ↔ বাংলা` localization for every active route, with guards.
- Introduce a centralized, warm design-token system on the brand palette and a subtle motion/shadow/radius system.

**Non-Goals (explicitly out of scope)**

`Daily Workbench`, `Manager Attention Board`, `Lead Scoring`, `RLS`, `AI Intelligence`, attendance control, commission engine, client-side KPI date math — none of these are introduced here.

---

## 2. Information Architecture

### 2.1 Dashboard — top to bottom (final)

1. **Header + unified date-range control** — title + business subtitle + single popover control (`Today / WTD / MTD / LMTD / YTD / Custom / All Time`) + `Add Lead` + `Refresh`.
2. **Primary KPI summary** — Total · Untouched · Due Today · Overdue · Converted (reads `GET /api/dashboard` + `followUpCounts` only).
3. **Secondary KPI summary** — Projected NCP · Collected NCP · Conversion Rate · Active Leads.
4. **Sales Pipeline** — canonical `current_status` stages with `statusCounts` counts + % of total.
5. **Today & Tomorrow Actions** — server follow-up queue (`GET /api/leads/follow-ups?bucket=`) + server `scheduled_activities` (`GET /api/scheduled-activities?from=&to=`, `Asia/Dhaka`) never `leadService.getLeads()`.
6. **Follow-up Health** — Overdue / Due Today / Upcoming cards linking to `/follow-up?bucket=`.
7. **Needs Attention** — Untouched + Overdue quick entrances with plain-business copy.
8. **Analytics / Support** — Trend (empty: “No trend data available”), Team Performance, Lead Status Distribution.
9. **Task Calendar — last major section** — embedded calendar (`TaskCalendar embedded`) + `Open Calendar → /task-calendar`.

### 2.2 Header

- No visible `Dhaka Standard Time` string; compact date · time capsule remains (uses `Asia/Dhaka` internally but never shows the raw timezone label).
- No global `Sync` button/icon in the header; manual sync lives only in **Settings → System Tools**.
- Transient degraded-state indicator (`Offline` / `Connection degraded`) is shown **only** when `navigator.onLine` is `false` or the server reports degraded — no permanent “Connected” pill.

### 2.3 Sidebar (grouped IA preserved from PR #18)

Groups: **Overview → My Work → Leads → Insights → Management → System**. Each path maps to a real route in `App.tsx`; grouping is visual-only and never changes `menuAccess` / role visibility. Active state: filled `brand-olive` with a subtle `brand-orange` left accent strip.

---

## 3. Design Tokens & Visual System

**Centralized in `src/index.css` — Tailwind `@theme` + CSS vars + utility classes. No scattered raw hex.**

- **Brand palette:** `#F3702B` (orange), `#978C21` (olive), `#0359B3` (blue), `#3C3C3C` (text), `#FFFFFF`
- **Surfaces:** `#FDFBF7` page (`--color-surface`), `#FFFCF8` card wash, white cards
- **Radius:** `--radius-card: 12px`, `--radius-input: 10px`, `--radius-pill: 9999px` (cards 10–14px)
- **Shadow:** `card (0 1px 3px / 0.06)`, `hover (0 4px 16px / 0.10)`, `elevated (0 12px 32px / 0.12)`
- **Gradients:** warm linear `warmNeutral` (`#978C21→#0359B3`) used sparingly for accents, never neon
- **Motion:** `120–180ms ease` (`--duration-fast: 120ms`, `--duration-normal: 180ms`), `prefers-reduced-motion` guard; no layout-shifting entrance bloat
- **Component primitives:** `.card-premium`, `.kpi-card` (+ variants `blue/orange/emerald/red/olive`), `.btn-primary`, `.input-standard`, `.table-premium`, `.filter-toolbar`, `.modal-panel`, `.skeleton`, `.icon-capsule`, `.page-header`, `.section-heading`
- **KPI cards:** light/tinted surface, 3.5px top brand accent, right-aligned `icon-capsule`, bold metric, muted sub-copy — low-elevation, formal
- **Responsiveness:** `grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5` for primary KPIs; header popover uses `max-w-[92vw]` + responsive grids
- **Accessibility:** `focus-visible` ring (`--color-brand-blue / 0.14`), keyboard operable language switcher (`aria-pressed`), date popover `role="dialog"` + `aria-expanded`, notification panel `role="dialog"`, `Escape` + outside-click dismiss, `aria-label` on icon buttons

**Anti-patterns avoided:** flashy consumer gradients, heavy glassmorphism, neon, persistent header noise, raw hex scatter.

---

## 4. Localization

### 4.1 Architecture

- Canonical dictionary: `src/modules/shared/utils/translations.ts` (≈ 500+ keys, `EN` + `BN`).
- Mirror: `src/utils/translations.ts` re-exports the canonical file.
- Persistence: `src/store/languageStore.ts` (`zustand` + `persist`, key `leadflow-language`, default `en`); shared by `Login` (`#login-language-switcher`) and `AppLayout` (`#layout-language-switcher`); survives login/reload via `localStorage`.
- Hook: `useTranslation()` exposes `t(key, vars?)`, `language`, `setLanguage`.

### 4.2 Terminology

Natural, business Bangla — not literal Google-Translate. Examples: `Dashboard → ড্যাশবোর্ড`, `Lead → লিড`, `Follow-up → ফলো-আপ`, `Activities → কার্যক্রম`, `Task Calendar → টাস্ক ক্যালেন্ডার`, `Lead Tracking → লিড ট্র্যাকিং`, `Settings → সেটিংস`. User-generated content (names, emails, phones, policy codes) is never translated.

### 4.3 Coverage

All active routes under `App.tsx` (`REAL_ROUTES`) are covered: Dashboard (header + KPIs + pipeline + daily execution + health/attention/trend/team/status), Lead Generate/Upload/All/Tracking/360, Activities, Task Calendar, NCP Progress, Trends, Campaign Breakdown, Execution Intelligence, Team, Users, Settings, Follow-up Queue, plus shared form/validation/toasts/pagination/table copy.

The unified date filter contributes translated labels including `Today/WTD/MTD/LMTD/YTD/Custom/All Time` and descriptive tooltips: WTD = `Week to date`, MTD = `Month to date`, LMTD = `Last month to date (same elapsed days)` (e.g. 11 Sep → 1–11 Aug), YTD = `Year to date`.

### 4.4 What changed in code

- `Dashboard.tsx` — every heading, KPI label, empty state, CTA, and date-filter label now reads `t(...)`.
- `AppLayout.tsx` — sidebar group headings + item labels + header controls (notifications, user menu, degraded indicator) read `t(...)`; `Dhaka Standard Time` string removed from source.
- `Login.tsx` — headings, field labels/placeholders, buttons, `welcomeMessage` toast already used `t(...)`.
- `Settings.tsx`, `TaskCalendar.tsx`, `FollowUpStrategy.tsx`, `Activities.tsx`, `Lead*` pages — progressively switched from hardcoded English to `t(...)` (business logic untouched).

---

## 5. Unified Date-Range Control

**Previous:** separate `PERIODS = TODAY | THIS MONTH | LAST MONTH | CUSTOM | ALL` + duplicated pickers/labels (`TODAY` date input + `CUSTOM` start/end).

**Now:** one popover control (`Today / WTD / MTD / LMTD / YTD / Custom` + secondary `All Time`).

- Default: `Today`.
- Collapsed form: `Date Range: MTD · 1 Sep – 11 Sep` (or `Custom · 3 Sep – 10 Sep`), using `Asia/Dhaka` formatted range.
- Abbreviations carry `title` / `aria-label` tooltips (e.g. `LMTD — Last month to date: same elapsed days mapped to the prior month`).
- `Custom` expands **inside the same popover** with `Start date + End date` + a single `Apply` action; no duplicate inputs outside the control.
- `All Time` is a secondary affordance at the bottom of the same popover, not a primary top-bar chip.
- **Server authority preserved:** the resolved `{ startDate, endDate }` (YMD, `Asia/Dhaka` calendar) is sent as `period: 'CUSTOM'` with `startDate/endDate` to `dashboardService.getDashboard(...)`; `WTD/LMTD/YTD` are not special-cased on the server.

**Date semantics (business calendars):**

- `WTD` = Monday → today
- `MTD` = 1st → today
- `LMTD` = 1st of prior month → same elapsed day of prior month (capped at month length)
- `YTD` = 1 Jan → today
- `CUSTOM` = explicit start/end
- Boundaries are computed from the wall time in `Asia/Dhaka` (`Intl.DateTimeFormat` + `toLocaleString('…','Asia/Dhaka')`), not the browser's local zone.

No client-side KPI date math is introduced; no `leadService.getLeads()` is ever called from `Dashboard.loadDashboardData`.

---

## 6. Today & Tomorrow — server authority & visual differentiation

Binds to:

- `leadService.getFollowUpQueue({ bucket: 'today'|'upcoming' })` — enforces server bucket semantics and `nextFollowUpAt` dates.
- `scheduledActivityService.list({ from: todayYmd, to: tomorrowYmd })` — visibility-enforced, `Asia/Dhaka` date bucketing, without fetching the full lead list.

Rendered activity types: `CALL`, `MEETING`, `FOLLOW_UP`, `TASK` — human-friendly labels from `translations` and distinct visual capsules: `Call` = sky, `Meeting` = amber, `Task` = purple, `Follow-up` = emerald. Follow-ups use the `History` icon; scheduled activities use `Phone / Video / ClipboardCheck / CalendarClock`.

---

## 7. Performance & Correctness Preservation

- **PR #19 performance hardening intact:** no polling (`setInterval(loadRoles, 3000)` / `5000`, `setInterval(loadReminders, 8000)` / `60000` in `app-bootstrap`) remains absent; permission pre-computation is memoized and committed *after* the request; notification panel uses a 60s visibility-paused refresh with in-flight de-duplication; `leadService` raw cache is written only after `apiRequest` resolves.
- **PR #21 calendar architecture intact:** `TaskCalendar` remains the single `scheduled_activities` surface, `Asia/Dhaka` normalization on read/write, visibility-enforced, `scheduledAt` + `leadId` + accessible status; `Dashboard` passes `embedded` and is placed last.
- **No new data fetching regression:** `Dashboard` does not call `leadService.getLeads()`; `Settings` / `Lead*` preserve their existing server contracts.

---

## 8. Verification

Run:

```bash
npm run build        # tsc + vite — no type errors, no bundling regressions
npm run verify:serverless  # PGlite offline contract suite (if present)
npm test             # regression suite must stay green
```

Source guards that must remain green after this PR:

- `server/tests/dashboard-ux-step5b-source-guards.test.ts` — 14 `REAL_ROUTES`, grouped sidebar, no dead routes, `statusCounts`/`followUpCounts`/`totalLeads` read from `GET /api/dashboard`, trend empty literal, no fabricated `CAMPAIGN_TREND_DATA`, `No trend data available` guard, `TaskCalendar embedded`, `/follow-up?bucket=` contract, `REAL_ROUTES` Kpi/route/calendar/followup, admin bypass, `ProtectedRoute`, `isMobileMenuOpen`, `resolveMenuVisibility`, dashboard service `/api/dashboard`, quick-action to `/leads/new`.
- `server/tests/perf-latency-hardening.test.ts` — `Server-Timing`, `permissionJoin` fail-closed, memoized permission join, client polling/cache guards.
- `server/tests/scheduled-activities-integration.test.ts` — `scheduled_activities` visibility + `Asia/Dhaka` CRUD.
- New `server/tests/ui-localization-modernization.test.ts` — login `EN/BN` switcher persisted via `leadflow-language`, Bangla beyond sidebar, dashboard labels localized, hardcoded-copy audit, no `Dhaka Standard Time` / header `Sync` string, Task Calendar last, `Today&Tomorrow` type coverage, unified date-filter surface, server-authoritative dashboard call, PR #19/#21/ RBAC regressions.

---

## 9. Files Touched (only polish — business logic preserved)

- `src/modules/dashboard/pages/Dashboard.tsx` — unified date filter, business subtitles, reordered sections, modernized KPI/pipeline/daily-execution/attention analytics, full `t(...)`.
- `src/layouts/AppLayout.tsx` — removed `Dhaka Standard Time` label + header Sync; added compact date·time capsule + degraded-only offline indicator; modernized sidebar/header tokens; preserved `menuAccess`/`roles.includes`/`isItemVisible`/`visibleSections` + 30-min timeout + notification caching.
- `src/index.css` — warm design-token palette, radius/shadow/motion, `.card-premium`/`.kpi-card`/`icon-capsule`/`.table-premium`/`.filter-toolbar` primitives, `focus-visible` a11y.
- `src/modules/shared/utils/translations.ts` — expanded `EN/BN` (≈ 500+ keys) including `dashboardFilter*`, `kpi*`, `dashboardPipeline*`, `dailyExecution`, `followUp*`, `activity*`.
- `src/utils/translations.ts` — now a re-export of the canonical dictionary.
- `src/store/languageStore.ts` — `persist` (`leadflow-language`) verified (no code change needed, documented).
- `docs/UI_LOCALIZATION_DESIGN_MODERNIZATION.md` — this file.
- `server/tests/ui-localization-modernization.test.ts` — new focused regression suite (see §8).

---

## 10. Rollback & Risk

Purely presentational — safe to revert. No migration, no API contract change, no new DB table. If date semantics need tuning, only `resolveRange()` in `Dashboard.tsx` is touched. If a locale string is wrong, only `translations.ts` is touched.
