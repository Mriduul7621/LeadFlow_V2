import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Calendar, Phone, Users as MeetingIcon, Clock, AlertTriangle, CheckCircle2, ChevronRight } from 'lucide-react';
import { motion } from 'framer-motion';
import { cn } from '../../../lib/utils';
import { useAuthStore } from '../../auth/store/authStore';
import { leadService } from '../services/leadService';
import { Lead } from '../../shared/types';
import { buildActivities, groupByCategory, ActivityCategory, Activity } from '../utils/activityEngine';
import { getLeadStatusColorClasses } from '../../workflow/utils/leadStatusMeta';
import BackButton from '../../shared/components/BackButton';

const CATEGORY_CONFIG: Record<ActivityCategory, { label: string; icon: any; color: string }> = {
  Today: { label: 'Today', icon: Calendar, color: 'text-[#978C21] bg-[#978C21]/10' },
  Tomorrow: { label: 'Tomorrow', icon: Clock, color: 'text-blue-600 bg-blue-50' },
  Upcoming: { label: 'Upcoming', icon: Clock, color: 'text-slate-500 bg-slate-100' },
  Overdue: { label: 'Overdue', icon: AlertTriangle, color: 'text-amber-600 bg-amber-50' },
  Missed: { label: 'Missed', icon: AlertTriangle, color: 'text-red-600 bg-red-50' },
  Completed: { label: 'Completed', icon: CheckCircle2, color: 'text-emerald-600 bg-emerald-50' },
};

const TYPE_ICON: Record<Activity['type'], any> = {
  'Follow-up': Clock,
  'Call': Phone,
  'Meeting': MeetingIcon,
};

export default function Activities() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState<ActivityCategory>('Today');

  useEffect(() => {
    const load = async () => {
      if (!user) return;
      setLoading(true);
      try {
        const allLeads = await leadService.getLeads({ employeeId: user.employeeId, role: user.role });
        setLeads(allLeads);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [user]);

  const activities = useMemo(() => buildActivities(leads), [leads]);
  const grouped = useMemo(() => groupByCategory(activities), [activities]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6 lg:p-8">
      <BackButton fallback="/" />
      <div>
        <h1 className="text-xl font-bold text-slate-800">Activities</h1>
        <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-500 sm:text-sm">
          Every pending follow-up, call, and meeting across your visible leads, organized by urgency.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {(Object.keys(CATEGORY_CONFIG) as ActivityCategory[]).map(cat => {
          const config = CATEGORY_CONFIG[cat];
          const Icon = config.icon;
          const count = grouped[cat].length;
          return (
            <button
              key={cat}
              type="button"
              aria-pressed={activeCategory === cat}
              onClick={() => setActiveCategory(cat)}
              className={cn(
                "min-h-[112px] rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#978C21] focus-visible:ring-offset-2",
                activeCategory === cat ? "border-[#978C21] bg-white shadow-md" : "border-slate-100 bg-slate-50 hover:bg-white"
              )}
            >
              <div className={cn("w-8 h-8 rounded-sm flex items-center justify-center mb-3", config.color)}>
                <Icon className="w-4 h-4" />
              </div>
              <p className="text-xs font-medium text-slate-500">{config.label}</p>
              <p className="text-[22px] font-black text-brand-text">{count}</p>
            </button>
          );
        })}
      </div>

      <div className="overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">
        <div className="border-b border-stone-100 bg-[#FFFCF8] px-4 py-4 sm:px-5">
          <h3 className="text-sm font-semibold text-slate-700">{CATEGORY_CONFIG[activeCategory].label} ({grouped[activeCategory].length})</h3>
        </div>
        <div className="divide-y divide-stone-100">
          {loading ? (
            <div className="p-10 text-center text-[11px] text-slate-300 uppercase tracking-widest italic">Loading activities...</div>
          ) : grouped[activeCategory].length === 0 ? (
            <div className="p-10 text-center text-[11px] text-slate-300 uppercase tracking-widest italic">Nothing here</div>
          ) : (
            grouped[activeCategory].map(activity => {
              const TypeIcon = TYPE_ICON[activity.type];
              return (
                <motion.button
                  type="button"
                  key={activity.id}
                  aria-label={`Open ${activity.type} for ${activity.prospectName}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  onClick={() => navigate(`/leads/${activity.leadId}`)}
                  className="group flex min-h-[76px] w-full items-center justify-between gap-3 px-4 py-4 text-left transition-colors hover:bg-[#FFFCF8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#978C21] sm:gap-4 sm:px-5"
                >
                  <div className="flex min-w-0 items-center gap-3 sm:gap-4">
                    <div className="w-9 h-9 rounded-sm bg-slate-50 border border-slate-100 flex items-center justify-center shrink-0">
                      <TypeIcon className="w-4 h-4 text-slate-400" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-800 truncate">{activity.prospectName}</p>
                      <p className="text-[10px] text-slate-400 uppercase tracking-widest">{activity.type} &middot; {new Date(activity.dueDate).toLocaleDateString()}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 sm:gap-3">
                    <span className={cn("px-2 py-1 rounded-sm text-[9px] font-black uppercase tracking-widest border", getLeadStatusColorClasses(activity.status))}>
                      {activity.status}
                    </span>
                    <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-[#978C21] transition-all" />
                  </div>
                </motion.button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
