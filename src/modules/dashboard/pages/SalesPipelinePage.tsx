import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronRight, RefreshCw, TrendingUp } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { dashboardService, type DashboardMetrics } from '../services/dashboardService';
import LeadQualitySnapshot from '../components/LeadQualitySnapshot';
import BackButton from '../../shared/components/BackButton';
import NoAccessYet from '../../shared/components/NoAccessYet';
import { isForbiddenError } from '../../shared/api/forbidden';

/**
 * SalesPipelinePage — the pipeline board that used to sit on Home.
 * ------------------------------------------------------------------
 * Home now keeps only the personal today/tomorrow work; the pipeline is
 * a destination of its own, reachable from the left sidebar only.
 *
 * Data authority is unchanged: every stage count comes from the SAME
 * server-authoritative GET /api/dashboard payload (PostgreSQL + Dhaka +
 * visibility-scoped). Nothing here is derived from client lead lists and
 * no new endpoint was added, so the page inherits the dashboard's role and
 * data visibility rules exactly.
 *
 * The Lead Quality snapshot moved here from Home (2026-10): it is the same
 * server-computed scope aggregate of that same payload, now shown next to
 * the stage board it explains, instead of on the personal work page.
 */

const PIPELINE_STAGES = [
  'New',
  'Contacted',
  'Interested',
  'Meeting Fixed',
  'Meeting Completed',
  'Pipeline Locked',
  'Converted',
] as const;

const formatCount = (n: number) => Number(n || 0).toLocaleString('en-US');

export default function SalesPipelinePage() {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // F3: a 403 is a permissions gap, not a failure — say so instead of
  // showing a red "try again" card that can never succeed.
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const data = await dashboardService.getDashboard();
      setMetrics(data);
    } catch (err) {
      if (isForbiddenError(err)) {
        setMetrics(null);
        setForbidden(true);
      } else {
        setError(err instanceof Error ? err.message : 'Could not load the sales pipeline.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totalLeads = metrics?.totalLeads ?? 0;
  const statusCounts = metrics?.statusCounts ?? {};
  const stages = useMemo(() => PIPELINE_STAGES.map(stage => {
    const count = Number((statusCounts as Record<string, number>)[stage] || 0);
    const pct = totalLeads > 0 ? Math.round((count / totalLeads) * 100) : 0;
    return { stage, count, pct };
  }), [statusCounts, totalLeads]);

  return (
    <div className="mx-auto max-w-[1280px] space-y-5 pb-12 font-sans">
      <BackButton fallback="/" />
      <div className="flex flex-col gap-3 border-b border-stone-100 pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-brand-text">Sales Pipeline</h1>
          <p className="mt-1.5 text-[12px] text-stone-500">Every lead in your visibility scope across each sales stage.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-stone-100 bg-[#FFFCF8] px-3 py-1.5 text-[11px] font-bold text-stone-600">
            {forbidden ? '—' : `${formatCount(totalLeads)} total leads`}
          </span>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-[10px] border border-stone-200 bg-white px-3 py-2 text-xs font-semibold text-stone-600 transition-colors hover:border-[#978C21]/30 hover:text-[#978C21] disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            Refresh
          </button>
        </div>
      </div>

      {forbidden ? (
        <NoAccessYet module="the sales pipeline" hint="Pipeline stages come from the dashboard read, which your role cannot see yet." />
      ) : error && (
        <div className="flex items-center justify-between gap-4 rounded-[12px] border border-red-200 bg-red-50 px-5 py-4">
          <div className="flex items-center gap-3 text-red-700">
            <AlertTriangle className="h-5 w-5" />
            <div>
              <p className="text-sm font-semibold">{error}</p>
              <p className="mt-0.5 text-xs text-red-500">Your saved data is unchanged. Please try again.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-[10px] bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700"
          >
            Retry
          </button>
        </div>
      )}

      {forbidden ? null : loading && !metrics ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="min-h-[118px] animate-pulse rounded-[12px] border border-stone-100 bg-white p-5" />
          ))}
        </div>
      ) : (
        <section className="rounded-[12px] border border-stone-100 bg-white p-4 md:p-6" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <h2 className="text-sm font-black uppercase tracking-[0.12em] text-stone-700">Stage board</h2>
              <p className="mt-1.5 text-[12px] text-stone-500">New → Contacted → Interested → Meeting Fixed → Meeting Completed → Pipeline Locked → Converted</p>
            </div>
            <TrendingUp className="hidden h-5 w-5 shrink-0 text-[#978C21] md:block" />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            {stages.map((s, i) => (
              <div key={s.stage} className="relative rounded-[12px] border border-stone-100 bg-[#FFFCF8] p-3 transition-all duration-150 hover:bg-white hover:shadow-sm">
                <div className="flex items-center justify-between">
                  <span className="truncate text-[10px] font-black uppercase tracking-wider text-stone-500">{s.stage}</span>
                  {i < stages.length - 1 && <ChevronRight className="hidden h-3.5 w-3.5 shrink-0 text-stone-300 lg:block" />}
                </div>
                <p className="mt-2 text-2xl font-black leading-none text-brand-text">{formatCount(s.count)}</p>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-stone-200">
                  <div className="h-full rounded-full bg-[#978C21] transition-all duration-500" style={{ width: `${s.pct}%` }} />
                </div>
                <p className="mt-2 text-[10px] font-semibold text-stone-400">{s.pct}% of leads</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {!loading && <LeadQualitySnapshot quality={metrics?.quality} />}

      <section className="rounded-[12px] border border-stone-100 bg-white p-5 md:p-6" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
        <h2 className="text-sm font-black uppercase tracking-[0.12em] text-stone-700">Where to go next</h2>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Link to="/leads" className="flex items-center justify-between rounded-[12px] border border-stone-100 bg-[#FFFCF8] px-4 py-3 transition-colors hover:border-[#978C21]/30 hover:bg-white">
            <span className="text-xs font-semibold text-stone-700">Lead workspace</span>
            <ChevronRight className="h-4 w-4 text-stone-400" />
          </Link>
          <Link to="/follow-up" className="flex items-center justify-between rounded-[12px] border border-stone-100 bg-[#FFFCF8] px-4 py-3 transition-colors hover:border-[#978C21]/30 hover:bg-white">
            <span className="text-xs font-semibold text-stone-700">Follow-up queue</span>
            <ChevronRight className="h-4 w-4 text-stone-400" />
          </Link>
          <Link to="/workbench" className="flex items-center justify-between rounded-[12px] border border-stone-100 bg-[#FFFCF8] px-4 py-3 transition-colors hover:border-[#978C21]/30 hover:bg-white">
            <span className="text-xs font-semibold text-stone-700">My Work</span>
            <ChevronRight className="h-4 w-4 text-stone-400" />
          </Link>
        </div>
      </section>
    </div>
  );
}
