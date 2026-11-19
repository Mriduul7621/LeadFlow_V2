import { AlertTriangle } from 'lucide-react';

/**
 * EnterpriseErrorPanel — the load-failure card for the enterprise
 * role homes (Enterprise Preview redesign, 2026-11-19).
 * ------------------------------------------------------------------
 * A genuine failure (not a 403 — those render NoAccessYet) keeps its
 * original message + Retry, per the F3 contract: a server outage
 * must never read as "no access", and a permissions gap must never
 * read as a crash.
 */
export function EnterpriseErrorPanel(props: {
  title: string;
  body: string;
  onRetry: () => void;
}) {
  return (
    <div className="ep-error" role="alert">
      <div className="ep-error-copy">
        <AlertTriangle className="ep-error-icon" aria-hidden="true" />
        <div>
          <p className="ep-error-title">{props.title}</p>
          <p className="ep-error-body">{props.body} Your saved data is unchanged. Please try again.</p>
        </div>
      </div>
      <button type="button" className="ep-btn ep-btn-danger" onClick={props.onRetry}>
        Retry
      </button>
    </div>
  );
}
