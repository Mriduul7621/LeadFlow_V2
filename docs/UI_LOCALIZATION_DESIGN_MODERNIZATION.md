# UI Design Modernization — English-Only — LeadFlow V2

**Branch:** `arena/01a08d25-leadflow-v2` · **Base:** latest `main` after PR #21 · **Date:** 2026-09-11

This document describes the UI/UX + visual design modernization delivered in **PR #22 `feat: modernize LeadFlow dashboard UX, localization and visual design` (English-only update)**. It is strictly a polish pass — no PostgreSQL, auth/JWT, RBAC/visibility, lead CRUD/import, follow-up queue, `lead_activities` immutability, `scheduled_activities`, dashboard KPI authority, or PR #19 / PR #21 performance and calendar architecture was changed.

> **English-only posture (2026-09-11 direction):** user-facing language selectors were removed; the app renders **English only**. No `EN/বাংলা` toggles, no `leadflow-language` persistence, no runtime switching, and no `t(...)` wiring in Login, AppLayout, or Dashboard. Canonical status values, API contracts, and user-entered data were never translated.

---

## 1. Goals & Non-Goals

**Goals**

- Remove developer-facing wording from the user-visible Dashboard and global header.
- Replace the duplicated Dashboard date filter with one unified, executive-grade control (English labels).
- Move `Task Calendar` to the last Dashboard section; keep `Today & Tomorrow` as the primary daily execution surface (English copy).
- Keep `Today & Tomorrow` server-authoritative and type-rich (CALL / MEETING / FOLLOW_UP / TASK).
- Strip `Dhaka Standard Time` and the persistent header **Sync** affordance; relocate the cloud check to **Settings → System Connection** with polished English copy.
- Remove translation/localization UI from Login, header, and preferences; render English only with clear literals.
- Introduce a centralized, warm design-token system on the brand palette and a subtle motion/shadow/radius system.

**Non-Goals (explicitly out of scope)**

`Daily Workbench`, `Manager Attention Board`, `Lead Scoring`, `RLS`, `AI Intelligence`, attendance control, commission engine, client-side KPI date math — none introduced here. No new translation infrastructure, no Bangla copy.

---

## 2. Information Architecture

### 2.1 Dashboard — top to bottom (final)

1. **Header + unified date-range control** — title `Dashboard` + subtitle `Sales performance at a glance. Track outcomes by period.` + single popover control (`Today / WTD / MTD / LMTD / YTD / Custom / All Time`) + `Add Lead` + `Refresh`.
2. **Primary KPI summary** — Total · Untouched · Due Today · Overdue · Converted (reads `GET /api/dashboard` + `followUpCounts` only).
3. **Secondary KPI summary** — Projected NCP · Collected NCP · Conversion Rate · Active Leads.
4. **Sales Pipeline** — canonical `current_status` stages with `statusCounts` counts + % of total.
5. **Today & Tomorrow Actions** — server follow-up queue (`GET /api/leads/follow-ups?bucket=`) + server `scheduled_activities` (`GET /api/scheduled-activities?from=&to=`, `Asia/Dhaka`) never `leadService.getLeads()`.
6. **Follow-up Health** — Overdue / Due Today / Upcoming cards linking to `/follow-up?bucket=`.
7. **Needs Attention** — Untouched + Overdue quick entrances with plain-business English.
8. **Analytics / Support** — Trend (empty: “No trend data available”), Team Performance, Lead Status Distribution.
9. **Task Calendar — last major section** — embedded calendar (`TaskCalendar embedded`) + `Open Calendar → /task-calendar`.

### 2.2 Header

