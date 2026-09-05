import React, { useEffect, useState } from 'react';
import { 
  ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, AreaChart, Area
} from 'recharts';
import { 
  TrendingUp, Calendar as CalendarIcon, RefreshCw, LayoutDashboard, Search, Zap
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useAuthStore } from '../store/authStore';
import { UserRole, Lead } from '../types';
import { leadService } from '../services/leadService';
import { toast } from 'sonner';

export default function TrendCharts() {
  const { user } = useAuthStore();
  const [period, setPeriod] = useState('THIS MONTH');
  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().substring(0, 10));
  const [customDates, setCustomDates] = useState({ 
    start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0]
  });
  const [loading, setLoading] = useState(true);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [trendData, setTrendData] = useState<{ date: string; value: number }[]>([]);
  const [summaryStats, setSummaryStats] = useState({
    totalLeads: 0,
    velocity: '0.0 / day',
    peakInterval: 'N/A'
  });

  const loadData = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const allLeads = await leadService.getLeads({ 
        employeeId: user.employeeId, 
        role: user.role
      });

      // Daily ranges
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

      // Trend generation hourly / daily breakdown
      let calculatedTrend: { date: string; value: number }[] = [];
      const diffTime = Math.abs(endDate.getTime() - startDate.getTime());
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      let peakIntervalText = 'N/A';
      let peakCount = -1;

      if (period === 'TODAY' || diffDays <= 1) {
        // Hourly breakdown
        const hours = [
          { label: '09:00', start: 0, end: 9 },
          { label: '12:00', start: 9, end: 12 },
          { label: '15:00', start: 12, end: 15 },
          { label: '18:00', start: 15, end: 18 },
          { label: '21:00', start: 18, end: 21 },
          { label: '24:00', start: 21, end: 24 }
        ];
        calculatedTrend = hours.map(h => {
          const count = filteredLeads.filter(l => {
            const hr = new Date(l.timestamp).getHours();
            return hr >= h.start && hr < h.end;
          }).length;
          if (count > peakCount) {
             peakCount = count;
             peakIntervalText = `${h.label} interval`;
          }
          return { date: h.label, value: count };
        });
      } else {
        // Multi-day breakdown (max 7-8 intervals to look beautiful)
        const pointCount = Math.min(diffDays, 7);
        const intervalMs = diffTime / pointCount;

        for (let i = 0; i < pointCount; i++) {
          const pointStart = new Date(startDate.getTime() + i * intervalMs);
          const pointEnd = new Date(startDate.getTime() + (i + 1) * intervalMs);
          
          const label = pointEnd.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
          const count = filteredLeads.filter(l => {
            const leadDate = new Date(l.timestamp);
            return leadDate >= pointStart && leadDate <= pointEnd;
          }).length;

          if (count > peakCount) {
             peakCount = count;
             peakIntervalText = label;
          }

          calculatedTrend.push({ date: label, value: count });
        }
      }

      setTrendData(calculatedTrend);

      // Velocity metrics
      const calculatedDays = diffDays > 0 ? diffDays : 1;
      const velocityText = (filteredLeads.length / calculatedDays).toFixed(1) + ' leads / day';

      setSummaryStats({
        totalLeads: filteredLeads.length,
        velocity: velocityText,
        peakInterval: peakIntervalText
      });

    } catch (err) {
      toast.error('Trend charts data calculation failure');
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
    <div className="space-y-8 pb-24 bg-white font-sans animate-fade-in text-slate-800">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-slate-100 pb-8">
        <div>
          <h1 className="text-4xl font-black tracking-tighter text-brand-text italic uppercase leading-none">Trend Progression Curves</h1>
          <p className="text-slate-400 font-bold text-[10px] uppercase tracking-[0.3em] mt-3 italic">Leads generation velocities, peak times and load maps</p>
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

      {/* Period Selection Controls */}
      <div className="bg-[#3C3C3C] p-6 rounded-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
           <div className="w-8 h-8 rounded bg-white/5 flex items-center justify-center">
              <TrendingUp className="w-4 h-4 text-[#978C21]" />
           </div>
           <div>
              <h4 className="text-white text-[12px] font-black uppercase tracking-[0.2em] italic">Generation timeline charts</h4>
              <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">Timeline velocity tracking scope</p>
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
        <div className="space-y-6">
          {/* Main Chart Area */}
          <div className="bg-white rounded-sm border border-slate-100 p-8 md:p-10 shadow-sm">
             <p className="text-[11px] font-black text-slate-400 uppercase tracking-widest text-center italic mb-8">Campaign lead generation Trend line</p>
             <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                   <AreaChart data={trendData}>
                      <defs>
                        <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#978C21" stopOpacity={0.15}/>
                          <stop offset="95%" stopColor="#978C21" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f8fafc" />
                      <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#cbd5e1', fontWeight: 800, fontStyle: 'italic' }} dy={15} />
                      <YAxis 
                         axisLine={false}
                         tickLine={false}
                         tick={{ fontSize: 10, fill: '#cbd5e1', fontWeight: 800 }}
                      />
                      <Tooltip 
                        contentStyle={{ borderRadius: '4px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)', fontSize: '10px', fontWeight: '900' }}
                      />
                      <Area type="monotone" dataKey="value" stroke="#978C21" strokeWidth={4} fillOpacity={1} fill="url(#colorValue)" dot={{ fill: '#978C21', strokeWidth: 3, r: 6, stroke: '#fff' }} name="Leads Count" />
                   </AreaChart>
                </ResponsiveContainer>
             </div>
             <p className="text-[10px] font-black text-slate-300 uppercase tracking-widest text-center italic mt-10">Daily lead creation count</p>
          </div>

          {/* Trend Summary Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
             <div className="bg-slate-50 border border-slate-100 p-6 rounded-sm text-center">
                <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-3 italic">Total Processed Leads</p>
                <h4 className="text-3xl font-black text-slate-900 italic leading-none">{summaryStats.totalLeads}</h4>
             </div>
             <div className="bg-slate-50 border border-slate-100 p-6 rounded-sm text-center">
                <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-3 italic">Generation Velocity</p>
                <h4 className="text-2xl font-black text-[#978C21] italic leading-none">{summaryStats.velocity}</h4>
             </div>
             <div className="bg-[#2D2D2D] text-white p-6 rounded-sm text-center">
                <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-3 italic">Peak Performance Point</p>
                <h4 className="text-2xl font-black text-[#10B981] italic leading-none uppercase">{summaryStats.peakInterval}</h4>
             </div>
          </div>
        </div>
      )}
    </div>
  );
}
