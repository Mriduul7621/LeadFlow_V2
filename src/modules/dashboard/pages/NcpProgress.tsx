import React, { useEffect, useMemo, useState } from 'react';
import { 
  ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, AreaChart, Area
} from 'recharts';
import {
  RefreshCw, Download
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useAuthStore } from '../../auth/store/authStore';
import { Lead } from '../../shared/types';
import { leadService } from '../../leads/services/leadService';
import { toast } from 'sonner';
import { downloadWorkbook } from '../../shared/utils/excel';
import { EnterprisePageHeader } from '../../workspace/components/EnterprisePrimitives';
import BackButton from '../../shared/components/BackButton';

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

  // The selected period's date range (local dates), shared by the
  // loader and the chart buckets so both describe the same leads.
  const getPeriodRange = () => {
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
    return { startDate, endDate };
  };

  const loadData = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const allLeads = await leadService.getLeads({ 
        employeeId: user.employeeId, 
        role: user.role
      });
      
      // Determine date ranges
      const { startDate, endDate } = getPeriodRange();

      // Filter leads by date & role
      let filteredLeads = allLeads.filter(l => {
        const leadDate = new Date(l.timestamp);
        return leadDate >= startDate && leadDate <= endDate;
      });

      // UM-1: no role-name re-filter here. leadService.getLeads already
      // applied the caller's EFFECTIVE scope (dataScope, incl. the
      // tree-derived team-lead floor), so an RO with people under them
      // correctly sees own + team leads, and a pure Own user already
      // received own leads only.

      setLeads(filteredLeads);

      const collectedTotal = filteredLeads.reduce((acc, curr) => acc + (curr.collectedNCP || 0), 0);
      const projectedTotal = filteredLeads.reduce((acc, curr) => acc + (curr.projectedNCP || 0), 0);

      // Turnaround time (TAT) calculation
      let totalTatMs = 0;
      let targetTatLeads = 0;
      filteredLeads.forEach(l => {
        if (l.currentStatus !== 'New') {
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

  /**
   * Cumulative NCP by period quartile (fix round, 2026-11-19):
   * the old chart interpolated the totals at 25/55/80/100% —
   * invented numbers. These buckets sum the leads that actually
   * fall in each quarter of the selected period, cumulatively.
   * Labels are the quartile's start (hour for a single day).
   */
  const ncpTrackingData = useMemo(() => {
    const { startDate, endDate } = getPeriodRange();
    const span = endDate.getTime() - startDate.getTime();
    const buckets: { name: string; Collected: number; Projected: number }[] = [];
    let cumCollected = 0;
    let cumProjected = 0;
    for (let i = 0; i < 4; i++) {
      const qStart = new Date(startDate.getTime() + (span * i) / 4);
      const qEnd = new Date(startDate.getTime() + (span * (i + 1)) / 4);
      const inQuartile = leads.filter(l => {
        const d = new Date(l.timestamp);
        return d >= qStart && (i === 3 ? d <= qEnd : d < qEnd);
      });
      cumCollected += inQuartile.reduce((acc, l) => acc + (l.collectedNCP || 0), 0);
      cumProjected += inQuartile.reduce((acc, l) => acc + (l.projectedNCP || 0), 0);
      const label = period === 'TODAY'
        ? `${String(qStart.getHours()).padStart(2, '0')}:00`
        : qStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      buckets.push({ name: label, Collected: cumCollected, Projected: cumProjected });
    }
    return buckets;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leads, period, selectedDate, customDates]);

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

  const handleExportNcpLeads = async () => {
    const data = leads.map(l => ({
      'Client Name': l.prospectName,
      'Area': l.area,
      'Product': l.productName,
      'Campaign': l.campaignName,
      'Collected NCP': l.collectedNCP,
      'Projected NCP': l.projectedNCP,
      'Status': l.currentStatus,
    }));
    try {
      await downloadWorkbook(`NCP_Progress_Ledger_${period}.xlsx`, [{ name: "NCP_Ledger", rows: data }]);
      toast.success("NCP Ledger downloaded successfully!");
    } catch {
      toast.error("Failed to generate export file");
    }
  };

  return (
    <div className="ep-page">
      <BackButton fallback="/" />
      <EnterprisePageHeader
        path="/ncp-progress"
        actions={(
          <button
            type="button"
            onClick={loadData}
            className="ep-btn"
            aria-label="Refresh NCP progress"
          >
            <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
            Refresh
          </button>
        )}
      />

      {/* Period filter */}
      <div className="ep-card" style={{ marginBottom: 18 }}>
        <div className="ep-cardhead">
          <div>
            <h3>Period</h3>
            <div className="ep-muted">{formattedDateRange()}</div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {['TODAY', 'THIS MONTH', 'LAST MONTH', 'CUSTOM'].map(p => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                className={cn('ep-pill', period === p && 'active')}
                aria-pressed={period === p}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
        {period === 'CUSTOM' && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
            <label className="ep-field-label">
              Start
              <input
                type="date"
                value={customDates.start}
                onChange={(e) => setCustomDates({ ...customDates, start: e.target.value })}
                className="ep-search"
              />
            </label>
            <label className="ep-field-label">
              End
              <input
                type="date"
                value={customDates.end}
                onChange={(e) => setCustomDates({ ...customDates, end: e.target.value })}
                className="ep-search"
              />
            </label>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center items-center py-24">
          <div className="w-12 h-12 border-4 border-slate-100 border-t-[#978C21] rounded-full animate-spin"></div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Main chart card */}
          <div className="lg:col-span-3 ep-card">
             <div className="ep-cardhead">
                <div>
                   <h3>Financial target tracking</h3>
                   <div className="ep-muted">Collected vs projected potential, cumulative through the period</div>
                </div>
                <span className="ep-pill">
                  {stats.projected > 0 ? ((stats.collected / stats.projected) * 100).toFixed(1) : 0}% of potential
                </span>
             </div>
             <div className="flex flex-row gap-8 justify-between items-end" style={{ marginBottom: 8 }}>
                <div>
                   <div className="ep-metric-label">Collected NCP</div>
                   <div className="ep-metric" style={{ color: '#10B981' }}>৳{stats.collected.toLocaleString()}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                   <div className="ep-metric-label">Projected NCP</div>
                   <div className="ep-metric">৳{stats.projected.toLocaleString()}</div>
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
                   <div className="ep-metric-label">Conversion</div>
                   <div className="ep-metric" style={{ fontSize: 22 }}>{stats.conversionRate}</div>
                </div>
                <div>
                   <div className="ep-metric-label">Response TAT</div>
                   <div className="ep-metric" style={{ fontSize: 22 }}>{stats.avgResponseTAT}</div>
                </div>
                <div>
                   <div className="ep-metric-label">Active leads</div>
                   <div className="ep-metric" style={{ fontSize: 22 }}>{stats.activeLeads}</div>
                </div>
             </div>
          </div>

          {/* Quick stats sidebar details */}
          <div className="flex flex-col gap-6 justify-between">
             <div className="ep-card flex-1 flex flex-col justify-between">
                 <div>
                    <div className="ep-metric-label">Collected segment (finalized)</div>
                    <div className="ep-metric" style={{ color: '#10B981', wordBreak: 'break-all' }}>৳{stats.collected.toLocaleString()}</div>
                 </div>
                 <div className="ep-muted" style={{ textAlign: 'right', marginTop: 16 }}>NCP extracted ledger</div>
             </div>
             <div className="ep-card flex-1 flex flex-col justify-between">
                 <div>
                    <div className="ep-metric-label">Projected segment (potential)</div>
                    <div className="ep-metric" style={{ wordBreak: 'break-all' }}>৳{stats.projected.toLocaleString()}</div>
                 </div>
                 <div className="ep-muted" style={{ textAlign: 'right', marginTop: 16 }}>Pipeline locked ৳ potential</div>
             </div>
          </div>
        </div>
      )}

      {/* Leads ledger table */}
      {!loading && (
        <div className="ep-card ep-tablecard" style={{ marginTop: 18 }}>
           <div className="ep-tablehead">
              <div>
                 <h3>NCP registry ledger</h3>
                 <div className="ep-muted">Individual client progression lines</div>
              </div>
              <button
                type="button"
                onClick={handleExportNcpLeads}
                className="ep-btn"
              >
                <Download className="w-3.5 h-3.5" />
                Export ledger
              </button>
           </div>
           <div className="ep-tablewrap">
              <table>
                 <thead>
                    <tr>
                       <th>Client prospect</th>
                       <th>Area location</th>
                       <th style={{ textAlign: 'center' }}>Campaign name</th>
                       <th style={{ textAlign: 'center' }}>Product choice</th>
                       <th style={{ textAlign: 'center' }}>Projected NCP</th>
                       <th style={{ textAlign: 'center' }}>Collected NCP</th>
                       <th style={{ textAlign: 'center' }}>NCP status line</th>
                    </tr>
                 </thead>
                 <tbody>
                    {leads.length === 0 ? (
                       <tr>
                          <td colSpan={7} className="ep-td-empty">
                             No NCP progress lines matched for this period scope
                          </td>
                       </tr>
                    ) : (
                      leads.slice(0, 15).map((l, index) => (
                         <tr key={l.id || index}>
                            <td><strong>{l.prospectName}</strong></td>
                            <td>{l.area}</td>
                            <td style={{ textAlign: 'center' }}>{l.campaignName}</td>
                            <td style={{ textAlign: 'center' }}>{l.productName}</td>
                            <td style={{ textAlign: 'center' }}><strong>৳{(l.projectedNCP || 0).toLocaleString()}</strong></td>
                            <td style={{ textAlign: 'center' }}><strong>৳{(l.collectedNCP || 0).toLocaleString()}</strong></td>
                            <td style={{ textAlign: 'center' }}>
                               <span className="ep-pill">
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
