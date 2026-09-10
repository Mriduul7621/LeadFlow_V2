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
import { useTranslation, type TranslationKey } from '../../shared/utils/translations';

const CATEGORY_CONFIG: Record<ActivityCategory, { labelKey: TranslationKey; icon: any; color: string }> = {
  Today: { labelKey: 'categoryToday', icon: Calendar, color: 'text-[#978C21] bg-[#978C21]/10' },
  Tomorrow: { labelKey: 'categoryTomorrow', icon: Clock, color: 'text-blue-600 bg-blue-50' },
  Upcoming: { labelKey: 'categoryUpcoming', icon: Clock, color: 'text-slate-500 bg-slate-100' },
  Overdue: { labelKey: 'categoryOverdue', icon: AlertTriangle, color: 'text-amber-600 bg-amber-50' },
  Missed: { labelKey: 'categoryMissed', icon: AlertTriangle, color: 'text-red-600 bg-red-50' },
  Completed: { labelKey: 'categoryCompleted', icon: CheckCircle2, color: 'text-emerald-600 bg-emerald-50' },
};

const TYPE_LABELS: Record<Activity['type'], TranslationKey> = {
  'Follow-up': 'typeFollowUp',
  'Call': 'typeCall',
  'Meeting': 'typeMeeting',
};

const TYPE_ICON: Record<Activity['type'], any> = {
  'Follow-up': Clock,
  'Call': Phone,
  'Meeting': MeetingIcon,
};

export default function Activities() {
  const { user } = useAuthStore();
  const { t } = useTranslation();
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
    <div className="p-6 md:p-10 max-w-6xl mx-auto space-y-8">
      <div>
        <h1 className="text-xl font-bold text-slate-800">{t('activitiesTitle')}</h1>
        <p className="text-[11px] text-slate-400 uppercase tracking-widest mt-1">
          {t('activitiesSubtitle')}
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
              onClick={() => setActiveCategory(cat)}
              className={cn(
                "p-4 rounded-sm border text-left transition-all",
                activeCategory === cat ? "border-[#978C21] bg-white shadow-md" : "border-slate-100 bg-slate-50 hover:bg-white"
              )}
            >
              <div className={cn("w-8 h-8 rounded-sm flex items-center justify-center mb-3", config.color)}>
                <Icon className="w-4 h-4" />
              </div>
              <p className="text-xs font-medium text-slate-500">{t(config.labelKey)}</p>
              <p className="text-[22px] font-black text-brand-text">{count}</p>
            </button>
          );
        })}
      </div>

      <div className="bg-white rounded-sm border border-slate-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-50 bg-[#FBFAF8]">
          <h3 className="text-sm font-semibold text-slate-700">{t(CATEGORY_CONFIG[activeCategory].labelKey)} ({grouped[activeCategory].length})</h3>
        </div>
        <div className="divide-y divide-slate-50">
          {loading ? (
            <div className="p-10 text-center text-[11px] text-slate-300 uppercase tracking-widest italic">{t('loadingActivities')}</div>
          ) : grouped[activeCategory].length === 0 ? (
            <div className="p-10 text-center text-[11px] text-slate-300 uppercase tracking-widest italic">{t('nothingHere')}</div>
          ) : (
            grouped[activeCategory].map(activity => {
              const TypeIcon = TYPE_ICON[activity.type];
              return (
                <motion.div
                  key={activity.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  onClick={() => navigate(`/leads/${activity.leadId}`)}
                  className="px-6 py-4 flex items-center justify-between gap-4 hover:bg-slate-50 cursor-pointer transition-all group"
                >
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="w-9 h-9 rounded-sm bg-slate-50 border border-slate-100 flex items-center justify-center shrink-0">
                      <TypeIcon className="w-4 h-4 text-slate-400" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-800 truncate">{activity.prospectName}</p>
                      <p className="text-[10px] text-slate-400 uppercase tracking-widest">{t(TYPE_LABELS[activity.type])} &middot; {new Date(activity.dueDate).toLocaleDateString()}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className={cn("px-2 py-1 rounded-sm text-[9px] font-black uppercase tracking-widest border", getLeadStatusColorClasses(activity.status))}>
                      {activity.status}
                    </span>
                    <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-[#978C21] transition-all" />
                  </div>
                </motion.div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
