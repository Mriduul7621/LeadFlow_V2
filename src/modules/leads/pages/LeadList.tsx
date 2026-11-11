import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Search,
  Filter,
  Download,
  MoreHorizontal,
  Phone,
  MessageSquare,
  Clock,
  ChevronLeft,
  ChevronRight,
  Eye,
  Calendar,
  RefreshCw,
  Edit2,
  Target,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { motion } from 'framer-motion';
import { useAuthStore } from '../../auth/store/authStore';
import { Lead, LeadQuality, LeadStatus } from '../../shared/types';
import { toast } from 'sonner';
import { leadService } from '../services/leadService';
import { settingsService } from '../../../services/settingsService';
import AdvancedFilterPanel from '../../shared/components/AdvancedFilterPanel';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { getLeadStatusColorClasses, getLeadStatusOrder } from '../../workflow/utils/leadStatusMeta';
import LeadQualityBadge from '../components/LeadQualityBadge';

const getStatusColor = (status: string) => getLeadStatusColorClasses(status);

export default function LeadList() {
  const { user } = useAuthStore();
  const { canAccess } = usePermissions();
  const canEditLead = canAccess('lead_tracking', 'edit');
  const canExportLeads = canAccess('lead_tracking', 'export');
  const location = useLocation();
  const navigate = useNavigate();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [advancedFilteredLeads, setAdvancedFilteredLeads] = useState<Lead[]>([]);
  const [sortLogic, setSortLogic] = useState<'Recency' | 'Economic Potential' | 'Priority Status' | 'Quality: High to Low' | 'Quality: Low to High'>('Recency');
  // Lead Quality band filter — compares the SERVER-computed band only.
  const [qualityBand, setQualityBand] = useState<string>('All');
  const [search, setSearch] = useState('');
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [activeStatus, setActiveStatus] = useState('All');
  const mobileSearchRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(true);
  const [statusOptions, setStatusOptions] = useState<string[]>([]);

  // FIX-1c — deep links (?leadId=, used by notifications and the Task
  // Calendar) land on the Lead 360 workspace, the same full-page format
  // every other lead entry point opens. The old in-list detail modal is
  // gone: opening or editing a lead from this page navigates to
  // /leads/:id, and status updates run through Lead 360's Update page.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const leadId = params.get('leadId');
    if (leadId) {
      navigate(`/leads/${encodeURIComponent(leadId)}`, { replace: true });
    }
  }, [location.search, navigate]);

  // Lead Workspace intentionally has no assignment-management data load.
  // Ownership changes belong to Lead Pool; this page stays focused on
  // operational execution against the server-visible lead set.

  useEffect(() => {
    loadLeads();
    loadStatusOptions();
  }, [user]);

  useEffect(() => {
    if (mobileSearchOpen) mobileSearchRef.current?.focus();
  }, [mobileSearchOpen]);

  const loadLeads = async () => {
    if (!user) return;
    setLoading(true);
    try {
      // The API derives both identity and Data Visibility from the session.
      // Do not send a client-selected role or employee id to widen scope.
      const visibleLeads = await leadService.getLeads();
      setLeads(visibleLeads);
    } catch (err) {
      toast.error('Failed to sync lead intelligence');
    } finally {
      setLoading(false);
    }
  };

  const DEFAULT_STATUS_LIST: LeadStatus[] = [
    'New',
    'Contacted',
    'No Response',
    'Busy',
    'Interested',
    'Follow-up Set',
    'Meeting Fixed',
    'Meeting Completed',
    'Pipeline Locked',
    'Converted',
    'Not Interested'
  ];
  const statusTabs = [
    'All',
    ...Array.from(new Set([
      ...(statusOptions.length ? statusOptions : DEFAULT_STATUS_LIST),
      ...leads.map(lead => lead.currentStatus).filter(Boolean),
    ])),
  ];

  const loadStatusOptions = async () => {
    try {
      const res = await settingsService.getOptionsByType('FollowUpStatus');
      setStatusOptions(res && res.length > 0 ? res : DEFAULT_STATUS_LIST);
    } catch (err) {
      console.error(err);
      setStatusOptions(DEFAULT_STATUS_LIST);
    }
  };

  const filteredLeads = (() => {
    // Authoritative source of rules-filtered leads from dynamic query builder
    const baseList = advancedFilteredLeads.length > 0 || leads.length === 0 ? advancedFilteredLeads : leads;

    // Narrow by server-computed Lead Quality band (never widens scope).
    const statusScoped = activeStatus === 'All'
      ? baseList
      : baseList.filter(lead => String(lead.currentStatus || '').toLowerCase() === activeStatus.toLowerCase());
    const qualityScoped =
      qualityBand === 'All'
        ? statusScoped
        : statusScoped.filter(lead => (lead.leadQuality as LeadQuality | undefined)?.band === qualityBand);

    // Filter using fast text search across demographics
    let result = qualityScoped.filter(lead => {
      const prospectName = String(lead.prospectName || '').toLowerCase();
      const mobile = String(lead.mobile || '');
      const mobileNum = String(lead.mobileNumber || '').toLowerCase();
      const campaignName = String(lead.campaignName || '').toLowerCase();
      const areaVal = String(lead.area || '').toLowerCase();
      const sourceVal = String(lead.source || '').toLowerCase();
      const searchTerm = search.toLowerCase();

      const matchesRemarks = (lead.statusHistory || []).some(h => 
        String(h.remarks || '').toLowerCase().includes(searchTerm)
      );

      return prospectName.includes(searchTerm) || 
             mobile.includes(search) ||
             mobileNum.includes(search) ||
             campaignName.includes(searchTerm) ||
             areaVal.includes(searchTerm) ||
             sourceVal.includes(searchTerm) ||
             matchesRemarks;
    });

    // Apply sort criteria
    result = [...result].sort((a, b) => {
      if (sortLogic === 'Recency') {
        const keyA = new Date(a.timestamp || a.creationDate || 0).getTime();
        const keyB = new Date(b.timestamp || b.creationDate || 0).getTime();
        return keyB - keyA;
      } else if (sortLogic === 'Economic Potential') {
        const potA = (a.collectedNCP || 0) + (a.projectedNCP || 0);
        const potB = (b.collectedNCP || 0) + (b.projectedNCP || 0);
        return potB - potA;
      } else if (sortLogic === 'Priority Status') {
        return getLeadStatusOrder(b.currentStatus) - getLeadStatusOrder(a.currentStatus);
      } else if (sortLogic === 'Quality: High to Low' || sortLogic === 'Quality: Low to High') {
        // Sort by the SERVER-computed score (missing scores sort last).
        const scoreA = (a.leadQuality as LeadQuality | undefined)?.score;
        const scoreB = (b.leadQuality as LeadQuality | undefined)?.score;
        const valA = typeof scoreA === 'number' ? scoreA : -1;
        const valB = typeof scoreB === 'number' ? scoreB : -1;
        if (valA !== valB) return sortLogic === 'Quality: High to Low' ? valB - valA : valA - valB;
        const keyA = new Date(a.timestamp || a.creationDate || 0).getTime();
        const keyB = new Date(b.timestamp || b.creationDate || 0).getTime();
        return keyB - keyA;
      }
      return 0;
    });

    return result;
  })();

  const handleExport = () => {
    if (!canExportLeads) {
      toast.error('You do not have permission to export leads.');
      return;
    }
    if (leads.length === 0) {
      toast.error("No lead data available to export.");
      return;
    }

    // Define CSV Headers
    const headers = [
      "Prospect Name",
      "Mobile",
      "Area",
      "Source",
      "Campaign Name",
      "Product Name",
      "Profession",
      "Marital Status",
      "Family Members",
      "Has Child",
      "Assigned To Agent",
      "Projected NCP",
      "Collected NCP",
      "Current Status",
      "Creation Date",
      "Last Follow Up Date",
      "Next Follow Up Date",
      "Change Audit History (Date | Status | Remarks | UpdatedBy)"
    ];

    // Escape CSV values
    const escapeCSV = (val: any) => {
      if (val === undefined || val === null) return "";
      let str = typeof val === 'string' ? val : String(val);
      // Double quote escape
      str = str.replace(/"/g, '""');
      return `"${str}"`;
    };

    // Construct spreadsheet rows
    const rows = leads.map(lead => {
      // Format history entries
      const historyStr = (lead.statusHistory || [])
        .map(h => {
          const formattedDate = h.date ? new Date(h.date).toLocaleString().replace(/"/g, '""') : '';
          const statusVal = h.status || '';
          const remarksVal = h.remarks || '';
          const userVal = h.updatedBy || 'N/A';
          return `[${formattedDate}] Status: ${statusVal} -> Remarks: ${remarksVal} (By: ${userVal})`;
        })
        .join("; ");

      return [
        escapeCSV(lead.prospectName),
        escapeCSV(lead.mobile),
        escapeCSV(lead.area),
        escapeCSV(lead.source),
        escapeCSV(lead.campaignName),
        escapeCSV(lead.productName),
        escapeCSV(lead.profession),
        escapeCSV(lead.maritalStatus),
        escapeCSV(lead.familyMember),
        escapeCSV(lead.hasChild ? "Yes" : "No"),
        escapeCSV(lead.assignedTo),
        escapeCSV(lead.projectedNCP),
        escapeCSV(lead.collectedNCP),
        escapeCSV(lead.currentStatus),
        escapeCSV(lead.creationDate ? new Date(lead.creationDate).toLocaleString() : ""),
        escapeCSV(lead.lastFollowUpDate ? new Date(lead.lastFollowUpDate).toLocaleString() : ""),
        escapeCSV(lead.nextFollowUpDate ? new Date(lead.nextFollowUpDate).toLocaleDateString() : ""),
        escapeCSV(historyStr)
      ];
    });

    const csvContent = [
      headers.join(","),
      ...rows.map(row => row.join(","))
    ].join("\n");

    // Create a Blob and download it with UTF-8 BOM
    const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `Shanta_Life_Lead_Intelligence_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    toast.success("Intelligence CSV Report downloaded successfully with historical change audits!");
  };

  const handleCall = (name: string) => {
    toast(`Initiating secure call to ${name}...`, {
      icon: <Phone className="w-4 h-4 text-brand-blue" />
    });
  };

  if (!canAccess('lead_tracking', 'view')) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center p-8 bg-white border border-slate-100 rounded-sm shadow-sm max-w-xl mx-auto space-y-3">
        <h2 className="text-xl font-bold text-slate-800">Lead Workspace unavailable</h2>
        <p className="text-sm text-slate-500">Your current Feature Access does not include the Lead Workspace.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-4">
          <RefreshCw className="w-8 h-8 text-primary animate-spin" />
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Loading leads...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-20 bg-white min-h-screen">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 px-1">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight text-slate-800">Lead Workspace</h1>
            <p className="text-sm text-slate-500 mt-1">Manage assigned leads, update progress, and schedule the next action.</p>
          </div>
          <div className="lf-mobile-lead-tools" aria-label="Lead search and filters">
            <button
              type="button"
              onClick={() => setMobileSearchOpen((open) => !open)}
              className={cn('lf-mobile-lead-tool', mobileSearchOpen && 'is-active')}
              aria-label={mobileSearchOpen ? 'Close lead search' : 'Search leads'}
              aria-expanded={mobileSearchOpen}
              aria-controls="mobile-lead-search"
            >
              <Search size={19} />
            </button>
            <button
              type="button"
              onClick={() => setMobileFiltersOpen((open) => !open)}
              className={cn('lf-mobile-lead-tool', mobileFiltersOpen && 'is-active')}
              aria-label={mobileFiltersOpen ? 'Close lead filters' : 'Filter leads'}
              aria-expanded={mobileFiltersOpen}
              aria-controls="mobile-lead-filters"
            >
              <Filter size={19} />
            </button>
          </div>
        </div>
        <div className="lf-desktop-lead-actions flex items-center gap-2">
          <button 
            onClick={() => {
              const panelBtn = document.getElementById('btn-advanced-filter-toggle');
              if (panelBtn) {
                panelBtn.click();
                panelBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            }}
            className="flex items-center gap-2 px-4 py-2 border border-slate-100 hover:bg-slate-50 text-[10px] font-black uppercase tracking-widest transition-all rounded-sm shadow-sm group cursor-pointer"
          >
            <Filter className="w-3.5 h-3.5 text-slate-400 group-hover:text-primary" />
            Segment Matrix
          </button>
          {canExportLeads && (
            <button
              onClick={handleExport}
              className="flex items-center gap-2 px-4 py-2 bg-slate-900 hover:bg-black text-white text-[10px] font-black uppercase tracking-widest transition-all rounded-sm shadow-md"
            >
              <Download className="w-3.5 h-3.5 text-[#978C21]" />
              Export Intelligence
            </button>
          )}
        </div>
      </div>

      {mobileSearchOpen && (
        <div className="lf-mobile-lead-search" id="mobile-lead-search">
          <Search className="lf-mobile-lead-search-icon" size={18} aria-hidden="true" />
          <input
            ref={mobileSearchRef}
            type="search"
            placeholder="Search name, phone, area..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search leads by name, phone, or area"
          />
        </div>
      )}

      {mobileFiltersOpen && (
        <div className="lf-mobile-lead-filters" id="mobile-lead-filters">
          <label>
            <span>Lead quality</span>
            <select value={qualityBand} onChange={(e) => setQualityBand(e.target.value)}>
              <option value="All">All quality</option>
              <option value="Hot">Hot</option>
              <option value="Warm">Warm</option>
              <option value="Developing">Developing</option>
              <option value="Cold">Cold</option>
              <option value="Converted">Converted</option>
              <option value="Not Interested">Not interested</option>
            </select>
          </label>
          <label>
            <span>Sort leads</span>
            <select
              value={sortLogic}
              onChange={(e) => setSortLogic(e.target.value as typeof sortLogic)}
            >
              <option value="Recency">Most recent</option>
              <option value="Economic Potential">Economic potential</option>
              <option value="Priority Status">Priority status</option>
              <option value="Quality: High to Low">Quality: high to low</option>
              <option value="Quality: Low to High">Quality: low to high</option>
            </select>
          </label>
        </div>
      )}

      <div className="flex gap-2 overflow-x-auto border-b border-stone-100 pb-2" role="tablist" aria-label="Filter leads by status">
        {statusTabs.map(status => {
          const count = status === 'All'
            ? leads.length
            : leads.filter(lead => String(lead.currentStatus || '').toLowerCase() === status.toLowerCase()).length;
          const active = activeStatus === status;
          return (
            <button
              key={status}
              type="button"
              role="tab"
              aria-selected={active}
              aria-pressed={active}
              onClick={() => setActiveStatus(status)}
              className={cn(
                'inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-xs font-semibold transition-colors',
                active
                  ? 'border-[#978C21] bg-[#978C21] text-white'
                  : 'border-stone-200 bg-white text-stone-600 hover:border-stone-300 hover:bg-stone-50',
              )}
            >
              {status}
              <span className={cn('text-[10px]', active ? 'text-white/80' : 'text-stone-400')}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* Advanced multi-criteria search and dynamic filtering builder */}
      <AdvancedFilterPanel 
        onFilterChange={setAdvancedFilteredLeads} 
        allLeads={leads} 
        className={cn(
          'mx-1 shadow-sm bg-white border border-slate-100 rounded-sm lf-lead-advanced-filters',
          mobileFiltersOpen && 'is-mobile-open',
        )}
        isOpen={mobileFiltersOpen}
        onOpenChange={setMobileFiltersOpen}
      />

      <div className="bg-white rounded-sm border border-slate-100 shadow-sm overflow-hidden mx-1">
        <div className="lf-desktop-lead-controls p-6 border-b border-slate-50 flex flex-col md:flex-row md:items-center gap-6 bg-[#FBFAF8]">
          <div className="relative flex-1">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input 
              type="text" 
              placeholder="Search Intelligence Matrix..." 
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-12 pr-4 py-3 bg-white border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] outline-none transition-all shadow-sm italic placeholder:text-slate-300"
            />
          </div>
          <div className="flex items-center gap-4">
             <div className="h-10 w-px bg-slate-200 hidden md:block" />
            <label className="text-[10px] font-black text-slate-300 uppercase tracking-widest italic whitespace-nowrap">Quality</label>
            <select
              value={qualityBand}
              onChange={(e) => setQualityBand(e.target.value)}
              title="Filter by server-computed Lead Quality band"
              className="bg-white border border-slate-100 rounded-sm px-4 py-2.5 text-[10px] font-black uppercase tracking-widest focus:ring-2 focus:ring-primary/5 outline-none shadow-sm cursor-pointer hover:bg-slate-50 transition-colors"
            >
              <option value="All">All Quality</option>
              <option value="Hot">Hot</option>
              <option value="Warm">Warm</option>
              <option value="Developing">Developing</option>
              <option value="Cold">Cold</option>
              <option value="Converted">Converted</option>
              <option value="Not Interested">Not Interested</option>
            </select>
            <label className="text-[10px] font-black text-slate-300 uppercase tracking-widest italic whitespace-nowrap">Sort by</label>
            <select 
              value={sortLogic}
              onChange={(e) => setSortLogic(e.target.value as any)}
              className="bg-white border border-slate-100 rounded-sm px-4 py-2.5 text-[10px] font-black uppercase tracking-widest focus:ring-2 focus:ring-primary/5 outline-none shadow-sm cursor-pointer hover:bg-slate-50 transition-colors"
            >
              <option value="Recency">Recency</option>
              <option value="Economic Potential">Economic Potential</option>
              <option value="Priority Status">Priority Status</option>
              <option value="Quality: High to Low">Quality: High to Low</option>
              <option value="Quality: Low to High">Quality: Low to High</option>
            </select>
          </div>
        </div>

        <div className="lf-mobile-lead-list" aria-label="Lead prospects">
  {filteredLeads.length > 0 ? filteredLeads.map((lead) => (
    <div key={lead.id} className="lf-mobile-lead-row">
      <button
        type="button"
        className="lf-mobile-lead-open"
        onClick={() => navigate('/leads/' + lead.id)}
        aria-label={'Open details for ' + (lead.prospectName || 'Unknown Prospect')}
      >
        <span className="lf-mobile-lead-avatar" aria-hidden="true">
          {String(lead.prospectName || 'U').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}
        </span>
        <span className="lf-mobile-lead-copy">
          <strong>{lead.prospectName || 'Unknown Prospect'}</strong>
          <small>{lead.mobile || 'No mobile'}{lead.area ? ' · ' + lead.area : ''}</small>
          <span className="lf-mobile-lead-status">{lead.currentStatus || 'New'}</span>
        </span>
      </button>
      {/* Quick status update straight from the list (same rule as Lead 360:
          only when the role may edit leads). */}
      {canEditLead && (
        <button
          type="button"
          className="lf-row-action lf-row-action--primary"
          onClick={() => navigate(`/leads/${encodeURIComponent(lead.id)}/update`)}
          aria-label={'Update status for ' + (lead.prospectName || 'lead')}
          title="Update status"
        >
          <Target size={17} />
        </button>
      )}
      <button
        type="button"
        className="lf-row-action"
        onClick={() => navigate('/leads/' + lead.id)}
        aria-label={'Open details for ' + (lead.prospectName || 'Unknown Prospect')}
        title="Open lead"
      >
        <ChevronRight size={19} aria-hidden="true" />
      </button>
    </div>
  )) : <div className="lf-mobile-lead-empty">No prospects match your filters.</div>}
</div>

<div className="lf-desktop-lead-table overflow-x-auto">
  <table className="w-full text-left">
            <thead>
              <tr className="bg-[#F8F8F5] text-slate-600">
                <th className="px-8 py-6 text-[10px] font-black uppercase tracking-[0.2em] border-r border-white/5">Prospect</th>
                <th className="px-6 py-6 text-[10px] font-black uppercase tracking-[0.2em] border-r border-white/5">Owner / Next Action</th>
                <th className="px-6 py-6 text-[10px] font-black uppercase tracking-[0.2em] border-r border-white/5">Campaign / Source</th>
                <th className="px-6 py-6 text-[10px] font-black uppercase tracking-[0.2em] border-r border-white/5">Current Status</th>
                <th className="px-6 py-6 text-[10px] font-black uppercase tracking-[0.2em] border-r border-white/5">Quality</th>
                <th className="px-6 py-6 text-[10px] font-black uppercase tracking-[0.2em] border-r border-white/5">Last Activity</th>
                <th className="px-6 py-6 text-[10px] font-black uppercase tracking-[0.2em] text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredLeads.length > 0 ? filteredLeads.map((lead, idx) => (
                <motion.tr 
                  key={lead.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  className="group hover:bg-[#FBFAF8] transition-colors cursor-pointer relative"
                  onClick={() => navigate(`/leads/${lead.id}`)}
                >
                  <td className="px-8 py-6">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-xl bg-[#F7F5E9] flex items-center justify-center text-[#817719] font-bold text-xs shrink-0 border border-[#EAE7D6] transition-colors group-hover:bg-[#978C21] group-hover:text-white">
                        {String(lead.prospectName || 'U').split(' ').map(n => n[0] || '').join('')}
                      </div>
                      <div>
                        <div className="font-bold text-brand-text text-[13px] group-hover:text-[#817719] transition-colors tracking-tight flex items-center gap-2">
                           {lead.prospectName || 'Unknown Prospect'}
                           {(lead.collectedNCP || 0) > 100000 && <span className="w-2 h-2 rounded-full bg-[#978C21]" />}
                           <button
                              onClick={(e) => { e.stopPropagation(); navigate(`/leads/${lead.id}`); }}
                              title="View full timeline"
                              className="text-[8px] font-black text-[#978C21] bg-[#978C21]/10 px-1.5 py-0.5 rounded-sm uppercase tracking-wider hover:bg-[#978C21]/20 transition-all shrink-0 normal-case not-italic"
                           >
                              Timeline
                           </button>
                           {canEditLead && (
                             <button
                               onClick={(e) => { e.stopPropagation(); navigate(`/leads/${encodeURIComponent(lead.id)}/update`); }}
                               title="Update status"
                               aria-label={'Update status for ' + (lead.prospectName || 'lead')}
                               className="text-[8px] font-black text-white bg-[#978C21] px-1.5 py-0.5 rounded-sm uppercase tracking-wider hover:bg-[#8a7f1e] transition-all shrink-0 normal-case not-italic"
                             >
                                Update
                             </button>
                           )}
                        </div>
                        <p className="text-[10px] text-slate-400 font-bold flex items-center gap-1 uppercase tracking-tight mt-1 opacity-60">
                          <Phone className="w-3 h-3 text-brand-blue" /> {lead.mobile || 'No Mobile'} • {lead.area || 'No Area'}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-6 border-l border-slate-50/50">
                    <p className="text-[11px] font-black text-[#978C21] uppercase tracking-tight italic">{lead.assignedTo || 'Unassigned'}</p>
                    <p className="text-[9px] text-slate-400 font-bold uppercase tracking-widest mt-1">
                      {lead.nextFollowUpDate ? `Next: ${new Date(lead.nextFollowUpDate).toLocaleDateString('en-GB')}` : 'No next action set'}
                    </p>
                    {(lead.projectedNCP || lead.collectedNCP) ? (
                      <p className="text-[9px] text-emerald-600 font-bold mt-1">NCP signal: ৳ {(lead.collectedNCP || lead.projectedNCP || 0).toLocaleString()}</p>
                    ) : null}
                  </td>
                  <td className="px-6 py-6 border-l border-slate-50/50">
                    <p className="text-[11px] font-black text-slate-400 uppercase tracking-tight italic">{lead.campaignName || 'N/A'}</p>
                    <p className="text-[9px] text-slate-300 font-black uppercase tracking-widest mt-1">{lead.source || 'N/A'}</p>
                  </td>
                  <td className="px-6 py-6 border-l border-slate-50/50">
                    <span className={cn(
                      "px-3 py-1.5 rounded-sm text-[9px] font-black uppercase tracking-widest border transition-all",
                      getStatusColor(lead.currentStatus)
                    )}>
                      {lead.currentStatus}
                    </span>
                  </td>
                  <td className="px-6 py-6 border-l border-slate-50/50">
                    <LeadQualityBadge quality={lead.leadQuality} />
                  </td>
                  <td className="px-6 py-6 border-l border-slate-50/50 max-w-[200px]">
                    {(() => {
                      const latestHistory = lead.statusHistory && lead.statusHistory.length > 0 
                        ? lead.statusHistory[lead.statusHistory.length - 1] 
                        : null;
                      const latestRemark = latestHistory ? latestHistory.remarks : "No remarks logged";
                      return (
                        <p className="text-[11px] font-medium text-slate-500 italic truncate" title={latestRemark}>
                          {latestRemark}
                        </p>
                      );
                    })()}
                  </td>
                  <td className="px-6 py-6 text-right">
                    <div className="flex items-center justify-end gap-1.5 opacity-100 transition-opacity">
                       <button 
                         onClick={(e) => { e.stopPropagation(); navigate(`/leads/${lead.id}`); }}
                         className="p-2 border border-slate-100 hover:border-[#978C21] text-slate-400 hover:text-[#978C21] hover:bg-slate-50 rounded-sm shadow-xs transition-all bg-white cursor-pointer"
                         title="Edit — open lead workspace"
                         aria-label={'Edit lead in workspace for ' + (lead.prospectName || 'lead')}
                       >
                        <Edit2 className="w-3.5 h-3.5" />
                       </button>
                       <button 
                         onClick={(e) => { e.stopPropagation(); handleCall(lead.prospectName || 'Prospect'); }}
                         className="p-2 border border-slate-100 hover:border-blue-300 text-blue-700 hover:text-blue-700 hover:bg-blue-50 rounded-sm shadow-xs transition-all bg-white cursor-pointer"
                         title="Call Prospect"
                       >
                        <Phone className="w-3.5 h-3.5" />
                       </button>
                    </div>
                  </td>
                </motion.tr>
              )) : (
                <tr>
                  <td colSpan={7} className="px-8 py-20 text-center">
                    <div className="flex flex-col items-center gap-3">
                       <div className="w-12 h-12 bg-slate-50 rounded-full flex items-center justify-center">
                          <Search className="w-6 h-6 text-slate-200" />
                       </div>
                       <p className="text-[10px] font-black text-slate-300 uppercase tracking-[0.3em] italic">No lead entities found matching criteria</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="px-4 py-8 flex flex-col md:flex-row items-center justify-between gap-6 opacity-30 mt-4 mx-1 italic">
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none underline decoration-slate-200 underline-offset-4">Showing {filteredLeads.length} Matrix Entities</p>
        <div className="flex items-center gap-2">
          <button className="p-3 hover:bg-slate-50 rounded-sm disabled:opacity-20 transition-all border border-transparent hover:border-slate-100">
            <ChevronLeft className="w-4 h-4 text-slate-400" />
          </button>
          <div className="flex items-center gap-1.5 px-6">
            {[1, 2, 3].map(p => (
              <button 
                key={p} 
                className={cn(
                  "w-10 h-10 rounded-sm text-[11px] font-black transition-all border shadow-sm",
                  p === 1 ? "bg-[#3C3C3C] text-white border-[#3C3C3C]" : "text-slate-300 border-transparent hover:border-slate-100 hover:text-slate-600"
                )}
              >
                {p}
              </button>
            ))}
          </div>
          <button className="p-3 hover:bg-slate-50 rounded-sm transition-all border border-transparent hover:border-slate-100">
            <ChevronRight className="w-4 h-4 text-slate-400" />
          </button>
        </div>
      </div>


    </div>
  );
}
