import React, { useEffect, useState } from 'react';
import { 
  ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, AreaChart, Area
} from 'recharts';
import { 
  TrendingUp, Calendar as CalendarIcon, RefreshCw, LayoutDashboard, CheckCircle, Search, Download
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useAuthStore } from '../store/authStore';
import { UserRole, Lead } from '../types';
import { leadService } from '../services/leadService';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';

export default function NcpProgress() {
  const { user } = useAuthStore();
  const [period, setPeriod] = useState('THIS MONTH');
  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().substring(0, 10));
  const [customDates, setCustomDates] = useState({ 
    start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0]
  });
  const [loading, setLoading] = useState(true);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [stats, setStats] = useState({
    collected: 0,
    projected: 0,
    conversionRate: '0.0%',
    avgResponseTAT: '24.0h',
    activeLeads: 0
  });

  const loadData = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const allLeads = await leadService.getLeads({ 
        employeeId: user.employeeId, 
        role: user.role
      });
      
      // Determine date ranges
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

      const collectedTotal = filteredLeads.reduce((acc, curr) => acc + (curr.collectedNCP || 0), 0);
      const projectedTotal = filteredLeads.reduce((acc, curr) => acc + (curr.projectedNCP || 0), 0);

      // Turnaround time (TAT) calculation
      let totalTatMs = 0;
      let targetTatLeads = 0;
      filteredLeads.forEach(l => {
        if (l.currentStatus !== 'Untouched') {
          const birthTime = new Date(l.timestamp || l.creationDate).getTime();
          let reactionTime = 0;
          if (l.statusHistory && l.statusHistory.length > 0) {
            const validTimes = l.statusHistory
              .map(h => new Date(h.date).getTime())
              .filter(t => !isNaN(t));
            if (validTimes.length > 0) {
              reactionTime = Math.min(...validTimes);
            }
          }
          if (reactionTime > birthTime) {
            totalTatMs += (reactionTime - birthTime);
            targetTatLeads++;
          }
        }
      });
      const tatVal = targetTatLeads > 0 
        ? (totalTatMs / (1000 * 60 * 60 * targetTatLeads)).toFixed(1) + 'h' 
        : '24.0h';

      const activeLeadsCount = filteredLeads.filter(l => l.currentStatus !== 'Converted' && l.currentStatus !== 'Not Interested').length;
      const convertedCount = filteredLeads.filter(l => l.currentStatus === 'Converted').length;
      const conversionRateVal = filteredLeads.length > 0
        ? ((convertedCount / filteredLeads.length) * 100).toFixed(1) + '%'
        : '0.0%';

      setStats({
        collected: collectedTotal,
        projected: projectedTotal,
        conversionRate: conversionRateVal,
        avgResponseTAT: tatVal,
        activeLeads: activeLeadsCount
      });

    } catch (err) {
      toast.error('NCP progress retrieval failure');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [period, selectedDate, customDates]);

  const ncpTrackingData = [
    { name: 'Week 1', Collected: Math.round(stats.collected * 0.25), Projected: Math.round(stats.projected * 0.25) },
    { name: 'Week 2', Collected: Math.round(stats.collected * 0.55), Projected: Math.round(stats.projected * 0.50) },
    { name: 'Week 3', Collected: Math.round(stats.collected * 0.80), Projected: Math.round(stats.projected * 0.80) },
    { name: 'Week 4', Collected: stats.collected, Projected: stats.projected },
  ];

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

  const handleExportNcpLeads = () => {
    const data = leads.map(l => ({
      'Client Name': l.prospectName,
      'Area': l.area,
      'Product': l.productName,
      'Campaign': l.campaignName,
      'Collected NCP': l.collectedNCP,
      'Projected NCP': l.projectedNCP,
      'Status': l.currentStatus,
    }));
    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "NCP_Ledger");
    XLSX.writeFile(workbook, `NCP_Progress_Ledger_${period}.xlsx`);
    toast.success("NCP Ledger downloaded successfully!");
  };

  return (
    <div className="space-y-8 pb-24 bg-white font-sans">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-slate-100 pb-8">
        <div>
          <h1 className="text-4xl font-black tracking-tighter text-brand-text italic uppercase leading-none">NCP Progress Matrix</h1>
          <p className="text-slate-400 font-bold text-[10px] uppercase tracking-[0.3em] mt-3 italic">Volume Velocity, collected BDT metrics and conversions</p>
        </div>
        <div className="flex items-center gap-3 animate-fade-in">
          <button 
            onClick={loadData}
            className="p-3 border border-slate-100 rounded-sm hover:text-[#978C21] hover:bg-slate-50 transition-all shadow-sm"
          >
            <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      {/* Period Select Bar */}
      <div className="bg-[#3C3C3C] p-6 rounded-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3 animate-pulse-slow">
           <div className="w-8 h-8 rounded bg-white/5 flex items-center justify-center">
              <TrendingUp className="w-4 h-4 text-[#10B981]" />
           </div>
           <div>
              <h4 className="text-white text-[12px] font-black uppercase tracking-[0.2em] italic">Progression Velocity</h4>
              <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">NCP tracking status range</p>
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
        <div className="bg-slate-50 px-6 py-4 border border-slate-100 rounded-sm flex items-center gap-4 animate-fade-in">
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
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 px-1">
          {/* Main Chart Card */}
          <div className="lg:col-span-3 bg-white rounded-sm border border-slate-100 p-8 md:p-10 shadow-sm">
             <div className="flex flex-col md:flex-row md:items-start justify-between gap-8 mb-8">
                <div>
                   <h4 className="text-[20px] font-black text-brand-text tracking-tighter italic leading-tight uppercase">Financial Target Tracking</h4>
                   <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-2 ml-0.5">Collected BDT vs Projected Potential</p>
                </div>
                <div className="text-right border-l-0 md:border-l md:pl-6 border-slate-100 flex flex-row md:flex-col gap-4 md:gap-2 justify-between items-end">
                   <div>
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1 italic">Collected NCP</p>
                      <h3 className="text-2xl md:text-3xl font-black text-[#978C21] italic tracking-tighter leading-none">৳{stats.collected.toLocaleString()}</h3>
                   </div>
                   <div>
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1 italic">Projected NCP</p>
                      <h4 className="text-lg md:text-xl font-black text-slate-500 italic tracking-tighter leading-none">৳{stats.projected.toLocaleString()}</h4>
                   </div>
                   <p className="text-[11px] font-black text-[#978C21] mt-1 italic flex items-center gap-1">
                      <TrendingUp className="w-3.5 h-3.5" /> 
                      {stats.projected > 0 ? ((stats.collected / stats.projected) * 100).toFixed(1) : 0}% of Potential
                   </p>
                </div>
             </div>

             {/* Dynamic tracking area chart */}
             <div className="h-56 w-full border-t border-b border-slate-50 py-4 my-6">
                <ResponsiveContainer width="100%" height="100%">
                   <AreaChart data={ncpTrackingData}>
                      <defs>
                        <linearGradient id="colorCollected" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10B981" stopOpacity={0.15}/>
                          <stop offset="95%" stopColor="#10B981" stopOpacity={0}/>
                        </linearGradient>
                        <linearGradient id="colorProjected" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#978C21" stopOpacity={0.15}/>
                          <stop offset="95%" stopColor="#978C21" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f8fafc" vertical={false} />
                      <XAxis 
                        dataKey="name" 
                        axisLine={false} 
                        tickLine={false} 
                        tick={{ fontSize: 9, fill: '#64748b', fontWeight: 800, fontStyle: 'italic' }} 
                      />
                      <YAxis 
                        axisLine={false} 
                        tickLine={false} 
                        tick={{ fontSize: 9, fill: '#cbd5e1', fontWeight: 700 }}
                        tickFormatter={(v) => `৳${(v / 1000).toFixed(0)}k`}
                      />
                      <Tooltip 
                        formatter={(value: any) => [`৳${value.toLocaleString()}`, '']}
                        contentStyle={{ borderRadius: '4px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)', fontSize: '11px', fontWeight: '800' }}
                      />
                      <Area type="monotone" dataKey="Collected" stroke="#10B981" strokeWidth={3} fillOpacity={1} fill="url(#colorCollected)" name="Collected" />
                      <Area type="monotone" dataKey="Projected" stroke="#978C21" strokeWidth={2} strokeDasharray="4 4" fillOpacity={1} fill="url(#colorProjected)" name="Projected" />
                   </AreaChart>
                </ResponsiveContainer>
             </div>

             <div className="grid grid-cols-3 gap-2 mt-6 border-t border-slate-50 pt-6">
                <div>
                   <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1.5 italic">Conversion</p>
                   <h4 className="text-xl md:text-2xl font-black text-brand-blue italic leading-none">{stats.conversionRate}</h4>
                </div>
                <div>
                   <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1.5 italic">Response TAT</p>
                   <h4 className="text-xl md:text-2xl font-black text-slate-800 italic leading-none">{stats.avgResponseTAT}</h4>
                </div>
                <div>
                   <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1.5 italic">Active Leads</p>
                   <h4 className="text-xl md:text-2xl font-black text-slate-800 italic leading-none">{stats.activeLeads}</h4>
                </div>
             </div>
          </div>

          {/* Quick Stats sidebar details */}
          <div className="flex flex-col gap-6 justify-between">
             <div className="flex-1 bg-[#1A1A1A] text-white p-6 rounded-sm border border-slate-800 flex flex-col justify-between shadow-md">
                 <div>
                    <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest italic block mb-3">Collected Segment (Finalized)</span>
                    <h3 className="text-3xl font-black text-[#978C21] italic tracking-tighter leading-tight break-all">৳{stats.collected.toLocaleString()}</h3>
                 </div>
                 <div className="text-right text-[9px] font-bold text-slate-500 uppercase mt-4">NCP extracted ledger</div>
             </div>
             <div className="flex-1 bg-[#FBFAF8] p-6 rounded-sm border border-slate-100 flex flex-col justify-between shadow-sm">
                 <div>
                    <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest italic block mb-3">Projected Segment (Potential)</span>
                    <h3 className="text-3xl font-black text-slate-800 italic tracking-tighter leading-tight break-all">৳{stats.projected.toLocaleString()}</h3>
                 </div>
                 <div className="text-right text-[9px] font-bold text-[#978C21] uppercase mt-4">Pipeline locked BDT potential</div>
             </div>
          </div>
        </div>
      )}

      {/* Leads Ledger Table */}
      {!loading && (
        <div className="bg-white rounded-sm border border-slate-100 overflow-hidden shadow-sm mt-8 mx-1">
           <div className="px-8 py-6 border-b border-slate-50 flex items-center justify-between">
              <div>
                 <h4 className="text-[12px] font-black uppercase text-brand-text tracking-widest italic">NCP Registry Ledger</h4>
                 <p className="text-[8px] tracking-widest text-slate-400 uppercase font-bold mt-1">Direct individual clients progression lines</p>
              </div>
              <button 
                onClick={handleExportNcpLeads}
                className="flex items-center gap-2 border border-slate-100 bg-white hover:bg-slate-50 px-4 py-2 my-1 text-[10px] uppercase font-black tracking-wider shadow-sm transition-all text-[#978C21]"
              >
                <Download className="w-3.5 h-3.5" />
                Export ledger
              </button>
           </div>
           <div className="overflow-x-auto">
              <table className="w-full text-left">
                 <thead className="bg-[#FBFAF8] text-[8px] font-black text-slate-500 uppercase tracking-widest border-b border-slate-100">
                    <tr>
                       <th className="px-8 py-4">Client Prospect</th>
                       <th className="px-6 py-4">Area Location</th>
                       <th className="px-6 py-4 text-center">Campaign Name</th>
                       <th className="px-6 py-4 text-center">Product Choice</th>
                       <th className="px-6 py-4 text-center">Projected NCP</th>
                       <th className="px-6 py-4 text-center text-[#10B981]">Collected NCP</th>
                       <th className="px-6 py-4 text-center">NCP Status Line</th>
                    </tr>
                 </thead>
                 <tbody className="divide-y divide-slate-50 italic text-[11px] text-slate-600 font-medium">
                    {leads.length === 0 ? (
                       <tr>
                          <td colSpan={7} className="text-center py-10 text-slate-450 font-bold uppercase tracking-widest text-[9px] italic">
                             No NCP progress lines matched for this period scope
                          </td>
                       </tr>
                    ) : (
                      leads.slice(0, 15).map((l, index) => (
                         <tr key={l.id || index} className="hover:bg-slate-50/50 transition-colors">
                            <td className="px-8 py-4 font-black uppercase text-slate-800 not-italic">{l.prospectName}</td>
                            <td className="px-6 py-4 text-slate-450">{l.area}</td>
                            <td className="px-6 py-4 text-center text-slate-500">{l.campaignName}</td>
                            <td className="px-6 py-4 text-center text-slate-500">{l.productName}</td>
                            <td className="px-6 py-4 text-center font-bold text-slate-700">৳{(l.projectedNCP || 0).toLocaleString()}</td>
                            <td className="px-6 py-4 text-center font-black text-[#10B981]">৳{(l.collectedNCP || 0).toLocaleString()}</td>
                            <td className="px-6 py-4 text-center col-span-1">
                               <span className="px-2.5 py-1 bg-slate-100 rounded text-[8px] font-black uppercase text-slate-600">
                                  {l.currentStatus}
                                </span>
                            </td>
                         </tr>
                      ))
                    )}
                 </tbody>
              </table>
           </div>
        </div>
      )}
    </div>
  );
}
