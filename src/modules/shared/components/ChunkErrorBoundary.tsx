import React from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { isChunkLoadError, recoverFromChunkError } from '../../../utils/chunkRecovery';
import { useTranslation } from '../utils/translations';

/**
 * Route-level error boundary for the lazy route pages.
 * ------------------------------------------------------------------
 * Every route page renders through `LazyPage` (App.tsx): a Suspense
 * boundary inside the protected shell. Suspense handles the WHILE
 * (the compact placeholder); this boundary handles the FAILURE — and
 * it handles BOTH failure categories explicitly, because once a
 * descendant throws, the boundary has caught the render error and the
 * crashing child can never "just continue": React needs a replacement
 * tree either way.
 *
 * `staleChunk` — the dynamic import rejected because the deployment's
 *   old hashed chunks are gone. Exactly ONE guarded auto-reload (see
 *   `utils/chunkRecovery.ts` — reload refetches a current index.html,
 *   cooldown makes a loop impossible). If the guard is spent, the
 *   bilingual "New version available / Reload now" card renders.
 *
 * `runtimeError` — any other render error. NEVER auto-reloads (that
 *   would hide a real bug behind a reboot loop); renders a safe
 *   generic fallback with explicit user-controlled actions instead.
 *   Raw error text/stack is deliberately never rendered or logged —
 *   the repo has no error-telemetry sink, and exception text can
 *   carry sensitive payload fragments.
 */
type BoundaryPhase = 'normal' | 'staleChunk' | 'runtimeError';

class ChunkErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { phase: BoundaryPhase }
> {
  // React owns both members; declared explicitly because this repo runs
  // without bundled React type declarations (no @types/react).
  declare props: { children: React.ReactNode };
  declare state: { phase: BoundaryPhase };

  private autoReloadStarted = false;

  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { phase: 'normal' };
    this.handleManualReload = this.handleManualReload.bind(this);
  }

  static getDerivedStateFromError(error: unknown): { phase: BoundaryPhase } {
    return { phase: isChunkLoadError(error) ? 'staleChunk' : 'runtimeError' };
  }

  componentDidCatch(error: unknown): void {
    // Automatic recovery is reserved for chunk-shaped errors. A generic
    // render error must not reload the app behind the user's back — it
    // gets the fallback UI with explicit actions instead.
    if (!isChunkLoadError(error) || this.autoReloadStarted) return;
    // First chunk failure in this document: one guarded reload. If the
    // guard is spent this returns false and the notice below renders.
    this.autoReloadStarted = recoverFromChunkError();
  }

  handleManualReload(): void {
    // Explicit user intent bypasses the cooldown — a manual reload also
    // revalidates index.html, so this always offers a real way forward.
    recoverFromChunkError({ force: true });
  }

  render(): React.ReactNode {
    if (this.state.phase === 'normal') return this.props.children;
    if (this.state.phase === 'staleChunk') {
      return <ChunkRecoveryNotice onReload={this.handleManualReload} />;
    }
    return <GenericErrorFallback />;
  }
}

/**
 * Stale-chunk recovery card: compact, in-content (the shell around it
 * stays intact — sidebar/header keep working), bilingual via the
 * shared dictionary.
 */
function ChunkRecoveryNotice({ onReload }: { onReload: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="mx-auto mt-16 max-w-md rounded-[12px] border border-stone-200 bg-white p-6 text-center shadow-xs"
    >
      <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-amber-50">
        <RefreshCw className="h-5 w-5 text-amber-600" />
      </div>
      <h2 className="text-[11px] font-black uppercase tracking-[0.15em] text-stone-800">
        {t('newVersionTitle')}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-stone-500">{t('newVersionBody')}</p>
      <button
        type="button"
        onClick={onReload}
        className="mt-5 inline-flex items-center gap-2 rounded-[10px] bg-stone-900 px-4 py-2 text-[11px] font-black uppercase tracking-[0.12em] text-white transition-colors hover:bg-stone-700"
      >
        <RefreshCw className="h-3.5 w-3.5" />
        {t('reloadNow')}
      </button>
    </div>
  );
}

/**
 * Generic runtime-error fallback: a professional dead end that never
 * retries the broken child on its own. Renders FIXED strings only —
 * the thrown error's message/stack never reach the DOM (they can
 * carry sensitive fragments and mean nothing to end users).
 */
function GenericErrorFallback() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const onDashboard = typeof window !== 'undefined' && window.location?.pathname === '/';
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="mx-auto mt-16 max-w-md rounded-[12px] border border-stone-200 bg-white p-6 text-center shadow-xs"
    >
      <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-red-50">
        <AlertTriangle className="h-5 w-5 text-red-600" />
      </div>
      <h2 className="text-[11px] font-black uppercase tracking-[0.15em] text-stone-800">
        {t('somethingWentWrongTitle')}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-stone-500">{t('somethingWentWrongBody')}</p>
      <div className="mt-5 flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-2 rounded-[10px] bg-stone-900 px-4 py-2 text-[11px] font-black uppercase tracking-[0.12em] text-white transition-colors hover:bg-stone-700"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t('reloadApplication')}
        </button>
        {/* "Go to Dashboard" only helps when the crash happened on another
            page; on the dashboard itself the action would just retry the
            same broken route, so it is hidden there (if practical). */}
        {!onDashboard && (
          <button
            type="button"
            onClick={() => navigate('/', { replace: true })}
            className="inline-flex items-center rounded-[10px] border border-stone-300 px-4 py-2 text-[11px] font-black uppercase tracking-[0.12em] text-stone-700 transition-colors hover:bg-stone-100"
          >
            {t('goDashboard')}
          </button>
        )}
      </div>
    </div>
  );
}

export default ChunkErrorBoundary;
