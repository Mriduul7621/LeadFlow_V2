import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { DashboardQualityAggregate } from '../services/dashboardService';

/**
 * LeadQualitySnapshot — the lead-quality bands of the pipeline.
 * ---------------------------------------------------------------
 * It used to sit on Home; Home now keeps only personal daily work, so the
 * snapshot lives on the Sales Pipeline page, next to the stage board it
 * explains.
 *
 * Data authority is unchanged and stays server-side: this renders ONLY the
 * scope-consistent aggregate that GET /api/dashboard already returned
 * (`metrics.quality`) — one request for the whole page, no per-lead
 * `GET /api/leads/:id/quality` fan-out, no client-side scoring.
 */

const formatCount = (n: number) => Number(n || 0).toLocaleString('en-US');

export default function LeadQualitySnapshot({ quality }: { quality?: DashboardQualityAggregate }) {
  if (!quality) return null;
  const bands = [
    { label: 'Hot', value: quality.hot, dot: 'bg-red-500' },
    { label: 'Warm', value: quality.warm, dot: 'bg-amber-500' },
    { label: 'Developing', value: quality.developing, dot: 'bg-blue-500' },
    { label: 'Cold', value: quality.cold, dot: 'bg-slate-300' },
  ];
  const desc =
    quality.activeScored > 0
      ? `${formatCount(quality.activeScored)} active leads scored${quality.activeAverage !== null ? ` · avg ${quality.activeAverage}` : ''}`
      : 'No active leads scored yet';
  return (
    <section
      className="rounded-[12px] border border-stone-100 bg-white p-4 md:p-6"
      style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}
      aria-label="Lead quality"
    >
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-sm font-black uppercase tracking-[0.12em] text-stone-700">Lead Quality</h2>
          <p className="mt-1.5 text-[12px] leading-relaxed text-stone-500">{desc}</p>
        </div>
        <Link to="/leads" className="inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold text-[#978C21] hover:underline">
          Open Lead Workspace <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {bands.map(band => (
          <div key={band.label} className="rounded-[10px] border border-stone-100 bg-[#FFFCF8] px-4 py-3">
            <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-stone-500">
              <span className={cn('h-2 w-2 rounded-full', band.dot)} />
              {band.label}
            </p>
            <p className="mt-1 text-xl font-black tabular-nums text-brand-text">{formatCount(band.value)}</p>
          </div>
        ))}
      </div>
      {quality.needsAttention > 0 && (
        <p className="mt-3 text-[12px] text-stone-500">
          <span className="font-bold text-amber-600">{formatCount(quality.needsAttention)}</span>
          {' '}need attention — overdue or stale engagement.
        </p>
      )}
    </section>
  );
}