- No visible `Dhaka Standard Time` string; compact date · time capsule remains (uses `Asia/Dhaka` internally but never shows the raw timezone label).
- No global `Sync` button/icon in the header; cloud connection check lives only in **Settings → System Connection** via `Check Connection`.
- No language selector (`#layout-language-switcher` removed, no `useTranslation`/`setLanguage`/`leadflow-language` in AppLayout).
- Transient degraded-state indicator (`Connection degraded` / `Offline`) is shown **only** when `navigator.onLine` is `false` or the server reports degraded — no permanent “Connected” pill.
- Notifications: `Notifications`, `Mark All Read`, `Delete All`, `No notifications yet`, `Logged in as` / `Logout` — all English literals with `aria-label`.

### 2.3 Sidebar (grouped IA preserved from PR #18)

Groups: **Overview → My Work → Leads → Insights → Management → System**. Each path maps to a real route in `App.tsx`; grouping is visual-only and never changes `menuAccess` / role visibility. Active state: filled `brand-olive` with a subtle `brand-orange` left accent strip. Labels are English (`sectionLabelMap`) without `t(...)`.

### 2.4 Login

- No language selector (`#login-language-switcher` removed).
- Header status: `System Ready` / `Secure Node Online` / `Setup Required` (English).
- Hero: `Smart Lead Management System` + `Track your leads and grow your team with confidence.` (or setup copy).
- Form labels/placeholders: `Employee ID`, `Password`, `Full Name`, `Email Address`, `Confirm Password` — English literals only.
- CTA: `Get Started` / `Initialize Console`, `Welcome Back` / `Admin Setup`, `Login` / `Create Admin Account`, `Back to home`.
- Welcome toast: ``Welcome back, ${user.name}!`` (template literal, English).

### 2.5 Settings → System Connection

- Section title: `System Connection`
- Description: `Check the current cloud database connection status.`
- Button: `Check Connection` (calls `databaseStatusService.checkDatabaseStatus()` / `GET /api/db-status`, which is a **connection check**, not a sync).
- Success: `Cloud database connection is active.`
- Failure: `Cloud database connection could not be verified.` (only if the check does not succeed; no stale “sync” wording).
- `System Tools` / `Clear All Data` remains for admin destruct operation below.

---

## 3. Design Tokens & Visual System

**Centralized in `src/index.css` — Tailwind `@theme` + CSS vars + utility classes. No scattered raw hex.**

- **Brand palette:** `#F3702B` (orange), `#978C21` (olive), `#0359B3` (blue), `#3C3C3C` (text), `#FFFFFF`
- **Surfaces:** `#FDFBF7` page (`--color-surface`), `#FFFCF8` card wash, white cards
- **Radius:** `--radius-card: 12px`, `--radius-input: 10px`, `--radius-pill: 9999px` (cards 10–14px)
- **Shadow:** `card (0 1px 3px / 0.06)`, `hover (0 4px 16px / 0.10)`, `elevated (0 12px 32px / 0.12)`
- **Gradients:** warm linear used sparingly for accents, never neon
- **Motion:** `120–180ms ease` (`--duration-fast: 120ms`, `--duration-normal: 180ms`), `prefers-reduced-motion` guard
- **Component primitives:** `.card-premium`, `.kpi-card` (+ variants `blue/orange/emerald/red/olive`), `.btn-primary`, `.input-standard`, `.table-premium`, `.filter-toolbar`, `.modal-panel`, `.skeleton`, `.icon-capsule`
- **KPI cards:** light/tinted surface, 3.5px top brand accent, right-aligned `icon-capsule`, bold metric, muted sub-copy
- **Responsiveness:** `grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5` for primary KPIs; header popover uses `max-w-[92vw]` + responsive grids
- **Accessibility:** `focus-visible` ring (`--color-brand-blue / 0.14`), date popover `role="dialog"` + `aria-expanded`, notification panel `role="dialog"`, `Escape` + outside-click dismiss, `aria-label` on icon buttons — all English
- **Forced password reset (AppLayout):** `Set New Password` / `For security, create a new password before continuing.` / `New Password` / `Confirm Password` / `Minimum 6 characters` / `Re-enter new password` / `Updating password...` / `Update Password & Continue` — polished English, no translation hook.

