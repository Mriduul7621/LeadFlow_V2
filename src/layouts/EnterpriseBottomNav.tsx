import { Link } from 'react-router-dom';
import { cn } from '../lib/utils';
import type { EnterpriseBottomNavTab } from './enterpriseNav';

/**
 * EnterpriseBottomNav — the mobile-only fixed bottom navigation
 * (fix round, 2026-11-19).
 * ------------------------------------------------------------------
 * Four tabs (the role's most important pages, Overview always
 * first), in the sample's design language: a white bar, olive
 * active state, small icon + label per tab. Hidden on desktop by
 * CSS, at the same 720px breakpoint as the sidebar drawer; the
 * drawer overlays above it (z-index 20 vs the bar's 10).
 *
 * Presentational only: AppLayout resolves the tabs for the DISPLAY
 * role (so a super admin previewing another role sees that role's
 * tabs) through the same access predicates as the sidebar, and
 * passes the active path. Every tab is a real route — the builder
 * filters out anything the user could not open.
 */
export default function EnterpriseBottomNav({
  tabs,
  activePath,
}: {
  tabs: EnterpriseBottomNavTab[];
  activePath: string | null;
}) {
  if (tabs.length === 0) return null;
  return (
    <nav className="ep-bottomnav" aria-label="Primary">
      {tabs.map(tab => {
        const Icon = tab.icon;
        const active = activePath === tab.path;
        return (
          <Link
            key={tab.path}
            to={tab.path}
            className={cn('ep-bottomnav-tab', active && 'active')}
            aria-current={active ? 'page' : undefined}
            aria-label={tab.label}
          >
            <Icon className="ep-bottomnav-ico" aria-hidden="true" />
            <span className="ep-bottomnav-label">{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
