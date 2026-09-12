# Lead Quality Scoring — Explainable, Server-Authoritative Lead Prioritization

## Purpose
"Which leads deserve attention first, why, and what action would improve quality?"

Lead Quality is a deterministic, transparent 0–100 score computed on the server for every lead, with Hot/Warm/Developing/Cold bands for active opportunities and terminal handling for Converted/Not Interested outcomes. Every score ships with a human-readable explanation (positive/negative factors + attention reasons) so the number is always auditable: `score = clamp(0, 100, BASE + Σ factor.points)` holds for every result.

This is NOT an AI/ML model. It is a rule-based weighted sum over operational sales signals already present in LeadFlow.

## Formula (authoritative: `server/utils/leadQuality.ts`)

```
score = clamp(0, 100, BASE + status + recency + engagement
                         + followUpDiscipline + investment
                         - failedContact)
```

- `LEAD_QUALITY_BASE_SCORE = 35` — neutral starting point for every active lead.
- `LEAD_QUALITY_MIN_SCORE = 0`, `LEAD_QUALITY_MAX_SCORE = 100`.
- Active band thresholds (`LEAD_QUALITY_THRESHOLDS`): Hot ≥ 80, Warm ≥ 60, Developing ≥ 40, else Cold.
- Bands: `Hot | Warm | Developing | Cold | Converted | Not Interested`.

### Component weights

| # | Signal | Rule | Points | Factor emitted |
|---|--------|------|--------|----------------|
| 1 | Status / buying intent | Pipeline Locked | +35 | `Pipeline locked` |
| 1 | Status | Meeting Completed | +25 | `Meeting completed` |
| 1 | Status | Meeting Fixed | +20 | `Meeting fixed` |
| 1 | Status | Interested | +15 | `Customer interested` |
| 1 | Status | Follow-up Set | +10 | `Follow-up set` |
| 1 | Status | Contacted | +5 | `Contacted` |
| 1 | Status | Untouched / unknown custom | 0 | none (neutral) |
| 1 | Status | Busy | −2 | `Customer busy` |
| 1 | Status | No Response (incl. legacy `Unreachable` alias) | −8 | `No response` |
| 2 | Recency (max of last-contacted, last history event, created) | touched ≤ 1 Dhaka day ago | +5 | `Touched within the last day` |
| 2 | Recency | touched 2–3 days ago | +3 | `Touched N days ago` |
| 2 | Recency | touched 4–7 days ago | 0 | none (neutral week) |
| 2 | Recency | no progress 8–14 days | −8 | `No progress in N days` |
| 2 | Recency | no progress 15–30 days | −15 | + attention `No meaningful progress in N days` |
| 2 | Recency | no progress 31+ days (stale) | −22 | + attention `… — going stale` |
| 3 | Engagement (meaningful history responses, capped at 3 events) | +3 per counted event | 0…+9 | `Customer showed buying interest…` (+ `(capped)` note past the cap) |
| 4 | Follow-up discipline (earliest of next-follow-up / next scheduled action) | action scheduled (today or future) | +5 | `Next action scheduled` |
| 4 | Follow-up discipline | overdue 1–3 days | −5 | + attention `Next action overdue by N day(s)` |
| 4 | Follow-up discipline | overdue 4–7 days | −10 | + attention |
| 4 | Follow-up discipline | overdue 8+ days | −15 | + attention |
| 4 | Follow-up discipline | no next action on advanced status (Interested and beyond) | 0 | attention `No next action scheduled for <Status> lead` |
| 5 | Explicit investment interest (customer-supplied amount only) | flat capped bonus | +3 | `Customer shared an investment interest (৳…)` |
| 6 | Failed contacts (`No Response`/`Unreachable` history, capped at 3) | −3 per counted event | 0…−9 | `… unanswered contact attempt(s)` (+ `(capped)`); ≥3 also raises attention |

Design rules:

- Deterministic: same input → same output. No randomness; the only clock read is an injectable `now` (server clock by default, fixed instant in tests).
- Dhaka-safe: all day math uses Asia/Dhaka calendar days, consistent with `server/utils/businessTime.ts` (the follow-up queue buckets).
- No demographic signals: gender, age, occupation, income proxies are NEVER inputs. Only an explicitly supplied investment amount counts, as a small flat bonus.
- Anti-gaming: engagement bonuses and failed-contact penalties are hard-capped; raw activity volume alone can never produce Hot (active maximum is 92).
- Status aliases reuse the SAME resolution as bulk import (`Unreachable` → `No Response`, `Follow up` → `Follow-up Set`), so historical wording never loses meaning. Unknown/custom statuses stay neutral instead of failing.

