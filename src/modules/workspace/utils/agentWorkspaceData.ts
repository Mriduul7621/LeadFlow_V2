import type { FollowUpQueueItem } from '../../leads/services/leadService';
import type { Lead, StatusHistoryEntry } from '../../shared/types';
import { DEFAULT_STATUS_DICTIONARY } from '../../leads/utils/leadUploadMapping';
import { dhakaDayKey, dhakaDayStartMs, dhakaDayLabel, formatDhakaShort } from './enterpriseData';

/**
 * agentWorkspaceData.ts — pure data shaping for the Agent workspace
 * rebuild (2026-11-20, Mahadi's demo screenshots).
 * ------------------------------------------------------------------
 * Every helper here is pure and timezone-explicit (Asia/Dhaka,
 * UTC+6 year-round, no DST) so the node test suite can pin it
 * without a browser. Nothing here fetches, and nothing invents a
 * number: each helper only reshapes a server payload for display.
 * Where the demo shows a figure with no real source (target
 * percent, "+x% vs last week", a 7-day upcoming window), the
 * helper returns the honest substitute — or null, so the caller
 * omits the card instead of fabricating it.
 *
 * Status names are NEVER invented here: the pipeline order and the
 * funnel stages use LeadFlow's own DEFAULT_STATUS_DICTIONARY and
 * the canonical terminal names (Converted / Not Interested — the
 * same fallback the server itself uses).
 */

/** Segment colours for the pipeline bar (the sample palette first). */
export const PIPELINE_COLORS = [
  '#858515', '#596b35', '#f36b21', '#a6ad79', '#263238',
  '#b0b8c1', '#e8b48c', '#7d8c6f', '#c9a227', '#8d6e63', '#5b7a99',
];

/**
 * The statuses that count as "contacted" (reached at least once) —
 * the same set ExecutionIntelligence uses for its Contacted KPI.
 */
export const CONTACTED_STATUSES = [
  'Contacted', 'Interested', 'Follow-up Set', 'Meeting Fixed',
  'Meeting Completed', 'Pipeline Locked', 'Converted',
];

/** Canonical terminal statuses (the server's own fallback names). */
export const TERMINAL_STATUS_NAMES = ['Converted', 'Not Interested'];

export function isTerminalStatus(status: string | null | undefined): boolean {
  return TERMINAL_STATUS_NAMES.includes(String(status || ''));
}

/** Time-based greeting for a Dhaka hour (0–23). */
export function greetingForDhakaHour(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** The Dhaka hour (0–23) of one instant. */
export function dhakaHour(instant: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka', hour: 'numeric', hour12: false,
  }).format(instant));
}

/** First name from a full name (the whole string when it has one word). */
export function firstNameOf(fullName: string | null | undefined): string {
  const trimmed = String(fullName || '').trim();
  if (!trimmed) return '';
  return trimmed.split(/\s+/)[0];
}

/**
 * The top priority follow-ups for today: the today bucket sorted by
 * due time, earliest first. Overdue items are NOT mixed in — they
 * surface on the queue page and in the Due-today KPI subline.
 */
export function topPriorityFollowUps(
  todayItems: FollowUpQueueItem[],
  limit = 2,
): FollowUpQueueItem[] {
  return [...todayItems]
    .sort((a, b) => new Date(a.nextFollowUpAt).getTime() - new Date(b.nextFollowUpAt).getTime())
    .slice(0, limit);
}

/** The upcoming items due tomorrow (Dhaka day). */
export function tomorrowFollowUps(
  upcomingItems: FollowUpQueueItem[],
  now: Date = new Date(),
): FollowUpQueueItem[] {
  const tomorrowKey = dhakaDayKey(new Date(dhakaDayStartMs(now) + 86_400_000 + 3600 * 1000));
  return upcomingItems
    .filter(item => {
      const t = new Date(item.nextFollowUpAt).getTime();
      return !Number.isNaN(t) && dhakaDayKey(new Date(t)) === tomorrowKey;
    })
    .sort((a, b) => new Date(a.nextFollowUpAt).getTime() - new Date(b.nextFollowUpAt).getTime());
}

