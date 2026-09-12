import { cn } from '../../../lib/utils';
import type { LeadQuality, LeadQualityBand } from '../../shared/types';

/**
 * LeadQualityBadge — compact "Band · Score" pill.
 * ------------------------------------------------------------------
 * Purely presentational: it renders the SERVER-computed score/band and
 * contains no scoring logic, thresholds, or weights. Unknown/missing
 * quality renders nothing (never a guessed value).
 */

export const LEAD_QUALITY_BADGE_CLASSES: Record<LeadQualityBand, string> = {
  Hot: 'bg-red-100 text-red-600 border-red-200',
  Warm: 'bg-amber-100 text-amber-700 border-amber-200',
  Developing: 'bg-blue-100 text-blue-600 border-blue-200',
  Cold: 'bg-slate-100 text-slate-500 border-slate-200',
  Converted: 'bg-green-100 text-green-700 border-green-200',
  'Not Interested': 'bg-stone-200 text-stone-600 border-stone-300',
};

export function leadQualityBadgeClass(band: unknown): string {
  return (
    (typeof band === 'string' &&
      (LEAD_QUALITY_BADGE_CLASSES as Record<string, string>)[band]) ||
    'bg-slate-100 text-slate-500 border-slate-200'
  );
}

export default function LeadQualityBadge({
  quality,
  className,
}: {
  quality?: LeadQuality | null;
  className?: string;
}) {
  if (!quality || typeof quality.score !== 'number' || !quality.band) return null;
  return (
    <span
      title={`Lead Quality: ${quality.band} (${quality.score}/100)`}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-1 rounded-sm text-[9px] font-black uppercase tracking-widest border whitespace-nowrap',
        leadQualityBadgeClass(quality.band),
        className
      )}
    >
      {quality.band} · {quality.score}
    </span>
  );
}