## Terminal Model

Terminal outcomes are NOT scored on the active scale:

- `Converted` → score 100, band `Converted`, `isTerminal: true`, single positive factor `Converted — successful outcome (terminal)` (+65). No attention reasons.
- `Not Interested` → score 0, band `Not Interested`, `isTerminal: true`, single negative factor `Not Interested — closed (terminal)` (−35). No attention reasons.

Terminal leads are excluded from active band counts, the dashboard average, and quality-band filters except their own terminal bands. The reconciliation invariant (`reconcileQualityFactors`) holds for terminal results through the single terminal factor.

## Architecture

### Pure scorer — `server/utils/leadQuality.ts`
No DB, no route imports, no I/O. Exports `calculateLeadQuality(input)` (full explanation), `bandForScore`, `toCompactQuality`, `reconcileQualityFactors`, and all weight/threshold constants in one place. Imported by the signals module and (transitively) by routes only — never by the frontend.

### Bulk signals — `server/utils/leadQualitySignals.ts`
Answers "what are the signals for THESE leads" with a constant number of queries regardless of lead count:

- 1 × `lead_activities` aggregate (newest event, failed-contact count, meaningful-engagement count per lead).
- 1 × `scheduled_activities` query (earliest still-`scheduled` action per lead).

Lead-row signals (status, next-follow-up, last-contacted, created, expected premium, `custom_fields.interestedAmount`) come from rows the caller ALREADY fetched — never extra reads. `LeadRowLike` accepts snake_case PostgreSQL rows or camelCase mapped/fallback objects. Ownership/visibility fields are never consulted here: callers enforce visibility BEFORE scoring.

Degradation policy: each bulk query is wrapped in try/catch. If a signal query ever fails, signals degrade to neutral (empty history / no planned action) with a warning instead of failing the enclosing read.

### Read-time computation, no new column
Scores are computed at read time (per request) from live data, so they can never go stale. No `quality_score` column, no migration, no backfill: the formula inputs are all existing columns/tables, and bulk SQL keeps reads cheap.

### Route wiring — `server/routes/production.routes.ts`
- `GET /api/leads` — compact `{score, band}` per lead; `qualityBand=<band>` narrowing filter and `sort=quality_asc|quality_desc` (newest-first tiebreak). Demo-mode parity via `scoreFallbackLead`.
- `POST /api/leads` — fresh full quality on the created lead so the UI never patches in a stale score.
- `GET /api/leads/follow-ups` — compact quality per queue item (workbench prioritization source).
- `GET /api/leads/:id` — full quality embedded in the detail payload.
- `GET /api/leads/:id/quality` — read-only full explanation (`{score, band, isTerminal, positiveFactors, negativeFactors, attentionReasons}`) under the same `leads.view` + visibility boundary as the lead itself. 404 for missing or inaccessible leads; the score never grants access.
- `POST /api/leads/:id/follow-up` — fresh full quality on the returned lead after the status move.
- `GET /api/scheduled-activities` — compact parent-lead quality per item.
- `GET /api/dashboard` — scope-consistent `quality` aggregate (`hot, warm, developing, cold, activeAverage, activeScored, needsAttention`) via `aggregateQualityForScope` (one narrow lead scan + the two bulk signal queries; terminal outcomes excluded).

## UI

All UI is presentational: it renders server-computed values and contains no weights, thresholds, or scoring logic (locked by source guards in `server/tests/lead-quality-scoring.test.ts`).

- `LeadQualityBadge` (`src/modules/leads/components/LeadQualityBadge.tsx`) — compact `Band · Score` pill. Renders nothing for missing quality (never guesses).
- `LeadQualityPanel` (`src/modules/leads/components/LeadQualityPanel.tsx`) — the WHY: score bar, "What lifts this score" / "What pulls it down" factor lists, and "Needs attention" reasons.
- Lead Workspace (`LeadList.tsx`) — Quality filter dropdown (narrowing-only), `Quality: High to Low / Low to High` sorts, Quality column, modal badge, and one lazy `getLeadQuality(leadId)` fetch per opened lead for the full explanation.
- Lead360 (`Lead360.tsx`) — header badge + Lead Quality explanation card fed by the embedded detail quality.
- Daily Workbench (`DailyWorkbench.tsx`) — quality badges on queue rows and the quick-action area, plus a Quality chip row that narrows the already-loaded queue client-side (no refetch, no rescoring, no per-item detail fetch — workbench never calls `getLeadQuality`).
- Dashboard (`Dashboard.tsx` + `dashboardService.ts`) — `LeadQualitySnapshot` band-distribution strip fed only by `metrics.quality` from `GET /api/dashboard` (sanitized, never fabricated).

