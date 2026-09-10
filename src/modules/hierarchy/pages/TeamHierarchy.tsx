import React, { useEffect, useState } from 'react';
import { 
  Users, 
  MapPin, 
  Briefcase, 
  UserCheck, 
  ArrowRight,
  TrendingDown,
  TrendingUp,
  Award,
  Search,
  X,
  ChevronRight,
  Building,
  Plus,
  Trash2,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Check,
  Save,
  ChevronDown,
  BarChart2,
  Lock,
  UserCheck2,
  Mail,
  Phone,
  LayoutGrid
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../../../lib/utils';
import { useAuthStore } from '../../auth/store/authStore';
import { useTranslation } from '../../shared/utils/translations';
import { userService } from '../../users/services/userService';
import { leadService } from '../../leads/services/leadService';
import { orgService } from '../services/orgService';
import { UserRole, User, Lead } from '../../shared/types';
import { toast } from 'sonner';

// Auto-generated organogram node (server derives the tree from users.manager_id)
interface OrgNode {
  employeeId: string;
  name: string;
  designation: string;
  roleId: string;
  roleName: string;
  level: number;              // company ladder level (1 = CEO)
  departmentId: string;
  departmentName: string;
  managerEmployeeId: string | null;
  isActive: boolean;
  directReports: number;
}

interface MemberStats {
  user: User;
  totalLeads: number;
  contactedCalls: number;
  meetingsCompleted: number;
  pipelineLocked: number;
  collectedNCP: number;
  projectedNCP: number;
  conversionRate: string;
}

export default function TeamHierarchy() {
  const { t } = useTranslation();
  const { user: currentUser } = useAuthStore();
  const isAdmin = currentUser?.role === UserRole.ADMIN;

  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'chart' | 'list'>('chart');
  
  // Master lists
  const [users, setUsers] = useState<User[]>([]);
  const [teamMembers, setTeamMembers] = useState<MemberStats[]>([]);
  
  // Org Tree state (auto-generated from reporting links)
  const [nodes, setNodes] = useState<OrgNode[]>([]);
  const [rootEmployeeIds, setRootEmployeeIds] = useState<string[]>([]);
  const [zoom, setZoom] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');

  // Stats Sidebar state
  const [selectedMember, setSelectedMember] = useState<User | null>(null);
  const [selectedMemberStats, setSelectedMemberStats] = useState<any>(null);
  const [selectedMemberLeads, setSelectedMemberLeads] = useState<Lead[]>([]);
  const [loadingStats, setLoadingStats] = useState(false);


  // ----------------------------------------------------
  // DATA LOADING & STATISTICS CALCULATION
  // ----------------------------------------------------
  const loadAllData = async () => {
    if (!currentUser) return;
    setLoading(true);
    try {
      // 1. Users roster (member details + stats lookups)
      const roster = await userService.getAllUsers();
      setUsers(roster);

      // 2. Auto-generated organogram — the server derives the tree from
      //    users.manager_id (single source of truth; no manual drawing).
      const organogram = await orgService.getOrganogram();
      setNodes(organogram.nodes.map(n => ({
        employeeId: n.employeeId,
        name: n.fullName || n.name,
        designation: n.designation || n.roleName || t('employee'),
        roleId: n.roleId,
        roleName: n.roleName,
        level: n.level,
        departmentId: n.departmentId,
        departmentName: n.departmentName,
        managerEmployeeId: n.managerEmployeeId,
        isActive: n.isActive,
        directReports: n.directReports,
      })));
      setRootEmployeeIds(organogram.roots);

      // 3. Direct-report statistics from the real reporting tree. Lead data
      //    comes from the (server-scoped) leads API, so members outside the
      //    caller's visibility can never leak numbers here.
      const allLeads = await leadService.getLeads({ 
        employeeId: currentUser.employeeId, 
        role: currentUser.role 
      });

      const managerOf = (u: User) => u.managerId || (u as any).reportingManagerId || '';
      const directReports = roster.filter(u => managerOf(u) === currentUser.employeeId);

      const computedMembers: MemberStats[] = directReports.map(u => {
        const getReportingEmployeeIds = (mgrId: string): string[] => {
          const ids = [mgrId];
          const subordinates = roster.filter(x => managerOf(x) === mgrId);
          subordinates.forEach(s => {
            ids.push(...getReportingEmployeeIds(s.employeeId));
          });
          return Array.from(new Set(ids));
        };

        const reportingIds = getReportingEmployeeIds(u.employeeId);
        const memberLeads = allLeads.filter(l => reportingIds.includes(l.assignedTo || ''));

        const lCount = memberLeads.length;
        const contacted = memberLeads.filter(l => l.currentStatus !== 'Untouched').length;
        const meetings = memberLeads.filter(l => l.currentStatus === 'Meeting Completed' || l.meetingDate).length;
        const pipeline = memberLeads.filter(l => l.currentStatus === 'Pipeline Locked' || l.projectedNCP > 0).length;
        const collected = memberLeads.reduce((acc, curr) => acc + (curr.collectedNCP || 0), 0);
        const projected = memberLeads.reduce((acc, curr) => acc + (curr.projectedNCP || 0), 0);
        const convertedCount = memberLeads.filter(l => l.currentStatus === 'Converted' || l.collectedNCP > 0).length;

        const rate = lCount > 0 ? `${Math.round((convertedCount / lCount) * 100)}%` : '0%';

        return {
          user: u,
          totalLeads: lCount,
          contactedCalls: contacted,
          meetingsCompleted: meetings,
          pipelineLocked: pipeline,
          collectedNCP: collected,
          projectedNCP: projected,
          conversionRate: rate
        };
      });

      setTeamMembers(computedMembers);

    } catch (err) {
      console.error("Error computing team progress stats:", err);
      toast.error(t('errorLoadingData'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAllData();
  }, [currentUser]);

  // ----------------------------------------------------
  // HIERARCHY TREE LOGIC
  // ----------------------------------------------------
  const handleZoomIn = () => setZoom(prev => Math.min(prev + 0.1, 1.4));
  const handleZoomOut = () => setZoom(prev => Math.max(prev - 0.1, 0.6));
  const handleZoomReset = () => setZoom(1);

  // ----------------------------------------------------
  // INTERACTIVE STATS DRAWER (DETAILS SIDEBAR)
  // ----------------------------------------------------
  const handleNodeClick = async (node: OrgNode) => {
    if (!node.employeeId) return;
    
    const emp = users.find(u => u.employeeId === node.employeeId);
    if (!emp) {
      toast.error(t('employeeNotFound'));
      return;
    }

    setSelectedMember(emp);
    setLoadingStats(true);
    try {
      const allLeads = await leadService.getLeads({
        employeeId: emp.employeeId,
        role: emp.role
      });
      setSelectedMemberLeads(allLeads);

      const lCount = allLeads.length;
      const contacted = allLeads.filter(l => l.currentStatus !== 'Untouched').length;
      const meetings = allLeads.filter(l => l.currentStatus === 'Meeting Completed' || l.meetingDate).length;
      const collected = allLeads.reduce((acc, curr) => acc + (curr.collectedNCP || 0), 0);
      const convertedCount = allLeads.filter(l => l.currentStatus === 'Converted' || l.collectedNCP > 0).length;
      const rate = lCount > 0 ? `${Math.round((convertedCount / lCount) * 100)}%` : '0%';

      setSelectedMemberStats({
        totalLeads: lCount,
        contactedCalls: contacted,
        meetingsCompleted: meetings,
        collectedNCP: collected,
        conversionRate: rate
      });
    } catch (e) {
      console.error("Error computing sidebar user statistics:", e);
      setSelectedMemberStats(null);
      setSelectedMemberLeads([]);
    } finally {
      setLoadingStats(false);
    }
  };

  const isNodeMatchingQuery = (node: OrgNode): boolean => {
    if (!searchQuery) return false;
    const q = searchQuery.toLowerCase();
    if (node.name.toLowerCase().includes(q)) return true;
    if (node.designation && node.designation.toLowerCase().includes(q)) return true;
    if (node.employeeId && node.employeeId.toLowerCase().includes(q)) return true;
    return false;
  };

  // ----------------------------------------------------
  // RECURSIVE TREE RENDERING COMPONENT
  // ----------------------------------------------------
  const renderTreeNode = (node: OrgNode) => {
    const children = nodes.filter(n => n.managerEmployeeId === node.employeeId);
    const matches = isNodeMatchingQuery(node);

    return (
      <li key={node.employeeId}>
        <div className="inline-block relative">
          <div 
            onClick={() => handleNodeClick(node)}
            className={cn(
              "w-56 bg-white border-2 rounded-xl shadow-xs overflow-hidden text-center transition-all duration-300 relative group cursor-pointer",
              matches 
                ? "border-amber-400 ring-4 ring-amber-400/30 scale-[1.05] shadow-lg" 
                : "border-slate-200 hover:border-[#978C21] hover:shadow-md hover:scale-[1.02]",
              node.level === 1 && "border-[#0359B3]/40 bg-gradient-to-b from-blue-50/20 to-white"
            )}
          >
            {/* Header / Top label */}
            <div className={cn(
              "text-[10px] font-black uppercase tracking-widest py-1.5 px-3 border-b text-center font-sans",
              node.level === 1
                ? "bg-blue-100/80 border-blue-200 text-[#0359B3]"
                : "bg-[#978C21]/10 border-amber-200/50 text-[#978C21]"
            )}>
              {node.roleName || node.designation || t('employee').toUpperCase()}
            </div>

            {/* Core / Bottom label */}
            <div className="p-3">
              <p className="text-sm font-extrabold text-slate-800 tracking-tight block">
                {node.name}
              </p>
              <span className="text-[9px] font-bold text-slate-400 mt-1 font-mono block">
                ID: {node.employeeId}
              </span>
              {!node.isActive && (
                <span className="text-[9px] font-bold text-red-500 mt-1 block uppercase tracking-widest">
                  {t('inactive')}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Render child nodes under the connector lines */}
        {children.length > 0 && (
          <ul>
            {children.map(child => renderTreeNode(child))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="space-y-6 pb-24 bg-white font-sans min-h-screen">
      {/* 1. Header Section */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 border-b border-slate-100 pb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-800">
            {t('teamHierarchyTitle')}
          </h1>
          <p className="text-slate-400 font-bold text-[10px] uppercase tracking-[0.25em] mt-1.5 italic">
            {t('teamHierarchySubtitle')}
          </p>
        </div>

        {/* Top Control Bar */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Tab Selection toggle */}
          <div className="flex p-1 bg-slate-100 rounded-lg border border-slate-200">
            <button
              onClick={() => setActiveTab('chart')}
              className={cn(
                "px-3.5 py-1.5 text-xs font-bold rounded-md transition-all flex items-center gap-2",
                activeTab === 'chart' 
                  ? "bg-white text-[#978C21] shadow-xs" 
                  : "text-slate-600 hover:text-slate-900"
              )}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              {t('orgChart')}
            </button>
            <button
              onClick={() => setActiveTab('list')}
              className={cn(
                "px-3.5 py-1.5 text-xs font-bold rounded-md transition-all flex items-center gap-2",
                activeTab === 'list' 
                  ? "bg-white text-[#978C21] shadow-xs" 
                  : "text-slate-600 hover:text-slate-900"
              )}
            >
              <Users className="w-3.5 h-3.5" />
              {t('listView')}
            </button>
          </div>

          {/* Search tool for Chart */}
          {activeTab === 'chart' && (
            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-lg w-64 shadow-xs">
              <Search className="w-3.5 h-3.5 text-slate-400" />
              <input 
                type="text" 
                placeholder={t("searchPlaceholder")} 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-transparent border-none text-[11px] font-bold uppercase text-slate-700 placeholder-slate-400 outline-none w-full"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="text-slate-400 hover:text-slate-600">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          )}

          {/* Refresh organogram */}
          {activeTab === 'chart' && (
            <button
              type="button"
              onClick={() => loadAllData()}
              className="flex items-center gap-2 px-5 py-2.5 bg-[#978C21] hover:bg-[#857b1c] text-white text-xs font-bold uppercase tracking-wider rounded-lg shadow-sm transition-all"
              title={t('chartAutoGenerated')}
            >
              <RotateCcw className="w-4 h-4" />
              {t('refresh')}
            </button>
          )}
        </div>
      </div>

      {/* Loading animation */}
      {loading ? (
        <div className="flex justify-center items-center py-32">
          <div className="w-12 h-12 border-4 border-slate-100 border-t-[#978C21] rounded-full animate-spin"></div>
        </div>
      ) : (
        <AnimatePresence mode="wait">
          {activeTab === 'chart' ? (
            <motion.div
              key="chart-tab"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              className="space-y-4"
            >
              {/* Zoom and Drag notice toolbar */}
              <div className="flex items-center justify-between bg-slate-50 border border-slate-200 px-4 py-3 rounded-xl">
                <span className="text-[10px] font-bold text-slate-500 uppercase flex items-center gap-2">
                  <span className="flex h-2 w-2 rounded-full bg-emerald-500 animate-ping"></span>
                  ← {t('scrollHint')} →
                </span>
                
                {/* Zoom Controls */}
                <div className="flex items-center gap-1.5">
                  <button 
                    onClick={handleZoomOut} 
                    className="p-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 rounded-md transition-colors"
                    title={t('zoomOut')}
                  >
                    <ZoomOut className="w-4 h-4" />
                  </button>
                  <span className="text-xs font-mono font-bold text-slate-500 px-2 min-w-10 text-center">
                    {Math.round(zoom * 100)}%
                  </span>
                  <button 
                    onClick={handleZoomIn} 
                    className="p-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 rounded-md transition-colors"
                    title={t('zoomIn')}
                  >
                    <ZoomIn className="w-4 h-4" />
                  </button>
                  <button 
                    onClick={handleZoomReset} 
                    className="p-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 rounded-md transition-colors"
                    title={t('resetZoom')}
                  >
                    <RotateCcw className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* main Tree Stage */}
              <div className="w-full overflow-auto max-h-[75vh] border border-slate-100 bg-[#F9F9F4] rounded-2xl shadow-inner p-12 custom-scrollbar">
                <div 
                  className="org-tree transition-transform duration-200 ease-out" 
                  style={{ transform: `scale(${zoom})`, transformOrigin: 'top center' }}
                >
                  <ul>
                    {nodes.length === 0 && (
                      <li className="text-center text-slate-400 font-bold uppercase tracking-widest text-[11px] italic py-16">
                        {t('noOrganogramYet')} — {t('noOrganogramYetNote')}
                      </li>
                    )}
                    {rootEmployeeIds
                      .map(id => nodes.find(n => n.employeeId === id))
                      .filter((n): n is OrgNode => Boolean(n))
                      .map(rootNode => renderTreeNode(rootNode))}
                  </ul>
                </div>
              </div>
            </motion.div>
          ) : (
            // Tab 2: Roster List (Original Subordinate Statistics representation)
            <motion.div
              key="list-tab"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              className="space-y-6"
            >
              {teamMembers.length === 0 ? (
                <div className="text-center py-24 border border-dashed border-slate-200 rounded-2xl bg-[#F9F9F4] text-slate-400 font-bold uppercase tracking-widest text-[11px] italic">
                  {t('noDirectReports')}
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {teamMembers.map((member, idx) => (
                    <motion.div
                      key={member.user.id}
                      initial={{ opacity: 0, y: 15 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.04 }}
                      onClick={() => {
                        setSelectedMember(member.user);
                        setSelectedMemberStats({
                          totalLeads: member.totalLeads,
                          contactedCalls: member.contactedCalls,
                          meetingsCompleted: member.meetingsCompleted,
                          collectedNCP: member.collectedNCP,
                          conversionRate: member.conversionRate
                        });
                        // Fetch details
                        leadService.getLeads({
                          employeeId: member.user.employeeId,
                          role: member.user.role
                        }).then(leads => setSelectedMemberLeads(leads)).catch(() => setSelectedMemberLeads([]));
                      }}
                      className="bg-white border border-slate-200/80 hover:border-[#978C21]/30 hover:shadow-md hover:scale-[1.01] transition-all rounded-xl p-6 cursor-pointer shadow-xs flex flex-col justify-between group"
                    >
                      <div>
                        <div className="flex items-center justify-between mb-4">
                          <div className="px-2.5 py-0.5 bg-slate-900 text-[#978C21] text-[9px] font-black uppercase tracking-widest rounded-sm">
                            {member.user.role}
                          </div>
                          <span className="text-[9px] font-mono font-bold text-slate-400 uppercase">
                            ID: {member.user.employeeId}
                          </span>
                        </div>

                        <h3 className="text-lg font-extrabold text-slate-800 uppercase tracking-tight mb-1 group-hover:text-[#978C21] transition-colors">
                          {member.user.name}
                        </h3>
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-6 italic">
                          {member.user.email}
                        </p>

                        <div className="grid grid-cols-3 gap-2 border-t border-slate-100 pt-4 mb-6 text-center">
                          <div>
                            <p className="text-[8px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">{t('leads')}</p>
                            <p className="text-base font-extrabold text-slate-800">{member.totalLeads}</p>
                          </div>
                          <div>
                            <p className="text-[8px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">{t('meetings')}</p>
                            <p className="text-base font-extrabold text-[#0359B3]">{member.meetingsCompleted}</p>
                          </div>
                          <div>
                            <p className="text-[8px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">{t('ratio')}</p>
                            <p className="text-base font-extrabold text-emerald-500">{member.conversionRate}</p>
                          </div>
                        </div>
                      </div>

                      <div className="bg-[#FBFAF8] p-4 rounded-lg border border-slate-100 flex items-center justify-between">
                        <div>
                          <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">{t('collectedNCP')}</p>
                          <p className="text-[13px] font-extrabold text-[#978C21]">৳{member.collectedNCP.toLocaleString()}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">{t('projectedNCP')}</p>
                          <p className="text-[11px] font-bold text-slate-500">৳{member.projectedNCP.toLocaleString()}</p>
                        </div>
                      </div>

                      <div className="flex items-center justify-end text-right text-[9px] font-bold text-[#978C21] uppercase tracking-widest italic mt-4 gap-1 group-hover:translate-x-1 transition-transform">
                        <span>{t('performanceDetails')}</span>
                        <ChevronRight className="w-3.5 h-3.5" />
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      )}

      {/* ----------------------------------------------------
          SIDEBAR SLIDE-OVER: DETAILED INTEL MATRIX
         ---------------------------------------------------- */}
      <AnimatePresence>
        {selectedMember && (
          <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-50 flex justify-end">
            <motion.div 
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'tween', duration: 0.3 }}
              className="bg-white w-full max-w-2xl h-full shadow-2xl p-8 overflow-y-auto flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between border-b border-slate-100 pb-5 mb-6">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 bg-slate-50 rounded-xl flex items-center justify-center text-[#978C21] border border-slate-100">
                      <Building className="w-6 h-6" />
                    </div>
                    <div>
                      <h2 className="text-xl font-extrabold text-slate-800 uppercase tracking-tight leading-none">
                        {selectedMember.name}
                      </h2>
                      <p className="text-[10px] font-bold text-[#978C21] uppercase tracking-widest mt-1.5 italic">
                        {t('clearanceReportingBranch', { role: selectedMember.role })}
                      </p>
                    </div>
                  </div>
                  <button 
                    type="button"
                    onClick={() => {
                      setSelectedMember(null);
                      setSelectedMemberStats(null);
                    }}
                    className="w-10 h-10 rounded-full hover:bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-400 hover:text-slate-800 transition-colors"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {loadingStats ? (
                  <div className="flex justify-center items-center py-20">
                    <div className="w-10 h-10 border-4 border-slate-100 border-t-[#978C21] rounded-full animate-spin"></div>
                  </div>
                ) : (
                  <>
                    {/* Stats bento layout */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
                      <div className="p-4 bg-slate-50 border border-slate-200/50 rounded-xl text-center">
                        <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest mb-1">{t('assignedLeads')}</p>
                        <h4 className="text-2xl font-extrabold text-slate-800 leading-none">{selectedMemberStats?.totalLeads ?? 0}</h4>
                      </div>
                      <div className="p-4 bg-slate-50 border border-slate-200/50 rounded-xl text-center">
                        <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest mb-1">{t('contacted')}</p>
                        <h4 className="text-2xl font-extrabold text-brand-blue leading-none">{selectedMemberStats?.contactedCalls ?? 0}</h4>
                      </div>
                      <div className="p-4 bg-slate-50 border border-slate-200/50 rounded-xl text-center">
                        <p className="text-[8px] font-bold text-emerald-600 uppercase tracking-widest mb-1">{t('collectedNCP')}</p>
                        <h4 className="text-2xl font-extrabold text-emerald-600 leading-none">৳{(selectedMemberStats?.collectedNCP ?? 0).toLocaleString()}</h4>
                      </div>
                      <div className="p-4 bg-slate-50 border border-slate-200/50 rounded-xl text-center">
                        <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest mb-1">{t('conversionPct')}</p>
                        <h4 className="text-2xl font-extrabold text-slate-800 leading-none">{selectedMemberStats?.conversionRate ?? '0%'}</h4>
                      </div>
                    </div>

                    {/* Member Profile Details card */}
                    <div className="p-5 border border-slate-200/60 rounded-xl bg-slate-50/50 space-y-3.5 mb-6 text-xs text-slate-600">
                      <h4 className="text-sm font-semibold text-slate-700">{t('profileSummary')}</h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="flex items-center gap-2">
                          <Users className="w-4 h-4 text-slate-400" />
                          <span><strong>{t('idLabel')}:</strong> {selectedMember.employeeId}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Briefcase className="w-4 h-4 text-slate-400" />
                          <span><strong>{t('designation')}:</strong> {selectedMember.designation || t('employee')}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Mail className="w-4 h-4 text-slate-400" />
                          <span><strong>{t('email')}:</strong> {selectedMember.email}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Phone className="w-4 h-4 text-slate-400" />
                          <span><strong>{t('contact')}:</strong> {selectedMember.contact || t('noNumberProvided')}</span>
                        </div>
                      </div>
                    </div>

                    {/* Lead table */}
                    <div>
                      <h4 className="text-sm font-semibold text-slate-700 mb-3">
                        {t('latestLeads')}
                      </h4>
                      
                      <div className="border border-slate-200/80 rounded-xl overflow-hidden shadow-xs bg-white">
                        <div className="overflow-x-auto">
                          <table className="w-full text-left">
                            <thead className="bg-[#FBFAF8] text-[8px] font-black text-slate-500 uppercase tracking-widest border-b border-slate-200/60">
                              <tr>
                                <th className="px-5 py-3.5">{t('clientName')}</th>
                                <th className="px-5 py-3.5">{t('area')}</th>
                                <th className="px-5 py-3.5 text-right">{t('ncpCollected')}</th>
                                <th className="px-5 py-3.5 text-center">{t('status')}</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 text-[11px]">
                              {selectedMemberLeads.length === 0 ? (
                                <tr>
                                  <td colSpan={4} className="text-center py-12 text-slate-400 font-bold uppercase tracking-widest text-[9px] italic">
                                    {t('noActiveLeadRows')}
                                  </td>
                                </tr>
                              ) : (
                                selectedMemberLeads.slice(0, 10).map((lead, index) => (
                                  <tr key={index} className="hover:bg-slate-50/40 transition-colors">
                                    <td className="px-5 py-3 font-bold text-slate-700">{lead.prospectName || t('unknown')}</td>
                                    <td className="px-5 py-3 text-slate-400 font-medium">{lead.area}</td>
                                    <td className="px-5 py-3 font-extrabold text-slate-800 text-right">৳{(lead.collectedNCP || 0).toLocaleString()}</td>
                                    <td className="px-5 py-3 text-center">
                                      <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded-sm text-[8px] font-black uppercase">
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
                  </>
                )}
              </div>

              <div className="mt-6 border-t border-slate-100 pt-5">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedMember(null);
                    setSelectedMemberStats(null);
                  }}
                  className="w-full py-3.5 bg-slate-900 hover:bg-slate-800 text-white font-bold uppercase tracking-widest text-[10px] rounded-lg shadow-md transition-colors"
                >
                  {t('closeDetails')}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
