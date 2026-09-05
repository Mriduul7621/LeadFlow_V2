import React, { useEffect, useState } from 'react';
import { 
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip
} from 'recharts';
import { 
  Database, Calendar as CalendarIcon, RefreshCw, LayoutDashboard, Filter, ChevronRight
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useAuthStore } from '../store/authStore';
import { UserRole, Lead } from '../types';
import { leadService } from '../services/leadService';
import { toast } from 'sonner';

export default function CampaignBreakdown() {
  const { user } = useAuthStore();
  const [period, setPeriod] = useState('THIS MONTH');
  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().substring(0, 10));
  const [customDates, setCustomDates] = useState({ 
    start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0]
  });
  const [loading, setLoading] = useState(true);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [campaignStats, setCampaignStats] = useState<any[]>([]);
  const [grandTotal, setGrandTotal] = useState(0);

  const loadData = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const allLeads = await leadService.getLeads({ 
        employeeId: user.employeeId, 
        role: user.role
      });

      // Date ranges
      let startDate = new Date(0);
      let endDate = new Date();
      const now = new Date();

      if (period === 'TODAY') {
        startDate = new Date(selectedDate + 'T00:00:00');
        endDate = new Date(selectedDate + 'T23:59:59.999');
      } else if (period === 'THIS MONTH') {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      } else if (period === 'LAST MONTH') {
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      } else if (period === 'CUSTOM') {
        startDate = new Date(customDates.start);
        endDate = new Date(customDates.end);
        endDate.setHours(23, 59, 59, 999);
      }

      // Filter leads by date & role
      let filteredLeads = allLeads.filter(l => {
        const leadDate = new Date(l.timestamp);
        return leadDate >= startDate && leadDate <= endDate;
      });

      if (user.role === UserRole.RO) {
        filteredLeads = filteredLeads.filter(l => l.assignedTo === user.employeeId);
      }

      setLeads(filteredLeads);
      setGrandTotal(filteredLeads.length);

      // Call status breakdown
      const statuses = [
        'Untouched', 'Interested', 'Follow-up Set', 'No Response', 'Not Interested', 
        'Meeting Fixed', 'Meeting Completed', 'Converted', 'Pipeline Locked'
      ];
      const colors = ['#e2e8f0', '#0F172A', '#334155', '#64748B', '#94A3B8', '#1E293B', '#CBD5E1', '#978C21', '#475569'];
      
      const breakdown = statuses.map((status, i) => ({
        name: status,
        value: filteredLeads.filter(l => l.currentStatus === status).length,
        color: colors[i]
      }));

      setCampaignStats(breakdown.filter(item => item.value > 0 || true));

    } catch (err) {
      toast.error('Campaign breakdown calculations failure.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [period, selectedDate, customDates]);

  const formattedDateRange = () => {
    const now = new Date();
    if (period === 'TODAY') return new Date(selectedDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    if (period === 'THIS MONTH') return `1 ${now.toLocaleDateString('en-GB', { month: 'short' })} - ${now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    if (period === 'LAST MONTH') {
       const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
       const lastDay = new Date(now.getFullYear(), now.getMonth(), 0);
       return `${lastMonth.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} - ${lastDay.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    }
    if (period === 'CUSTOM') {
       return `${new Date(customDates.start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} - ${new Date(customDates.end).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    }
    return '';
  };

  return (
    <div className="space-y-8 pb-24 bg-white font-sans text-slate-800 animate-fade-in">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-slate-100 pb-8">
        <div>
          <h1 className="text-4xl font-black tracking-tighter text-brand-text italic uppercase leading-none">Campaign breakdown</h1>
          <p className="text-slate-400 font-bold text-[10px] uppercase tracking-[0.3em] mt-3 italic">Campaign distributions, statuses, conversion rates and shares</p>
        </div>
        <div className="flex items-center gap-3">
          <button 
            onClick={loadData}
            className="p-3 border border-slate-100 rounded-sm hover:text-[#978C21] hover:bg-slate-50 transition-all shadow-sm"
          >
            <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      {/* Period Selection */}
      <div className="bg-[#3C3C3C] p-6 rounded-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
           <div className="w-8 h-8 rounded bg-white/5 flex items-center justify-center">
              <Database className="w-5 h-5 text-[#978C21]" />
           </div>
           <div>
              <h4 className="text-white text-[12px] font-black uppercase tracking-[0.2em] italic">Campaign performance distribution</h4>
              <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">Campaign details reporting scope</p>
           </div>
        </div>
        <div className="flex items-center flex-wrap gap-1 bg-white/5 p-1 rounded-sm">
           {['TODAY', 'THIS MONTH', 'LAST MONTH', 'CUSTOM'].map(p => (
             <button 
               key={p}
               onClick={() => setPeriod(p)}
               className={cn(
                 "px-4 py-1.5 text-[9px] font-black uppercase tracking-widest rounded-sm transition-all",
                 period === p ? "bg-white text-brand-text" : "text-slate-400 hover:text-white"
               )}
             >
               {p}
             </button>
           ))}
           <div className="hidden md:block h-6 w-px bg-white/10 mx-2" />
           <div className="flex items-center gap-2 px-2">
              <CalendarIcon className="w-3 h-3 text-slate-400" />
              <span className="text-[9px] font-black text-slate-400 uppercase">{formattedDateRange()}</span>
           </div>
        </div>
      </div>

      {period === 'CUSTOM' && (
        <div className="bg-slate-50 px-6 py-4 border border-slate-100 rounded-sm flex items-center gap-4">
           <div className="flex items-center gap-2">
              <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Start Date:</span>
              <input 
                type="date" 
                value={customDates.start}
                onChange={(e) => setCustomDates({ ...customDates, start: e.target.value })}
                className="bg-white border border-slate-200 rounded-sm px-2 py-1 text-[10px] font-black uppercase outline-none focus:border-[#978C21]"
              />
           </div>
           <div className="flex items-center gap-2">
              <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">End Date:</span>
              <input 
                type="date" 
                value={customDates.end}
                onChange={(e) => setCustomDates({ ...customDates, end: e.target.value })}
                className="bg-white border border-slate-200 rounded-sm px-2 py-1 text-[10px] font-black uppercase outline-none focus:border-[#978C21]"
              />
           </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center items-center py-24">
          <div className="w-12 h-12 border-4 border-slate-100 border-t-[#978C21] rounded-full animate-spin"></div>
        </div>
      ) : (
        <div className="bg-white rounded-sm border border-slate-100 p-8 md:p-10 shadow-sm">
           <div className="flex flex-col lg:flex-row items-center justify-between gap-16">
              {/* Left Side: Interactive Pie Chart Dial */}
              <div className="h-80 w-80 relative flex-shrink-0 flex items-center justify-center">
                 <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                       <Pie
                          data={campaignStats}
                          cx="50%"
                          cy="50%"
                          innerRadius={105}
                          outerRadius={135}
                          paddingAngle={3}
                          dataKey="value"
                       >
                          {campaignStats.map((entry, index) => (
                             <Cell key={`cell-${index}`} fill={entry.color} />
                          ))}
                       </Pie>
                       <Tooltip />
                    </PieChart>
                 </ResponsiveContainer>
                 <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <span className="text-5xl font-black italic tracking-tighter text-brand-text leading-none">{grandTotal}</span>
                    <span className="text-[9px] text-slate-400 uppercase font-black tracking-widest mt-2 block">TOTAL LEADS</span>
                 </div>
              </div>

              {/* Right Side: Legend breakout list */}
              <div className="w-full flex-1 max-w-xl">
                 <div className="flex justify-between border-b border-slate-100 pb-3 mb-6">
                    <p className="text-[11px] font-black text-slate-400 uppercase italic">Call Status Group</p>
                    <p className="text-[11px] font-black text-slate-400 uppercase italic">Distribution Volume</p>
                 </div>
                 <div className="space-y-1.5 max-h-[45vh] overflow-y-auto pr-2">
                    {campaignStats.map((item, i) => (
                       <div key={i} className="flex items-center justify-between group cursor-pointer hover:bg-slate-50 px-3 py-2 rounded transition-all">
                          <div className="flex items-center gap-3">
                             <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} />
                             <p className="text-[11px] font-bold text-slate-600 uppercase tracking-tight italic group-hover:text-primary">{item.name}</p>
                          </div>
                          <p className="text-[13px] font-black text-brand-text italic">{item.value}</p>
                       </div>
                    ))}
                    <div className="flex items-center justify-between border-t border-slate-100 pt-6 mt-6">
                       <p className="text-[12px] font-black text-brand-text uppercase tracking-widest italic opacity-40">Grand Total sum</p>
                       <h5 className="text-[18px] font-black text-brand-text italic leading-none">{grandTotal}</h5>
                    </div>
                 </div>
              </div>
           </div>
        </div>
      )}
    </div>
  );
}