**Anti-patterns avoided:** flashy consumer gradients, heavy glassmorphism, neon, persistent header noise, raw hex scatter.

---

## 4. English-Only Copy (replaces prior localization section)

- **Posture:** English only. No user-facing language controls; no `leadflow-language` persistence; no `useTranslation`/`t()` in Login/AppLayout/Dashboard. If pre-PR translation infra exists elsewhere (`src/modules/shared/utils/translations.ts`, `src/utils/translations.ts`, `src/store/languageStore.ts`), it is preserved but not referenced by PR #22 UI — PR #22 UI does not depend on Bengali state.
- **Dashboard literals:** `Dashboard`, `Sales performance at a glance…`, `Date Range: …`, `Today` / `WTD` / `MTD` / `LMTD` / `YTD` / `Custom` / `All Time`, `Start Date` · `End Date` · `Apply`, `Add Lead`, `Refresh`, `Sync failed — showing cached data.` / `Retry`, `No trend data available`, etc.
- **Tooltips (English):** `Week to date`, `Month to date`, `Last month to date (same elapsed days)` (e.g. 11 Sep → 1–11 Aug) — capped at prior month length, `Year to date`, `Custom range — pick a start and end date`.
- **Today & Tomorrow:** `CALL` / `MEETING` / `FOLLOW_UP` / `TASK` labels + distinct capsules/icons in English; never translates user data (lead name, phone, NCP, etc.).
- **Audit guard:** `grep -rn "useTranslation|t('" src/modules/dashboard/pages/Dashboard.tsx | grep -v …` must be 0; same for AppLayout and Login; no `\u0980-\u09FF` Bangla characters in those files’ visible output.

---

## 5. Unified Date-Range Control

One popover control (`Today / WTD / MTD / LMTD / YTD / Custom` + secondary `All Time`).

- Default: `Today`.
- Collapsed: `Date Range: MTD · 1 Sep – 11 Sep` (or `Custom · 3 Sep – 10 Sep`), using `Asia/Dhaka` formatted range.
- Abbreviations carry `title` / `aria-label` tooltips (e.g. `LMTD — Last month to date: same elapsed days mapped to the prior month`).
- `Custom` expands **inside the same popover** with `Start Date + End Date` + single `Apply`; no duplicate inputs outside the control.
- `All Time` is secondary at bottom of same popover.
- **Server authority preserved:** resolved `{ startDate, endDate }` (YMD, `Asia/Dhaka` calendar) sent as `period: 'CUSTOM'` with `startDate/endDate` to `dashboardService.getDashboard(...)`; `WTD/LMTD/YTD` are not special-cased on the server.

**Date semantics (business calendars, `Asia/Dhaka`):**

- `WTD` = Monday → today
- `MTD` = 1st → today
- `LMTD` = 1st of prior month → same elapsed day of prior month (capped)
- `YTD` = 1 Jan → today

No client-side KPI date math; no `leadService.getLeads()` from `Dashboard.loadDashboardData`.

---

## 6. Today & Tomorrow — server authority & visual differentiation

Binds to:

- `leadService.getFollowUpQueue({ bucket: 'today'|'upcoming' })`
- `scheduledActivityService.list({ from: todayYmd, to: tomorrowYmd })` — `Asia/Dhaka` bucketing, never full lead list.

Activity types: `CALL`, `MEETING`, `FOLLOW_UP`, `TASK` — English labels + distinct capsules: `Call` = sky, `Meeting` = amber, `Task` = purple, `Follow-up` = emerald. Icons: `Phone / Video / ClipboardCheck / History`.

---

## 7. Performance & Correctness Preservation

