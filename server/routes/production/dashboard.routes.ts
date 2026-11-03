/**
 * production/dashboard.routes.ts — DASHBOARD domain of the production API.
 * ------------------------------------------------------------------
 * Phase 1 extraction (no behaviour change): the GET /dashboard handler
 * that used to live inline in production.routes.ts, moved verbatim
 * together with its exclusive helpers (the status-key table, the
 * period parser and the in-memory aggregator used by the demo-mode
 * branch). buildDashboardVisibilitySql is imported from ./shared.js
 * (it moved there in the leads step because both domains call it).
 *
 * Mount position: in the monolith the roadshows mount sat between
 * these helpers and the /dashboard handler; production.routes.ts now
 * mounts this router exactly where the handler was (immediately after
 * the roadshows mount), so the effective registration order is
 * unchanged. /dashboard has no path overlap with any other router.
 */

import { Router } from 'express';
import { getPool } from '../../database/connection.js';
import { fallbackStore } from '../../fallbackStore.js';
import { createPerf } from '../../utils/perf.js';
import {
  BUSINESS_TIMEZONE,
  TERMINAL_LEAD_STATUSES,
  getDhakaBusinessDayBounds,
  parseYmd,
  dhakaStartUtc,
  addCalendarDays,
  classifyFollowUpBucket,
} from '../../utils/businessTime.js';
import {
  aggregateQualityForScope,
  aggregateQualityForFallbackLeads,
} from '../../utils/leadQualitySignals.js';
import {
  buildDashboardVisibilitySql,
  dbErrorStatus,
  demoModeAllowed,
  getCallerDbInfo,
  hasPermissionCode,
  requireAuth,
  resolveCallerVisibility,
  sendDbUnavailable,
  sendJson,
  useDb,
} from './shared.js';

const router = Router();

/* ====================================================================
   DASHBOARD — server-authoritative metrics (Step 5)
   ------------------------------------------------------------------
   - PostgreSQL is source of truth
   - Same visibility resolver as leads / follow-up queue
   - Soft-deleted leads never count
   - Follow-up buckets reuse Asia/Dhaka business-day helpers (Step 4B)
   - Query params (role/employeeId/assignedTo) cannot widen scope
==================================================================== */

const DASHBOARD_STATUS_KEYS = [
  'New',
  'Contacted',
  'No Response',
  'Busy',
  'Interested',
  'Follow-up Set',
  'Meeting Fixed',
  'Meeting Completed',
  'Pipeline Locked',
  'Converted',
  'Not Interested',
] as const;

function emptyStatusCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of DASHBOARD_STATUS_KEYS) out[s] = 0;
  return out;
}

function parseDashboardPeriod(query: any): { start: Date | null; end: Date | null; label: string } {
  const period = String(query?.period || 'ALL').trim().toUpperCase();
  const bounds = getDhakaBusinessDayBounds(new Date());
  const { y, m, d } = (() => {
    const parts = bounds.todayDate.split('-').map(Number);
    return { y: parts[0], m: parts[1], d: parts[2] };
  })();

  if (period === 'TODAY') {
    const selected = parseYmd(query?.selectedDate ? String(query.selectedDate) : bounds.todayDate) || { y, m, d };
    const start = dhakaStartUtc(selected.y, selected.m, selected.d);
    const next = addCalendarDays(selected.y, selected.m, selected.d, 1);
    const end = dhakaStartUtc(next.y, next.m, next.d);
    return { start, end, label: 'TODAY' };
  }
  if (period === 'THIS_MONTH' || period === 'THIS MONTH') {
    const start = dhakaStartUtc(y, m, 1);
    const nextMonth = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
    const end = dhakaStartUtc(nextMonth.y, nextMonth.m, 1);
    return { start, end, label: 'THIS_MONTH' };
  }
  if (period === 'LAST_MONTH' || period === 'LAST MONTH') {
    const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
    const start = dhakaStartUtc(prev.y, prev.m, 1);
    const end = dhakaStartUtc(y, m, 1);
    return { start, end, label: 'LAST_MONTH' };
  }
  if (period === 'CUSTOM') {
    const from = parseYmd(query?.startDate ? String(query.startDate) : null);
    const to = parseYmd(query?.endDate ? String(query.endDate) : null);
    if (!from || !to) return { start: null, end: null, label: 'CUSTOM' };
    const start = dhakaStartUtc(from.y, from.m, from.d);
    const next = addCalendarDays(to.y, to.m, to.d, 1);
    const end = dhakaStartUtc(next.y, next.m, next.d);
    return { start, end, label: 'CUSTOM' };
  }
  return { start: null, end: null, label: 'ALL' };
}


