import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Search, 
  Trash2, 
  Edit3, 
  UserPlus, 
  ChevronRight, 
  Database,
  Calendar,
  AlertTriangle,
  X,
  CheckCircle,
  FileText,
  User,
  MapPin,
  Clipboard,
  Sliders,
  DollarSign,
  History,
  TrendingUp,
  Inbox,
  UserCheck
} from 'lucide-react';
import { useAuthStore } from '../../auth/store/authStore';
import { cn } from '../../../lib/utils';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { Lead } from '../../shared/types';
import { leadService } from '../services/leadService';
import { filterLeadsByPoolTab, getLeadPoolCounts, type LeadPoolTab } from '../utils/leadPool';
import { userService } from '../../users/services/userService';
import { settingsService } from '../../../services/settingsService';
import { toast } from 'sonner';
import AdvancedFilterPanel from '../../shared/components/AdvancedFilterPanel';

export default function AllLeads() {
  const { user } = useAuthStore();
  const { canAccess, userRole } = usePermissions();
  const canAssign = canAccess('all_leads', 'assign');
  const canEdit = canAccess('all_leads', 'edit');
  const canDelete = canAccess('all_leads', 'delete');
  const canExport = canAccess('all_leads', 'export');
  const isAdminRole = ['ADMIN', 'SUPERADMIN'].includes(String(userRole || '').toUpperCase());
  const canPurgeCampaign = canDelete && isAdminRole;
  const navigate = useNavigate();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [advancedFilteredLeads, setAdvancedFilteredLeads] = useState<Lead[] | null>(null);
  const [poolTab, setPoolTab] = useState<LeadPoolTab>('unassigned');
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [campaignOptions, setCampaignOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);

  // Campaign deletion and statistics states
  const [targetCampaignToDelete, setTargetCampaignToDelete] = useState('');
  const [isConfirmDeleteCampOpen, setIsConfirmDeleteCampOpen] = useState(false);
  const [deleteConfirmPassword, setDeleteConfirmPassword] = useState('');

  // Edit fields inside modal drawer
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editCampaign, setEditCampaign] = useState('');
  const [editAssignee, setEditAssignee] = useState('');
  const [editArea, setEditArea] = useState('');
  const [editSource, setEditSource] = useState('');
  const [editProduct, setEditProduct] = useState('');
  const [editProfession, setEditProfession] = useState('');

  // Inline assignment state for selected lead
  const [inlineAssignmentLeadId, setInlineAssignmentLeadId] = useState<string | null>(null);
  const [inlineAssigneeId, setInlineAssigneeId] = useState('');

  // Bulk action state variables
  const [selectedLeadIds, setSelectedLeadIds] = useState<string[]>([]);
  const [bulkAssigneeId, setBulkAssigneeId] = useState('');
  const [bulkAssigning, setBulkAssigning] = useState(false);

  const handleBulkAssign = async () => {
    if (!canAssign) {
      toast.error('You do not have permission to assign leads.');
      return;
    }
    if (!selectedLeadIds.length) {
      toast.error('No leads selected');
      return;
    }
    if (!bulkAssigneeId) {
      toast.error('Please choose a bulk assignee or Unassign option');
      return;
    }
    setBulkAssigning(true);
    const targetAssignee = bulkAssigneeId === 'unassign' ? '' : bulkAssigneeId;
    try {
      await Promise.all(
        selectedLeadIds.map(leadId => 
          leadService.updateLead(leadId, { assignedTo: targetAssignee }, user?.name || 'Admin')
        )
      );
      toast.success(`Successfully assigned ${selectedLeadIds.length} leads in batch!`);
      setSelectedLeadIds([]);
      setBulkAssigneeId('');
      loadData();
    } catch (err) {
      toast.error('Bulk assignment failed');
    } finally {
      setBulkAssigning(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [user, canAssign]);

  const loadData = async () => {
    if (!user) return;
    setLoading(true);
    try {
      // The server derives the caller and Data Visibility from the session.
      // Never impersonate ADMIN or send a role query from this page.
      const visibleLeads = await leadService.getLeads();
      setLeads(visibleLeads);

      // Assignee references are only needed when the canonical assign action
      // is available. userService itself remains session-cached/coalesced.
      if (canAssign) {
        const usersList = await userService.getAllUsers();
        setAllUsers(usersList);
      } else {
        setAllUsers([]);
      }

      // Campaign options support the secondary administrative correction and
      // danger-zone controls; they do not determine visibility.
      const campaigns = await settingsService.getOptionsByType('Campaign');
      setCampaignOptions(campaigns);
    } catch (err) {
      toast.error('Initialization matrix sync failure');
    } finally {
      setLoading(false);
    }
  };

  // Pre-fill edit modal states
  useEffect(() => {
    if (selectedLead) {
      setEditName(selectedLead.prospectName || '');
      setEditPhone(selectedLead.mobileNumber || '');
      setEditEmail(selectedLead.email || '');
      setEditCampaign(selectedLead.campaignName || '');
      setEditAssignee(selectedLead.assignedTo || '');
      setEditArea(selectedLead.area || '');
      setEditSource(selectedLead.source || '');
      setEditProduct(selectedLead.productName || '');
      setEditProfession(selectedLead.profession || '');
    }
  }, [selectedLead]);

  // Handle single lead deletion
  const handleDeleteIndividualLead = async (leadId: string) => {
    if (!canDelete) {
      toast.error('Access Denied: the canonical leads.delete permission is required.');
      return;
    }
    if (!window.confirm('Are you strictly sure you want to permanently delete this lead?')) return;
    try {
      await leadService.deleteLead(leadId);
      toast.success('Lead permanently removed from tracking');
      setLeads(prev => prev.filter(l => l.id !== leadId));
      if (selectedLead?.id === leadId) setSelectedLead(null);
    } catch (err) {
      toast.error('Deletion failure');
    }
  };

  // Handle campaign-wise deletion
  const handlePurgeCampaignLeads = async () => {
    if (!canPurgeCampaign) {
      toast.error('Campaign purge requires admin access and the canonical leads.delete permission.');
      return;
    }
    if (!targetCampaignToDelete) {
      toast.error('Please select a campaign to purge first');
      return;
    }
    if (!deleteConfirmPassword) {
      toast.error('Please enter your login password to confirm deletion');
      return;
    }

    try {
      const verifyRes = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId: user?.employeeId, password: deleteConfirmPassword }),
      });

      if (!verifyRes.ok) {
        toast.error('Deletion aborted: Incorrect password provided');
        return;
      }

      await leadService.deleteLeadsByCampaign(targetCampaignToDelete);
      toast.success(`Successfully purged all leads associated with campaign "${targetCampaignToDelete}"`);
      setLeads(prev => prev.filter(l => l.campaignName !== targetCampaignToDelete));
      setIsConfirmDeleteCampOpen(false);
      setTargetCampaignToDelete('');
      setDeleteConfirmPassword('');
    } catch (err) {
      toast.error('Campaign mass purge failed');
    }
  };

  if (!canAccess('all_leads', 'view')) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center p-8 bg-white border border-slate-100 rounded-sm shadow-xs max-w-xl mx-auto space-y-6 animate-in fade-in duration-300">
        <div className="w-16 h-16 rounded-full bg-amber-50 border border-amber-100 flex items-center justify-center text-[#978C21] shrink-0 transform hover:rotate-12 transition-transform">
          <AlertTriangle className="w-8 h-8" />
        </div>
        <div className="space-y-2">
          <span className="text-[9px] font-black tracking-[0.25em] text-[#978C21] uppercase italic">Lead Pool access</span>
          <h2 className="text-xl font-black text-slate-900 uppercase tracking-tight italic">Access Denied</h2>
          <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider leading-relaxed">
            Your current clearance level <span className="text-red-650 font-black">"{userRole || 'RESTRICTED'}"</span> does not have Feature Access to the Lead Pool.
          </p>
        </div>
        <div className="pt-2 border-t border-slate-100 w-full text-[9px] font-mono text-slate-400 uppercase tracking-widest leading-none">
          Feature Access: all_leads · canonical leads.view required
        </div>
      </div>
    );
  }

  // Handle general lead details update
  const handleUpdateLeadDetails = async () => {
    if (!selectedLead) return;
    if (!canEdit) {
      toast.error('Access Denied: the canonical leads.edit permission is required.');
      return;
    }
    if (!editName.trim()) {
      toast.error('Prospect Name is a mandatory field');
      return;
    }
    if (!editPhone.trim()) {
      toast.error('Mobile Number is a mandatory field');
      return;
    }

    try {
      const updatePayload: Partial<Lead> = {
        prospectName: editName,
        mobileNumber: editPhone,
        email: editEmail,
        campaignName: editCampaign,
        area: editArea,
        source: editSource,
        productName: editProduct,
        profession: editProfession
      };
      if (canAssign) {
        updatePayload.assignedTo = editAssignee;
      }

      await leadService.updateLead(selectedLead.id, updatePayload, user?.name || 'Administrator');
      toast.success('Lead demographics and routing updated successfully!');
      setSelectedLead(null);
      loadData();
    } catch (err) {
      toast.error('Update save aborted');
    }
  };

  // Handle inline quick-assign dropdown saving
  const handleSaveInlineAssignment = async (leadId: string) => {
    if (!canAssign) {
      toast.error('You do not have permission to assign leads.');
      return;
    }
    if (!inlineAssigneeId) {
      toast.error('Select an assignee or choose Unassigned');
      return;
    }
    try {
      const targetAssignee = inlineAssigneeId === 'unassign' ? '' : inlineAssigneeId;
      await leadService.updateLead(leadId, { assignedTo: targetAssignee }, user?.name || 'Admin');
      toast.success(`Lead successfully routed to assignee ID ${inlineAssigneeId}`);
      setInlineAssignmentLeadId(null);
      loadData();
    } catch (err) {
      toast.error('Inline assignment failed');
    }
  };

  // Searching logic combined with the advanced filter and canonical pool tab.
  // A null advanced-filter result means "no filter applied"; an empty array
  // means the filter intentionally matched no records.
  const filteredLeads = (() => {
    const advancedList = advancedFilteredLeads ?? leads;
    const tabList = filterLeadsByPoolTab(advancedList, poolTab);
    const q = searchQuery.toLowerCase().trim();
    if (!q) return tabList;

    return tabList.filter(l => {
      return (
        (l.prospectName || '').toLowerCase().includes(q) ||
        (l.mobile || '').toLowerCase().includes(q) ||
        (l.mobileNumber || '').toLowerCase().includes(q) ||
        (l.campaignName || '').toLowerCase().includes(q) ||
        (l.assignedTo || '').toLowerCase().includes(q) ||
        (l.area || '').toLowerCase().includes(q) ||
        (l.source || '').toLowerCase().includes(q)
      );
    });
  })();

  const poolCounts = getLeadPoolCounts(advancedFilteredLeads ?? leads);
  const totalLeadsCount = poolCounts.total;
  const unassignedLeadsCount = poolCounts.unassigned;
  const conversionRateCount = poolCounts.converted;
  const uniqueCampaignsCount = Array.from(new Set(leads.map(l => l.campaignName).filter(Boolean))).length;

  return (
    <div className="space-y-8 max-w-7xl mx-auto">
      {/* Title & Top Meta Row */}
      <div className="border-b border-slate-100 pb-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
           <span className="text-[9px] font-black tracking-[0.25em] text-[#978C21] uppercase italic">Lead intake and routing console</span>
           <h1 className="text-2xl font-black text-slate-900 uppercase tracking-tight italic mt-1">Lead Pool</h1>
           <p className="text-xs text-slate-500 mt-1">Route intake, review server-visible lead records, correct permitted details, and open the operational workspace.</p>
        </div>
        <div className="flex gap-3">
          <button 
             onClick={loadData}
             className="px-5 py-3 border border-slate-200 hover:bg-slate-50 text-[10px] font-black uppercase tracking-widest text-slate-700 bg-white shadow-sm rounded-sm transition-all flex items-center gap-2"
          >
             🔄 Reload Data
          </button>
        </div>
      </div>

      {/* Canonical intake tabs. Classification is based only on assignedTo. */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {([
          { id: 'unassigned' as const, label: 'Unassigned', count: poolCounts.unassigned, hint: 'Needs routing' },
          { id: 'assigned' as const, label: 'Assigned', count: poolCounts.assigned, hint: 'In active ownership' },
          { id: 'all' as const, label: 'All', count: poolCounts.total, hint: 'Server-visible pool' },
        ]).map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => { setPoolTab(tab.id); setSelectedLeadIds([]); }}
            className={cn(
              'text-left p-4 border rounded-sm transition-all',
              poolTab === tab.id
                ? 'border-[#978C21] bg-[#978C21]/5 shadow-sm'
                : 'border-slate-100 bg-white hover:border-slate-300'
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-700">{tab.label}</span>
              <span className="text-xl font-black text-slate-900">{tab.count}</span>
            </div>
            <span className="text-[9px] text-slate-400 uppercase tracking-widest">{tab.hint}</span>
          </button>
        ))}
      </div>

      {/* Lead Pool summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
         <div className="p-6 bg-[#FBFAF8] border border-slate-100 rounded-sm shadow-sm relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-4 opacity-5 text-slate-900 group-hover:scale-110 transition-transform">
               <Database className="w-16 h-16" />
            </div>
            <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest italic">Pool Records</p>
            <p className="text-3xl font-black text-slate-900 italic tracking-tighter leading-none mt-2">{totalLeadsCount}</p>
            <span className="text-[9px] text-[#978C21] font-bold mt-2 block lowercase italic">uploaded entities cataloged</span>
         </div>

         <div className="p-6 bg-amber-50/50 border border-amber-100 rounded-sm shadow-sm relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-4 opacity-5 text-amber-500">
               <Inbox className="w-16 h-16" />
            </div>
            <p className="text-[9px] font-black text-amber-700 uppercase tracking-widest italic">Pending Assignment</p>
            <p className="text-3xl font-black text-amber-800 italic tracking-tighter leading-none mt-2">{unassignedLeadsCount}</p>
            <span className="text-[9px] text-amber-600 font-bold mt-2 block lowercase italic">requires operator routing</span>
         </div>

         <div className="p-6 bg-[#978C21]/5 border border-[#978C21]/10 rounded-sm shadow-sm relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-4 opacity-5 text-[#978C21]">
               <Sliders className="w-16 h-16" />
            </div>
            <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest italic">Live Campaign Channels</p>
            <p className="text-3xl font-black text-slate-900 italic tracking-tighter leading-none mt-2">{uniqueCampaignsCount}</p>
            <span className="text-[9px] text-[#978C21] font-bold mt-2 block lowercase italic">active generation funnels</span>
         </div>

         <div className="p-6 bg-emerald-50/50 border border-emerald-100 rounded-sm shadow-sm relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-4 opacity-5 text-emerald-500">
               <TrendingUp className="w-16 h-16" />
            </div>
            <p className="text-[9px] font-black text-emerald-800 uppercase tracking-widest italic">Converted Acquisitions</p>
            <p className="text-3xl font-black text-emerald-900 italic tracking-tighter leading-none mt-2">{conversionRateCount}</p>
            <span className="text-[9px] text-emerald-600 font-bold mt-2 block lowercase italic">converted pipeline targets</span>
         </div>
      </div>

      {/* Secondary danger zone: destructive purge is never the primary workflow. */}
      {canPurgeCampaign && (
      <div className="p-6 bg-red-50/30 border border-red-100/60 rounded-sm shadow-sm">
         <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
            <div className="space-y-1 max-w-2xl">
               <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-ping" />
                  <p className="text-[10px] font-black text-red-700 uppercase tracking-widest italic">Camp Wise Lead Cleanup</p>
               </div>
               <h3 className="text-[13px] font-black text-slate-950 uppercase tracking-tight italic">Erase Uploaded Leads By Campaign Name</h3>
               <p className="text-xs text-slate-500">Permanently delete all leads associated with a selected campaign in one click. WARNING: This operation is irreversible and removes data permanently from secondary caches.</p>
            </div>
            <div className="flex items-center gap-3">
               <select
                 value={targetCampaignToDelete}
                 onChange={(e) => setTargetCampaignToDelete(e.target.value)}
                 className="bg-white border border-slate-200 text-[11px] font-black uppercase tracking-wider px-4 py-3 rounded-sm focus:ring-1 focus:ring-red-500 outline-none"
               >
                  <option value="">-- CHOOSE TARGET CAMPAIGN --</option>
                  {Array.from(new Set(leads.map(l => l.campaignName).filter(Boolean))).map(camp => (
                     <option key={String(camp)} value={String(camp)}>{String(camp).toUpperCase()}</option>
                  ))}
               </select>
               <button
                 type="button"
                 onClick={() => {
                   if (!targetCampaignToDelete) {
                     toast.error('Please pick a campaign first');
                     return;
                   }
                   setIsConfirmDeleteCampOpen(true);
                 }}
                 className="px-5 py-3.5 bg-red-600 hover:bg-red-700 text-white text-[10px] font-black uppercase tracking-widest rounded-sm transition-all shadow-md flex items-center gap-2"
               >
                  <Trash2 className="w-3.5 h-3.5" />
                  Erase Lead
               </button>
            </div>
         </div>
      </div>
      )}

      {/* Advanced multi-criteria search and dynamic filtering builder */}
      <AdvancedFilterPanel 
        onFilterChange={setAdvancedFilteredLeads} 
        allLeads={leads} 
        className="shadow-sm bg-white"
      />

      {/* Main Grid Workspace */}
      <div className="bg-white border border-slate-100/80 rounded-sm shadow-sm overflow-hidden">
         {/* Live Search and Control Panel */}
         <div className="p-6 border-b border-slate-55 flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-50/50">
            <div className="relative flex-1 max-w-md">
               <Search className="w-4 h-4 text-slate-400 absolute left-4 top-1/2 -translate-y-1/2" />
               <input 
                 type="text"
                 placeholder="Search by candidate name, mobile, active assignee, or campaign name..."
                 value={searchQuery}
                 onChange={(e) => setSearchQuery(e.target.value)}
                 className="w-full pl-12 pr-4 py-3 bg-white border border-slate-200/85 text-[11px] font-black uppercase tracking-wider focus:ring-1 focus:ring-[#978C21] rounded-sm placeholder:opacity-50 outline-none"
               />
            </div>
            <div className="text-[10px] text-slate-400 font-extrabold uppercase italic tracking-widest">
               Displaying {filteredLeads.length} of {leads.length} Records
            </div>
         </div>

         {/* Batch Lead Assignment Header Panel when items are selected */}
         {canAssign && selectedLeadIds.length > 0 && (
            <div className="p-5 bg-amber-50/65 border-b border-amber-100/80 flex flex-col md:flex-row md:items-center justify-between gap-4 animate-fadeIn">
               <div className="flex items-center gap-2">
                  <span className="inline-flex items-center justify-center bg-[#978C21] text-white font-black rounded-full h-5 w-5 text-[10px] shadow-sm">
                     {selectedLeadIds.length}
                  </span>
                  <div>
                     <p className="text-[11px] font-black uppercase tracking-widest text-slate-900 italic">Bulk Routing Workflow</p>
                     <p className="text-[10px] text-slate-500 font-medium">Select a system team handler to propagate immediate assignments to all selected lead registries.</p>
                  </div>
               </div>
               <div className="flex items-center gap-3">
                  <select
                    value={bulkAssigneeId}
                    onChange={(e) => setBulkAssigneeId(e.target.value)}
                    className="bg-white border border-slate-200 text-[10px] font-black uppercase py-2 px-3 rounded-sm outline-none focus:ring-1 focus:ring-[#978C21] cursor-pointer"
                  >
                     <option value="">-- SELECT RE-ROUTE HANDLER --</option>
                     <option value="unassign">-- MARK AS UNASSIGNED --</option>
                     {allUsers.map(u => (
                        <option key={u.employeeId} value={u.employeeId}>
                           {u.role}: {u.name} (ID: {u.employeeId})
                        </option>
                     ))}
                  </select>
                  <button
                    onClick={handleBulkAssign}
                    disabled={bulkAssigning}
                    className="bg-slate-900 hover:bg-black text-white text-[10px] font-black uppercase tracking-[0.15em] px-5 py-2.5 rounded-sm transition-all disabled:opacity-50 cursor-pointer shadow-md"
                  >
                     {bulkAssigning ? 'Synchronizing edits...' : 'Assign Selection'}
                  </button>
                  <button
                    onClick={() => setSelectedLeadIds([])}
                    className="text-slate-400 hover:text-slate-600 text-[10px] font-black uppercase tracking-widest px-2 cursor-pointer border-l border-slate-200 pl-4 py-1"
                  >
                     Cancel Selection
                  </button>
               </div>
            </div>
         )}

         {/* Core Master Table View */}
         <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
               <thead>
                  <tr className="border-b border-slate-100 bg-[#FBFAF8] text-[9px] font-black text-slate-400 uppercase tracking-widest italic divide-x divide-slate-100/50">
                     <th className="p-4 px-6 text-center select-none w-14">
                        <input 
                          type="checkbox"
                          checked={canAssign && filteredLeads.length > 0 && selectedLeadIds.length === filteredLeads.length}
                          disabled={!canAssign}
                          onChange={(e) => {
                             if (!canAssign) return;
                             if (e.target.checked) {
                                setSelectedLeadIds(filteredLeads.map(l => l.id));
                             } else {
                                setSelectedLeadIds([]);
                             }
                          }}
                          className="cursor-pointer accent-[#978C21] h-3.5 w-3.5 rounded border-slate-300 focus:ring-0 disabled:cursor-not-allowed disabled:opacity-40"
                        />
                     </th>
                     <th className="p-4 px-6 text-slate-900">Demographic Name</th>
                     <th className="p-4 px-6 text-slate-900">Mobile Connection</th>
                     <th className="p-4 px-6 text-slate-900">Campaign</th>
                     <th className="p-4 px-6 text-slate-[#978C21]">Assignee ID / Status (Tab)</th>
                     <th className="p-4 px-6 text-slate-900">Current Status</th>
                     <th className="p-4 px-6 text-slate-900">Upload Date</th>
                     <th className="p-4 px-6 text-center text-slate-900">Control Actions</th>
                  </tr>
               </thead>
               <tbody className="divide-y divide-slate-50 text-[11px] text-slate-700 font-medium">
                  {loading ? (
                     <tr>
                        <td colSpan={8} className="p-12 text-center text-[10px] text-slate-400 font-black uppercase tracking-widest italic leading-none">
                           🔄 Cataloging operational records data...
                        </td>
                     </tr>
                  ) : filteredLeads.length === 0 ? (
                     <tr>
                        <td colSpan={8} className="p-12 text-center text-[10px] text-slate-400 font-black uppercase tracking-widest italic leading-none">
                           📭 No matching lead registers discovered
                        </td>
                     </tr>
                  ) : (
                     filteredLeads.map((lead) => (
                        <tr 
                          key={lead.id}
                          className={`hover:bg-slate-50/50 transition-colors group align-middle ${selectedLeadIds.includes(lead.id) ? 'bg-amber-50/10' : ''}`}
                        >
                           {/* Row Checkbox Selection */}
                           <td className="p-4 px-6 text-center select-none w-14" onClick={(e) => e.stopPropagation()}>
                              <input 
                                type="checkbox"
                                checked={selectedLeadIds.includes(lead.id)}
                                onChange={(e) => {
                                   if (e.target.checked) {
                                      setSelectedLeadIds(prev => [...prev, lead.id]);
                                   } else {
                                      setSelectedLeadIds(prev => prev.filter(id => id !== lead.id));
                                   }
                                }}
                                className="cursor-pointer accent-[#978C21] h-3.5 w-3.5 rounded border-slate-300 focus:ring-0"
                              />
                           </td>
                           {/* Demographics Name */}
                           <td className="p-4 px-6 text-slate-950 font-black uppercase tracking-tight select-all">
                              <div className="flex items-center gap-2">
                                 <span>{lead.prospectName || 'Anonymous Candidate'}</span>
                                 <button
                                    onClick={(e) => { e.stopPropagation(); navigate(`/leads/${lead.id}`); }}
                                    title="View full timeline"
                                    className="text-[8px] font-black text-[#978C21] bg-[#978C21]/10 px-1.5 py-0.5 rounded-sm uppercase tracking-wider hover:bg-[#978C21]/20 transition-all shrink-0"
                                 >
                                    Timeline
                                 </button>
                              </div>
                              {lead.email && <div className="text-[9px] text-slate-400 font-normal lowercase tracking-normal mt-0.5">{lead.email}</div>}
                           </td>

                           {/* Mobile Number */}
                           <td className="p-4 px-6 font-mono text-[11px] font-semibold text-slate-500 tracking-wider">
                              {lead.mobileNumber}
                           </td>

                           {/* Campaign Name */}
                           <td className="p-4 px-6 font-extrabold uppercase tracking-wide text-indigo-950 text-[10px]">
                              {lead.campaignName || 'ORGANIC_INLINE'}
                           </td>

                           {/* Assignee / Employee ID (Requirement 4) */}
                           <td className="p-4 px-6 select-none">
                              {canAssign && inlineAssignmentLeadId === lead.id ? (
                                 <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                                    <select
                                      value={inlineAssigneeId}
                                      onChange={(e) => setInlineAssigneeId(e.target.value)}
                                      className="bg-white border border-slate-200 text-[10px] font-black uppercase tracking-tight py-1.5 px-2 rounded-sm focus:ring-1 focus:ring-[#978C21] outline-none"
                                    >
                                       <option value="unassign">-- UNASSIGNED --</option>
                                       {allUsers.map(u => (
                                          <option key={u.employeeId} value={u.employeeId}>
                                             {u.role}: {u.name} (ID: {u.employeeId})
                                          </option>
                                       ))}
                                    </select>
                                    <button
                                      onClick={() => handleSaveInlineAssignment(lead.id)}
                                      className="p-1.5 bg-[#978C21] text-white rounded hover:opacity-95 text-[9px] font-bold"
                                      title="Confirm Route"
                                    >
                                       ✓
                                    </button>
                                    <button
                                      onClick={() => setInlineAssignmentLeadId(null)}
                                      className="p-1.5 bg-slate-100 text-slate-500 rounded hover:bg-slate-200 text-[9px]"
                                    >
                                       ✕
                                    </button>
                                 </div>
                              ) : (
                                 <div className="flex items-center gap-2">
                                    {lead.assignedTo ? (
                                       <span className="font-extrabold uppercase italic tracking-wider text-[#978C21] bg-[#978C21]/5 border border-[#978C21]/15 px-2 py-1 rounded text-[9px]">
                                          {lead.assignedTo}
                                       </span>
                                    ) : (
                                       <span className="font-black uppercase italic tracking-widest text-amber-600 bg-amber-50 border border-amber-100 px-2 py-1 rounded text-[9px]">
                                          ● UNASSIGNED
                                       </span>
                                    )}
                                    {canAssign && (
                                      <button
                                        onClick={() => {
                                          setInlineAssigneeId(lead.assignedTo || 'unassign');
                                          setInlineAssignmentLeadId(lead.id);
                                        }}
                                        className="opacity-0 group-hover:opacity-100 text-[9px] font-black px-1.5 py-0.5 uppercase tracking-widest italic hover:text-[#978C21] text-slate-400 bg-slate-50 transition-opacity ml-2"
                                      >
                                        Change
                                      </button>
                                    )}
                                 </div>
                              )}
                           </td>

                           {/* Status Badge */}
                           <td className="p-4 px-6">
                              <span className="px-2 py-1 bg-slate-900 border border-slate-900 text-white font-extrabold uppercase tracking-widest rounded-sm text-[8px] italic">
                                 {lead.currentStatus}
                              </span>
                           </td>

                           {/* Upload timestamp */}
                           <td className="p-4 px-6 font-mono text-slate-400 text-[10px]">
                              {lead.timestamp ? new Date(lead.timestamp).toLocaleDateString('en-GB') : 'N/A'}
                           </td>

                           {/* Row Controls */}
                           <td className="p-4 px-6 text-center select-none" onClick={(e) => e.stopPropagation()}>
                              <div className="flex items-center justify-center gap-3">
                                 <button
                                   onClick={() => setSelectedLead(lead)}
                                   className="p-2 border border-slate-100 hover:border-slate-200 text-slate-600 hover:text-[#978C21] hover:bg-slate-50 rounded-sm shadow-sm transition-all bg-white"
                                   title="Inspect Data & Event Stream"
                                 >
                                    <Edit3 className="w-3.5 h-3.5" />
                                 </button>
                                 {canDelete && (
                                   <button
                                     onClick={() => handleDeleteIndividualLead(lead.id)}
                                     className="p-2 border border-slate-100 hover:border-red-200 text-slate-600 hover:text-red-500 hover:bg-red-50 rounded-sm shadow-sm transition-all bg-white"
                                     title="Secure Delete"
                                   >
                                      <Trash2 className="w-3.5 h-3.5" />
                                   </button>
                                 )}
                              </div>
                           </td>
                        </tr>
                     ))
                  )}
               </tbody>
            </table>
         </div>
      </div>

      {/* Global Campaign Destruction Safeguard Confirmation Modal */}
      {isConfirmDeleteCampOpen && (
         <div className="fixed inset-0 bg-slate-950/40 backdrop-blur-xs flex items-center justify-center z-50">
            <div className="bg-white rounded-sm border border-slate-100 p-8 shadow-2xl max-w-md w-full animate-in fade-in zoom-in-95 duration-200">
               <div className="flex items-start gap-4">
                  <div className="p-3 bg-red-100 text-red-600 rounded-sm">
                     <AlertTriangle className="w-6 h-6" />
                  </div>
                  <div className="flex-1">
                     <h3 className="text-[14px] font-black text-slate-950 uppercase tracking-tight italic">Irreversible Deletion Safeguard</h3>
                     <p className="text-xs text-slate-500 mt-2 leading-relaxed">
                        Are you absolutely certain you want to purge and eradicate all leads associated with the campaign 
                        <span className="font-extrabold text-red-600 uppercase mx-1">"{targetCampaignToDelete}"</span>? 
                        Any associated pipeline histories, operational updates, and logs will be lost permanently.
                     </p>
                     
                     <div className="mt-4 space-y-1.5">
                        <label className="text-[9px] font-black text-[#978C21] uppercase tracking-widest italic">Confirm with Login Password *</label>
                        <input 
                          type="password"
                          value={deleteConfirmPassword}
                          onChange={(e) => setDeleteConfirmPassword(e.target.value)}
                          className="w-full px-4 py-3 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-tight focus:ring-1 focus:ring-[#978C21] focus:border-[#978C21] outline-none animate-none"
                          placeholder="ENTER YOUR PASSWORD"
                        />
                     </div>
                  </div>
               </div>
               <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-slate-50">
                  <button
                    onClick={() => {
                       setIsConfirmDeleteCampOpen(false);
                       setDeleteConfirmPassword('');
                    }}
                    className="px-5 py-3 border border-slate-200 hover:bg-slate-50 text-[10px] font-black uppercase tracking-widest text-slate-500 rounded-sm transition-all"
                  >
                     Abort Operations
                  </button>
                  <button
                    onClick={handlePurgeCampaignLeads}
                    className="px-5 py-3 bg-red-600 hover:bg-red-700 text-white text-[10px] font-black uppercase tracking-widest rounded-sm transition-all shadow-md"
                  >
                     Proceed with Complete Purge
                  </button>
               </div>
            </div>
         </div>
      )}

      {/* DEMOGRAPHICS EDITOR & TELEMETRY AUDIT LOG DRAWER MODAL */}
      {selectedLead && (
         <div className="fixed inset-0 bg-slate-950/50 backdrop-blur-xs flex items-center justify-end z-50 animate-in fade-in duration-200">
            <div className="fixed inset-0" onClick={() => setSelectedLead(null)} />
            <div className="bg-white border-l border-slate-100 h-screen w-full max-w-xl shadow-2xl z-5 relative flex flex-col justify-between overflow-y-auto animate-in slide-in-from-right duration-300">
               {/* Modal Header */}
               <div className="p-8 border-b border-slate-50 flex items-center justify-between bg-slate-50/50 select-none">
                  <div>
                     <span className="text-[9px] font-black tracking-[0.25em] text-[#978C21] uppercase italic">Admin Registry Oversight</span>
                     <h3 className="text-lg font-black text-brand-text truncate uppercase italic tracking-tight">{editName || 'Dynamic Inspector'}</h3>
                  </div>
                  <button 
                    onClick={() => setSelectedLead(null)}
                    className="p-2 hover:bg-slate-100 text-slate-400 hover:text-slate-800 transition-all rounded-sm border border-transparent hover:border-slate-100"
                  >
                     <X className="w-5 h-5" />
                  </button>
               </div>

               {/* Modal Content */}
               <div className="flex-1 p-8 space-y-8">
                  {/* Row Basic status display */}
                  <div className="grid grid-cols-2 gap-4 bg-[#FBFAF8] border border-slate-100 p-5 rounded-sm">
                     <div>
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest italic">Archived Current Status</p>
                        <span className="inline-block mt-2 px-2.5 py-1 bg-slate-900 text-white font-extrabold uppercase tracking-widest text-[8px] italic leading-none rounded-sm">
                           {selectedLead.currentStatus}
                        </span>
                     </div>
                     <div>
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest italic">Active Campaign Funnel</p>
                        <span className="inline-block mt-2 text-[10px] font-black uppercase text-indigo-900 italic leading-none">
                           {selectedLead.campaignName || 'unassociated'}
                        </span>
                     </div>
                  </div>

                  {/* Core Editor inputs */}
                  <div className="space-y-4">
                     <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] italic border-b border-slate-50 pb-2">Modify Demographics Registry</p>
                     <fieldset disabled={!canEdit} className="contents">
                     <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-1">
                           <p className="text-[9px] font-black text-slate-400 uppercase italic">Prospect Full Name *</p>
                           <input 
                             type="text"
                             value={editName}
                             onChange={(e) => setEditName(e.target.value)}
                             className="w-full bg-[#FBFAF8] border border-slate-100 rounded-sm px-4 py-2.5 text-[11px] font-black uppercase tracking-wider outline-none focus:ring-1 focus:ring-[#978C21]"
                           />
                        </div>
                        <div className="space-y-1">
                           <p className="text-[9px] font-black text-slate-400 uppercase italic">Mobile Connect *</p>
                           <input 
                             type="text"
                             value={editPhone}
                             onChange={(e) => setEditPhone(e.target.value)}
                             className="w-full bg-[#FBFAF8] border border-slate-100 rounded-sm px-4 py-2.5 text-[11px] font-mono font-semibold tracking-wider outline-none focus:ring-1 focus:ring-[#978C21]"
                           />
                        </div>
                        <div className="space-y-1">
                           <p className="text-[9px] font-black text-slate-400 uppercase italic">Primary Email</p>
                           <input 
                             type="email"
                             value={editEmail}
                             onChange={(e) => setEditEmail(e.target.value)}
                             className="w-full bg-[#FBFAF8] border border-slate-100 rounded-sm px-4 py-2.5 text-[11px] outline-none focus:ring-1 focus:ring-[#978C21]"
                           />
                        </div>
                        <div className="space-y-1">
                           <p className="text-[9px] font-black text-slate-400 uppercase italic">Designated Product Option</p>
                           <input 
                             type="text"
                             value={editProduct}
                             onChange={(e) => setEditProduct(e.target.value)}
                             className="w-full bg-[#FBFAF8] border border-slate-100 rounded-sm px-4 py-2.5 text-[11px] font-black uppercase outline-none focus:ring-1 focus:ring-[#978C21]"
                           />
                        </div>
                        <div className="space-y-1">
                           <p className="text-[9px] font-black text-slate-400 uppercase italic">Campaign Match</p>
                           <select 
                             value={editCampaign}
                             onChange={(e) => setEditCampaign(e.target.value)}
                             className="w-full bg-[#FBFAF8] border border-slate-100 rounded-sm px-4 py-2.5 text-[11px] font-black uppercase outline-none focus:ring-1 focus:ring-[#978C21]"
                           >
                              <option value="">-- NO CAMPAIGN --</option>
                              {campaignOptions.map(c => (
                                 <option key={c} value={c}>{c}</option>
                              ))}
                           </select>
                        </div>
                        <div className="space-y-1">
                           <p className="text-[9px] font-black text-slate-400 uppercase italic">Professional Category</p>
                           <input 
                             type="text"
                             value={editProfession}
                             onChange={(e) => setEditProfession(e.target.value)}
                             className="w-full bg-[#FBFAF8] border border-slate-100 rounded-sm px-4 py-2.5 text-[11px] font-black uppercase outline-none focus:ring-1 focus:ring-[#978C21]"
                           />
                        </div>
                        <div className="col-span-1 md:col-span-2 space-y-1">
                           <p className="text-[9px] font-black text-slate-400 uppercase italic">Active Regional Location (Area)</p>
                           <input 
                             type="text"
                             value={editArea}
                             onChange={(e) => setEditArea(e.target.value)}
                             className="w-full bg-[#FBFAF8] border border-slate-100 rounded-sm px-4 py-2.5 text-[11px] font-black uppercase outline-none focus:ring-1 focus:ring-[#978C21]"
                           />
                        </div>
                        <div className="col-span-1 md:col-span-2 space-y-1">
                           <span className="text-[9px] font-black text-slate-400 uppercase italic">Lead Origin (Source)</span>
                           <input 
                             type="text"
                             value={editSource}
                             onChange={(e) => setEditSource(e.target.value)}
                             className="w-full bg-[#FBFAF8] border border-slate-100 rounded-sm px-4 py-2.5 text-[11px] font-black uppercase outline-none focus:ring-1 focus:ring-[#978C21]"
                           />
                        </div>
                     </div>
                     </fieldset>
                     {!canEdit && (
                       <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-100 rounded-sm p-3">
                         View only: demographic corrections require the canonical <code>leads.edit</code> permission.
                       </p>
                     )}
                  </div>

                  {/* Assign Routing Controls */}
                  <div className="p-5 bg-indigo-50/30 border border-indigo-100 rounded-sm space-y-3">
                     <p className="text-[10px] font-black text-slate-900 uppercase tracking-widest italic leading-none flex items-center gap-2">
                        <UserCheck className="w-4 h-4 text-[#978C21]" />
                        Assignee Router Control
                     </p>
                     <p className="text-[11px] text-slate-500">Route or transfer matching ownership. Assigning to any RM propagates instant alerts to their interface feed.</p>
                     <select
                       value={editAssignee}
                       disabled={!canAssign}
                       onChange={(e) => setEditAssignee(e.target.value)}
                       className="w-full bg-white border border-slate-200 text-[11px] font-black uppercase tracking-wider p-3 rounded-sm focus:ring-1 focus:ring-[#978C21] outline-none"
                     >
                        <option value="">-- UNASSIGNED (BLANK) --</option>
                        {allUsers.map((u) => (
                           <option key={u.employeeId} value={u.employeeId}>
                              {u.role.toUpperCase()}: {u.name} (Employee ID: {u.employeeId})
                           </option>
                        ))}
                     </select>
                  </div>

                  {/* Operational Timeline Interaction Log History (Demanded Log Download requirement) */}
                  <div className="space-y-4">
                     <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] italic border-b border-slate-50 pb-2">Interaction Lifecycle History Logs</p>
                     {selectedLead.statusHistory && selectedLead.statusHistory.length > 0 ? (
                        <div className="space-y-3 max-h-48 overflow-y-auto pr-1 scrollbar-thin">
                           {selectedLead.statusHistory.slice().reverse().map((audit, aIdx) => (
                              <div key={aIdx} className="p-4 bg-[#FBFAF8] border border-slate-100 rounded-sm space-y-1.5 text-[11px]">
                                 <div className="flex justify-between items-center bg-white border border-slate-100 px-3 py-1.5">
                                    <span className="font-bold text-[#978C21] uppercase tracking-wider">{audit.status}</span>
                                    <span className="text-[9px] text-slate-400 font-medium font-mono">{new Date(audit.date).toLocaleString()}</span>
                                 </div>
                                 <p className="text-slate-700 italic px-1 font-semibold">"{audit.remarks || 'No interaction remarks provided'}"</p>
                                 <div className="flex justify-between items-center text-[9px] text-slate-400 pt-1.5 border-t border-slate-100/50">
                                    <span>Log Writer: {audit.updatedBy || 'N/A'}</span>
                                    {audit.nextFollowUpDate && <span className="text-emerald-600 font-bold">Follow up set: {new Date(audit.nextFollowUpDate).toLocaleDateString()}</span>}
                                 </div>
                              </div>
                           ))}
                        </div>
                     ) : (
                        <div className="p-8 text-center text-slate-400 text-[10px] font-bold uppercase tracking-widest italic border border-dashed border-slate-100">
                           No actions executed on this lead yet.
                        </div>
                     )}
                  </div>
               </div>

               {/* Modal Footer Controls */}
               <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-4 select-none">
                  {canExport && (
                  <button
                    onClick={() => {
                      if (!canExport) {
                         toast.error('Access Denied: the canonical leads.export permission is required.');
                         return;
                      }
                      if (window.confirm("Ensure any modification will overwrite values. Select OK to export back to CSV.")) {
                         // Simple log downloader for this lead specifically
                         const headers = ['Action Date', 'Target Status', 'Log Operator', 'Interaction Remarks', 'Planned Date'];
                         const rows = (selectedLead.statusHistory || []).map(hist => [
                            hist.date,
                            hist.status,
                            hist.updatedBy || 'System',
                            hist.remarks || '',
                            hist.nextFollowUpDate || ''
                         ]);
                         
                         const csvContent = "data:text/csv;charset=utf-8," 
                           + [headers.join(','), ...rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(','))].join('\n');
                         const encodedUri = encodeURI(csvContent);
                         const link = document.createElement("a");
                         link.setAttribute("href", encodedUri);
                         link.setAttribute("download", `Interaction_Audit_Logs_${selectedLead.prospectName}.csv`);
                         document.body.appendChild(link);
                         link.click();
                         document.body.removeChild(link);
                         toast.success('Lead audit telemetry exported successfully');
                      }
                    }}
                    className="flex-1 border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-black uppercase tracking-widest text-[10px] py-4 rounded-sm transition-all shadow-sm flex items-center justify-center gap-2"
                  >
                     📥 Export Logs
                  </button>
                  )}
                  {canEdit ? (
                  <button
                    onClick={handleUpdateLeadDetails}
                    className="flex-1 bg-slate-900 hover:bg-black text-white font-black uppercase tracking-widest text-[10px] py-4 rounded-sm transition-all shadow-xl"
                  >
                     Save Modifications
                  </button>
                  ) : (
                    <p className="flex-1 text-center self-center text-[10px] font-semibold text-slate-500">Read only: <code>leads.edit</code> is required to save permitted demographic changes.</p>
                  )}
               </div>
            </div>
         </div>
      )}
    </div>
  );
}