## Visibility & RBAC

- Scoring never widens access: every endpoint scores only rows already inside the caller's visibility scope (Own/DownTeam/FullTeam/Organization), enforced by the existing `resolveCallerVisibility` / `isLeadAccessible` checks before any quality computation.
- `GET /api/leads/:id/quality` requires `leads.view` and returns 404 (not 403) for leads outside the caller's scope — same as the lead detail route.
- Quality filters/sorts are narrowing-only: they subset or reorder the visible set, never add rows.
- Dashboard aggregates are scope-consistent: `aggregateQualityForScope` receives the caller's visibility WHERE clause and counts only visible active leads.
- No permission or role changes; no menu changes; statuses/aliases, follow-up and scheduled-activity models untouched.

## Performance

- Lead list / follow-up queue / scheduled list: +2 bulk queries per request (activity aggregate + scheduled lookup), each `GROUP BY lead_id` over the page's id set — no N+1.
- Single lead / quality endpoint: same 2 queries over 1 id.
- Dashboard: +3 bounded queries (narrow active-lead scan + 2 bulk signal queries), run inside the existing `Promise.all`.
- Frontend: zero extra requests except one lazy `GET /api/leads/:id/quality` per lead modal opened in the workspace. Workbench and dashboard add no requests.

## Files

Backend:
- `server/utils/leadQuality.ts` (pure formula + constants)
- `server/utils/leadQualitySignals.ts` (bulk SQL signals, row adapters, dashboard aggregates, fallback-mode equivalents)
- `server/routes/production.routes.ts` (endpoint wiring)

Frontend:
- `src/modules/shared/types/index.ts` (`LeadQualityBand`, `LeadQualityFactor`, `LeadQuality`, `Lead.leadQuality?`)
- `src/modules/leads/services/leadService.ts` (`FollowUpQueueItem.leadQuality?`, `getLeadQuality`)
- `src/modules/scheduledActivities/services/scheduledActivityService.ts` (`ScheduledActivity.leadQuality?`)
- `src/modules/leads/components/LeadQualityBadge.tsx`, `LeadQualityPanel.tsx`
- `src/modules/leads/pages/LeadList.tsx`, `Lead360.tsx`
- `src/modules/workbench/pages/DailyWorkbench.tsx`
- `src/modules/dashboard/services/dashboardService.ts` (`DashboardQualityAggregate`, sanitized `quality?`), `src/modules/dashboard/pages/Dashboard.tsx` (`LeadQualitySnapshot`)

Tests:
- `server/tests/lead-quality-scoring.test.ts` — formula units, stub-pool signal/aggregate tests, fallback-mode aggregates, route-wiring + no-frontend-scoring + no-new-column + doc source guards
- `server/tests/lead-quality-http-integration.test.ts` — PGlite end-to-end: quality endpoint (auth/visibility/shape/determinism), list filter/sort, fresh scores on create/follow-up, scheduled parent quality, dashboard aggregate

## Tests

- `npm test` (`tsx --test server/tests/*.test.ts`) — full suite including the two new files.
- `npx tsc --noEmit` — type safety across backend + frontend.
- New tests avoid wall-clock assertions: the pure scorer takes an injected `now`, and HTTP fixtures use dates relative to `Date.now()` with wide band margins.

## Deferrals (deliberately out of scope)

- No persisted score column, no backfill, no score-history trend (read-time scoring keeps values fresh without migration risk; revisit only if list pages show measurable latency).
- No manager-attention inbox beyond the existing Needs Attention pattern: attention reasons surface in the Lead Quality panel, workbench badges, and the dashboard `needsAttention` count. A dedicated attention queue is deferred.
- No quality-based assignment/routing rules and no notifications — scoring informs human prioritization only.
- No per-user/per-team quality leaderboards.
- No ML model: the weights are fixed, documented constants. Any future weight change must update this doc, the factor labels, and the tests together.
