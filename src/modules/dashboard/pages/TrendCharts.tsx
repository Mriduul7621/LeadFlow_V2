import React, { useEffect, useState } from 'react';
import { 
  ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, AreaChart, Area
} from 'recharts';
import {
  RefreshCw
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useAuthStore } from '../../auth/store/authStore';
import { Lead } from '../../shared/types';
import { leadService } from '../../leads/services/leadService';
import { toast } from 'sonner';
import { EnterprisePageHeader } from '../../workspace/components/EnterprisePrimitives';
import BackButton from '../../shared/components/BackButton';

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

      // UM-1: no role-name re-filter here. leadService.getLeads already
      // applied the caller's EFFECTIVE scope (dataScope, incl. the
      // tree-derived team-lead floor), so an RO with people under them
      // correctly sees own + team leads, and a pure Own user already
      // received own leads only.

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
    <div className="ep-page">
      <BackButton fallback="/" />
      <EnterprisePageHeader
        path="/trend-charts"
        actions={(
          <button
            type="button"
            onClick={loadData}
            className="ep-btn"
            aria-label="Refresh trend charts"
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
        <div className="space-y-6">
          {/* Main chart area */}
          <div className="ep-card">
             <div className="ep-cardhead">
               <div>
                 <h3>Lead generation over time</h3>
                 <div className="ep-muted">Daily lead creation count</div>
               </div>
               <span className="ep-pill">{summaryStats.totalLeads} leads</span>
             </div>
             <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                   <AreaChart data={trendData}>
                      <defs>
                        <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#858515" stopOpacity={0.15}/>
                          <stop offset="95%" stopColor="#858515" stopOpacity={0}/>
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
                      <Area type="monotone" dataKey="value" stroke="#858515" strokeWidth={4} fillOpacity={1} fill="url(#colorValue)" dot={{ fill: '#858515', strokeWidth: 3, r: 6, stroke: '#fff' }} name="Leads Count" />
                   </AreaChart>
                </ResponsiveContainer>
             </div>
          </div>

          {/* Trend summary grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
             <div className="ep-card" style={{ textAlign: 'center' }}>
                <div className="ep-metric-label">Total processed leads</div>
                <div className="ep-metric">{summaryStats.totalLeads}</div>
             </div>
             <div className="ep-card" style={{ textAlign: 'center' }}>
                <div className="ep-metric-label">Generation velocity</div>
                <div className="ep-metric" style={{ color: '#858515' }}>{summaryStats.velocity}</div>
             </div>
             <div className="ep-card" style={{ textAlign: 'center' }}>
                <div className="ep-metric-label">Peak performance point</div>
                <div className="ep-metric" style={{ color: '#10B981', textTransform: 'uppercase' }}>{summaryStats.peakInterval}</div>
             </div>
          </div>
        </div>
      )}
    </div>
  );
}