- **PR #19 intact:** no polling, permission fail-closed, memoized join, notification 60s visibility-paused, `leadService` raw cache only after `apiRequest`.
- **PR #21 intact:** `TaskCalendar` single `scheduled_activities` surface, `Asia/Dhaka` normalization, visibility-enforced, `Dashboard` passes `embedded` and is placed last.
- **No new data regression:** `Dashboard` never calls `leadService.getLeads()`; `Settings` preserves server contracts.
- **English-only does not alter business logic:** status enums, KPI formulas, RBAC/visibility remain.

---

## 8. Verification

```bash
npm run build
npm run verify:serverless
npm test -- --run   # or npx tsc --noEmit
```

English-only source guards (updated):

- `server/tests/ui-localization-modernization.test.ts` — **English-only**: no `#login-language-switcher` / `#layout-language-switcher`, no `useTranslation`/`t()`/`leadflow-language`/`setLanguage` in Login/AppLayout/Dashboard; Dashboard has polished English `Dashboard`/`Date Range`/`Today/WTD/MTD/LMTD/YTD/Custom/All Time`/`Start Date`/`End Date`/`Apply`/`Add Lead`/`Retry`; `Asia/Dhaka` + `dashboardService.getDashboard` + LMTD capped + `startYmd/endYmd` + `period: CUSTOM`; Today & Tomorrow via `getFollowUpQueue` + `scheduledActivityService.list` and no `getLeads`; Task Calendar last + `/task-calendar` route; header has `Connection degraded`/`Notifications` but no `Dhaka Standard Time`/`handleSync`/`System Sync`; Settings has `System Connection` / `Check the current cloud database connection status.` / `Check Connection` / `Cloud database connection is active.` / `Cloud database connection could not be verified.`; brand tokens `#F3702B/#978C21/#0359B3/#3C3C3C` + `120ms/180ms` + `10-14px` radii; `focus-visible`, `aria-label`, `role=dialog`; PR#19/PR#21/RBAC preserved; no full `getLeads`.
- `server/tests/dashboard-ux-step5b-source-guards.test.ts`, `server/tests/perf-latency-hardening.test.ts`, `server/tests/scheduled-activities-integration.test.ts` — remain green.

---

## 9. Files Touched (English-only polish only)

- `src/modules/dashboard/pages/Dashboard.tsx` — removed `useTranslation`/`t()`/`language`; replaced with polished English literals; preserved unified filter, LMTD capped, Asia/Dhaka, server CUSTOM, Today&Tomorrow server APIs, TaskCalendar last, no `getLeads`.
- `src/layouts/AppLayout.tsx` — removed `useTranslation`/`language/setLanguage` + `#layout-language-switcher`; added `sectionLabelMap` English; header literals `Connection degraded/Notifications/.../Logged in as/Logout`; forced reset `Set New Password/For security...` polished English; preserved `resolveMenuVisibility` + `menuAccess`/`roles.includes` comment/guard.
- `src/modules/auth/pages/Login.tsx` — removed `useTranslation`/`language/setLanguage` + `#login-language-switcher`; replaced with English literals `System Ready/Secure Node Online/Setup Required/Smart Lead Management System/Welcome Back` etc.; toast ``Welcome back, ${user.name}!``.
- `src/modules/settings/pages/Settings.tsx` — `System Sync` → `System Connection` (`Check the current cloud database connection status.` / `Check Connection` / `Cloud database connection is active.` / `Cloud database connection could not be verified.` via `databaseStatusService.checkDatabaseStatus()`).
- `src/index.css` — warm token palette, radius/shadow/motion (`120ms/180ms`) — unchanged, verified.
- `server/tests/ui-localization-modernization.test.ts` — rewritten to English-only regressions (list in §8).
- `docs/UI_LOCALIZATION_DESIGN_MODERNIZATION.md` — reframed to English-only (this file); Bangla claims removed.

---

## 10. Rollback & Risk

Purely presentational + copy — safe to revert. No migration, no API contract change, no new DB table. If a string needs tuning, only the English literal in the relevant component is touched. If date semantics need tuning, only `resolveRange()` in `Dashboard.tsx`.