export interface PipelineSegment {
  name: string;
  count: number;
  color: string;
}

/**
 * The pipeline bar: one segment per canonical status, in
 * dictionary order, with the real count behind each (0 included —
 * the legend names every stage, the bar only draws the nonzero
 * ones). Statuses outside the dictionary are ignored: the bar
 * shows LeadFlow's pipeline, not a stray value.
 */
export function pipelineSegments(
  statusCounts: Record<string, number>,
): { segments: PipelineSegment[]; total: number } {
  const segments: PipelineSegment[] = DEFAULT_STATUS_DICTIONARY.map((name, i) => ({
    name,
    count: Number(statusCounts[name]) || 0,
    color: PIPELINE_COLORS[i % PIPELINE_COLORS.length],
  }));
  return { segments, total: segments.reduce((sum, s) => sum + s.count, 0) };
}

/**
 * The caller's own most recently added OR updated leads. The
 * server's `timestamp` is updated_at (creation sets it too), so
 * sorting by it desc covers both. Only leads assigned to the
 * caller count as "own" — created-but-reassigned leads belong to
 * their new owner now.
 */
export function recentOwnLeads(
  leads: Lead[],
  employeeId: string | null | undefined,
  limit = 3,
): Lead[] {
  const self = String(employeeId || '').toUpperCase();
  if (!self) return [];
  return leads
    .filter(lead => String(lead.assignedTo || '').toUpperCase() === self)
    .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
    .slice(0, limit);
}

export type ActivityRange = 'this-week' | 'last-week' | 'this-month';

export interface ActivityBucket {
  /** Short axis label ('Mon', '2 Nov'). */
  label: string;
  count: number;
}

/** UTC ms of the Monday (00:00 Dhaka) of the week holding `instant`. */
function dhakaMondayStartMs(instant: Date): number {
  const startMs = dhakaDayStartMs(instant);
  // Dhaka weekday (0 = Sunday … 6 = Saturday) from the UTC instant.
  const weekday = new Date(startMs + 6 * 3600 * 1000).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  return startMs - daysSinceMonday * 86_400_000;
}

function weekdayShortLabel(dayStartMs: number): string {
  return new Date(dayStartMs + 3600 * 1000).toLocaleDateString('en-GB', {
    timeZone: 'Asia/Dhaka', weekday: 'short',
  });
}

/**
 * Follow-up outcomes logged per bucket — the "Weekly activity"
 * chart. One activity = one statusHistory entry (a logged
 * follow-up outcome with a real date). The ranges are the only
 * ones the data supports: this week / last week as seven daily
 * buckets (Mon–Sun, Dhaka), this month as the Mon–Sun weeks
 * intersecting the calendar month (labelled by week start).
 */
export function activityBuckets(
  leads: Lead[],
  range: ActivityRange,
  now: Date = new Date(),
): ActivityBucket[] {
  const entries: number[] = [];
  for (const lead of leads) {
    for (const entry of lead.statusHistory || []) {
      const t = new Date(entry.date).getTime();
      if (!Number.isNaN(t)) entries.push(t);
    }
  }

  if (range === 'this-month') {
    const { y, m } = (() => {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Dhaka', year: 'numeric', month: 'numeric',
      }).formatToParts(now);
      const pick = (type: string): number => Number(parts.find(p => p.type === type)?.value ?? 0);
      return { y: pick('year'), m: pick('month') };
    })();
    const monthStartMs = Date.UTC(y, m - 1, 1) - 6 * 3600 * 1000;
    const monthEndMs = Date.UTC(y, m, 1) - 6 * 3600 * 1000;
    const buckets: ActivityBucket[] = [];
    let weekStart = dhakaMondayStartMs(new Date(monthStartMs + 3600 * 1000));
    while (weekStart < monthEndMs) {
      const weekEnd = weekStart + 7 * 86_400_000;
      const count = entries.filter(t => t >= weekStart && t < weekEnd).length;
      buckets.push({ label: formatDhakaShort(new Date(weekStart + 3600 * 1000).toISOString()), count });
      weekStart = weekEnd;
    }
    return buckets;
  }

  const mondayMs = range === 'last-week'
    ? dhakaMondayStartMs(now) - 7 * 86_400_000
    : dhakaMondayStartMs(now);
  const buckets: ActivityBucket[] = [];
  for (let i = 0; i < 7; i++) {
    const dayStart = mondayMs + i * 86_400_000;
    const count = entries.filter(t => t >= dayStart && t < dayStart + 86_400_000).length;
    buckets.push({ label: weekdayShortLabel(dayStart), count });
  }
  return buckets;
}

