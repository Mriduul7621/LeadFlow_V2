import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  Activity,
  ChevronDown,
  Copy,
  RefreshCw,
  Trash2,
  Wifi,
  WifiOff,
  Timer,
  Gauge,
  ShieldCheck,
} from 'lucide-react';
import { Navigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ApiDiagnosticsEntry,
  ApiDiagnosticsDurationClass,
  buildDiagnosticsCopySummary,
  clearApiDiagnostics,
  classifyDuration,
  formatClock,
  formatDurationMs,
  formatTimestamp,
  getApiDiagnostics,
  parseServerTimingTotal,
  subscribeApiDiagnostics,
  summarizeApiDiagnostics,
} from '../../shared/api/diagnostics';
import { useAuthStore } from '../../auth/store/authStore';
import { resolveAdminAccess } from '../../auth/components/AdminRoute';

/**
 * PerformanceDiagnostics.tsx
 * ------------------------------------------------------------------
 * TEMPORARY, ADMIN-ONLY, READ-ONLY mobile performance diagnostics panel
 * (docs/MOBILE_PERFORMANCE_DIAGNOSTICS.md).
 *
 * - Shows recent API request timings recorded by the centralized API
 *   layer (lib/apiClient.ts + shared/api/http.ts). It issues NO requests
 *   of its own, never mutates business data, and holds no state outside
 *   the in-memory diagnostics recorder.
 * - Phone-width first: stacked compact rows, no horizontal scrolling.
 * - All values are timing metadata only (sanitized URLs, durations,
 *   statuses). No tokens, bodies, or customer data are reachable here.
 */

const DURATION_CLASS_STYLES: Record<ApiDiagnosticsDurationClass, string> = {
  good: 'bg-green-100 text-green-700',
  moderate: 'bg-amber-100 text-amber-800',
  slow: 'bg-orange-100 text-orange-800',
  very_slow: 'bg-red-100 text-red-700',
};

const DURATION_CLASS_LABELS: Record<ApiDiagnosticsDurationClass, string> = {
  good: 'good',
  moderate: 'moderate',
  slow: 'slow',
  very_slow: 'very slow',
};

async function copyPlainText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path (older mobile browsers)
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

