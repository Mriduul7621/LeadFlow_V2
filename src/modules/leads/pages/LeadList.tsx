import React, { useEffect, useState } from 'react';
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
  CheckCircle, 
  XCircle, 
  Calendar, 
  RefreshCw,
  Edit2,
  Trash2
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuthStore } from '../../auth/store/authStore';
import { UserRole, Lead, LeadStatus } from '../../shared/types';
import { toast } from 'sonner';
import { leadService } from '../services/leadService';
import { settingsService } from '../../../services/settingsService';
import { userService } from '../../users/services/userService';
import AdvancedFilterPanel from '../../shared/components/AdvancedFilterPanel';
import { getLeadStatusColorClasses, getLeadStatusOrder } from '../../workflow/utils/leadStatusMeta';

const getStatusColor = (status: string) => getLeadStatusColorClasses(status);

const formatToDateTimeLocal = (dateStr?: string) => {
  if (!dateStr) return '';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dateStr)) return dateStr;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const date = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${date}T${hours}:${minutes}`;
  } catch (e) {
    return '';
  }
};

export default function LeadList() {
  const { user } = useAuthStore();
  const location = useLocation();
  const navigate = useNavigate();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [advancedFilteredLeads, setAdvancedFilteredLeads] = useState<Lead[]>([]);
  const [sortLogic, setSortLogic] = useState<'Recency' | 'Economic Potential' | 'Priority Status'>('Recency');
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [statusOptions, setStatusOptions] = useState<string[]>([]);
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [selectedRO, setSelectedRO] = useState<string>('');

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const leadId = params.get('leadId');
    if (leadId && leads.length > 0) {
      const matched = leads.find(l => l.id === leadId);
      if (matched) {
        setSelectedLead(matched);
        setSearch(''); // clear quick search
        setAdvancedFilteredLeads([]); // clear advanced filters
      }
    }
  }, [location.search, leads]);

  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const list = await userService.getAllUsers();
        setAllUsers(list);
      } catch (err) {
        console.error(err);
      }
    };
    fetchUsers();
  }, []);

  // Editing state fields for granular updates
  const [formStatus, setFormStatus] = useState<LeadStatus | ''>('');
  const [formRemarks, setFormRemarks] = useState('');
  const [formNextFollowUpDate, setFormNextFollowUpDate] = useState('');
  const [formCollectedNCP, setFormCollectedNCP] = useState<number>(0);
  const [formNextCallDate, setFormNextCallDate] = useState('');
  const [formMeetingDate, setFormMeetingDate] = useState('');
  const [formSubStatus, setFormSubStatus] = useState<'Pipeline Locked' | 'Not Interested' | ''>('');
  const [formSumAssured, setFormSumAssured] = useState<number>(0);
  const [formProductName, setFormProductName] = useState('');
  const [formProjectedNCP, setFormProjectedNCP] = useState<number>(0);
  const [productOptions, setProductOptions] = useState<string[]>([]);

  // Sync form states with selected lead
  useEffect(() => {
    if (selectedLead) {
      setFormStatus(selectedLead.currentStatus);
      setFormRemarks('');
      setFormNextFollowUpDate(selectedLead.nextFollowUpDate || '');
      setFormCollectedNCP(selectedLead.collectedNCP || 0);
      setFormNextCallDate(selectedLead.nextCallDate || '');
      setFormMeetingDate(selectedLead.meetingDate || '');
      setFormSubStatus('');
      setFormSumAssured(selectedLead.sumAssured || 0);
      setFormProductName(selectedLead.productName || '');
      setFormProjectedNCP(selectedLead.projectedNCP || 0);
    } else {
      setFormStatus('');
      setFormRemarks('');
      setFormNextFollowUpDate('');
      setFormCollectedNCP(0);
      setFormNextCallDate('');
      setFormMeetingDate('');
      setFormSubStatus('');
      setFormSumAssured(0);
      setFormProductName('');
      setFormProjectedNCP(0);
    }
  }, [selectedLead]);

  useEffect(() => {
    loadLeads();
    loadStatusOptions();
  }, [user]);

  const loadLeads = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const allLeads = await leadService.getLeads({ 
        role: user.role, 
        employeeId: user.employeeId 
      });
      
      setLeads(allLeads);
    } catch (err) {
      toast.error('Failed to sync lead intelligence');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Apply a server-confirmed lead mutation in place instead of refetching
   * the full lead list (which would also re-fetch the users list just for
   * the visibility filter). The mutation response carries the
   * authoritative row, so the local list is patched with it.
   */
  const applyLeadUpdate = (updated: Lead) => {
    const patch = (list: Lead[]) => list.map(l => (l.id === updated.id ? updated : l));
    setLeads(prev => patch(prev));
    setAdvancedFilteredLeads(prev => (prev.some(l => l.id === updated.id) ? patch(prev) : prev));
  };

  const handleDeleteLead = async (leadId: string) => {
    if (!window.confirm('Are you sure you want to permanently delete this lead?')) return;
    try {
      await leadService.deleteLead(leadId);
      toast.success('Lead has been deleted successfully');
      // The server confirmed the soft delete; remove the row locally
      // instead of refetching the entire lead list.
      setLeads(prev => prev.filter(l => l.id !== leadId));
      setAdvancedFilteredLeads(prev => prev.filter(l => l.id !== leadId));
    } catch (err) {
      toast.error('Failed to delete the lead');
    }
  };

  const DEFAULT_STATUS_LIST: LeadStatus[] = [
    'Untouched',
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

  const loadStatusOptions = async () => {
    try {
      const res = await settingsService.getOptionsByType('FollowUpStatus');
      setStatusOptions(res && res.length > 0 ? res : DEFAULT_STATUS_LIST);
      
      const prodRes = await settingsService.getOptionsByType('Product');
      setProductOptions(prodRes || []);
    } catch (err) {
      console.error(err);
      setStatusOptions(DEFAULT_STATUS_LIST);
    }
  };

  const handleSaveLeadUpdate = async () => {
    if (!selectedLead) return;
    if (!formStatus) {
      toast.error('Please select a target status');
      return;
    }
    if (!formRemarks.trim()) {
      toast.error('Remarks are mandatory to fill when editing status!');
      return;
    }

    if (formStatus === 'No Response' && !formNextCallDate) {
      toast.error('Next Call Date is mandatory for No Response status!');
      return;
    }
    if (formStatus === 'Meeting Fixed' && !formMeetingDate) {
      toast.error('Meeting Date is mandatory for Meeting Fixed status!');
      return;
    }
    if ((formStatus === 'Follow-up Set' || formStatus === 'Interested' || formStatus === 'Busy') && !formNextFollowUpDate) {
      toast.error(`Next Follow-up Date is mandatory for ${formStatus} status!`);
      return;
    }
    if (formStatus === 'Meeting Completed' && !formSubStatus) {
      toast.error('Please select a sub-status (Pipeline Locked or Not Interested) for Meeting Completed!');
      return;
    }

    const isPipelineLocked = formStatus === 'Pipeline Locked' || (formStatus === 'Meeting Completed' && formSubStatus === 'Pipeline Locked');
    const isConverted = formStatus === 'Converted';

    if (isPipelineLocked) {
      if (!formProductName) {
        toast.error('Product Name is mandatory for Pipeline Locked status!');
        return;
      }
      if (!formSumAssured || formSumAssured <= 0) {
        toast.error('Sum Assured is mandatory and must be greater than zero for Pipeline Locked!');
        return;
      }
      if (!formProjectedNCP || formProjectedNCP <= 0) {
        toast.error('Projected NCP is mandatory and must be greater than zero for Pipeline Locked!');
        return;
      }
    }

    if (isConverted) {
      if (!formProductName) {
        toast.error('Product Name is mandatory for Converted status!');
        return;
      }
      if (!formSumAssured || formSumAssured <= 0) {
        toast.error('Sum Assured is mandatory and must be greater than zero for Converted!');
        return;
      }
      if (!formCollectedNCP || formCollectedNCP <= 0) {
        toast.error('Collected NCP is mandatory and must be greater than zero for Converted!');
        return;
      }
    }

    try {
      const updaterName = user ? `${user.name} (${user.employeeId})` : 'System';
      const finalStatus: LeadStatus = formStatus === 'Meeting Completed' ? (formSubStatus as LeadStatus) : formStatus;

      const updated = await leadService.updateLeadStatus(
        selectedLead.id, 
        finalStatus, 
        isConverted ? formCollectedNCP : undefined, 
        formRemarks, 
        (finalStatus === 'Follow-up Set' || finalStatus === 'Interested' || finalStatus === 'Busy') ? formNextFollowUpDate : undefined,
        updaterName,
        formStatus === 'No Response' ? formNextCallDate : undefined,
        formStatus === 'Meeting Fixed' ? formMeetingDate : undefined,
        (isPipelineLocked || isConverted) ? formSumAssured : undefined,
        (isPipelineLocked || isConverted) ? formProductName : undefined,
        isPipelineLocked ? formProjectedNCP : undefined
      );
      toast.success('Lead status and remarks logged successfully!');

      // The follow-up response carries the authoritative updated lead —
      // patch the list in place instead of refetching the full lead list.
      if (updated) applyLeadUpdate(updated);
      else loadLeads();

      // Close the tracking details popup/modal automatically
      setSelectedLead(null);
      setFormRemarks(''); // clear comments textarea
    } catch (err) {
      toast.error('Failed to update lead status');
    }
  };

  const handleUpdateStatus = async (leadId: string, status: LeadStatus, ncp?: number) => {
    try {
      const updated = await leadService.updateLeadStatus(leadId, status, ncp, 'Initial assignment tracking');
      toast.success('Lead intelligence updated');
      if (updated) applyLeadUpdate(updated);
      else loadLeads();
      setSelectedLead(null);
    } catch (err) {
      toast.error('Failed to update lead status');
    }
  };

  const filteredLeads = (() => {
    // Authoritative source of rules-filtered leads from dynamic query builder
    const baseList = advancedFilteredLeads.length > 0 || leads.length === 0 ? advancedFilteredLeads : leads;

    // Filter using fast text search across demographics
    let result = baseList.filter(lead => {
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
      }
      return 0;
    });

    return result;
  })();

  const handleExport = () => {
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
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-800">Lead Tracking</h1>
          <p className="text-sm text-slate-500 mt-1">View and manage your leads pipeline</p>
        </div>
        <div className="flex items-center gap-2">
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
          <button 
            onClick={handleExport}
            className="flex items-center gap-2 px-4 py-2 bg-slate-900 hover:bg-black text-white text-[10px] font-black uppercase tracking-widest transition-all rounded-sm shadow-md"
          >
            <Download className="w-3.5 h-3.5 text-[#978C21]" />
            Export Intelligence
          </button>
        </div>
      </div>

      {/* Advanced multi-criteria search and dynamic filtering builder */}
      <AdvancedFilterPanel 
        onFilterChange={setAdvancedFilteredLeads} 
        allLeads={leads} 
        className="mx-1 shadow-sm bg-white border border-slate-100 rounded-sm"
      />

      <div className="bg-white rounded-sm border border-slate-100 shadow-sm overflow-hidden mx-1">
        <div className="p-6 border-b border-slate-50 flex flex-col md:flex-row md:items-center gap-6 bg-[#FBFAF8]">
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
            <label className="text-[10px] font-black text-slate-300 uppercase tracking-widest italic whitespace-nowrap">Sort by</label>
            <select 
              value={sortLogic}
              onChange={(e) => setSortLogic(e.target.value as any)}
              className="bg-white border border-slate-100 rounded-sm px-4 py-2.5 text-[10px] font-black uppercase tracking-widest focus:ring-2 focus:ring-primary/5 outline-none shadow-sm cursor-pointer hover:bg-slate-50 transition-colors"
            >
              <option value="Recency">Recency</option>
              <option value="Economic Potential">Economic Potential</option>
              <option value="Priority Status">Priority Status</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-[#3C3C3C] text-white italic">
                <th className="px-8 py-6 text-[10px] font-black uppercase tracking-[0.2em] border-r border-white/5">Prospect</th>
                <th className="px-6 py-6 text-[10px] font-black uppercase tracking-[0.2em] border-r border-white/5">Financial</th>
                <th className="px-6 py-6 text-[10px] font-black uppercase tracking-[0.2em] border-r border-white/5">Details</th>
                <th className="px-6 py-6 text-[10px] font-black uppercase tracking-[0.2em] border-r border-white/5">Status</th>
                <th className="px-6 py-6 text-[10px] font-black uppercase tracking-[0.2em] border-r border-white/5">Remarks</th>
                <th className="px-6 py-6 text-[10px] font-black uppercase tracking-[0.2em] text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 italic">
              {filteredLeads.length > 0 ? filteredLeads.map((lead, idx) => (
                <motion.tr 
                  key={lead.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  className="group hover:bg-[#FBFAF8] transition-all cursor-pointer relative"
                  onClick={() => setSelectedLead(lead)}
                >
                  <td className="px-8 py-6">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-sm bg-slate-100 flex items-center justify-center text-primary font-black text-xs shrink-0 border border-slate-200 uppercase italic transition-all group-hover:bg-[#978C21] group-hover:text-white">
                        {String(lead.prospectName || 'U').split(' ').map(n => n[0] || '').join('')}
                      </div>
                      <div>
                        <div className="font-black text-brand-text text-[13px] group-hover:text-[#978C21] transition-colors tracking-tight uppercase italic flex items-center gap-2">
                           {lead.prospectName || 'Unknown Prospect'}
                           {(lead.collectedNCP || 0) > 100000 && <span className="w-2 h-2 rounded-full bg-[#978C21]" />}
                           <button
                              onClick={(e) => { e.stopPropagation(); navigate(`/leads/${lead.id}`); }}
                              title="View full timeline"
                              className="text-[8px] font-black text-[#978C21] bg-[#978C21]/10 px-1.5 py-0.5 rounded-sm uppercase tracking-wider hover:bg-[#978C21]/20 transition-all shrink-0 normal-case not-italic"
                           >
                              Timeline
                           </button>
                        </div>
                        <p className="text-[10px] text-slate-400 font-bold flex items-center gap-1 uppercase tracking-tight mt-1 opacity-60">
                          <Phone className="w-3 h-3 text-brand-blue" /> {lead.mobile || 'No Mobile'} • {lead.area || 'No Area'}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-6 border-l border-slate-50/50">
                    <p className="text-[12px] font-black text-brand-text italic uppercase group-hover:text-primary transition-colors">{lead.productName || 'N/A'}</p>
                    <p className="text-[10px] font-black text-[#10B981] tracking-tighter mt-1 whitespace-nowrap">৳ {(lead.collectedNCP || 0).toLocaleString()} <span className="text-[8px] font-bold text-slate-300 uppercase tracking-widest ml-1">NCP Collected</span></p>
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
                    <div className="flex items-center justify-end gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                       <button 
                         onClick={(e) => { e.stopPropagation(); setSelectedLead(lead); }}
                         className="p-2 border border-slate-100 hover:border-[#978C21] text-slate-400 hover:text-[#978C21] hover:bg-slate-50 rounded-sm shadow-xs transition-all bg-white cursor-pointer"
                         title="Edit Status & Logs"
                       >
                        <Edit2 className="w-3.5 h-3.5" />
                       </button>
                       <button 
                         onClick={(e) => { e.stopPropagation(); handleCall(lead.prospectName || 'Prospect'); }}
                         className="p-2 border border-slate-100 hover:border-blue-300 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-sm shadow-xs transition-all bg-white cursor-pointer"
                         title="Call Prospect"
                       >
                        <Phone className="w-3.5 h-3.5" />
                       </button>
                       <button 
                         onClick={(e) => { e.stopPropagation(); handleDeleteLead(lead.id); }}
                         className="p-2 border border-slate-100 hover:border-red-300 text-slate-400 hover:text-red-550 hover:bg-red-50 rounded-sm shadow-xs transition-all bg-white cursor-pointer"
                         title="Delete Lead"
                       >
                        <Trash2 className="w-3.5 h-3.5" />
                       </button>
                    </div>
                  </td>
                </motion.tr>
              )) : (
                <tr>
                  <td colSpan={6} className="px-8 py-20 text-center">
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

      {/* Lead Detail Modal */}
      <AnimatePresence>
        {selectedLead && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedLead(null)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative bg-white w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden border border-slate-100 italic flex flex-col max-h-[90vh]"
            >
              <div className="bg-[#3C3C3C] px-8 py-6 flex items-center justify-between">
                <div className="flex items-center gap-4">
                   <div className="w-12 h-12 rounded-sm bg-[#978C21] border border-white/10 flex items-center justify-center text-white font-black text-lg italic uppercase">
                     {String(selectedLead.prospectName || 'U').charAt(0)}
                   </div>
                   <div>
                     <h3 className="text-white text-xl font-black italic uppercase tracking-tight">{selectedLead.prospectName || 'Unknown Prospect'}</h3>
                     <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest mt-1">Lead Identity Matrix • {selectedLead.id}</p>
                   </div>
                </div>
                <button 
                  onClick={() => setSelectedLead(null)}
                  className="p-2 hover:bg-white/5 rounded-sm text-slate-400 hover:text-white transition-all"
                >
                  <XCircle className="w-6 h-6" />
                </button>
              </div>

              <div className="p-8 md:p-10 space-y-8 overflow-y-auto flex-1">
                <div className="grid grid-cols-2 gap-10">
                  <div className="space-y-2">
                    <p className="text-[10px] font-black text-slate-300 uppercase tracking-widest italic">Contact Primary</p>
                    <div className="flex items-center gap-2">
                       <p className="text-lg font-black text-brand-text italic underline decoration-brand-blue decoration-2 underline-offset-4 mr-1">{selectedLead.mobile || 'N/A'}</p>
                       {selectedLead.mobile && (
                          <button
                            onClick={() => handleCall(selectedLead.prospectName || 'Prospect')}
                            title="Call Now"
                            className="p-1.5 bg-[#978C21] text-white hover:bg-opacity-90 rounded-full transition-all flex items-center justify-center cursor-pointer shadow-sm active:scale-95"
                          >
                             <Phone className="w-3.5 h-3.5" />
                          </button>
                       )}
                    </div>
                    <p className="text-[10px] text-slate-400 font-bold uppercase">{selectedLead.area || 'N/A'}</p>
                  </div>
                  <div className="space-y-2">
                    <p className="text-[10px] font-black text-slate-300 uppercase tracking-widest italic">Status</p>
                    <div className="flex">
                      <span className={cn(
                        "px-4 py-1.5 rounded-sm text-[10px] font-black uppercase tracking-widest border",
                        getStatusColor(selectedLead.currentStatus)
                      )}>
                        {selectedLead.currentStatus}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-8 p-8 bg-[#FBFAF8] rounded-sm border border-slate-100">
                   <div>
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-2 italic">Collected NCP</p>
                      <p className="text-lg font-black text-[#10B981] italic tracking-tighter leading-none">৳ {(selectedLead.collectedNCP || 0).toLocaleString()}</p>
                   </div>
                   <div>
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-2 italic">Family Profile</p>
                      <p className="text-[11px] font-black text-slate-600 uppercase italic leading-none">{selectedLead.maritalStatus || 'N/A'} • {selectedLead.familyMember || '0'} Person</p>
                   </div>
                   <div>
                      <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-2 italic">Institutional Lead</p>
                      <p className="text-[11px] font-black text-[#978C21] uppercase italic leading-none">{selectedLead.assignedTo || 'N/A'}</p>
                   </div>
                </div>

                <div className="space-y-4">
                   <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] italic border-b border-slate-50 pb-2">Operational Pipeline Update</p>

                   {/* Last Logged follow up status & remarks (Requirement 3) */}
                   {selectedLead.statusHistory && selectedLead.statusHistory.length > 0 ? (
                      (() => {
                         const last = selectedLead.statusHistory[selectedLead.statusHistory.length - 1];
                         return (
                            <div className="p-4 bg-amber-50/75 border border-amber-100 rounded-lg space-y-2 text-[12px]">
                               <p className="text-[9px] font-black uppercase tracking-widest text-[#978C21] italic">Last Engaged Activity:</p>
                               <div className="grid grid-cols-2 gap-4">
                                  <div>
                                     <p className="text-[9px] text-slate-400 uppercase font-black tracking-wider">Status</p>
                                     <span className="font-bold text-slate-850 px-2 py-0.5 bg-amber-100 text-[#978C21] rounded text-[10px] uppercase tracking-wider font-extrabold">{last.status}</span>
                                  </div>
                                  {last.nextFollowUpDate && (
                                     <div>
                                        <p className="text-[9px] text-slate-400 uppercase font-black tracking-wider">Next Follow-up</p>
                                        <span className="font-extrabold text-slate-700">{new Date(last.nextFollowUpDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                                     </div>
                                  )}
                               </div>
                               <div>
                                  <p className="text-[9px] text-slate-400 uppercase font-black tracking-wider">Remarks</p>
                                  <p className="font-semibold text-slate-800 italic bg-white/60 p-2 rounded border border-slate-100">"{last.remarks}"</p>
                               </div>
                               <div className="flex justify-between items-center text-[9px] text-slate-400 pt-1.5 border-t border-amber-100/50">
                                  <span>Log Creator: {last.updatedBy || 'N/A'}</span>
                                  <span>{new Date(last.date).toLocaleString()}</span>
                               </div>
                            </div>
                         );
                      })()
                   ) : (
                      <div className="p-4 bg-slate-50 border border-slate-100 rounded-lg text-[11px] text-slate-400 italic">
                         No previous operational engagement history has been logged yet.
                      </div>
                   )}

                   {/* Editable Form Inputs */}
                   <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                      <div className="space-y-1">
                         <p className="text-[9px] font-black text-slate-400 uppercase italic">Target Status <span className="text-red-500">*</span></p>
                         <select 
                           value={formStatus}
                           onChange={(e) => {
                             const newStatus = e.target.value as LeadStatus;
                             setFormStatus(newStatus);
                             if (newStatus !== 'No Response') setFormNextCallDate('');
                             if (newStatus !== 'Meeting Fixed') setFormMeetingDate('');
                             if (newStatus !== 'Follow-up Set' && newStatus !== 'Interested' && newStatus !== 'Busy') setFormNextFollowUpDate('');
                             if (newStatus !== 'Meeting Completed') setFormSubStatus('');
                           }}
                           className="w-full bg-[#FBFAF8] border border-slate-100 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest focus:ring-1 focus:ring-[#978C21] outline-none"
                         >
                            <option value="">-- SELECT STATUS --</option>
                            {statusOptions.map(opt => (
                              <option key={opt} value={opt}>{opt}</option>
                            ))}
                         </select>
                      </div>

                      {/* Conditional Field: No Response -> Next Call Date */}
                      {formStatus === 'No Response' && (
                         <div className="space-y-1">
                            <p className="text-[9px] font-black text-slate-400 uppercase italic">Next Call Date & Time <span className="text-red-500">*</span></p>
                            <input 
                              type="datetime-local"
                              value={formNextCallDate ? formatToDateTimeLocal(formNextCallDate) : ''}
                              onChange={(e) => setFormNextCallDate(e.target.value)}
                              className="w-full bg-[#FBFAF8] border border-slate-100 rounded-sm px-4 py-3 text-[11px] font-black uppercase focus:ring-1 focus:ring-[#978C21] outline-none"
                            />
                         </div>
                      )}

                      {/* Conditional Field: Meeting Fixed -> Meeting Date */}
                      {formStatus === 'Meeting Fixed' && (
                         <div className="space-y-1">
                            <p className="text-[9px] font-black text-slate-400 uppercase italic">Meeting Date & Time <span className="text-red-500">*</span></p>
                            <input 
                              type="datetime-local"
                              value={formMeetingDate ? formatToDateTimeLocal(formMeetingDate) : ''}
                              onChange={(e) => setFormMeetingDate(e.target.value)}
                              className="w-full bg-[#FBFAF8] border border-slate-100 rounded-sm px-4 py-3 text-[11px] font-black uppercase focus:ring-1 focus:ring-[#978C21] outline-none"
                            />
                         </div>
                      )}

                      {/* Conditional Field: Follow-up Set, Interested or Busy -> Next Follow-up Date */}
                      {(formStatus === 'Follow-up Set' || formStatus === 'Interested' || formStatus === 'Busy') && (
                         <div className="space-y-1">
                            <p className="text-[9px] font-black text-slate-400 uppercase italic">Target Follow-Up Date & Time <span className="text-red-500">*</span></p>
                            <input 
                              type="datetime-local"
                              value={formNextFollowUpDate ? formatToDateTimeLocal(formNextFollowUpDate) : ''}
                              onChange={(e) => setFormNextFollowUpDate(e.target.value)}
                              className="w-full bg-[#FBFAF8] border border-slate-100 rounded-sm px-4 py-3 text-[11px] font-black uppercase focus:ring-1 focus:ring-[#978C21] outline-none"
                            />
                         </div>
                      )}

                      {/* Conditional Field: Meeting Completed -> sub-status dropdown */}
                      {formStatus === 'Meeting Completed' && (
                         <div className="space-y-1">
                            <p className="text-[9px] font-black text-slate-400 uppercase italic">Meeting Result (Sub-Status) <span className="text-red-500">*</span></p>
                            <select 
                              value={formSubStatus}
                              onChange={(e) => setFormSubStatus(e.target.value as any)}
                              className="w-full bg-[#FBFAF8] border border-slate-100 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-wider focus:ring-1 focus:ring-[#978C21] outline-none"
                            >
                               <option value="">-- SELECT RESULT --</option>
                               <option value="Pipeline Locked">Pipeline Locked</option>
                               <option value="Not Interested">Not Interested</option>
                            </select>
                         </div>
                      )}

                      {/* Conditional Fields block: Pipeline Locked */}
                      {(formStatus === 'Pipeline Locked' || (formStatus === 'Meeting Completed' && formSubStatus === 'Pipeline Locked')) && (
                         <div className="col-span-2 grid grid-cols-1 md:grid-cols-3 gap-4 border-l-2 border-[#978C21] pl-3 py-1 bg-slate-50/50 rounded-r-md">
                            <div className="space-y-1">
                               <p className="text-[9px] font-black text-slate-400 uppercase italic">Product Name <span className="text-red-500">*</span></p>
                               <select 
                                 value={formProductName}
                                 onChange={(e) => setFormProductName(e.target.value)}
                                 className="w-full bg-white border border-slate-100 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest focus:ring-1 focus:ring-[#978C21] outline-none"
                               >
                                  <option value="">-- SELECT PRODUCT --</option>
                                  {productOptions.map(p => (
                                     <option key={p} value={p}>{p}</option>
                                  ))}
                               </select>
                            </div>
                            <div className="space-y-1">
                               <p className="text-[9px] font-black text-slate-400 uppercase italic">Sum Assured (৳) <span className="text-red-500">*</span></p>
                               <input 
                                 type="number"
                                 placeholder="Sum Assured..."
                                 value={formSumAssured || ''}
                                 onChange={(e) => setFormSumAssured(parseFloat(e.target.value) || 0)}
                                 className="w-full bg-white border border-slate-100 rounded-sm px-4 py-3 text-[11px] font-black focus:ring-1 focus:ring-[#978C21] outline-none placeholder:opacity-30"
                               />
                            </div>
                            <div className="space-y-1">
                               <p className="text-[9px] font-black text-slate-400 uppercase italic">Projected NCP (৳) <span className="text-red-500">*</span></p>
                               <input 
                                 type="number"
                                 placeholder="Projected NCP..."
                                 value={formProjectedNCP || ''}
                                 onChange={(e) => setFormProjectedNCP(parseFloat(e.target.value) || 0)}
                                 className="w-full bg-white border border-slate-100 rounded-sm px-4 py-3 text-[11px] font-black focus:ring-1 focus:ring-[#978C21] outline-none placeholder:opacity-30"
                               />
                            </div>
                         </div>
                      )}

                      {/* Conditional Fields block: Converted */}
                      {formStatus === 'Converted' && (
                         <div className="col-span-2 grid grid-cols-1 md:grid-cols-3 gap-4 border-l-2 border-emerald-500 pl-3 py-1 bg-slate-50/50 rounded-r-md">
                            <div className="space-y-1">
                               <p className="text-[9px] font-black text-slate-400 uppercase italic">Product Name <span className="text-red-500">*</span></p>
                               <select 
                                 value={formProductName}
                                 onChange={(e) => setFormProductName(e.target.value)}
                                 className="w-full bg-white border border-slate-100 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest focus:ring-1 focus:ring-[#978C21] outline-none"
                               >
                                  <option value="">-- SELECT PRODUCT --</option>
                                  {productOptions.map(p => (
                                     <option key={p} value={p}>{p}</option>
                                  ))}
                               </select>
                            </div>
                            <div className="space-y-1">
                               <p className="text-[9px] font-black text-slate-400 uppercase italic">Sum Assured (৳) <span className="text-red-500">*</span></p>
                               <input 
                                 type="number"
                                 placeholder="Sum Assured..."
                                 value={formSumAssured || ''}
                                 onChange={(e) => setFormSumAssured(parseFloat(e.target.value) || 0)}
                                 className="w-full bg-white border border-slate-100 rounded-sm px-4 py-3 text-[11px] font-black focus:ring-1 focus:ring-[#978C21] outline-none placeholder:opacity-30"
                               />
                            </div>
                            <div className="space-y-1">
                               <p className="text-[9px] font-black text-slate-400 uppercase italic">Collected NCP (৳) <span className="text-red-400">*</span></p>
                               <input 
                                 type="number"
                                 placeholder="Collected NCP..."
                                 value={formCollectedNCP || ''}
                                 onChange={(e) => setFormCollectedNCP(parseFloat(e.target.value) || 0)}
                                 className="w-full bg-white border border-slate-100 rounded-sm px-4 py-3 text-[11px] font-black focus:ring-1 focus:ring-[#978C21] outline-none placeholder:opacity-30"
                               />
                            </div>
                         </div>
                      )}

                      {/* Operational Remarks */}
                      <div className="col-span-2 space-y-1">
                         <p className="text-[9px] font-black text-slate-400 uppercase italic">Operational Remarks <span className="text-red-500">*</span></p>
                         <textarea
                           placeholder="Describe client response, expectations, or next steps in detail (Mandatory)..."
                           value={formRemarks}
                           onChange={(e) => setFormRemarks(e.target.value)}
                           rows={3}
                           className="w-full bg-[#FBFAF8] border border-slate-100 rounded-sm p-3 text-[11px] font-medium focus:ring-1 focus:ring-[#978C21] outline-none placeholder:opacity-40"
                         />
                      </div>
                   </div>

                   {/* Requirement 5: Update button */}
                   <button
                     onClick={handleSaveLeadUpdate}
                     className="hidden"
                   >
                     <CheckCircle className="w-4 h-4 text-[#978C21]" />
                     Save & Update Status
                   </button>

                   {/* RM Delegation Action Matrix */}
                   {user?.role === UserRole.RM && (
                      <div className="p-4 bg-[#978C21]/5 border border-[#978C21]/10 rounded-sm space-y-3 mt-4">
                         <p className="text-[10px] font-black text-slate-800 uppercase tracking-widest italic leading-none">📋 Delegate to Relationship Officer (RO)</p>
                         <div className="flex gap-3">
                            <select
                              value={selectedRO}
                              onChange={(e) => setSelectedRO(e.target.value)}
                              className="flex-1 bg-white border border-slate-100 rounded-sm px-3 py-2 text-[11px] font-black uppercase tracking-wider outline-none focus:ring-1 focus:ring-[#978C21]"
                            >
                               <option value="">-- CHOOSE RO --</option>
                               {allUsers
                                 .filter(u => u.role === UserRole.RO && u.status === 'Active')
                                 .map(u => (
                                    <option key={u.employeeId} value={u.employeeId}>
                                       {u.name} (ID: {u.employeeId})
                                    </option>
                                 ))
                               }
                            </select>
                            <button
                              onClick={async () => {
                                if (!selectedRO) {
                                  toast.error('Please choose a valid RO first');
                                  return;
                                }
                                try {
                                   await leadService.updateLead(selectedLead.id, { 
                                     assignedTo: selectedRO 
                                   }, user.name);
                                   toast.success(`Successfully delegated lead directly to RO: ${selectedRO}`);
                                   setSelectedLead(prev => prev ? { ...prev, assignedTo: selectedRO } : null);
                                   loadLeads();
                                } catch (err) {
                                   toast.error('Re-assignment failure');
                                }
                              }}
                              className="px-4 py-2 bg-[#978C21] text-white text-[10px] font-black uppercase tracking-widest rounded-sm transition-all hover:bg-opacity-90 font-black whitespace-nowrap"
                            >
                               Assign RO
                            </button>
                         </div>
                      </div>
                   )}
                </div>

                {/* Historical Timeline Audit Log */}
                {selectedLead.statusHistory && selectedLead.statusHistory.length > 0 && (
                   <div className="space-y-4 pt-4 border-t border-slate-100">
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] italic border-b border-slate-50 pb-2">Full Change & Interaction Audit Log</p>
                      <div className="space-y-3 max-h-40 overflow-y-auto pr-2 scrollbar-thin">
                         {selectedLead.statusHistory.slice().reverse().map((hist, hIdx) => (
                            <div key={hIdx} className="p-3.5 bg-slate-50 border border-slate-100 rounded-lg text-[11px] space-y-1">
                               <div className="flex justify-between items-start">
                                  <span className="font-extrabold text-[#978C21] uppercase tracking-wider">{hist.status}</span>
                                  <span className="text-[9px] text-slate-400">{new Date(hist.date).toLocaleString()}</span>
                               </div>
                               <p className="text-slate-700 italic font-medium">"{hist.remarks}"</p>
                               {hist.nextFollowUpDate && (
                                  <p className="text-[9px] text-indigo-600 font-bold">Planned Callback: {new Date(hist.nextFollowUpDate).toLocaleDateString()}</p>
                                )}
                               <p className="text-[9px] text-slate-400 text-right">Modified By: {hist.updatedBy || 'N/A'}</p>
                            </div>
                         ))}
                      </div>
                   </div>
                )}

                <div className="space-y-4 pt-4">
                   <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] italic border-b border-slate-50 pb-2">Engagement Intelligence</p>
                   <div className="grid grid-cols-2 gap-6 pt-2">
                      <div className="space-y-1">
                         <p className="text-[9px] font-black text-slate-300 uppercase italic">Source Entity</p>
                         <p className="text-[11px] font-black text-brand-text uppercase italic">{selectedLead.source || 'N/A'}</p>
                      </div>
                      <div className="space-y-1">
                         <p className="text-[9px] font-black text-slate-300 uppercase italic">Active Campaign</p>
                         <p className="text-[11px] font-black text-brand-text uppercase italic">{selectedLead.campaignName || 'N/A'}</p>
                      </div>
                      <div className="space-y-1">
                         <p className="text-[9px] font-black text-slate-300 uppercase italic">Target Product</p>
                         <p className="text-[11px] font-black text-brand-text uppercase italic">{selectedLead.productName || 'N/A'}</p>
                      </div>
                      <div className="space-y-1">
                         <p className="text-[9px] font-black text-slate-300 uppercase italic">Profession Matrix</p>
                         <p className="text-[11px] font-black text-brand-text uppercase italic">{selectedLead.profession || 'N/A'}</p>
                      </div>
                   </div>
                </div>
              </div>

              <div className="p-8 bg-slate-50 border-t border-slate-100 flex items-center justify-center">
                <button 
                  onClick={handleSaveLeadUpdate}
                  className="w-full bg-slate-900 hover:bg-black text-white px-6 py-4 text-[11px] font-black uppercase tracking-widest rounded-sm transition-all shadow-xl flex items-center justify-center gap-3 cursor-pointer"
                >
                   <CheckCircle className="w-4 h-4 text-[#978C21]" />
                   Save & Update Status
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