/** A lead's history entries, oldest first (the stored order is not trusted). */
function sortedHistory(lead: Lead): StatusHistoryEntry[] {
  return [...(lead.statusHistory || [])].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
}

/**
 * Follow-ups completed today: the leads whose LATEST history entry
 * falls on today's Dhaka day. "Completed" means an outcome was
 * logged — the only completion the lead model records.
 */
export function completedToday(leads: Lead[], now: Date = new Date()): Lead[] {
  const todayKey = dhakaDayKey(now);
  const done: Lead[] = [];
  for (const lead of leads) {
    const history = sortedHistory(lead);
    if (history.length === 0) continue;
    const latest = history[history.length - 1];
    const t = new Date(latest.date).getTime();
    if (!Number.isNaN(t) && dhakaDayKey(new Date(t)) === todayKey) done.push(lead);
  }
  return done;
}

/**
 * The on-time rate over today's completed follow-ups: a completion
 * is on time when it was logged no later than the follow-up date
 * the PREVIOUS entry scheduled. Leads whose latest entry has no
 * previous entry with a scheduled date are unmeasurable and are
 * excluded — never counted as late. Null when nothing is
 * measurable, so the caller omits the card instead of inventing
 * a rate.
 */
export function onTimeRate(
  leads: Lead[],
  now: Date = new Date(),
): { rate: number; onTime: number; total: number } | null {
  let onTime = 0;
  let total = 0;
  for (const lead of completedToday(leads, now)) {
    const history = sortedHistory(lead);
    if (history.length < 2) continue;
    const latest = history[history.length - 1];
    const previous = history[history.length - 2];
    const due = previous.nextFollowUpDate ? new Date(previous.nextFollowUpDate).getTime() : NaN;
    const doneAt = new Date(latest.date).getTime();
    if (Number.isNaN(due) || Number.isNaN(doneAt)) continue;
    total += 1;
    if (doneAt <= due) onTime += 1;
  }
  if (total === 0) return null;
  return { rate: Math.round((onTime / total) * 100), onTime, total };
}

export interface AgentPerformanceKpis {
  assigned: number;
  contacted: number;
  contactedRate: number;
  converted: number;
  convertedRate: number;
  /** Σ projected NCP of open (non-terminal) leads. */
  pipelinePremium: number;
  pipelineOpenCount: number;
  /** Σ collected NCP across the period's leads. */
  collectedPremium: number;
  collectedCount: number;
}

/** Mahadi's My Performance KPI set, from the period's leads. */
export function agentPerformanceKpis(periodLeads: Lead[]): AgentPerformanceKpis {
  const assigned = periodLeads.length;
  const contactedSet = new Set(CONTACTED_STATUSES);
  let contacted = 0;
  let converted = 0;
  let pipelinePremium = 0;
  let pipelineOpenCount = 0;
  let collectedPremium = 0;
  let collectedCount = 0;
  for (const lead of periodLeads) {
    if (contactedSet.has(lead.currentStatus)) contacted += 1;
    if (lead.currentStatus === 'Converted') converted += 1;
    if (!isTerminalStatus(lead.currentStatus)) {
      pipelinePremium += Number(lead.projectedNCP) || 0;
      pipelineOpenCount += 1;
    }
    const collected = Number(lead.collectedNCP) || 0;
    collectedPremium += collected;
    if (collected > 0) collectedCount += 1;
  }
  const pct = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 100));
  return {
    assigned,
    contacted,
    contactedRate: pct(contacted, assigned),
    converted,
    convertedRate: pct(converted, assigned),
    pipelinePremium,
    pipelineOpenCount,
    collectedPremium,
    collectedCount,
  };
}