function StatusChip({ entry }: { entry: ApiDiagnosticsEntry }) {
  if (entry.pending) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-semibold text-stone-500">
        <span className="inline-block h-2 w-2 rounded-full bg-stone-400 animate-pulse" />
        pending
      </span>
    );
  }
  if (entry.networkError) {
    return (
      <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700">
        network error
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
        entry.ok ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
      }`}
    >
      {entry.status}
    </span>
  );
}

/** Hedged frontend/network vs backend hint — never an infrastructure claim. */
function ServerTimingHint({ entry }: { entry: ApiDiagnosticsEntry }) {
  const serverMs = parseServerTimingTotal(entry.serverTiming);
  if (serverMs === null || entry.durationMs <= 0) return null;
  const share = serverMs / entry.durationMs;
  if (share >= 0.7) {
    return (
      <p className="mt-1 text-[11px] leading-snug text-stone-500">
        Per Server-Timing, most of this request&apos;s time was spent on the server
        ({formatDurationMs(serverMs)} of {formatDurationMs(entry.durationMs)}).
      </p>
    );
  }
  if (share <= 0.4 && entry.durationMs > 800) {
    return (
      <p className="mt-1 text-[11px] leading-snug text-stone-500">
        Per Server-Timing, the server reported {formatDurationMs(serverMs)} — a large part of the
        total ({formatDurationMs(entry.durationMs)}) was client/network time.
      </p>
    );
  }
  return null;
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-stone-400">{label}</span>
      <span className="min-w-0 break-words text-xs text-stone-700">{value}</span>
    </div>
  );
}

function RequestRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: ApiDiagnosticsEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const durationClass = classifyDuration(entry.durationMs);
  const serverMs = parseServerTimingTotal(entry.serverTiming);

  return (
    <div className="rounded-[10px] border border-stone-100 bg-white">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full px-3 py-2.5 text-left"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0 flex-1 break-all text-xs font-medium text-stone-800">
            <span className="mr-1.5 text-[10px] font-semibold text-stone-400">#{entry.seq}</span>
            {entry.path}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${DURATION_CLASS_STYLES[durationClass]}`}>
              {formatDurationMs(entry.durationMs)}
            </span>
            <ChevronDown
              size={14}
              className={`mt-0.5 shrink-0 text-stone-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
            />
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-stone-500">
          <StatusChip entry={entry} />
          <span className="font-mono">{entry.method}</span>
          {serverMs !== null && <span>Server: {formatDurationMs(serverMs)}</span>}
          {entry.firstAfterLoad && (
            <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-600">
              1st after app load
            </span>
          )}
          <span className="ml-auto">{formatClock(entry.startedAt)}</span>
        </div>
      </button>

      {expanded && (
        <div className="space-y-1.5 border-t border-stone-100 px-3 py-2.5">
          <DetailRow label="Path" value={<span className="break-all font-mono">{entry.path}</span>} />
          <DetailRow label="Method" value={entry.method} />
          <DetailRow label="HTTP status" value={entry.networkError ? 'no response (network error)' : entry.status} />
          <DetailRow label="Total duration" value={`${entry.durationMs} ms (${formatDurationMs(entry.durationMs)}) — ${DURATION_CLASS_LABELS[durationClass]}`} />
          <DetailRow
            label="Server-Timing"
            value={
              entry.serverTiming
                ? <span className="break-all font-mono">{entry.serverTiming}</span>
                : 'not present / not readable for this response'
            }
          />
          {serverMs !== null && <ServerTimingHint entry={entry} />}
          <DetailRow label="Response size" value={entry.responseSizeBytes !== null ? `${entry.responseSizeBytes} bytes (content-length)` : 'not provided by server'} />
          <DetailRow label="Request start" value={`${formatClock(entry.startedAt)} (${formatTimestamp(entry.startedAt)})`} />
          <DetailRow label="Request finish" value={entry.finishedAt === null ? 'in flight' : `${formatClock(entry.finishedAt)} (${formatTimestamp(entry.finishedAt)})`} />
          <DetailRow label="Sequence" value={`#${entry.seq}${entry.firstAfterLoad ? ' — first request after app load' : ' — subsequent request'}`} />
          {entry.errorMessage && (
            <DetailRow label="Error" value={<span className="text-red-600">{entry.errorMessage}</span>} />
          )}
        </div>
      )}
    </div>
  );
}

