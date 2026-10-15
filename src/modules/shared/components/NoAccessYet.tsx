import React from 'react';
import { ShieldAlert } from 'lucide-react';

/**
 * NoAccessYet.tsx
 * ------------------------------------------------------------------
 * The empty state behind F3: a role that has been given a PAGE (via menu
 * access or a module grant) but no PERMISSION still reaches this screen
 * instead of a blank body or a red "something failed" card.
 *
 * Copy contract (asserted by tests, and the point of the whole component):
 * the user must learn (a) that this is a permissions gap, not a bug, and
 * (b) exactly where an admin fixes it. The server keeps failing closed —
 * this component only explains the 403 the server already returned.
 */
export default function NoAccessYet({
  module,
  hint,
}: {
  /** Human name of the area, e.g. "the leads list". */
  module?: string;
  /** Optional extra line, page-specific. */
  hint?: string;
}) {
  const scope = module ? ` ${module}` : '';
  return (
    <div
      data-testid="no-access-yet"
      role="status"
      aria-live="polite"
      className="flex flex-col items-center justify-center min-h-[46vh] text-center p-8 bg-white border border-slate-200 rounded-sm max-w-xl mx-auto space-y-5 animate-in fade-in duration-300 my-8"
    >
      <div className="w-14 h-14 rounded-full bg-amber-50 border border-amber-100 flex items-center justify-center text-[#978C21] shrink-0">
        <ShieldAlert className="w-7 h-7" />
      </div>
      <div className="space-y-2">
        <span className="text-sm font-medium text-[#978C21]">Access not granted yet</span>
        <h2 className="text-xl font-bold text-slate-900">{"You don't have access yet"}</h2>
        <p className="text-xs text-slate-500 leading-relaxed font-sans">
          Your role has not been granted access to{scope} on this workspace. Nothing is broken &mdash; an
          administrator can enable it for your role from Administration &rarr; Roles &amp; Access.
        </p>
        {hint ? <p className="text-xs text-slate-400 leading-relaxed font-sans">{hint}</p> : null}
      </div>
      <div className="pt-2 border-t border-slate-100 w-full text-[9px] font-mono text-slate-400 uppercase tracking-widest leading-none">
        Access is decided on the server &middot; ask an admin to grant it
      </div>
    </div>
  );
}