export interface FunnelStage {
  label: string;
  count: number;
  /** Share of the period's assigned leads. */
  pct: number;
}

/**
 * The conversion funnel as cumulative status sets over the real
 * LeadFlow statuses: each stage counts the leads that reached at
 * least that far. "Interested" means Interested or any later
 * stage; "Meeting" means Meeting Fixed or later; "Pipeline
 * Locked" means Pipeline Locked or Converted. Percentages are
 * shares of the assigned total — never of the previous stage, so
 * a stage can never read above 100%.
 */
export function conversionFunnel(periodLeads: Lead[]): FunnelStage[] {
  const total = periodLeads.length;
  const pct = (count: number) => (total === 0 ? 0 : Math.round((count / total) * 100));
  const inSet = (statuses: string[]) => {
    const set = new Set(statuses);
    return periodLeads.filter(l => set.has(l.currentStatus)).length;
  };
  return [
    { label: 'Assigned', count: total, pct: 100 },
    { label: 'Contacted', count: inSet(CONTACTED_STATUSES), pct: pct(inSet(CONTACTED_STATUSES)) },
    {
      label: 'Interested',
      count: inSet(['Interested', 'Follow-up Set', 'Meeting Fixed', 'Meeting Completed', 'Pipeline Locked', 'Converted']),
      pct: pct(inSet(['Interested', 'Follow-up Set', 'Meeting Fixed', 'Meeting Completed', 'Pipeline Locked', 'Converted'])),
    },
    {
      label: 'Meeting',
      count: inSet(['Meeting Fixed', 'Meeting Completed', 'Pipeline Locked', 'Converted']),
      pct: pct(inSet(['Meeting Fixed', 'Meeting Completed', 'Pipeline Locked', 'Converted'])),
    },
    {
      label: 'Pipeline Locked',
      count: inSet(['Pipeline Locked', 'Converted']),
      pct: pct(inSet(['Pipeline Locked', 'Converted'])),
    },
    { label: 'Converted', count: inSet(['Converted']), pct: pct(inSet(['Converted'])) },
  ];
}

export interface PerformanceInsight {
  title: string;
  sub: string;
  tone: 'good' | 'info' | 'warn';
  /** Optional deep link (e.g. the overdue insight opens the queue). */
  href?: string;
}

/**
 * Performance insights — only the ones the data can actually
 * support (0–3). A best-converting source needs ≥3 leads from
 * that source and a conversion rate above zero; the overdue
 * insight needs at least one overdue open follow-up; the
 * first-response insight needs at least one lead with a dated
 * first follow-up. Anything uncomputable is omitted, never
 * invented.
 */