export default function PerformanceDiagnostics() {
  const user = useAuthStore(state => state.user);
  const entries = useSyncExternalStore(subscribeApiDiagnostics, getApiDiagnostics);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    const update = () => setIsOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  // Diagnostics update live via subscription; the Refresh button re-reads
  // the current in-memory data (no network request, nothing re-fetched).
  const summary = useMemo(() => summarizeApiDiagnostics(), [entries, refreshTick]);

  // Belt-and-braces: the route gate already blocks non-admins; the page
  // itself never renders diagnostics data for a non-admin session either.
  // (Placed after all hooks so the component's hook order is stable.)
  if (resolveAdminAccess(user?.role) === 'denied') {
    return <Navigate to="/settings" replace />;
  }

  const handleCopy = async () => {
    const ok = await copyPlainText(buildDiagnosticsCopySummary());
    if (ok) {
      toast.success('Summary copied — paste it into your report or chat.');
    } else {
      toast.error('Copy failed on this browser. Select the text manually.');
    }
  };

  const handleClear = () => {
    clearApiDiagnostics();
    setExpandedId(null);
    toast.success('Diagnostics cleared.');
  };

  const handleRefresh = () => {
    // Diagnostics update live via subscription; Refresh re-reads the
    // current in-memory data (no network request, nothing re-fetched).
    setRefreshTick(t => t + 1);
    toast.info(`Showing latest in-memory data (${entries.length} requests).`);
  };

  return (
    <div className="mx-auto max-w-xl space-y-4 px-3 py-4 sm:px-4" data-testid="performance-diagnostics">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="rounded-[10px] bg-[#978C21]/10 p-2">
          <Gauge size={20} className="text-[#978C21]" />
        </div>
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-stone-900">Performance Diagnostics</h1>
          <p className="text-xs text-stone-500">
            Admin-only · read-only · temporary tool. Session started {formatTimestamp(summary.sessionStartedAt)}.
          </p>
        </div>
        <span
          className={`ml-auto inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ${
            isOnline ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
          }`}
        >
          {isOnline ? <Wifi size={12} /> : <WifiOff size={12} />}
          {isOnline ? 'online' : 'offline'}
        </span>
      </div>

      {/* Summary */}
      <div className="rounded-[12px] border border-stone-100 bg-white p-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-[10px] bg-stone-50 p-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">Slowest request</p>
            <p className="truncate text-sm font-bold text-stone-800">
              {summary.slowest ? formatDurationMs(summary.slowest.durationMs) : '—'}
            </p>
            {summary.slowest && (
              <p className="truncate text-[10px] text-stone-400" title={summary.slowest.path}>
                {summary.slowest.path}
              </p>
            )}
          </div>
          <div className="rounded-[10px] bg-stone-50 p-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">Average (recent)</p>
            <p className="text-sm font-bold text-stone-800">
              {summary.averageMs !== null ? formatDurationMs(summary.averageMs) : '—'}
            </p>
            <p className="text-[10px] text-stone-400">{summary.captured} captured · {summary.pending} pending</p>
          </div>
          <div className="rounded-[10px] bg-stone-50 p-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">Requests &gt; 1 s</p>
            <p className={`text-sm font-bold ${summary.over1s > 0 ? 'text-orange-600' : 'text-stone-800'}`}>
              {summary.over1s}
            </p>
          </div>
          <div className="rounded-[10px] bg-stone-50 p-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">Requests &gt; 3 s</p>
            <p className={`text-sm font-bold ${summary.over3s > 0 ? 'text-red-600' : 'text-stone-800'}`}>
              {summary.over3s}
            </p>
          </div>
        </div>
        {summary.failed > 0 && (
          <p className="mt-2 text-[11px] font-medium text-red-600">
            {summary.failed} failed request{summary.failed > 1 ? 's' : ''} in the recent window.
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 rounded-[10px] bg-[#978C21] px-3 py-2 text-xs font-semibold text-white active:opacity-80"
        >
          <Copy size={13} /> Copy summary
        </button>
        <button
          type="button"
          onClick={handleRefresh}
          className="inline-flex items-center gap-1.5 rounded-[10px] border border-stone-200 bg-white px-3 py-2 text-xs font-semibold text-stone-700 active:opacity-80"
        >
          <RefreshCw size={13} /> Refresh
        </button>
        <button
          type="button"
          onClick={handleClear}
          className="ml-auto inline-flex items-center gap-1.5 rounded-[10px] border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-600 active:opacity-80"
        >
          <Trash2 size={13} /> Clear diagnostics
        </button>
      </div>

      {/* Request list — newest first, phone-width stacked rows */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5 text-[11px] text-stone-400">
          <Activity size={12} />
          <span>
            Most recent {entries.length} API request{entries.length === 1 ? '' : 's'} — updates automatically.
          </span>
        </div>

        {entries.length === 0 && (
          <div className="rounded-[12px] border border-dashed border-stone-200 bg-white p-6 text-center">
            <Timer size={20} className="mx-auto mb-2 text-stone-300" />
            <p className="text-sm font-medium text-stone-600">No API requests recorded yet.</p>
            <p className="mt-1 text-xs text-stone-400">
              Navigate around the app (Dashboard, Workbench, Follow-up Queue), then come back here.
            </p>
          </div>
        )}

        {entries.map(entry => (
          <React.Fragment key={entry.id}>
            <RequestRow
              entry={entry}
              expanded={expandedId === entry.id}
              onToggle={() => setExpandedId(current => (current === entry.id ? null : entry.id))}
            />
          </React.Fragment>
        ))}
      </div>

      {/* Privacy note */}
      <div className="flex items-start gap-2 rounded-[12px] border border-stone-100 bg-white p-3">
        <ShieldCheck size={16} className="mt-0.5 shrink-0 text-green-600" />
        <p className="text-[11px] leading-relaxed text-stone-500">
          Timings only. Tokens, passwords, request/response bodies and customer data are never
          recorded; URLs are shown with unknown query values redacted. Diagnostics live in memory
          for this session only and are cleared on logout. No data leaves this device.
        </p>
      </div>
    </div>
  );
}
