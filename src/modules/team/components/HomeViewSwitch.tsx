import { useNavigate } from 'react-router-dom';
import { User, Users } from 'lucide-react';
import { useAuthStore } from '../../auth/store/authStore';
import {
  setHomeViewPreference,
  type HomeViewPreference,
} from '../../auth/services/homeLanding';
import { cn } from '../../../lib/utils';

/**
 * HomeViewSwitch — the Team / My-work toggle (TL+ Home)
 * ------------------------------------------------------------------
 * One control, two homes, shown only to people who HAVE a team:
 * rendered by the team home (active = Team) and by the Daily
 * Workbench (active = My work). The choice is recorded in the
 * session-scoped home-view preference (see homeLanding.ts), so the
 * root landing honours it for the rest of the session:
 *
 *   Team    -> preference 'team', go to `/` (the team-first home)
 *   My work -> preference 'work', go to `/workbench` (My Day)
 *
 * Clicking the already-active side is a no-op.
 */
export default function HomeViewSwitch({ active }: { active: HomeViewPreference }) {
  const userId = useAuthStore(state => state.user?.id);
  const navigate = useNavigate();

  const choose = (view: HomeViewPreference) => {
    if (view === active) return;
    if (userId) setHomeViewPreference(userId, view);
    navigate(view === 'team' ? '/' : '/workbench');
  };

  const buttonClass = (view: HomeViewPreference) =>
    cn(
      'flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[11px] font-black uppercase tracking-widest transition-colors',
      active === view ? 'bg-[#3C3C3B] text-white' : 'text-stone-500 hover:text-stone-800'
    );

  return (
    <div
      className="inline-flex items-center gap-1 bg-white border border-stone-200 rounded-full p-1"
      role="group"
      aria-label="Home view"
    >
      <button type="button" className={buttonClass('team')} onClick={() => choose('team')} aria-pressed={active === 'team'}>
        <Users className="w-3.5 h-3.5" /> Team
      </button>
      <button type="button" className={buttonClass('work')} onClick={() => choose('work')} aria-pressed={active === 'work'}>
        <User className="w-3.5 h-3.5" /> My work
      </button>
    </div>
  );
}
