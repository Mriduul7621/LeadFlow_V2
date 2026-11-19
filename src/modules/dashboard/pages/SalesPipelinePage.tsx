import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronRight, RefreshCw, TrendingUp } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { dashboardService, type DashboardMetrics } from '../services/dashboardService';
import LeadQualitySnapshot from '../components/LeadQualitySnapshot';
import NoAccessYet from '../../shared/components/NoAccessYet';
import { EnterprisePageHeader } from '../../workspace/components/EnterprisePrimitives';
import BackButton from '../../shared/components/BackButton';
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
    <div className="ep-page">
      <BackButton fallback="/" />
      <EnterprisePageHeader
        path="/sales-pipeline"
        actions={(
          <>
            <span className="ep-pill">
              {forbidden ? '—' : `${formatCount(totalLeads)} total leads`}
            </span>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="ep-btn"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              Refresh
            </button>
          </>
        )}
      />

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
            className="ep-btn ep-btn-danger"
          >
            Retry
          </button>
        </div>
      )}

      {forbidden ? null : loading && !metrics ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="ep-card min-h-[118px] animate-pulse" />
          ))}
        </div>
      ) : (
        <section className="ep-card" style={{ marginBottom: 16 }}>
          <div className="ep-cardhead">
            <div>
              <h3>Stage board</h3>
              <div className="ep-muted">New → Contacted → Interested → Meeting Fixed → Meeting Completed → Pipeline Locked → Converted</div>
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

      <section className="ep-card" style={{ marginTop: 16 }}>
        <div className="ep-cardhead">
          <h3>Where to go next</h3>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Link to="/leads" className="ep-card flex items-center justify-between" style={{ padding: '12px 14px' }}>
            <span className="text-xs font-semibold text-stone-700">Lead workspace</span>
            <ChevronRight className="h-4 w-4 text-stone-400" />
          </Link>
          <Link to="/follow-up" className="ep-card flex items-center justify-between" style={{ padding: '12px 14px' }}>
            <span className="text-xs font-semibold text-stone-700">Follow-up queue</span>
            <ChevronRight className="h-4 w-4 text-stone-400" />
          </Link>
          <Link to="/workbench" className="ep-card flex items-center justify-between" style={{ padding: '12px 14px' }}>
            <span className="text-xs font-semibold text-stone-700">My Work</span>
            <ChevronRight className="h-4 w-4 text-stone-400" />
          </Link>
        </div>
      </section>
    </div>
  );
}
