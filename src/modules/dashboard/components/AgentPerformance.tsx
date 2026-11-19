import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import type { Lead } from '../../shared/types';
import { KpiCard } from '../../workspace/components/EnterprisePrimitives';
import { dhakaDayStartMs, formatDhakaShort, money } from '../../workspace/utils/enterpriseData';
import {
  agentPerformanceKpis,
  conversionFunnel,
  dailyHistoryCounts,
  hourlyHistoryCounts,
  performanceInsights,
  toCsv,
} from '../../workspace/utils/agentWorkspaceData';

/**
 * AgentPerformance — the Agent's "My Performance" layout on
 * /execution-intelligence (Agent workspace rebuild, 2026-11-20,
 * Mahadi's demo screenshot 6).
 * ------------------------------------------------------------------
 * Role-conditional: only the Agent role sees this layout; Admin /
 * Manager / Team Lead keep the Analytics layout in
 * ExecutionIntelligence.tsx. The KPIs are MAHADI's set, computed
 * from the period's leads (the caller's own scope — the parent
 * loads the scoped list):
 *
 *   Total Response         -> contacted / assigned (% + count)
 *   Pipeline Premium       -> Σ projected NCP of open leads (৳)
 *   Converted ratio        -> converted / assigned (% + count)
 *   Total Collected Premium -> Σ collected NCP (৳)
 *
 * The trend counts real follow-up outcomes logged per day (hourly
 * for a single day). The funnel is cumulative over the real
 * LeadFlow statuses. Insights are only the ones the data can
 * support (0–3); nothing is invented. Export downloads a real CSV
 * of the displayed figures.
 *
 * Periods are Asia/Dhaka calendar ranges. "This month" is the
 * default, as in the demo.
 */
type AgentPeriod = 'TODAY' | 'THIS MONTH' | 'LAST MONTH' | 'CUSTOM';

const PERIOD_OPTIONS: Array<{ value: AgentPeriod; label: string }> = [
  { value: 'TODAY', label: 'Today' },
  { value: 'THIS MONTH', label: 'This month' },
  { value: 'LAST MONTH', label: 'Last month' },
  { value: 'CUSTOM', label: 'Custom range' },
];

/** A YYYY-MM-DD string in Asia/Dhaka (for <input type="date">). */
function dhakaDateString(instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);
}

/** UTC ms of 00:00 Dhaka on a YYYY-MM-DD calendar day. */
function dhakaDateStartMs(dateString: string): number {
  const [y, m, d] = dateString.split('-').map(Number);
  if (!y || !m || !d) return NaN;
  return Date.UTC(y, m - 1, d) - 6 * 3600 * 1000;
}

function dhakaYearMonth(instant: Date): { y: number; m: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: 'numeric',
  }).formatToParts(instant);
  const pick = (type: string): number => Number(parts.find(p => p.type === type)?.value ?? 0);
  return { y: pick('year'), m: pick('month') };
}

interface PeriodRange {
  startMs: number;
  endMs: number;
  label: string;
}

function periodRange(period: AgentPeriod, customStart: string, customEnd: string, now: Date): PeriodRange {
  if (period === 'TODAY') {
    const startMs = dhakaDayStartMs(now);
    return { startMs, endMs: startMs + 86_400_000, label: 'Today' };
  }
  if (period === 'LAST MONTH') {
    const { y, m } = dhakaYearMonth(now);
    const thisMonth = Date.UTC(y, m - 1, 1) - 6 * 3600 * 1000;
    const lastMonth = Date.UTC(y, m - 2, 1) - 6 * 3600 * 1000;
    return { startMs: lastMonth, endMs: thisMonth, label: 'Last month' };
  }
  if (period === 'CUSTOM') {
    const startMs = dhakaDateStartMs(customStart);
    const endMs = dhakaDateStartMs(customEnd) + 86_400_000;
    if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && startMs < endMs) {
      return {
        startMs,
        endMs,
        label: `${formatDhakaShort(new Date(startMs + 3600 * 1000).toISOString())} – ${formatDhakaShort(new Date(endMs - 86_400_000 + 3600 * 1000).toISOString())}`,
      };
    }
    // An invalid custom range falls back to this month rather than
    // showing an empty page with no explanation.
    return periodRange('THIS MONTH', customStart, customEnd, now);
  }
  const { y, m } = dhakaYearMonth(now);
  const startMs = Date.UTC(y, m - 1, 1) - 6 * 3600 * 1000;
  const endMs = Date.UTC(y, m, 1) - 6 * 3600 * 1000;
  return { startMs, endMs, label: 'This month' };
}

