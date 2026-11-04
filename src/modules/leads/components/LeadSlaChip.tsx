import { cn } from '../../../lib/utils';
import type { LeadSlaInfo } from '../services/leadService';

/**
 * LeadSlaChip — compact first-contact SLA pill for the Workbench
 * (Phase 3 PR #3).
 * ------------------------------------------------------------------
 * Purely presentational: it renders the SERVER-computed SLA state
 * (LeadSlaService) and holds no window/threshold logic. Only the two
 * attention states are badged — breached (red) and due_soon (amber);
 * within/met and missing SLA render nothing.
 */

const HOUR_MS = 60 * 60 * 1000;

export function slaChipModel(
  sla?: LeadSlaInfo | null,
): { tone: string; label: string } | null {
  if (!sla) return null;
  if (sla.state === 'breached') {
    const hours = Math.max(1, Math.round((sla.overdueMs || 0) / HOUR_MS));
    return {
      tone: 'bg-red-100 text-red-700 border-red-200',
      label: `SLA পার হয়ে গেছে · ${hours}h`,
    };
  }
  if (sla.state === 'due_soon') {
    const hours = Math.max(1, Math.ceil((sla.remainingMs || 0) / HOUR_MS));
    return {
      tone: 'bg-amber-100 text-amber-700 border-amber-200',
      label: `SLA বাকি · ${hours}h`,
    };
  }
  return null;
}

export default function LeadSlaChip({
  sla,
  className,
}: {
  sla?: LeadSlaInfo | null;
  className?: string;
}) {
  const model = slaChipModel(sla);
  if (!model) return null;
  return (
    <span
      title="First-contact SLA"
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold whitespace-nowrap',
        model.tone,
        className,
      )}
    >
      {model.label}
    </span>
  );
}