export function performanceInsights(leads: Lead[], now: Date = new Date()): PerformanceInsight[] {
  const insights: PerformanceInsight[] = [];

  // Best-converting source (≥3 leads, strictly the best rate).
  const bySource = new Map<string, { total: number; converted: number }>();
  for (const lead of leads) {
    const source = String(lead.source || '').trim();
    if (!source) continue;
    const entry = bySource.get(source) ?? { total: 0, converted: 0 };
    entry.total += 1;
    if (lead.currentStatus === 'Converted') entry.converted += 1;
    bySource.set(source, entry);
  }
  let best: { source: string; rate: number; total: number; converted: number } | null = null;
  for (const [source, entry] of bySource) {
    if (entry.total < 3 || entry.converted === 0) continue;
    const rate = Math.round((entry.converted / entry.total) * 100);
    if (!best || rate > best.rate) best = { source, rate, total: entry.total, converted: entry.converted };
  }
  if (best) {
    insights.push({
      title: `${best.source} leads convert best`,
      sub: `${best.rate}% of ${best.total} ${best.source} leads converted (${best.converted} converted)`,
      tone: 'good',
    });
  }

  // Overdue open follow-ups right now.
  const todayStartMs = dhakaDayStartMs(now);
  let overdue = 0;
  for (const lead of leads) {
    if (isTerminalStatus(lead.currentStatus)) continue;
    const due = lead.nextFollowUpDate ? new Date(lead.nextFollowUpDate).getTime() : NaN;
    if (!Number.isNaN(due) && due < todayStartMs) overdue += 1;
  }
  if (overdue > 0) {
    insights.push({
      title: `${overdue} follow-up${overdue === 1 ? '' : 's'} overdue`,
      sub: 'Review the queue to clear them',
      tone: 'warn',
      href: '/follow-up',
    });
  }

  // Average first response: creation → first logged follow-up.
  let totalMs = 0;
  let measured = 0;
  for (const lead of leads) {
    const history = sortedHistory(lead);
    if (history.length === 0) continue;
    const created = new Date(lead.creationDate || lead.timestamp).getTime();
    const first = new Date(history[0].date).getTime();
    if (Number.isNaN(created) || Number.isNaN(first) || first < created) continue;
    totalMs += first - created;
    measured += 1;
  }
  if (measured > 0) {
    const avgHours = totalMs / measured / 3600_000;
    const display = avgHours < 1
      ? `${Math.max(1, Math.round(avgHours * 60))} min`
      : avgHours < 24
        ? `${avgHours.toFixed(1)} hrs`
        : `${(avgHours / 24).toFixed(1)} days`;
    insights.push({
      title: `Average first response ${display}`,
      sub: `Across ${measured} lead${measured === 1 ? '' : 's'} with a logged first follow-up`,
      tone: 'info',
    });
  }

  return insights;
}

/**
 * Follow-up outcomes logged per Dhaka day inside [startMs, endMs)
 * — the Performance trend series. Every day in the range gets a
 * bucket (0 included), labelled 'Mon 12' style.
 */
export function dailyHistoryCounts(
  leads: Lead[],
  startMs: number,
  endMs: number,
): { label: string; count: number }[] {
  const buckets: { label: string; count: number }[] = [];
  const dayCount = Math.max(0, Math.ceil((endMs - startMs) / 86_400_000));
  for (let i = 0; i < dayCount; i++) {
    const dayStart = startMs + i * 86_400_000;
    const key = dhakaDayKey(new Date(dayStart + 3600 * 1000));
    buckets.push({ label: dhakaDayLabel(key), count: 0 });
  }
  for (const lead of leads) {
    for (const entry of lead.statusHistory || []) {
      const t = new Date(entry.date).getTime();
      if (Number.isNaN(t) || t < startMs || t >= endMs) continue;
      const idx = Math.floor((t - startMs) / 86_400_000);
      if (idx >= 0 && idx < buckets.length) buckets[idx].count += 1;
    }
  }
  return buckets;
}

/**
 * Follow-up outcomes logged per hour of one Dhaka day — the
 * Performance trend for a single-day period. Hours use the
 * viewer's local hour labels via the Dhaka clock ('9:00').
 */
export function hourlyHistoryCounts(
  leads: Lead[],
  dayStartMs: number,
): { label: string; count: number }[] {
  const buckets: { label: string; count: number }[] = [];
  for (let h = 0; h < 24; h++) {
    buckets.push({ label: `${h}:00`, count: 0 });
  }
  for (const lead of leads) {
    for (const entry of lead.statusHistory || []) {
      const t = new Date(entry.date).getTime();
      if (Number.isNaN(t)) continue;
      const offset = t - dayStartMs;
      if (offset < 0 || offset >= 86_400_000) continue;
      buckets[Math.floor(offset / 3600_000)].count += 1;
    }
  }
  return buckets;
}

/** Minimal CSV serialiser (quotes fields holding , " or newline). */
export function toCsv(rows: string[][]): string {
  const cell = (value: string): string => {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${rows.map(row => row.map(cell).join(',')).join('\r\n')}\r\n`;
}