export function AgentPerformance({ leads, loading }: { leads: Lead[]; loading: boolean }) {
  const [period, setPeriod] = useState<AgentPeriod>('THIS MONTH');
  const [customStart, setCustomStart] = useState(() => {
    const { y, m } = dhakaYearMonth(new Date());
    return dhakaDateString(new Date(Date.UTC(y, m - 1, 1) - 6 * 3600 * 1000 + 3600 * 1000));
  });
  const [customEnd, setCustomEnd] = useState(() => dhakaDateString(new Date()));

  const range = useMemo(
    () => periodRange(period, customStart, customEnd, new Date()),
    [period, customStart, customEnd],
  );

  const periodLeads = useMemo(
    () => leads.filter(lead => {
      const t = new Date(lead.timestamp || 0).getTime();
      return !Number.isNaN(t) && t >= range.startMs && t < range.endMs;
    }),
    [leads, range],
  );

  const kpis = useMemo(() => agentPerformanceKpis(periodLeads), [periodLeads]);
  const funnel = useMemo(() => conversionFunnel(periodLeads), [periodLeads]);
  const insights = useMemo(() => performanceInsights(periodLeads), [periodLeads]);

  // The trend is an activity series: outcomes logged per day in
  // the range, across all visible leads (not just the period's
  // leads — a lead updated in the period may carry older entries,
  // and the range filter inside the counters is what binds it).
  const trend = useMemo(
    () => period === 'TODAY'
      ? hourlyHistoryCounts(leads, range.startMs)
      : dailyHistoryCounts(leads, range.startMs, range.endMs),
    [leads, range, period],
  );
  const trendTotal = trend.reduce((sum, bucket) => sum + bucket.count, 0);

  const exportCsv = () => {
    const rows: string[][] = [
      ['My Performance', range.label, `Exported ${dhakaDateString(new Date())}`],
      [],
      ['KPI', 'Value', 'Detail'],
      ['Total Response', `${kpis.contactedRate}%`, `${kpis.contacted} of ${kpis.assigned} contacted`],
      ['Pipeline Premium', money(kpis.pipelinePremium), `${kpis.pipelineOpenCount} open leads`],
      ['Converted ratio', `${kpis.convertedRate}%`, `${kpis.converted} of ${kpis.assigned} converted`],
      ['Total Collected Premium', money(kpis.collectedPremium), `${kpis.collectedCount} leads collected`],
      [],
      ['Conversion funnel', 'Leads', 'Share of assigned'],
      ...funnel.map(stage => [stage.label, String(stage.count), `${stage.pct}%`]),
      [],
      ['Performance trend (follow-up outcomes logged)', 'Day', 'Count'],
      ...trend.map(bucket => ['', bucket.label, String(bucket.count)]),
      [],
      ['Performance insights'],
      ...insights.map(insight => [`${insight.title} — ${insight.sub}`]),
    ];
    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `My_Performance_${period.replace(' ', '_')}_${dhakaDateString(new Date())}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast.success('Performance CSV downloaded.');
  };

  return (
    <>
      <div className="ep-card" style={{ marginBottom: 18 }}>
        <div className="ep-cardhead" style={{ marginBottom: 8 }}>
          <h3>{range.label}</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <select
              className="ep-select"
              value={period}
              onChange={e => setPeriod(e.target.value as AgentPeriod)}
              aria-label="Performance period"
            >
              {PERIOD_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            {period === 'CUSTOM' && (
              <>
                <input
                  type="date"
                  className="ep-input"
                  style={{ width: 'auto' }}
                  value={customStart}
                  onChange={e => setCustomStart(e.target.value)}
                  aria-label="Custom range start"
                />
                <input
                  type="date"
                  className="ep-input"
                  style={{ width: 'auto' }}
                  value={customEnd}
                  onChange={e => setCustomEnd(e.target.value)}
                  aria-label="Custom range end"
                />
              </>
            )}
            <button type="button" className="ep-btn" onClick={exportCsv}>
              <Download className="w-3.5 h-3.5" /> Export
            </button>
          </div>
        </div>
        <div className="ep-muted">
          {kpis.assigned} lead{kpis.assigned === 1 ? '' : 's'} in this period · all figures are your own scoped leads
        </div>
      </div>

      {loading ? (
        <p className="ep-empty">Loading your performance…</p>
      ) : (
        <>
          <div className="ep-grid">
            <KpiCard
              label="Total Response"
              value={`${kpis.contactedRate}%`}
              foot={`${kpis.contacted} of ${kpis.assigned} contacted`}
            />
            <KpiCard
              label="Pipeline Premium"
              value={money(kpis.pipelinePremium)}
              foot={`${kpis.pipelineOpenCount} open lead${kpis.pipelineOpenCount === 1 ? '' : 's'}`}
            />
            <KpiCard
              label="Converted ratio"
              value={`${kpis.convertedRate}%`}
              foot={`${kpis.converted} of ${kpis.assigned} converted`}
            />
            <KpiCard
              label="Total Collected Premium"
              value={money(kpis.collectedPremium)}
              foot={`${kpis.collectedCount} lead${kpis.collectedCount === 1 ? '' : 's'} collected`}
            />
          </div>

          <div className="ep-layout2">
            <div className="ep-card">
              <div className="ep-cardhead">
                <div>
                  <h3>Performance trend</h3>
                  <div className="ep-muted">Follow-up outcomes logged per {period === 'TODAY' ? 'hour' : 'day'}</div>
                </div>
              </div>
              {trendTotal === 0 ? (
                <p className="ep-empty">No follow-up outcomes logged in this period.</p>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={trend} margin={{ top: 5, right: 5, left: -18, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e7e7df" />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#788078' }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: '#788078' }} />
                    <Tooltip formatter={(value: unknown) => [`${value} outcome${Number(value) === 1 ? '' : 's'}`, 'Logged']} />
                    <Bar dataKey="count" fill="#858515" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="ep-card">
              <div className="ep-cardhead">
                <div>
                  <h3>Conversion funnel</h3>
                  <div className="ep-muted">Share of the period's assigned leads</div>
                </div>
              </div>
              {kpis.assigned === 0 ? (
                <p className="ep-empty">No leads in this period.</p>
              ) : (
                <div className="ep-funnel">
                  {funnel.map(stage => (
                    <div className="ep-funnel-row" key={stage.label}>
                      <span className="ep-funnel-label">{stage.label}</span>
                      <span className="ep-funnel-track">
                        <span
                          className="ep-funnel-fill"
                          style={{ width: `${Math.max(stage.count > 0 ? 2 : 0, stage.pct)}%`, display: 'block' }}
                        />
                      </span>
                      <span className="ep-funnel-value">
                        <strong>{stage.count}</strong> · {stage.pct}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="ep-card">
            <div className="ep-cardhead">
              <div>
                <h3>Performance insights</h3>
                <div className="ep-muted">Only what the data can actually show</div>
              </div>
            </div>
            {insights.length === 0 ? (
              <p className="ep-empty">Not enough data yet — insights appear once there is activity to measure.</p>
            ) : (
              <div className="ep-insight-list">
                {insights.map(insight => (
                  <div className="ep-insight-row" key={insight.title}>
                    <span className={`ep-insight-dot ${insight.tone}`} aria-hidden="true" />
                    <span className="ep-insight-copy">
                      <strong>{insight.title}</strong>
                      <small>{insight.sub}</small>
                    </span>
                    {insight.href && (
                      <Link className="ep-viewall" to={insight.href} style={{ marginLeft: 'auto' }}>
                        Review →
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
