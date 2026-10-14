import React from 'react';

interface Props {
  /** Rendered instead of the children once they have failed. */
  fallback: React.ReactNode;
  children: React.ReactNode;
}

interface State {
  failed: boolean;
}

/**
 * SectionErrorBoundary
 * ------------------------------------------------------------------
 * Keeps a DEFERRED, non-critical section (e.g. the embedded Task Calendar on
 * the dashboard) from taking the whole page down.
 *
 * The dashboard's primary content is server-authoritative and must stay
 * usable even if an optional section throws while rendering — the app-level
 * boundary would otherwise replace the entire screen with "Something went
 * wrong". The failed section simply renders its lightweight placeholder, and
 * the rest of the page (KPIs, recent leads, follow-ups) is unaffected.
 */
export default class SectionErrorBoundary extends React.Component<Props, State> {
  // React owns both members; declared explicitly because this repo runs
  // without bundled React type declarations (no @types/react).
  declare props: Props;
  declare state: State;

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  /** React 18 class components initialise state here; declared for the
   *  type-checker because the repo ships without @types/react. */
  constructor(props: Props) {
    super(props);
    this.state = { failed: false };
  }

  componentDidCatch(error: unknown): void {
    // Diagnostics only: never surface a stack to the user, and never swallow
    // the failure silently from an operator's point of view.
    console.error('[section] optional section failed to render:', error);
  }

  render(): React.ReactNode {
    return this.state.failed ? (this.props as Props).fallback : (this.props as Props).children;
  }
}
