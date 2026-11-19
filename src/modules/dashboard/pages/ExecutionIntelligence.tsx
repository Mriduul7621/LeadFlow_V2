import React, { useEffect, useMemo, useState } from 'react';
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, AreaChart, Area, BarChart, Bar, Legend
} from 'recharts';
import {
  TrendingUp, Users, Phone, Target, Download, RefreshCw, CheckCircle, Search, X
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../../../lib/utils';
import { useAuthStore } from '../../auth/store/authStore';
import { Lead } from '../../shared/types';
import { leadService } from '../../leads/services/leadService';
import { userService } from '../../users/services/userService';
import { toast } from 'sonner';
import { downloadWorkbook } from '../../shared/utils/excel';
import { EnterprisePageHeader } from '../../workspace/components/EnterprisePrimitives';
import BackButton from '../../shared/components/BackButton';

/** Stage-pie colours: the sample palette first, then muted tones. */
const STAGE_COLORS = ['#858515', '#596b35', '#f36b21', '#a6ad79', '#263238', '#b0b8c1', '#e8b48c', '#7d8c6f', '#c9a227', '#8d6e63'];

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

  // The selected period's date range (local dates), shared by the
  // loader, the drill-down popup and the chart memos below so all
  // three always describe the same set of leads.
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
      setLeads(allLeads);
      
      // UM-1: the user list is loaded for EVERY role — a team lead with
      // an individual-contributor role label (e.g. RO) still has a team
      // table to fill. The roster endpoint serves names/structure to any
      // signed-in user; failure still degrades to an empty list.
      let allUsers: any[] = [];
      try {
        allUsers = await userService.getAllUsers();
      } catch (e) {
        console.warn("Restricted user list");
      }

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
          noCall: teamLeads.filter(l => l.currentStatus === 'New').length,
          contacted: teamLeads.filter(l => l.currentStatus !== 'New').length,
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
    const { startDate, endDate } = getPeriodRange();

    let result = leads.filter(l => {
      const leadDate = new Date(l.timestamp);
      return leadDate >= startDate && leadDate <= endDate;
    });

    // UM-1: no role-name re-filter (see loadData) — the popup lists the
    // same effective scope the headline numbers were computed from.

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

  const handleExportTeamStats = async () => {
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
    try {
      await downloadWorkbook(`Execution_Intelligence_Export_${period}.xlsx`, [{ name: "Team_Breakout", rows: data }]);
      toast.success("Team breakout list downloaded successfully!");
    } catch {
      toast.error("Failed to generate export file");
    }
  };

  // ----------------------------------------------------------------
  // Analytic content (fix round, 2026-11-19 — "Analytics page E
  // analytic type E data thakte Hobe"). Every chart below is
  // computed from the same period-filtered leads the KPI cards
  // summarise; nothing is fabricated, and an empty period shows
  // an honest empty state instead of a chart.
  // ----------------------------------------------------------------

  /** The leads the selected period covers (same scope as the KPIs). */
  const filteredLeads = useMemo(() => {
    const { startDate, endDate } = getPeriodRange();
    return leads.filter(l => {
      const leadDate = new Date(l.timestamp);
      return leadDate >= startDate && leadDate <= endDate;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leads, period, selectedDate, customDates]);

  /** Stage distribution for the pie chart (real LeadFlow statuses). */
  const stageBreakdown = useMemo(() => {
    const counts = new Map<string, number>();
    for (const lead of filteredLeads) {
      const status = lead.currentStatus || 'Unknown';
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [filteredLeads]);

  /**
   * Leads over time: hourly buckets for a single day, daily
   * buckets for longer periods. Keys are LOCAL dates/hours so a
   * bucket never lands on the wrong day across timezones.
   */
  const trendPoints = useMemo(() => {
    const buckets = new Map<string, { label: string; leads: number }>();
    for (const lead of filteredLeads) {
      const d = new Date(lead.timestamp);
      const key = period === 'TODAY'
        ? String(d.getHours()).padStart(2, '0')
        : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const label = period === 'TODAY'
        ? `${d.getHours()}:00`
        : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      const bucket = buckets.get(key) ?? { label, leads: 0 };
      bucket.leads += 1;
      buckets.set(key, bucket);
    }
    return [...buckets.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, bucket]) => bucket);
  }, [filteredLeads, period]);

  /** NCP comparison per area for the bar chart (from teamStats). */
  const ncpByArea = useMemo(
    () => teamStats.map(row => ({
      area: row.team,
      projected: row.projected,
      collected: row.collected,
    })),
    [teamStats],
  );

  /** Conversion/contact/collection rates — real counts only. */
  const rates = useMemo(() => {
    const total = filteredLeads.length;
    const contacted = filteredLeads.filter(l =>
      ['Contacted', 'Interested', 'Follow-up Set', 'Meeting Fixed', 'Meeting Completed', 'Pipeline Locked', 'Converted'].includes(l.currentStatus),
    ).length;
    const converted = filteredLeads.filter(l => l.currentStatus === 'Converted').length;
    const pct = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 100));
    return {
      total,
      contactRate: pct(contacted, total),
      conversionRate: pct(converted, total),
      collectionRate: pct(stats.collected, stats.projected),
    };
  }, [filteredLeads, stats]);

  return (
    <div className="ep-page">
      <BackButton fallback="/" />
      <EnterprisePageHeader
        path="/execution-intelligence"
        actions={(
          <button
            type="button"
            onClick={loadData}
            className="ep-btn"
            aria-label="Refresh analytics"
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
        <>
          {/* Key KPI cards — each opens its drill-down list. */}
          <div className="ep-grid-3">
             {[
               { id: 'contacted', label: 'Contacted calls', value: stats.contacted, icon: Phone, foot: 'Tap to list the leads', tone: '' },
               { id: 'meetings', label: 'Meetings completed', value: stats.meetings, icon: Users, foot: 'Tap to list the leads', tone: '' },
               { id: 'followups', label: 'Follow-ups set', value: stats.followUps, icon: RefreshCw, foot: 'Tap to list the leads', tone: '' },
               { id: 'pipeline', label: 'Pipeline locked', value: stats.pipeline, icon: Target, foot: 'Tap to list the leads', tone: '' },
               { id: 'projected', label: 'Projected NCP', value: `৳${stats.projected.toLocaleString()}`, icon: TrendingUp, foot: 'Tap to list the leads', tone: '' },
               { id: 'collected', label: 'Collected NCP', value: `৳${stats.collected.toLocaleString()}`, icon: CheckCircle, foot: 'Tap to list the leads', tone: 'green' },
             ].map(stat => (
                <button
                   key={stat.id}
                   type="button"
                   onClick={() => {
                      setActivePopup(stat.id);
                      setPopupSearch('');
                   }}
                   className="ep-card ep-kpi-btn"
                   aria-label={`${stat.label}: ${stat.value}`}
                >
                   <div className="ep-metric-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <stat.icon className="w-4 h-4" />
                      {stat.label}
                   </div>
                   <div className={cn('ep-metric', stat.tone === 'green' && 'text-[#10B981]')}>{stat.value}</div>
                   <div className="ep-trend">{stat.foot}</div>
                </button>
             ))}
          </div>

          {/* Charts: leads over time + stage distribution. */}
          <div className="ep-layout2">
            <div className="ep-card">
              <div className="ep-cardhead">
                <div>
                  <h3>Leads over time</h3>
                  <div className="ep-muted">{period === 'TODAY' ? 'New leads by hour, today' : 'New leads by day, in this period'}</div>
                </div>
                <span className="ep-pill">{rates.total} leads</span>
              </div>
              {trendPoints.length === 0 ? (
                <p className="ep-empty">No leads in this period — the trend appears when there is data to show.</p>
              ) : (
                <ResponsiveContainer width="100%" height={230}>
                  <AreaChart data={trendPoints} margin={{ top: 5, right: 5, bottom: 0, left: -18 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Area type="monotone" dataKey="leads" stroke="#858515" fill="#a6ad79" fillOpacity={0.45} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
            <div className="ep-card">
              <div className="ep-cardhead">
                <div>
                  <h3>Stage distribution</h3>
                  <div className="ep-muted">Leads by current status</div>
                </div>
                <span className="ep-pill">{stageBreakdown.length} stages</span>
              </div>
              {stageBreakdown.length === 0 ? (
                <p className="ep-empty">No leads in this period — the breakdown appears when there is data to show.</p>
              ) : (
                <ResponsiveContainer width="100%" height={230}>
                  <PieChart>
                    <Pie
                      data={stageBreakdown}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      outerRadius={82}
                      label={(props: any) => `${props.name} ${Math.round((props.percent ?? 0) * 100)}%`}
                      labelLine={false}
                    >
                      {stageBreakdown.map((entry, i) => (
                        <Cell key={entry.name} fill={STAGE_COLORS[i % STAGE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Charts: NCP comparison per area + rates. */}
          <div className="ep-layout2">
            <div className="ep-card">
              <div className="ep-cardhead">
                <div>
                  <h3>NCP by area</h3>
                  <div className="ep-muted">Projected vs collected, per area</div>
                </div>
                <span className="ep-pill">৳</span>
              </div>
              {ncpByArea.length === 0 ? (
                <p className="ep-empty">No area records in this period — the comparison appears when there is data to show.</p>
              ) : (
                <ResponsiveContainer width="100%" height={230}>
                  <BarChart data={ncpByArea} margin={{ top: 5, right: 5, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                    <XAxis dataKey="area" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `৳${Number(v).toLocaleString()}`} width={90} />
                    <Tooltip formatter={v => `৳${Number(v).toLocaleString()}`} />
                    <Legend />
                    <Bar dataKey="projected" name="Projected" fill="#a6ad79" />
                    <Bar dataKey="collected" name="Collected" fill="#596b35" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
            <div className="ep-card">
              <div className="ep-cardhead">
                <div>
                  <h3>Rates</h3>
                  <div className="ep-muted">Shares of the leads in this period</div>
                </div>
              </div>
              <div className="ep-list">
                <div className="ep-listrow">
                  <div>
                    <div className="ep-rowtitle">Contact rate</div>
                    <div className="ep-rowsub">Leads reached at least once</div>
                  </div>
                  <span className="ep-pill">{rates.contactRate}%</span>
                </div>
                <div className="ep-listrow">
                  <div>
                    <div className="ep-rowtitle">Conversion rate</div>
                    <div className="ep-rowsub">Leads with status Converted</div>
                  </div>
                  <span className="ep-pill">{rates.conversionRate}%</span>
                </div>
                <div className="ep-listrow">
                  <div>
                    <div className="ep-rowtitle">Collection rate</div>
                    <div className="ep-rowsub">Collected vs projected NCP</div>
                  </div>
                  <span className="ep-pill">{rates.collectionRate}%</span>
                </div>
              </div>
              <div className="ep-cardfoot">Rates are computed from the {rates.total} lead{rates.total === 1 ? '' : 's'} in this period.</div>
            </div>
          </div>

          {/* Area breakout table */}
          <div className="ep-card ep-tablecard">
            <div className="ep-tablehead">
              <div>
                <h3>Regional agency distribution</h3>
                <div className="ep-muted">Team breakout numbers for this period</div>
              </div>
              <button type="button" onClick={handleExportTeamStats} className="ep-btn">
                <Download className="w-3.5 h-3.5" />
                Export sheet
              </button>
            </div>
            <div className="ep-tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Team / Agency</th>
                    <th style={{ textAlign: 'center' }}>Total assigned</th>
                    <th style={{ textAlign: 'center' }}>No call yet</th>
                    <th style={{ textAlign: 'center' }}>Contacted</th>
                    <th style={{ textAlign: 'center' }}>Meetings</th>
                    <th style={{ textAlign: 'center' }}>Follow-ups</th>
                    <th style={{ textAlign: 'center' }}>Pipeline locked</th>
                    <th style={{ textAlign: 'center' }}>Collected NCP</th>
                    <th style={{ textAlign: 'center' }}>Projected NCP</th>
                  </tr>
                </thead>
                <tbody>
                  {teamStats.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="ep-td-empty">No active team records matched for this range</td>
                    </tr>
                  ) : (
                    teamStats.map((row, i) => (
                      <tr key={i}>
                        <td><strong>{row.team}</strong></td>
                        <td style={{ textAlign: 'center' }}>{row.assigned}</td>
                        <td style={{ textAlign: 'center' }}><strong>{row.noCall}</strong></td>
                        <td style={{ textAlign: 'center' }}>{row.contacted}</td>
                        <td style={{ textAlign: 'center' }}>{row.meetings}</td>
                        <td style={{ textAlign: 'center' }}>{row.followUps}</td>
                        <td style={{ textAlign: 'center' }}><strong>{row.pipeline}</strong></td>
                        <td style={{ textAlign: 'center' }}><strong>৳{row.collected.toLocaleString()}</strong></td>
                        <td style={{ textAlign: 'center' }}>৳{row.projected.toLocaleString()}</td>
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

                   <div className="flex items-center gap-2 mb-6">
                      <Search className="w-4 h-4 text-slate-400" />
                      <input
                        type="text"
                        placeholder="Filter drilldown by client name, mobile or area..."
                        value={popupSearch}
                        onChange={(e) => setPopupSearch(e.target.value)}
                        className="ep-search"
                        style={{ flex: 1 }}
                      />
                   </div>

                   <div className="ep-card ep-tablecard">
                      <div className="max-h-[55vh] overflow-y-auto ep-tablewrap">
                        <table>
                           <thead>
                              <tr>
                                 <th>Client Name</th>
                                 <th>Area</th>
                                 <th style={{ textAlign: 'center' }}>NCP Collected</th>
                                 <th style={{ textAlign: 'center' }}>Current Status</th>
                              </tr>
                           </thead>
                           <tbody>
                              {getFilteredLeadsForPopup().length === 0 ? (
                                 <tr>
                                    <td colSpan={4} className="ep-td-empty">
                                       No active logs registered for this KPI
                                    </td>
                                 </tr>
                              ) : (
                                getFilteredLeadsForPopup().map((lead, idx) => (
                                   <tr key={lead.id || idx}>
                                      <td><strong>{lead.prospectName}</strong></td>
                                      <td>{lead.area}</td>
                                      <td style={{ textAlign: 'center' }}><strong>৳{(lead.collectedNCP || 0).toLocaleString()}</strong></td>
                                      <td style={{ textAlign: 'center' }}>
                                         <span className="ep-pill">
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
                     type="button"
                     onClick={() => setActivePopup(null)}
                     className="ep-btn ep-btn-primary"
                     style={{ width: '100%', justifyContent: 'center' }}
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
