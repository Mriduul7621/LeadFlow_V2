import React from 'react';
import { RefreshCw } from 'lucide-react';
import { isChunkLoadError, recoverFromChunkError } from '../../../utils/chunkRecovery';
import { useTranslation } from '../utils/translations';

/**
 * Route-level safety net for stale dynamic chunks after a deployment.
 * ------------------------------------------------------------------
 * Every route page renders through `LazyPage` (App.tsx): a Suspense
 * boundary inside the protected shell. Suspense handles the WHILE
 * (the compact placeholder); this boundary handles the FAILURE: after
 * a new deployment, the old session requests a hashed chunk that no
 * longer exists, the lazy import rejects, and without a boundary the
 * error unmounts the whole app — the silent white screen.
 *
 * Behavior:
 * - Chunk-shaped errors only (see `isChunkLoadError`): trigger ONE
 *   guarded auto-reload, which refetches a current index.html whose
 *   hashed references are valid again. The guard lives in
 *   `utils/chunkRecovery.ts` and makes a reload loop impossible.
 * - If the reload guard is spent (new deployment broken, or offline),
 *   an explicit bilingual "Reload now" card is rendered instead —
 *   user-controlled, no automatic retries.
 * - Anything else (real runtime bugs) returns `null` from
 *   `getDerivedStateFromError`, so it is NOT swallowed here and keeps
 *   the pre-existing behavior (no boundary → surfaces at root).
 */
class ChunkErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { staleChunk: boolean }
> {
  // React owns both members; declared explicitly because this repo runs
  // without bundled React type declarations (no @types/react).
  declare props: { children: React.ReactNode };
  declare state: { staleChunk: boolean };

  private autoReloadStarted = false;

  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { staleChunk: false };
    this.handleManualReload = this.handleManualReload.bind(this);
  }

  static getDerivedStateFromError(error: unknown): { staleChunk: boolean } | null {
    return isChunkLoadError(error) ? { staleChunk: true } : null;
  }

  componentDidCatch(error: unknown): void {
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
    if (!this.state.staleChunk) return this.props.children;
    return <ChunkRecoveryNotice onReload={this.handleManualReload} />;
  }
}

/**
 * Compact in-content recovery card (the shell around it stays intact —
 * sidebar/header keep working while this is shown). Bilingual via the
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

export default ChunkErrorBoundary;
