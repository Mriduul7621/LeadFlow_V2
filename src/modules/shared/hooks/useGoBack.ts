import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * useGoBack — history-aware "back" for every page in the app shell.
 * ------------------------------------------------------------------
 * The sidebar (and every drill-down) must return the user to the page they
 * actually came from, not to a fixed destination. `navigate(-1)` restores
 * the previous history entry; when there is nothing to go back to (a deep
 * link or a freshly opened installed app), it falls back to a safe landing
 * page with `replace` so the dead entry is not left in the stack.
 *
 * React Router v7 keeps its own index in `history.state.idx`, so
 * `idx > 0` is an exact "there is an in-app page behind this one" test —
 * `window.history.length` alone would count entries from other sites.
 */
export function useGoBack(fallbackPath = '/') {
  const navigate = useNavigate();
  return useCallback(() => {
    const idx = typeof window !== 'undefined' && typeof window.history.state?.idx === 'number'
      ? window.history.state.idx
      : 0;
    if (idx > 0) {
      navigate(-1);
      return;
    }
    navigate(fallbackPath, { replace: true });
  }, [navigate, fallbackPath]);
}
