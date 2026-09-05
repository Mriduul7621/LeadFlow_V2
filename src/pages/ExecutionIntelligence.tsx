import React, { useEffect, useState } from 'react';
import { 
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, AreaChart, Area
} from 'recharts';
import { 
  TrendingUp, Users, Phone, Target, Filter, Download, Calendar as CalendarIcon, RefreshCw, LayoutDashboard, CheckCircle, XCircle, Search, X
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../lib/utils';
import { useAuthStore } from '../store/authStore';
import { UserRole, Lead } from '../types';
import { leadService } from '../services/leadService';
import { userService } from '../services/userService';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';

export default function ExecutionIntelligence() {
  const { user } = useAuthStore();
  const [period, setPeriod] = useState('TODAY');
  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().substring(0, 10));
  const [customDates, setCustomDates] = useState({ 
    start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0]
  });
  const [loading, setLoading] = useState(true);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [teamStats, setTeamStats] = useState<any[]>([]);
  const [stats, setStats] = useState({
    contacted: 0,
    meetings: 0,
    followUps: 0,
    pipeline: 0,
    projected: 0,
    collected: 0,
  });
  const [activePopup, setActivePopup] = useState<string | null>(null);
  const [popupSearch, setPopupSearch] = useState<string>('');

  const loadData = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const allLeads = await leadService.getLeads({ 
        employeeId: user.employeeId, 
        role: user.role
      });
      setLeads(allLeads);
      
      let allUsers: any[] = [];
      if (user.role !== UserRole.RO) {
        try {
          allUsers = await userService.getAllUsers();
        } catch (e) {
          console.warn("Restricted user list");
        }
      }

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

      const collectedTotal = filteredLeads.reduce((acc, curr) => acc + (curr.collectedNCP || 0), 0);
      const projectedTotal = filteredLeads.reduce((acc, curr) => acc + (curr.projectedNCP || 0), 0);

      setStats({
        contacted: filteredLeads.filter(l => ['Contacted', 'Interested', 'Follow-up Set', 'Meeting Fixed', 'Meeting Completed', 'Pipeline Locked', 'Converted'].includes(l.currentStatus)).length,
        meetings: filteredLeads.filter(l => l.currentStatus === 'Meeting Completed').length,
        followUps: filteredLeads.filter(l => l.currentStatus === 'Follow-up Set').length,
        pipeline: filteredLeads.filter(l => l.currentStatus === 'Pipeline Locked').length,
        projected: projectedTotal,
        collected: collectedTotal,
      });

      // Team / area stats
      const teams = ['Gulshan', 'Banani', 'Dhanmondi', 'Uttara', 'Mirpur'];
      const teamBreakdown = teams.map(team => {
        const teamLeads = filteredLeads.filter(l => (l.area || '').includes(team));
        return {
          team,
          assigned: teamLeads.length,
          noCall: teamLeads.filter(l => l.currentStatus === 'Untouched').length,
          contacted: teamLeads.filter(l => l.currentStatus !== 'Untouched').length,
          meetings: teamLeads.filter(l => l.currentStatus === 'Meeting Completed').length,
          followUps: teamLeads.filter(l => l.currentStatus === 'Follow-up Set').length,
          pipeline: teamLeads.filter(l => l.currentStatus === 'Pipeline Locked').length,
          collected: teamLeads.reduce((acc, curr) => acc + (curr.collectedNCP || 0), 0),
          projected: teamLeads.reduce((acc, curr) => acc + (curr.projectedNCP || 0), 0),
        };
      });
      setTeamStats(teamBreakdown.filter(t => t.assigned > 0 || t.collected > 0));

    } catch (err) {
      toast.error('Execution intelligence retrieval failure');
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

  const getFilteredLeadsForPopup = () => {
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

    let result = leads.filter(l => {
      const leadDate = new Date(l.timestamp);
      return leadDate >= startDate && leadDate <= endDate;
    });

    if (user?.role === UserRole.RO) {
      result = result.filter(l => l.assignedTo === user.employeeId);
    }

    if (activePopup === 'contacted') {
      result = result.filter(l => ['Contacted', 'Interested', 'Follow-up Set', 'Meeting Fixed', 'Meeting Completed', 'Pipeline Locked', 'Converted'].includes(l.currentStatus));
    } else if (activePopup === 'meetings') {
      result = result.filter(l => l.currentStatus === 'Meeting Completed');
    } else if (activePopup === 'followups') {
      result = result.filter(l => l.currentStatus === 'Follow-up Set');
    } else if (activePopup === 'pipeline') {
      result = result.filter(l => l.currentStatus === 'Pipeline Locked');
    } else if (activePopup === 'projected') {
      result = result.filter(l => l.projectedNCP > 0);
    } else if (activePopup === 'collected') {
      result = result.filter(l => l.collectedNCP > 0);
    }

    if (popupSearch) {
      result = result.filter(l => 
        (l.prospectName || '').toLowerCase().includes(popupSearch.toLowerCase()) ||
        (l.mobile || '').includes(popupSearch) ||
        (l.area || '').toLowerCase().includes(popupSearch.toLowerCase())
      );
    }

    return result;
  };

  const handleExportTeamStats = () => {
    const data = teamStats.map(r => ({
      'Team / Area': r.team,
      'Total Assigned': r.assigned,
      'No Call Yet': r.noCall,
      'Contacted': r.contacted,
      'Meetings Completed': r.meetings,
      'Follow-ups Set': r.followUps,
      'Pipeline Locked': r.pipeline,
      'Collected NCP (BDT)': r.collected,
      'Projected NCP (BDT)': r.projected,
    }));
    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Team_Breakout");
    XLSX.writeFile(workbook, `Execution_Intelligence_Export_${period}.xlsx`);
    toast.success("Team breakout list downloaded successfully!");
  };

  return (
    <div className="space-y-8 pb-24 bg-white font-sans">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 border-b border-slate-100 pb-8">
        <div>
          <h1 className="text-4xl font-black tracking-tighter text-brand-text italic uppercase leading-none">Execution Intelligence</h1>
          <p className="text-slate-400 font-bold text-[10px] uppercase tracking-[0.3em] mt-3 italic">Live Status ledger and Hierarchical Output Audit</p>
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

      {/* Period Filter Header */}
      <div className="bg-[#3C3C3C] p-6 rounded-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
           <div className="w-8 h-8 rounded bg-white/5 flex items-center justify-center">
              <LayoutDashboard className="w-4 h-4 text-[#978C21]" />
           </div>
           <div>
              <h4 className="text-white text-[12px] font-black uppercase tracking-[0.2em] italic">Daily Status Audit</h4>
              <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">Execution intelligence scope</p>
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
        <>
          {/* Key KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
             {[
               { id: 'contacted', label: 'CONTACTED CALLS', value: stats.contacted, icon: Phone, color: 'text-brand-blue' },
               { id: 'meetings', label: 'MEETINGS COMPLETED', value: stats.meetings, icon: Users, color: 'text-slate-900' },
               { id: 'followups', label: 'FOLLOW-UPS SET', value: stats.followUps, icon: RefreshCw, color: 'text-slate-500' },
               { id: 'pipeline', label: 'PIPELINE LOCKED', value: stats.pipeline, icon: Target, color: 'text-slate-900' },
               { id: 'projected', label: 'PROJECTED NCP', value: `৳${stats.projected.toLocaleString()}`, icon: TrendingUp, color: 'text-brand-text' },
               { id: 'collected', label: 'COLLECTED NCP', value: `৳${stats.collected.toLocaleString()}`, icon: CheckCircle, color: 'text-[#10B981]', isGreen: true },
             ].map((stat, i) => (
                <button
                   key={stat.id}
                   onClick={() => {
                      setActivePopup(stat.id);
                      setPopupSearch('');
                   }}
                   className="p-6 bg-white border border-slate-100 hover:border-[#978C21]/20 rounded-sm text-left group hover:bg-slate-50/50 transition-colors cursor-pointer select-none border-0 outline-none w-full shadow-sm"
                >
                   <div className="flex items-center gap-2 mb-4">
                      <stat.icon className={cn("w-4 h-4", stat.color)} />
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">{stat.label}</p>
                   </div>
                   <h5 className={cn("text-3xl font-black text-brand-text tracking-tighter italic", stat.isGreen && "text-[#10B981]")}>{stat.value}</h5>
                </button>
             ))}
          </div>

          {/* Area Breakout Leaderboard */}
          <div className="bg-white rounded-sm border border-slate-100 overflow-hidden shadow-sm mt-8">
            <div className="px-8 py-6 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <h4 className="text-[12px] font-black uppercase text-brand-text tracking-widest italic">Regional Agency Distribution</h4>
                  <p className="text-[8px] uppercase tracking-widest text-slate-400 font-bold mt-1">Real-time team breakout numbers</p>
                </div>
                <button 
                  onClick={handleExportTeamStats}
                  className="flex items-center gap-2 border border-slate-100 bg-white hover:bg-slate-50 hover:border-[#978C21]/20 px-4 py-2 text-[10px] uppercase font-black tracking-wider shadow-sm transition-all text-[#978C21]"
                >
                  <Download className="w-3.5 h-3.5" />
                  Export Sheet
                </button>
            </div>
             <div className="overflow-x-auto">
                <table className="w-full text-left">
                   <thead className="bg-[#FBFAF8] text-[8px] font-black text-slate-500 uppercase tracking-widest border-b border-slate-100">
                      <tr>
                         <th className="px-8 py-4">Team / Agency</th>
                         <th className="px-6 py-4 text-center">Total Assigned</th>
                         <th className="px-6 py-4 text-center text-brand-blue">No Call Yet</th>
                         <th className="px-6 py-4 text-center">Contacted</th>
                         <th className="px-6 py-4 text-center">Meetings</th>
                         <th className="px-6 py-4 text-center font-bold">Follow-ups</th>
                         <th className="px-6 py-4 text-center">Pipeline Locked</th>
                         <th className="px-6 py-4 text-center text-[#10B981]">Collected NCP</th>
                         <th className="px-6 py-4 text-center">Projected NCP</th>
                      </tr>
                   </thead>
                   <tbody className="divide-y divide-slate-50 italic text-[11px]">
                      {teamStats.length === 0 ? (
                         <tr>
                            <td colSpan={9} className="text-center py-12 text-slate-400 font-bold uppercase tracking-widest italic text-[10px]">
                               No active team records matched for this range
                            </td>
                         </tr>
                      ) : (
                        teamStats.map((row, i) => (
                           <tr key={i} className="hover:bg-slate-50 transition-colors">
                              <td className="px-8 py-4 font-black uppercase text-slate-700">{row.team}</td>
                              <td className="px-6 py-4 text-center text-slate-500 font-semibold">{row.assigned}</td>
                              <td className="px-6 py-4 text-center font-black text-brand-blue">{row.noCall}</td>
                              <td className="px-6 py-4 text-center text-slate-500">{row.contacted}</td>
                              <td className="px-6 py-4 text-center text-slate-500">{row.meetings}</td>
                              <td className="px-6 py-4 text-center text-slate-500">{row.followUps}</td>
                              <td className="px-6 py-4 text-center font-black text-[#978C21]">{row.pipeline}</td>
                              <td className="px-6 py-4 text-center font-black text-[#10B981]">৳{row.collected.toLocaleString()}</td>
                              <td className="px-6 py-4 text-center font-black text-slate-400">৳{row.projected.toLocaleString()}</td>
                           </tr>
                        ))
                      )}
                   </tbody>
                </table>
             </div>
          </div>
        </>
      )}

      {/* Leads Drilldown Popup */}
      <AnimatePresence>
        {activePopup && (
           <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex justify-end">
              <motion.div 
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={{ type: 'tween', duration: 0.3 }}
                className="bg-white w-full max-w-2xl h-full shadow-2xl p-8 overflow-y-auto flex flex-col justify-between"
              >
                <div>
                   <div className="flex items-center justify-between border-b border-slate-100 pb-6 mb-8">
                      <div>
                         <h2 className="text-2xl font-black text-brand-text uppercase italic tracking-tighter leading-none">{activePopup.replace('_', ' ')} list</h2>
                         <p className="text-[9px] font-black text-[#978C21] uppercase tracking-widest mt-1.5 italic">Drill Down Lead Intelligence details</p>
                      </div>
                      <button 
                        onClick={() => setActivePopup(null)}
                        className="w-10 h-10 rounded-full hover:bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-900 transition-colors cursor-pointer"
                      >
                        <X className="w-5 h-5" />
                      </button>
                   </div>

                   <div className="flex items-center gap-2 bg-slate-50 border border-slate-100 px-4 py-2.5 rounded-sm mb-6 shadow-sm">
                      <Search className="w-4 h-4 text-slate-400" />
                      <input 
                        type="text" 
                        placeholder="Filter drilldown by client name, mobile or area..." 
                        value={popupSearch}
                        onChange={(e) => setPopupSearch(e.target.value)}
                        className="bg-transparent border-none text-[10px] font-bold uppercase text-slate-800 placeholder-slate-400 outline-none w-full"
                      />
                   </div>

                   <div className="border border-slate-100 rounded-sm overflow-hidden bg-white">
                      <div className="max-h-[55vh] overflow-y-auto">
                        <table className="w-full text-left">
                           <thead className="bg-[#FBFAF8] text-[8px] font-black text-slate-500 uppercase tracking-widest border-b border-slate-100">
                              <tr>
                                 <th className="px-6 py-4">Client Name</th>
                                 <th className="px-6 py-4">Area</th>
                                 <th className="px-6 py-4 text-center">NCP Collected</th>
                                 <th className="px-6 py-4 text-center">Current Status</th>
                              </tr>
                           </thead>
                           <tbody className="divide-y divide-slate-50 text-[11px] italic font-medium">
                              {getFilteredLeadsForPopup().length === 0 ? (
                                 <tr>
                                    <td colSpan={4} className="text-center py-12 text-slate-400 font-bold uppercase tracking-widest text-[9px] italic">
                                       No active logs registered for this KPI
                                    </td>
                                 </tr>
                              ) : (
                                getFilteredLeadsForPopup().map((lead, idx) => (
                                   <tr key={lead.id || idx} className="hover:bg-slate-50/50 transition-colors">
                                      <td className="px-6 py-3 font-bold text-slate-800 uppercase not-italic">{lead.prospectName}</td>
                                      <td className="px-6 py-3 text-slate-450">{lead.area}</td>
                                      <td className="px-6 py-3 font-black text-slate-700 text-center">৳{(lead.collectedNCP || 0).toLocaleString()}</td>
                                      <td className="px-6 py-3 text-center">
                                         <span className="px-2 py-0.5 bg-slate-100 text-[8px] font-black uppercase text-slate-600 rounded">
                                            {lead.currentStatus}
                                         </span>
                                      </td>
                                   </tr>
                                ))
                              )}
                           </tbody>
                        </table>
                      </div>
                   </div>
                </div>

                <div className="mt-8 border-t border-slate-100 pt-6">
                   <button 
                     onClick={() => setActivePopup(null)}
                     className="w-full py-4 bg-slate-900 hover:bg-slate-850 text-white font-black uppercase tracking-widest text-[10px] rounded-sm shadow-md transition-all italic"
                   >
                     Close intelligence panel
                   </button>
                </div>
              </motion.div>
           </div>
        )}
      </AnimatePresence>
    </div>
  );
}
