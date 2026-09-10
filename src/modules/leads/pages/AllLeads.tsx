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
import { usePermissions } from '../../shared/hooks/usePermissions';
import { Lead, UserRole, LeadStatus } from '../../shared/types';
import { leadService } from '../services/leadService';
import { userService } from '../../users/services/userService';
import { settingsService } from '../../../services/settingsService';
import { toast } from 'sonner';
import AdvancedFilterPanel from '../../shared/components/AdvancedFilterPanel';
import { useTranslation } from '../../shared/utils/translations';

export default function AllLeads() {
  const { user } = useAuthStore();
  const { t } = useTranslation();
  const { canAccess, userRole } = usePermissions();
  const navigate = useNavigate();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [advancedFilteredLeads, setAdvancedFilteredLeads] = useState<Lead[]>([]);
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
    if (!selectedLeadIds.length) {
      toast.error(t('noLeadsSelected'));
      return;
    }
    if (!bulkAssigneeId) {
      toast.error(t('chooseBulkAssignee'));
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
      toast.success(t('batchAssignSuccess', { count: String(selectedLeadIds.length) }));
      setSelectedLeadIds([]);
      setBulkAssigneeId('');
      loadData();
    } catch (err) {
      toast.error(t('bulkAssignmentFailed'));
    } finally {
      setBulkAssigning(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [user]);

  const loadData = async () => {
    if (!user) return;
    setLoading(true);
    try {
      // 1. Fetch all leads in database without restriction (Since user role is ADMIN)
      const allLeads = await leadService.getLeads({ role: UserRole.ADMIN });
      setLeads(allLeads);

      // 2. Fetch all system team members
      const usersList = await userService.getAllUsers();
      setAllUsers(usersList);

      // 3. Select active campaigns 
      const campaigns = await settingsService.getOptionsByType('Campaign');
      setCampaignOptions(campaigns);
    } catch (err) {
      toast.error(t('initMatrixSyncFailure'));
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
    if (!canAccess('all_leads', 'delete_destroy_leads')) {
      toast.error(t('accessDeniedDeleteLeads'));
      return;
    }
    if (!window.confirm(t('confirmDeleteLeadPermanent'))) return;
    try {
      await leadService.deleteLead(leadId);
      toast.success(t('leadPermanentlyRemoved'));
      setLeads(prev => prev.filter(l => l.id !== leadId));
      if (selectedLead?.id === leadId) setSelectedLead(null);
    } catch (err) {
      toast.error(t('deletionFailure'));
    }
  };

  // Handle campaign-wise deletion
  const handlePurgeCampaignLeads = async () => {
    if (!canAccess('all_leads', 'delete_destroy_leads')) {
      toast.error(t('accessDeniedDeleteCampaigns'));
      return;
    }
    if (!targetCampaignToDelete) {
      toast.error(t('purgeCampaignFirst'));
      return;
    }
    if (!deleteConfirmPassword) {
      toast.error(t('enterPasswordToConfirm'));
      return;
    }

    try {
      const verifyRes = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId: user?.employeeId, password: deleteConfirmPassword }),
      });

      if (!verifyRes.ok) {
        toast.error(t('incorrectPassword'));
        return;
      }

      await leadService.deleteLeadsByCampaign(targetCampaignToDelete);
      toast.success(t('campaignPurged', { campaign: targetCampaignToDelete }));
      setLeads(prev => prev.filter(l => l.campaignName !== targetCampaignToDelete));
      setIsConfirmDeleteCampOpen(false);
      setTargetCampaignToDelete('');
      setDeleteConfirmPassword('');
    } catch (err) {
      toast.error(t('campaignPurgeFailed'));
    }
  };

  if (!canAccess('all_leads', 'view_global_directory')) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center p-8 bg-white border border-slate-100 rounded-sm shadow-xs max-w-xl mx-auto space-y-6 animate-in fade-in duration-300">
        <div className="w-16 h-16 rounded-full bg-amber-50 border border-amber-100 flex items-center justify-center text-[#978C21] shrink-0 transform hover:rotate-12 transition-transform">
          <AlertTriangle className="w-8 h-8" />
        </div>
        <div className="space-y-2">
          <span className="text-[9px] font-black tracking-[0.25em] text-[#978C21] uppercase italic">{t('clearanceProtocolWarning')}</span>
          <h2 className="text-xl font-black text-slate-900 uppercase tracking-tight italic">{t('accessDeniedTitle')}</h2>
          <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider leading-relaxed">
            {t('clearanceLevel')} <span className="text-red-650 font-black">"{userRole || 'RESTRICTED'}"</span> {t('archiveAccessDeniedDesc')}
          </p>
        </div>
        <div className="pt-2 border-t border-slate-100 w-full text-[9px] font-mono text-slate-400 uppercase tracking-widest leading-none">
          {t('securityLevelRequired')}: all_leads.view_global_directory
        </div>
      </div>
    );
  }

  // Handle general lead details update
  const handleUpdateLeadDetails = async () => {
    if (!selectedLead) return;
    if (!editName.trim()) {
      toast.error(t('prospectNameMandatory'));
      return;
    }
    if (!editPhone.trim()) {
      toast.error(t('mobileMandatory'));
      return;
    }

    try {
      const updatePayload: Partial<Lead> = {
        prospectName: editName,
        mobileNumber: editPhone,
        email: editEmail,
        campaignName: editCampaign,
        assignedTo: editAssignee,
        area: editArea,
        source: editSource,
        productName: editProduct,
        profession: editProfession
      };

      await leadService.updateLead(selectedLead.id, updatePayload, user?.name || 'Administrator');
      toast.success(t('leadDemographicsUpdated'));
      setSelectedLead(null);
      loadData();
    } catch (err) {
      toast.error(t('updateSaveAborted'));
    }
  };

  // Handle inline quick-assign dropdown saving
  const handleSaveInlineAssignment = async (leadId: string) => {
    if (!inlineAssigneeId) {
      toast.error(t('selectAssigneeOrClear'));
      return;
    }
    try {
      await leadService.updateLead(leadId, { assignedTo: inlineAssigneeId }, user?.name || 'Admin');
      toast.success(t('leadRoutedTo', { id: inlineAssigneeId }));
      setInlineAssignmentLeadId(null);
      loadData();
    } catch (err) {
      toast.error(t('inlineAssignmentFailed'));
    }
  };

  // Searching logic combined with dynamic rules filter
  const filteredLeads = (() => {
    const baseList = advancedFilteredLeads.length > 0 || leads.length === 0 ? advancedFilteredLeads : leads;
    const q = searchQuery.toLowerCase().trim();
    if (!q) return baseList;

    return baseList.filter(l => {
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

  // Numeric summary calculations
  const totalLeadsCount = leads.length;
  const unassignedLeadsCount = leads.filter(l => !l.assignedTo || l.assignedTo.trim() === '').length;
  const uniqueCampaignsCount = Array.from(new Set(leads.map(l => l.campaignName).filter(Boolean))).length;
  const conversionRateCount = leads.filter(l => l.currentStatus === 'Converted').length;

  return (
    <div className="space-y-8 max-w-7xl mx-auto">
      {/* Title & Top Meta Row */}
      <div className="border-b border-slate-100 pb-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
           <span className="text-[9px] font-black tracking-[0.25em] text-[#978C21] uppercase italic">{t('systemManagementConsole')}</span>
           <h1 className="text-2xl font-black text-slate-900 uppercase tracking-tight italic mt-1">{t('allLeadsTitle')}</h1>
           <p className="text-xs text-slate-500 mt-1">{t('allLeadsSubtitle')}</p>
        </div>
        <div className="flex gap-3">
          <button 
             onClick={loadData}
             className="px-5 py-3 border border-slate-200 hover:bg-slate-50 text-[10px] font-black uppercase tracking-widest text-slate-700 bg-white shadow-sm rounded-sm transition-all flex items-center gap-2"
          >
             🔄 {t('reloadData')}
          </button>
        </div>
      </div>

      {/* Admin Quick Statistics Widget Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
         <div className="p-6 bg-[#FBFAF8] border border-slate-100 rounded-sm shadow-sm relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-4 opacity-5 text-slate-900 group-hover:scale-110 transition-transform">
               <Database className="w-16 h-16" />
            </div>
            <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest italic">{t('archivedRecords')}</p>
            <p className="text-3xl font-black text-slate-900 italic tracking-tighter leading-none mt-2">{totalLeadsCount}</p>
            <span className="text-[9px] text-[#978C21] font-bold mt-2 block lowercase italic">{t('uploadedEntitiesCataloged')}</span>
         </div>

         <div className="p-6 bg-amber-50/50 border border-amber-100 rounded-sm shadow-sm relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-4 opacity-5 text-amber-500">
               <Inbox className="w-16 h-16" />
            </div>
            <p className="text-[9px] font-black text-amber-700 uppercase tracking-widest italic">{t('pendingAssignment')}</p>
            <p className="text-3xl font-black text-amber-800 italic tracking-tighter leading-none mt-2">{unassignedLeadsCount}</p>
            <span className="text-[9px] text-amber-600 font-bold mt-2 block lowercase italic">{t('requiresOperatorRouting')}</span>
         </div>

         <div className="p-6 bg-[#978C21]/5 border border-[#978C21]/10 rounded-sm shadow-sm relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-4 opacity-5 text-[#978C21]">
               <Sliders className="w-16 h-16" />
            </div>
            <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest italic">{t('liveCampaignChannels')}</p>
            <p className="text-3xl font-black text-slate-900 italic tracking-tighter leading-none mt-2">{uniqueCampaignsCount}</p>
            <span className="text-[9px] text-[#978C21] font-bold mt-2 block lowercase italic">{t('activeGenerationFunnels')}</span>
         </div>

         <div className="p-6 bg-emerald-50/50 border border-emerald-100 rounded-sm shadow-sm relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-4 opacity-5 text-emerald-500">
               <TrendingUp className="w-16 h-16" />
            </div>
            <p className="text-[9px] font-black text-emerald-800 uppercase tracking-widest italic">{t('convertedAcquisitions')}</p>
            <p className="text-3xl font-black text-emerald-900 italic tracking-tighter leading-none mt-2">{conversionRateCount}</p>
            <span className="text-[9px] text-emerald-600 font-bold mt-2 block lowercase italic">{t('convertedPipelineTargets')}</span>
         </div>
      </div>

      {/* Campaign Purge Management Section */}
      {canAccess('all_leads', 'delete_destroy_leads') && (
      <div className="p-6 bg-red-50/30 border border-red-100/60 rounded-sm shadow-sm">
         <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
            <div className="space-y-1 max-w-2xl">
               <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-ping" />
                  <p className="text-[10px] font-black text-red-700 uppercase tracking-widest italic">{t('campWiseCleanup')}</p>
               </div>
               <h3 className="text-[13px] font-black text-slate-950 uppercase tracking-tight italic">{t('eraseLeadsByCampaign')}</h3>
               <p className="text-xs text-slate-500">{t('eraseLeadsByCampaignDesc')}</p>
            </div>
            <div className="flex items-center gap-3">
               <select
                 value={targetCampaignToDelete}
                 onChange={(e) => setTargetCampaignToDelete(e.target.value)}
                 className="bg-white border border-slate-200 text-[11px] font-black uppercase tracking-wider px-4 py-3 rounded-sm focus:ring-1 focus:ring-red-500 outline-none"
               >
                  <option value="">-- {t('chooseTargetCampaign')} --</option>
                  {Array.from(new Set(leads.map(l => l.campaignName).filter(Boolean))).map(camp => (
                     <option key={String(camp)} value={String(camp)}>{String(camp).toUpperCase()}</option>
                  ))}
               </select>
               <button
                 type="button"
                 onClick={() => {
                   if (!targetCampaignToDelete) {
                     toast.error(t('pickCampaignFirst'));
                     return;
                   }
                   setIsConfirmDeleteCampOpen(true);
                 }}
                 className="px-5 py-3.5 bg-red-600 hover:bg-red-700 text-white text-[10px] font-black uppercase tracking-widest rounded-sm transition-all shadow-md flex items-center gap-2"
               >
                  <Trash2 className="w-3.5 h-3.5" />
                  {t('eraseLead')}
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
                 placeholder={t('searchAllLeads')}
                 value={searchQuery}
                 onChange={(e) => setSearchQuery(e.target.value)}
                 className="w-full pl-12 pr-4 py-3 bg-white border border-slate-200/85 text-[11px] font-black uppercase tracking-wider focus:ring-1 focus:ring-[#978C21] rounded-sm placeholder:opacity-50 outline-none"
               />
            </div>
            <div className="text-[10px] text-slate-400 font-extrabold uppercase italic tracking-widest">
               {t('displayingRecords', { shown: String(filteredLeads.length), total: String(leads.length) })}
            </div>
         </div>

         {/* Batch Lead Assignment Header Panel when items are selected */}
         {selectedLeadIds.length > 0 && (
            <div className="p-5 bg-amber-50/65 border-b border-amber-100/80 flex flex-col md:flex-row md:items-center justify-between gap-4 animate-fadeIn">
               <div className="flex items-center gap-2">
                  <span className="inline-flex items-center justify-center bg-[#978C21] text-white font-black rounded-full h-5 w-5 text-[10px] shadow-sm">
                     {selectedLeadIds.length}
                  </span>
                  <div>
                     <p className="text-[11px] font-black uppercase tracking-widest text-slate-900 italic">{t('bulkRoutingWorkflow')}</p>
                     <p className="text-[10px] text-slate-500 font-medium">{t('bulkRoutingDesc')}</p>
                  </div>
               </div>
               <div className="flex items-center gap-3">
                  <select
                    value={bulkAssigneeId}
                    onChange={(e) => setBulkAssigneeId(e.target.value)}
                    className="bg-white border border-slate-200 text-[10px] font-black uppercase py-2 px-3 rounded-sm outline-none focus:ring-1 focus:ring-[#978C21] cursor-pointer"
                  >
                     <option value="">-- {t('selectRerouteHandler')} --</option>
                     <option value="unassign">-- {t('markUnassigned')} --</option>
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
                     {bulkAssigning ? t('synchronizingEdits') : t('assignSelection')}
                  </button>
                  <button
                    onClick={() => setSelectedLeadIds([])}
                    className="text-slate-400 hover:text-slate-600 text-[10px] font-black uppercase tracking-widest px-2 cursor-pointer border-l border-slate-200 pl-4 py-1"
                  >
                     {t('cancelSelection')}
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
                          checked={filteredLeads.length > 0 && selectedLeadIds.length === filteredLeads.length}
                          onChange={(e) => {
                             if (e.target.checked) {
                                setSelectedLeadIds(filteredLeads.map(l => l.id));
                             } else {
                                setSelectedLeadIds([]);
                             }
                          }}
                          className="cursor-pointer accent-[#978C21] h-3.5 w-3.5 rounded border-slate-300 focus:ring-0"
                        />
                     </th>
                     <th className="p-4 px-6 text-slate-900">{t('demographicName')}</th>
                     <th className="p-4 px-6 text-slate-900">{t('mobileConnection')}</th>
                     <th className="p-4 px-6 text-slate-900">{t('campaign')}</th>
                     <th className="p-4 px-6 text-slate-[#978C21]">{t('assigneeStatus')}</th>
                     <th className="p-4 px-6 text-slate-900">{t('currentStatus')}</th>
                     <th className="p-4 px-6 text-slate-900">{t('uploadDate')}</th>
                     <th className="p-4 px-6 text-center text-slate-900">{t('controlActions')}</th>
                  </tr>
               </thead>
               <tbody className="divide-y divide-slate-50 text-[11px] text-slate-700 font-medium">
                  {loading ? (
                     <tr>
                        <td colSpan={8} className="p-12 text-center text-[10px] text-slate-400 font-black uppercase tracking-widest italic leading-none">
                           🔄 {t('catalogingRecords')}
                        </td>
                     </tr>
                  ) : filteredLeads.length === 0 ? (
                     <tr>
                        <td colSpan={8} className="p-12 text-center text-[10px] text-slate-400 font-black uppercase tracking-widest italic leading-none">
                           📭 {t('noMatchingLeads')}
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
                                 <span>{lead.prospectName || t('anonymousCandidate')}</span>
                                 <button
                                    onClick={(e) => { e.stopPropagation(); navigate(`/leads/${lead.id}`); }}
                                    title={t('viewFullTimeline')}
                                    className="text-[8px] font-black text-[#978C21] bg-[#978C21]/10 px-1.5 py-0.5 rounded-sm uppercase tracking-wider hover:bg-[#978C21]/20 transition-all shrink-0"
                                 >
                                    {t('timeline')}
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
                              {inlineAssignmentLeadId === lead.id ? (
                                 <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                                    <select
                                      value={inlineAssigneeId}
                                      onChange={(e) => setInlineAssigneeId(e.target.value)}
                                      className="bg-white border border-slate-200 text-[10px] font-black uppercase tracking-tight py-1.5 px-2 rounded-sm focus:ring-1 focus:ring-[#978C21] outline-none"
                                    >
                                       <option value="">-- {t('unassignedLabel')} --</option>
                                       {allUsers.map(u => (
                                          <option key={u.employeeId} value={u.employeeId}>
                                             {u.role}: {u.name} (ID: {u.employeeId})
                                          </option>
                                       ))}
                                    </select>
                                    <button
                                      onClick={() => handleSaveInlineAssignment(lead.id)}
                                      className="p-1.5 bg-[#978C21] text-white rounded hover:opacity-95 text-[9px] font-bold"
                                      title={t('confirm')}
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
                                          ● {t('unassignedLabel')}
                                       </span>
                                    )}
                                    <button 
                                      onClick={() => {
                                        setInlineAssigneeId(lead.assignedTo || '');
                                        setInlineAssignmentLeadId(lead.id);
                                      }}
                                      className="opacity-0 group-hover:opacity-100 text-[9px] font-black px-1.5 py-0.5 uppercase tracking-widest italic hover:text-[#978C21] text-slate-400 bg-slate-50 transition-opacity ml-2"
                                    >
                                       {t('change')}
                                    </button>
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
                              {lead.timestamp ? new Date(lead.timestamp).toLocaleDateString('en-GB') : t('na')}
                           </td>

                           {/* Row Controls */}
                           <td className="p-4 px-6 text-center select-none" onClick={(e) => e.stopPropagation()}>
                              <div className="flex items-center justify-center gap-3">
                                 <button
                                   onClick={() => setSelectedLead(lead)}
                                   className="p-2 border border-slate-100 hover:border-slate-200 text-slate-600 hover:text-[#978C21] hover:bg-slate-50 rounded-sm shadow-sm transition-all bg-white"
                                   title={t('inspectDataStream')}
                                 >
                                    <Edit3 className="w-3.5 h-3.5" />
                                 </button>
                                 <button
                                   onClick={() => handleDeleteIndividualLead(lead.id)}
                                   className="p-2 border border-slate-100 hover:border-red-200 text-slate-600 hover:text-red-500 hover:bg-red-50 rounded-sm shadow-sm transition-all bg-white"
                                   title={t('secureDelete')}
                                 >
                                    <Trash2 className="w-3.5 h-3.5" />
                                 </button>
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
                     <h3 className="text-[14px] font-black text-slate-950 uppercase tracking-tight italic">{t('irreversibleDeletionSafeguard')}</h3>
                     <p className="text-xs text-slate-500 mt-2 leading-relaxed">
                        {t('confirmCampaignPurge', { campaign: targetCampaignToDelete })}
                        <span className="font-extrabold text-red-600 uppercase mx-1">"{targetCampaignToDelete}"</span>? 
                        
                     </p>
                     
                     <div className="mt-4 space-y-1.5">
                        <label className="text-[9px] font-black text-[#978C21] uppercase tracking-widest italic">{t('confirmWithPassword')} *</label>
                        <input 
                          type="password"
                          value={deleteConfirmPassword}
                          onChange={(e) => setDeleteConfirmPassword(e.target.value)}
                          className="w-full px-4 py-3 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-tight focus:ring-1 focus:ring-[#978C21] focus:border-[#978C21] outline-none animate-none"
                          placeholder={t('enterYourPassword').toUpperCase()}
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
                     {t('abortOperations')}
                  </button>
                  <button
                    onClick={handlePurgeCampaignLeads}
                    className="px-5 py-3 bg-red-600 hover:bg-red-700 text-white text-[10px] font-black uppercase tracking-widest rounded-sm transition-all shadow-md"
                  >
                     {t('proceedCompletePurge')}
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
                     <span className="text-[9px] font-black tracking-[0.25em] text-[#978C21] uppercase italic">{t('adminRegistryOversight')}</span>
                     <h3 className="text-lg font-black text-brand-text truncate uppercase italic tracking-tight">{editName || t('dynamicInspector')}</h3>
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
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest italic">{t('archivedCurrentStatus')}</p>
                        <span className="inline-block mt-2 px-2.5 py-1 bg-slate-900 text-white font-extrabold uppercase tracking-widest text-[8px] italic leading-none rounded-sm">
                           {selectedLead.currentStatus}
                        </span>
                     </div>
                     <div>
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest italic">{t('activeCampaignFunnel')}</p>
                        <span className="inline-block mt-2 text-[10px] font-black uppercase text-indigo-900 italic leading-none">
                           {selectedLead.campaignName || t('noCampaign')}
                        </span>
                     </div>
                  </div>

                  {/* Core Editor inputs */}
                  <div className="space-y-4">
                     <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] italic border-b border-slate-50 pb-2">{t('modifyDemographicsRegistry')}</p>
                     <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-1">
                           <p className="text-[9px] font-black text-slate-400 uppercase italic">{t('prospectFullName')} *</p>
                           <input 
                             type="text"
                             value={editName}
                             onChange={(e) => setEditName(e.target.value)}
                             className="w-full bg-[#FBFAF8] border border-slate-100 rounded-sm px-4 py-2.5 text-[11px] font-black uppercase tracking-wider outline-none focus:ring-1 focus:ring-[#978C21]"
                           />
                        </div>
                        <div className="space-y-1">
                           <p className="text-[9px] font-black text-slate-400 uppercase italic">{t('mobileConnect')} *</p>
                           <input 
                             type="text"
                             value={editPhone}
                             onChange={(e) => setEditPhone(e.target.value)}
                             className="w-full bg-[#FBFAF8] border border-slate-100 rounded-sm px-4 py-2.5 text-[11px] font-mono font-semibold tracking-wider outline-none focus:ring-1 focus:ring-[#978C21]"
                           />
                        </div>
                        <div className="space-y-1">
                           <p className="text-[9px] font-black text-slate-400 uppercase italic">{t('primaryEmail')}</p>
                           <input 
                             type="email"
                             value={editEmail}
                             onChange={(e) => setEditEmail(e.target.value)}
                             className="w-full bg-[#FBFAF8] border border-slate-100 rounded-sm px-4 py-2.5 text-[11px] outline-none focus:ring-1 focus:ring-[#978C21]"
                           />
                        </div>
                        <div className="space-y-1">
                           <p className="text-[9px] font-black text-slate-400 uppercase italic">{t('designatedProduct')}</p>
                           <input 
                             type="text"
                             value={editProduct}
                             onChange={(e) => setEditProduct(e.target.value)}
                             className="w-full bg-[#FBFAF8] border border-slate-100 rounded-sm px-4 py-2.5 text-[11px] font-black uppercase outline-none focus:ring-1 focus:ring-[#978C21]"
                           />
                        </div>
                        <div className="space-y-1">
                           <p className="text-[9px] font-black text-slate-400 uppercase italic">{t('campaignMatch')}</p>
                           <select 
                             value={editCampaign}
                             onChange={(e) => setEditCampaign(e.target.value)}
                             className="w-full bg-[#FBFAF8] border border-slate-100 rounded-sm px-4 py-2.5 text-[11px] font-black uppercase outline-none focus:ring-1 focus:ring-[#978C21]"
                           >
                              <option value="">-- {t('noCampaign')} --</option>
                              {campaignOptions.map(c => (
                                 <option key={c} value={c}>{c}</option>
                              ))}
                           </select>
                        </div>
                        <div className="space-y-1">
                           <p className="text-[9px] font-black text-slate-400 uppercase italic">{t('professionalCategory')}</p>
                           <input 
                             type="text"
                             value={editProfession}
                             onChange={(e) => setEditProfession(e.target.value)}
                             className="w-full bg-[#FBFAF8] border border-slate-100 rounded-sm px-4 py-2.5 text-[11px] font-black uppercase outline-none focus:ring-1 focus:ring-[#978C21]"
                           />
                        </div>
                        <div className="col-span-1 md:col-span-2 space-y-1">
                           <p className="text-[9px] font-black text-slate-400 uppercase italic">{t('activeRegionalLocation')}</p>
                           <input 
                             type="text"
                             value={editArea}
                             onChange={(e) => setEditArea(e.target.value)}
                             className="w-full bg-[#FBFAF8] border border-slate-100 rounded-sm px-4 py-2.5 text-[11px] font-black uppercase outline-none focus:ring-1 focus:ring-[#978C21]"
                           />
                        </div>
                        <div className="col-span-1 md:col-span-2 space-y-1">
                           <span className="text-[9px] font-black text-slate-400 uppercase italic">{t('leadOrigin')}</span>
                           <input 
                             type="text"
                             value={editSource}
                             onChange={(e) => setEditSource(e.target.value)}
                             className="w-full bg-[#FBFAF8] border border-slate-100 rounded-sm px-4 py-2.5 text-[11px] font-black uppercase outline-none focus:ring-1 focus:ring-[#978C21]"
                           />
                        </div>
                     </div>
                  </div>

                  {/* Assign Routing Controls */}
                  <div className="p-5 bg-indigo-50/30 border border-indigo-100 rounded-sm space-y-3">
                     <p className="text-[10px] font-black text-slate-900 uppercase tracking-widest italic leading-none flex items-center gap-2">
                        <UserCheck className="w-4 h-4 text-[#978C21]" />
                        {t('assigneeRouterControl')}
                     </p>
                     <p className="text-[11px] text-slate-500">{t('assigneeRouterDesc')}</p>
                     <select
                       value={editAssignee} disabled={!canAccess('all_leads', 'reassign_global_leads')}
                       onChange={(e) => setEditAssignee(e.target.value)}
                       className="w-full bg-white border border-slate-200 text-[11px] font-black uppercase tracking-wider p-3 rounded-sm focus:ring-1 focus:ring-[#978C21] outline-none"
                     >
                        <option value="">-- {t('unassignedBlank')} --</option>
                        {allUsers.map((u) => (
                           <option key={u.employeeId} value={u.employeeId}>
                              {u.role.toUpperCase()}: {u.name} (Employee ID: {u.employeeId})
                           </option>
                        ))}
                     </select>
                  </div>

                  {/* Operational Timeline Interaction Log History (Demanded Log Download requirement) */}
                  <div className="space-y-4">
                     <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] italic border-b border-slate-50 pb-2">{t('interactionLifecycleLogs')}</p>
                     {selectedLead.statusHistory && selectedLead.statusHistory.length > 0 ? (
                        <div className="space-y-3 max-h-48 overflow-y-auto pr-1 scrollbar-thin">
                           {selectedLead.statusHistory.slice().reverse().map((audit, aIdx) => (
                              <div key={aIdx} className="p-4 bg-[#FBFAF8] border border-slate-100 rounded-sm space-y-1.5 text-[11px]">
                                 <div className="flex justify-between items-center bg-white border border-slate-100 px-3 py-1.5">
                                    <span className="font-bold text-[#978C21] uppercase tracking-wider">{audit.status}</span>
                                    <span className="text-[9px] text-slate-400 font-medium font-mono">{new Date(audit.date).toLocaleString()}</span>
                                 </div>
                                 <p className="text-slate-700 italic px-1 font-semibold">"{audit.remarks || t('noInteractionRemarks')}"</p>
                                 <div className="flex justify-between items-center text-[9px] text-slate-400 pt-1.5 border-t border-slate-100/50">
                                    <span>{t('logWriter')}: {audit.updatedBy || t('na')}</span>
                                    {audit.nextFollowUpDate && <span className="text-emerald-600 font-bold">{t('followUpSet')}: {new Date(audit.nextFollowUpDate).toLocaleDateString()}</span>}
                                 </div>
                              </div>
                           ))}
                        </div>
                     ) : (
                        <div className="p-8 text-center text-slate-400 text-[10px] font-bold uppercase tracking-widest italic border border-dashed border-slate-100">
                           {t('noActionsExecuted')}
                        </div>
                     )}
                  </div>
               </div>

               {/* Modal Footer Controls */}
               <div className="p-8 border-t border-slate-100 bg-slate-50/50 flex gap-4 select-none">
                  <button
                    onClick={() => {
                      if (!canAccess('all_leads', 'export_raw_xlsx')) {
                         toast.error(t('exportLogsDenied'));
                         return;
                      }
                      if (window.confirm(t('confirmOverwriteExport'))) {
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
                         toast.success(t('auditExportedSuccess'));
                      }
                    }}
                    className="flex-1 border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-black uppercase tracking-widest text-[10px] py-4 rounded-sm transition-all shadow-sm flex items-center justify-center gap-2"
                  >
                     📥 {t('exportLogs')}
                  </button>
                  <button
                    onClick={handleUpdateLeadDetails}
                    className="flex-1 bg-slate-900 hover:bg-black text-white font-black uppercase tracking-widest text-[10px] py-4 rounded-sm transition-all shadow-xl"
                  >
                     {t('saveModifications')}
                  </button>
               </div>
            </div>
         </div>
      )}
    </div>
  );
}