function numOr0(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function conversionRatePct(converted: number, total: number): string {
  if (!total || total <= 0) return '0.0%';
  return ((converted / total) * 100).toFixed(1) + '%';
}

function leadProjectedNcp(lead: any): number {
  if (lead.projectedNCP != null) return numOr0(lead.projectedNCP);
  if (lead.expected_premium != null) return numOr0(lead.expected_premium);
  const cf = lead.customFields || lead.custom_fields || {};
  return numOr0(cf.projectedNCP);
}

function leadCollectedNcp(lead: any): number {
  if (lead.collectedNCP != null) return numOr0(lead.collectedNCP);
  const cf = lead.customFields || lead.custom_fields || {};
  return numOr0(cf.collectedNCP);
}

function leadSumAssured(lead: any): number {
  if (lead.sumAssured != null) return numOr0(lead.sumAssured);
  if (lead.expected_value != null) return numOr0(lead.expected_value);
  const cf = lead.customFields || lead.custom_fields || {};
  return numOr0(cf.sumAssured);
}

function computeDashboardFromLeads(
  leads: any[],
  followUpCounts: { overdue: number; today: number; upcoming: number; all: number },
  bounds: ReturnType<typeof getDhakaBusinessDayBounds>,
  periodLabel: string,
  agents: Array<{ employeeId: string; name: string; role?: string }> = []
) {
  const statusCounts = emptyStatusCounts();
  let totalLeads = 0;
  let activeLeads = 0;
  let converted = 0;
  let notInterested = 0;
  let projected = 0;
  let collected = 0;
  let sumAssured = 0;
  let pipelineVolume = 0;
  let contactedCombo = 0;
  let meetings = 0;
  let followUpsSet = 0;
  let responses = 0;

  for (const raw of leads) {
    const status = String(raw.currentStatus || raw.current_status || 'New');
    totalLeads += 1;
    if (statusCounts[status] !== undefined) statusCounts[status] += 1;
    else statusCounts[status] = (statusCounts[status] || 0) + 1;

    const proj = leadProjectedNcp(raw);
    const coll = leadCollectedNcp(raw);
    const sa = leadSumAssured(raw);
    projected += proj;
    collected += coll;
    sumAssured += sa;
    if (coll > 0 || proj > 0) pipelineVolume += 1;
    if (status !== 'New') responses += 1;
    if (status !== 'Converted' && status !== 'Not Interested') activeLeads += 1;
    if (status === 'Converted') converted += 1;
    if (status === 'Not Interested') notInterested += 1;
    if (['Contacted', 'Interested', 'Follow-up Set'].includes(status)) contactedCombo += 1;
    if (status === 'Meeting Fixed') meetings += 1;
    if (status === 'Follow-up Set') followUpsSet += 1;
  }

  const agentStats = agents.map(agent => {
    const agentLeads = leads.filter(l => {
      const assigned = String(
        l.assigned_to != null && String(l.assigned_to).trim() !== ''
          ? (l.assignedTo || l.assigned_to_employee_id || '')
          : (Object.prototype.hasOwnProperty.call(l, 'assigned_to') ? '' : (l.assignedTo || ''))
      ).toUpperCase();
      return assigned === String(agent.employeeId).toUpperCase();
    });
    const agentCollected = agentLeads.reduce((a, l) => a + leadCollectedNcp(l), 0);
    const agentProjected = agentLeads.reduce((a, l) => a + leadProjectedNcp(l), 0);
    const agentConverted = agentLeads.filter(l => String(l.currentStatus || l.current_status) === 'Converted').length;
    return {
      name: agent.name,
      employeeId: agent.employeeId,
      assigned: agentLeads.length,
      total: agentLeads.length,
      noCall: agentLeads.filter(l => String(l.currentStatus || l.current_status) === 'New').length,
      nextCall: agentLeads.filter(l => String(l.currentStatus || l.current_status) === 'New').length,
      followUp: agentLeads.filter(l => String(l.currentStatus || l.current_status) === 'Follow-up Set').length,
      followUpAlert: agentLeads.filter(l => String(l.currentStatus || l.current_status) === 'Follow-up Set').length,
      converted: agentConverted,
      collected: agentCollected,
      projected: agentProjected,
      conversion: conversionRatePct(agentConverted, agentLeads.length),
    };
  });

  // Team Performance deferred: area text is not a canonical team identity.
  // Return empty until hierarchy/team joins land in a dedicated step.
  const teamStats: any[] = [];

  const campaignStats = [
    'New', 'Interested', 'Follow-up Set', 'No Response', 'Not Interested',
    'Meeting Fixed', 'Meeting Completed', 'Converted', 'Pipeline Locked',
  ].map((name, i) => ({
    name,
    value: statusCounts[name] || 0,
    color: ['#e2e8f0', '#0F172A', '#334155', '#64748B', '#94A3B8', '#1E293B', '#CBD5E1', '#978C21', '#475569'][i],
  }));

  return {
    timezone: BUSINESS_TIMEZONE,
    todayDate: bounds.todayDate,
    bounds: { todayStart: bounds.todayStartIso, tomorrowStart: bounds.tomorrowStartIso },
    period: periodLabel,
    totalLeads,
    activeLeads,
    converted,
    notInterested,
    statusCounts,
    newLeads: statusCounts['New'] || 0,
    responses,
    pipeline: pipelineVolume,
    pipelineLocked: statusCounts['Pipeline Locked'] || 0,
    alerts: statusCounts['New'] || 0,
    contacted: contactedCombo,
    meetings,
    followUps: followUpsSet,
    projected,
    collected,
    sumAssured,
    conversionRate: conversionRatePct(converted, totalLeads),
    conversionRateValue: totalLeads > 0 ? Number(((converted / totalLeads) * 100).toFixed(1)) : 0,
    // Avg Response TAT is unavailable until a proven first-contact timestamp exists.
    avgResponseTAT: null,
    followUpsQueue: followUpCounts,
    followUpCounts,
    agentStats,
    teamStats,
    campaignStats,
    trendData: [],
    // backward-compatible aliases
    leadCount: totalLeads,
    userCount: agents.length,
  };
}

router.get('/dashboard', requireAuth, async (req: any, res) => {
  const perf = createPerf('dashboard');
  if (sendDbUnavailable(res)) return;
  try {
    const caller = await getCallerDbInfo(req);
    perf.span('authz.caller');
    if (!caller) {
      perf.finish(res);
      return sendJson(res, 403, { success: false, message: 'Your account was not found. Please log in again.' });
    }

    // Fail closed: require dashboard.view or leads.view (admin bypass inside
    // hasPermissionCode). Both checks are memoized per request and
    // independent, so they share one round trip of latency instead of two.
    const [canDashboard, canLeads] = await Promise.all([
      hasPermissionCode(caller, 'dashboard.view'),
      hasPermissionCode(caller, 'leads.view'),
    ]);
    perf.span('authz.permission');
    if (!canDashboard && !canLeads) {
      perf.finish(res);
      return sendJson(res, 403, { success: false, message: 'You do not have permission to view the dashboard.' });
    }

    // Forged role / employee / assignedTo params MUST NOT widen scope.
    // Visibility is always derived from the authenticated session.
    const visibility = await resolveCallerVisibility(caller);
    perf.span('authz.visibility');
    const bounds = getDhakaBusinessDayBounds(new Date());
    const period = parseDashboardPeriod(req.query || {});

    // Follow-up queue counts — same semantics as GET /leads/follow-ups (Step 4B).
    const terminalList = [...TERMINAL_LEAD_STATUSES];
    const todayLit = bounds.todayStartIso.replace(/'/g, "''");
    const tomorrowLit = bounds.tomorrowStartIso.replace(/'/g, "''");
    const bucketExpr = `CASE WHEN l.next_follow_up_at < '${todayLit}'::timestamp THEN 'overdue' WHEN l.next_follow_up_at < '${tomorrowLit}'::timestamp THEN 'today' ELSE 'upcoming' END`;

    if (!useDb()) {
      if (!demoModeAllowed()) return sendJson(res, 503, { success: false, message: 'Database is not configured.' });
      const visEmp = (visibility.employeeIds || []).map((e: string) => String(e).toUpperCase());
      let leads = (fallbackStore.leads || []).filter((l: any) => {
        if (l.is_deleted === true) return false;
        if (!visibility.all) {
          const assigned = String(l.assignedTo || '').toUpperCase();
          if (!assigned || !visEmp.includes(assigned)) return false;
        }
        if (period.start && period.end) {
          const t = new Date(l.timestamp || l.creationDate || l.created_at || 0).getTime();
          if (!(t >= period.start.getTime() && t < period.end.getTime())) return false;
        }
        return true;
      });

      const terminal = new Set(TERMINAL_LEAD_STATUSES.map(s => s.toLowerCase()));
      const fuBase = (fallbackStore.leads || []).filter((l: any) => {
        if (l.is_deleted === true) return false;
        const nfd = l.nextFollowUpDate || l.next_follow_up_at;
        if (!nfd) return false;
        if (!visibility.all) {
          const assigned = String(l.assignedTo || '').toUpperCase();
          if (!assigned || !visEmp.includes(assigned)) return false;
        }
        const st = String(l.currentStatus || '');
        if (terminal.has(st.toLowerCase())) return false;
        return true;
      });
      const followUpCounts = { overdue: 0, today: 0, upcoming: 0, all: fuBase.length };
      for (const l of fuBase) {
        const b = classifyFollowUpBucket(l.nextFollowUpDate || l.next_follow_up_at, bounds);
        if (b === 'overdue' || b === 'today' || b === 'upcoming') followUpCounts[b] += 1;
      }

      const agents = (fallbackStore.users || [])
        .filter((u: any) => {
          if (!visibility.all) {
            const emp = String(u.employeeId || '').toUpperCase();
            return visEmp.includes(emp);
          }
          return true;
        })
        .map((u: any) => ({ employeeId: u.employeeId, name: u.fullName || u.name || u.employeeId, role: u.role }));

      const data: any = computeDashboardFromLeads(leads, followUpCounts, bounds, period.label, agents);
      data.quality = aggregateQualityForFallbackLeads(
        leads,
        (fallbackStore as any).leadActivities || [],
        (fallbackStore as any).scheduledActivities || []
      );
      return sendJson(res, 200, { success: true, data });
    }

    const pool = getPool();

    // ---- Lead metric aggregates (one query) ----
    const metricParams: any[] = [];
    const metricWhere: string[] = ['l.is_deleted = FALSE'];
    metricWhere.push(buildDashboardVisibilitySql(visibility, metricParams));
    if (period.start && period.end) {
      metricParams.push(period.start.toISOString(), period.end.toISOString());
      metricWhere.push(`l.created_at >= $${metricParams.length - 1}::timestamp AND l.created_at < $${metricParams.length}::timestamp`);
    }

    // projected = expected_premium column, with custom_fields fallback
    // collected = custom_fields.collectedNCP (no dedicated column)
    // sum assured = expected_value column, with custom_fields fallback
    const metricSql = `
      SELECT
        COUNT(*)::int AS total_leads,
        COUNT(*) FILTER (WHERE l.current_status = 'New')::int AS untouched,
        COUNT(*) FILTER (WHERE l.current_status = 'Contacted')::int AS contacted,
        COUNT(*) FILTER (WHERE l.current_status = 'No Response')::int AS no_response,
        COUNT(*) FILTER (WHERE l.current_status = 'Busy')::int AS busy,
        COUNT(*) FILTER (WHERE l.current_status = 'Interested')::int AS interested,
        COUNT(*) FILTER (WHERE l.current_status = 'Follow-up Set')::int AS follow_up_set,
        COUNT(*) FILTER (WHERE l.current_status = 'Meeting Fixed')::int AS meeting_fixed,
        COUNT(*) FILTER (WHERE l.current_status = 'Meeting Completed')::int AS meeting_completed,
        COUNT(*) FILTER (WHERE l.current_status = 'Pipeline Locked')::int AS pipeline_locked,
        COUNT(*) FILTER (WHERE l.current_status = 'Converted')::int AS converted,
        COUNT(*) FILTER (WHERE l.current_status = 'Not Interested')::int AS not_interested,
        COUNT(*) FILTER (WHERE l.current_status IS DISTINCT FROM 'New')::int AS responses,
        COUNT(*) FILTER (WHERE l.current_status IS DISTINCT FROM 'Converted' AND l.current_status IS DISTINCT FROM 'Not Interested')::int AS active_leads,
        COUNT(*) FILTER (WHERE l.current_status IN ('Contacted','Interested','Follow-up Set'))::int AS contacted_combo,
        COUNT(*) FILTER (
          WHERE COALESCE(l.expected_premium, NULLIF(l.custom_fields->>'projectedNCP','')::numeric, 0) > 0
             OR COALESCE(NULLIF(l.custom_fields->>'collectedNCP','')::numeric, 0) > 0
        )::int AS pipeline_volume,
        COALESCE(SUM(COALESCE(l.expected_premium, NULLIF(l.custom_fields->>'projectedNCP','')::numeric, 0)), 0)::float AS projected_ncp,
        COALESCE(SUM(COALESCE(NULLIF(l.custom_fields->>'collectedNCP','')::numeric, 0)), 0)::float AS collected_ncp,
        COALESCE(SUM(COALESCE(l.expected_value, NULLIF(l.custom_fields->>'sumAssured','')::numeric, 0)), 0)::float AS sum_assured
      FROM leads l
      WHERE ${metricWhere.join(' AND ')}
    `;

    // ---- Follow-up queue counts (match Step 4B exactly; no period filter) ----
    const fuParams: any[] = [];
    const fuWhere: string[] = [
      'l.is_deleted = FALSE',
      'l.next_follow_up_at IS NOT NULL',
    ];
    fuParams.push(terminalList);
    fuWhere.push(`l.current_status <> ALL($${fuParams.length}::text[])`);
    fuWhere.push(buildDashboardVisibilitySql(visibility, fuParams));
    const fuCountSql = `SELECT ${bucketExpr} AS bucket, COUNT(*)::int AS cnt FROM leads l WHERE ${fuWhere.join(' AND ')} GROUP BY 1`;

    // ---- Agent breakdown (RO-like roles under visibility) ----
    const agentParams: any[] = [];
    const agentWhere: string[] = ['l.is_deleted = FALSE'];
    agentWhere.push(buildDashboardVisibilitySql(visibility, agentParams));
    if (period.start && period.end) {
      agentParams.push(period.start.toISOString(), period.end.toISOString());
      agentWhere.push(`l.created_at >= $${agentParams.length - 1}::timestamp AND l.created_at < $${agentParams.length}::timestamp`);
    }
    const agentSql = `
      SELECT
        COALESCE(au.employee_id, 'UNASSIGNED') AS employee_id,
        COALESCE(au.full_name, 'Unassigned') AS full_name,
        COUNT(*)::int AS assigned,
        COUNT(*) FILTER (WHERE l.current_status = 'New')::int AS no_call,
        COUNT(*) FILTER (WHERE l.current_status = 'Follow-up Set')::int AS follow_up,
        COUNT(*) FILTER (WHERE l.current_status = 'Converted')::int AS converted,
        COALESCE(SUM(COALESCE(l.expected_premium, NULLIF(l.custom_fields->>'projectedNCP','')::numeric, 0)), 0)::float AS projected,
        COALESCE(SUM(COALESCE(NULLIF(l.custom_fields->>'collectedNCP','')::numeric, 0)), 0)::float AS collected
      FROM leads l
      LEFT JOIN users au ON au.id = l.assigned_to
      WHERE ${agentWhere.join(' AND ')}
      GROUP BY 1, 2
      ORDER BY assigned DESC
      LIMIT 200
    `;

    // Lead Quality aggregates: one narrow active-lead scan + two bulk
    // signal queries, scored in memory. Same visibility scope as every
    // other dashboard figure — never wider.
    const qualityParams: any[] = [];
    const qualityVisibilitySql = buildDashboardVisibilitySql(visibility, qualityParams);

    // Team Performance deferred (Step 5B): do not invent teams from area text.
    const [metricRes, fuRes, agentRes, qualityAgg] = await Promise.all([
      pool.query(metricSql, metricParams),
      pool.query(fuCountSql, fuParams),
      pool.query(agentSql, agentParams),
      aggregateQualityForScope(pool, qualityVisibilitySql, qualityParams, terminalList),
    ]);
    perf.span('db.queries');

    const m = metricRes.rows[0] || {};
    const statusCounts = emptyStatusCounts();
    statusCounts['New'] = numOr0(m.untouched);
    statusCounts['Contacted'] = numOr0(m.contacted);
    statusCounts['No Response'] = numOr0(m.no_response);
    statusCounts['Busy'] = numOr0(m.busy);
    statusCounts['Interested'] = numOr0(m.interested);
    statusCounts['Follow-up Set'] = numOr0(m.follow_up_set);
    statusCounts['Meeting Fixed'] = numOr0(m.meeting_fixed);
    statusCounts['Meeting Completed'] = numOr0(m.meeting_completed);
    statusCounts['Pipeline Locked'] = numOr0(m.pipeline_locked);
    statusCounts['Converted'] = numOr0(m.converted);
    statusCounts['Not Interested'] = numOr0(m.not_interested);

    const totalLeads = numOr0(m.total_leads);
    const converted = numOr0(m.converted);
    const followUpCounts = { overdue: 0, today: 0, upcoming: 0, all: 0 };
    for (const row of fuRes.rows) {
      const b = String(row.bucket);
      const c = numOr0(row.cnt);
      if (b === 'overdue' || b === 'today' || b === 'upcoming') followUpCounts[b] = c;
      followUpCounts.all += c;
    }

    const agentStats = agentRes.rows.map((row: any) => ({
      name: row.full_name,
      employeeId: row.employee_id,
      assigned: numOr0(row.assigned),
      total: numOr0(row.assigned),
      noCall: numOr0(row.no_call),
      nextCall: numOr0(row.no_call),
      followUp: numOr0(row.follow_up),
      followUpAlert: numOr0(row.follow_up),
      converted: numOr0(row.converted),
      collected: numOr0(row.collected),
      projected: numOr0(row.projected),
      conversion: conversionRatePct(numOr0(row.converted), numOr0(row.assigned)),
    }));

    // Empty until canonical team/hierarchy metrics are implemented.
    const teamStats: any[] = [];

    const campaignStats = [
      'New', 'Interested', 'Follow-up Set', 'No Response', 'Not Interested',
      'Meeting Fixed', 'Meeting Completed', 'Converted', 'Pipeline Locked',
    ].map((name, i) => ({
      name,
      value: statusCounts[name] || 0,
      color: ['#e2e8f0', '#0F172A', '#334155', '#64748B', '#94A3B8', '#1E293B', '#CBD5E1', '#978C21', '#475569'][i],
    }));

    const data = {
      timezone: BUSINESS_TIMEZONE,
      todayDate: bounds.todayDate,
      bounds: { todayStart: bounds.todayStartIso, tomorrowStart: bounds.tomorrowStartIso },
      period: period.label,
      totalLeads,
      activeLeads: numOr0(m.active_leads),
      converted,
      notInterested: numOr0(m.not_interested),
      statusCounts,
      newLeads: statusCounts['New'] || 0,
      responses: numOr0(m.responses),
      pipeline: numOr0(m.pipeline_volume),
      pipelineLocked: statusCounts['Pipeline Locked'] || 0,
      alerts: statusCounts['New'] || 0,
      contacted: numOr0(m.contacted_combo),
      meetings: statusCounts['Meeting Fixed'] || 0,
      followUps: statusCounts['Follow-up Set'] || 0,
      projected: numOr0(m.projected_ncp),
      collected: numOr0(m.collected_ncp),
      sumAssured: numOr0(m.sum_assured),
      conversionRate: conversionRatePct(converted, totalLeads),
      conversionRateValue: totalLeads > 0 ? Number(((converted / totalLeads) * 100).toFixed(1)) : 0,
      // No fabricated TAT — null until a proven first-contact source exists.
      avgResponseTAT: null,
      // Lead Quality distribution over active visible leads (Hot/Warm/
      // Developing/Cold + mean active score + attention count). Terminal
      // outcomes stay in converted/notInterested, never in these bands.
      quality: qualityAgg,
      followUpsQueue: followUpCounts,
      followUpCounts,
      agentStats,
      teamStats,
      campaignStats,
      trendData: [],
      leadCount: totalLeads,
      userCount: agentStats.length,
    };

    perf.finish(res);
    return sendJson(res, 200, { success: true, data });
  } catch (error: any) {
    perf.finish(res);
    return sendJson(res, dbErrorStatus(error), { success: false, message: error?.message || 'Dashboard fetch failed' });
  }
});

export default router;
