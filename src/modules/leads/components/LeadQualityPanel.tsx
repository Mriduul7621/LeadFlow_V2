import { AlertTriangle, MinusCircle, PlusCircle } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { LeadQuality } from '../../shared/types';
import { leadQualityBadgeClass } from './LeadQualityBadge';

/**
 * LeadQualityPanel — the "WHY" behind a lead's score.
 * ------------------------------------------------------------------
 * Renders the server-authoritative explanation (positive/negative
 * factors + attention reasons) for Lead360 and lead details. It performs
 * no scoring: every number shown arrives from the API.
 */

function FactorRow({
  label,
  points,
  tone,
}: {
  label: string;
  points: number;
  tone: 'up' | 'down';
}) {
  const Icon = tone === 'up' ? PlusCircle : MinusCircle;
  return (
    <>
      <Icon
        className={cn(
          'w-3.5 h-3.5 mt-px shrink-0',
          tone === 'up' ? 'text-emerald-600' : 'text-red-500'
        )}
      />
      <span className="flex-1 text-slate-600 font-medium">{label}</span>
      <span
        className={cn(
          'font-black tabular-nums shrink-0',
          tone === 'up' ? 'text-emerald-600' : 'text-red-500'
        )}
      >
        {points > 0 ? `+${points}` : points}
      </span>
    </>
  );
}

export default function LeadQualityPanel({
  quality,
  className,
}: {
  quality?: LeadQuality | null;
  className?: string;
}) {
  if (!quality || typeof quality.score !== 'number' || !quality.band) {
    return (
      <div className={cn('text-[11px] text-slate-400 italic', className)}>
        Lead Quality is unavailable for this lead.
      </div>
    );
  }

  const positive = Array.isArray(quality.positiveFactors) ? quality.positiveFactors : [];
  const negative = Array.isArray(quality.negativeFactors) ? quality.negativeFactors : [];
  const attention = Array.isArray(quality.attentionReasons) ? quality.attentionReasons : [];
  const hasExplanation = positive.length > 0 || negative.length > 0;

  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex items-center gap-3 flex-wrap">
        <span
          className={cn(
            'px-3 py-1.5 rounded-sm text-[10px] font-black uppercase tracking-widest border',
            leadQualityBadgeClass(quality.band)
          )}
        >
          {quality.band} · {quality.score}
        </span>
        <div className="flex-1 min-w-[120px] h-2 bg-slate-100 rounded-full overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              quality.band === 'Hot'
                ? 'bg-red-500'
                : quality.band === 'Warm'
                  ? 'bg-amber-500'
                  : quality.band === 'Developing'
                    ? 'bg-blue-500'
                    : quality.band === 'Converted'
                      ? 'bg-emerald-500'
                      : 'bg-slate-300'
            )}
            style={{ width: `${Math.min(100, Math.max(0, quality.score))}%` }}
          />
        </div>
        <span className="text-[10px] font-black text-slate-400 tabular-nums">
          {quality.score}/100
        </span>
      </div>

      {quality.isTerminal ? (
        <p className="text-[11px] text-slate-500 italic leading-relaxed">
          {quality.band === 'Converted'
            ? 'This lead reached a successful outcome. Quality bands apply to active opportunities only.'
            : 'This lead is closed. Quality bands apply to active opportunities only.'}
        </p>
      ) : hasExplanation ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-sm border border-slate-100 bg-[#FBFAF8] p-3">
            <p className="text-[9px] font-black uppercase tracking-widest text-emerald-700 mb-2">
              What lifts this score
            </p>
            {positive.length === 0 ? (
              <p className="text-[11px] text-slate-400 italic">No positive signals yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {positive.map((f, i) => (
                  <li key={i} className="flex items-start gap-2 text-[11px] leading-relaxed">
                    <FactorRow label={f.label} points={f.points} tone="up" />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="rounded-sm border border-slate-100 bg-[#FBFAF8] p-3">
            <p className="text-[9px] font-black uppercase tracking-widest text-red-600 mb-2">
              What pulls it down
            </p>
            {negative.length === 0 ? (
              <p className="text-[11px] text-slate-400 italic">No negative signals.</p>
            ) : (
              <ul className="space-y-1.5">
                {negative.map((f, i) => (
                  <li key={i} className="flex items-start gap-2 text-[11px] leading-relaxed">
                    <FactorRow label={f.label} points={f.points} tone="down" />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-slate-400 italic">
          Detailed factors load with the full lead record.
        </p>
      )}

      {attention.length > 0 && (
        <div className="rounded-sm border border-amber-200 bg-amber-50/60 p-3 space-y-1.5">
          <p className="text-[9px] font-black uppercase tracking-widest text-amber-700 flex items-center gap-1.5">
            <AlertTriangle className="w-3 h-3" /> Needs attention
          </p>
          <ul className="space-y-1">
            {attention.map((reason, i) => (
              <li key={i} className="text-[11px] font-medium text-amber-800">
                {reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
