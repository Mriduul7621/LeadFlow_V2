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
import { cn } from '../lib/utils';
import { useAuthStore } from '../store/authStore';
import { useTranslation } from '../utils/translations';
import { userService } from '../services/userService';
import { leadService } from '../services/leadService';
import { orgService, Department, Hierarchy } from '../services/orgService';
import { UserRole, User, Lead } from '../types';
import { toast } from 'sonner';

// Custom Node structure for Unified Org Tree
interface OrgNode {
  id: string;
  parentId: string | null;
  type: 'root' | 'department' | 'employee';
  departmentId?: string; // used when type === 'department'
  employeeId?: string;   // used when type === 'employee'
  name: string;          // e.g. "Finance" or Employee Name
  designation?: string;  // e.g. "MANAGER", "CEO"
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
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'chart' | 'list'>('chart');
  
  // Master lists
  const [users, setUsers] = useState<User[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [teamMembers, setTeamMembers] = useState<MemberStats[]>([]);
  
  // Org Tree state
  const [nodes, setNodes] = useState<OrgNode[]>([]);
  const [zoom, setZoom] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');

  // Stats Sidebar state
  const [selectedMember, setSelectedMember] = useState<User | null>(null);
  const [selectedMemberStats, setSelectedMemberStats] = useState<any>(null);
  const [selectedMemberLeads, setSelectedMemberLeads] = useState<Lead[]>([]);
  const [loadingStats, setLoadingStats] = useState(false);

  // Modals / Dropdowns state
  const [activeAddParentNode, setActiveAddParentNode] = useState<OrgNode | null>(null);
  const [selectedDeptId, setSelectedDeptId] = useState<string>('');
  const [selectedEmpId, setSelectedEmpId] = useState<string>('');

  // ----------------------------------------------------
  // DATA LOADING & STATISTICS CALCULATION
  // ----------------------------------------------------
  const loadAllData = async () => {
    if (!currentUser) return;
    setLoading(true);
    try {
      // 1. Fetch Users Roster
      const roster = await userService.getAllUsers();
      setUsers(roster);

      // 2. Fetch Departments List
      const depts = await orgService.getDepartments();
      setDepartments(depts);

      // 3. Fetch Hierarchies and load the Unified Org Chart
      const hiers = await orgService.getHierarchies();
      const unifiedHier = hiers.find(h => h.departmentId === 'unified_org');
      
      if (unifiedHier && unifiedHier.layers && unifiedHier.layers.length > 0) {
        setNodes(unifiedHier.layers as unknown as OrgNode[]);
      } else {
        // Default initial chart layout: Admin is the Root
        setNodes([
          {
            id: 'root',
            parentId: null,
            type: 'root',
            name: 'System Administrator',
            designation: 'CEO / ADMIN'
          }
        ]);
      }

      // 4. Calculate individual/direct-reports statistics (preserving original page feature)
      const allLeads = await leadService.getLeads({ 
        employeeId: currentUser.employeeId, 
        role: currentUser.role 
      });

      let filteredUsers = roster.filter(u => u.employeeId !== currentUser.employeeId);

      if (currentUser.role !== UserRole.ADMIN) {
        const directReports = roster.filter(u => u.managerId === currentUser.employeeId);
        if (directReports.length > 0) {
          filteredUsers = directReports;
        } else {
          // Cascade fallback role hierarchy
          let targetSubRole: UserRole | null = null;
          if (currentUser.role === UserRole.BUSINESS_HEAD) targetSubRole = UserRole.BUSINESS_EXECUTIVE;
          else if (currentUser.role === UserRole.BUSINESS_EXECUTIVE) targetSubRole = UserRole.BDM;
          else if (currentUser.role === UserRole.BDM) targetSubRole = UserRole.ASM;
          else if (currentUser.role === UserRole.ASM) targetSubRole = UserRole.RM;
          else if (currentUser.role === UserRole.RM) targetSubRole = UserRole.RO;

          if (targetSubRole) {
            filteredUsers = roster.filter(u => u.role === targetSubRole);
          } else {
            filteredUsers = [];
          }
        }
      }

      const computedMembers: MemberStats[] = filteredUsers.map(u => {
        const getReportingEmployeeIds = (mgrId: string): string[] => {
          const ids = [mgrId];
          const subordinates = roster.filter(x => x.managerId === mgrId);
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
      toast.error("তথ্য লোড করার সময় ত্রুটি ঘটেছে।");
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
  const getBranchDepartmentId = (node: OrgNode): string | undefined => {
    let current: OrgNode | undefined = node;
    while (current) {
      if (current.type === 'department') return current.departmentId;
      current = nodes.find(n => n.id === current?.parentId);
    }
    return undefined;
  };

  const handleZoomIn = () => setZoom(prev => Math.min(prev + 0.1, 1.4));
  const handleZoomOut = () => setZoom(prev => Math.max(prev - 0.1, 0.6));
  const handleZoomReset = () => setZoom(1);

  const handleAddNodeClick = (parent: OrgNode) => {
    if (!isAdmin) {
      toast.error('শুধুমাত্র অ্যাডমিন নোড যোগ বা সম্পাদনা করতে পারবেন।');
      return;
    }
    setActiveAddParentNode(parent);
    setSelectedDeptId('');
    setSelectedEmpId('');
  };

  const handleAddDepartmentNode = () => {
    if (!activeAddParentNode || !selectedDeptId) return;
    const dept = departments.find(d => d.id === selectedDeptId);
    if (!dept) return;

    // Avoid duplicate departments under the same direct level
    const isDuplicate = nodes.some(
      n => n.parentId === activeAddParentNode.id && 
           n.type === 'department' && 
           n.departmentId === selectedDeptId
    );

    if (isDuplicate) {
      toast.error('এই বিভাগটি ইতিমধ্যেই এখানে যুক্ত করা হয়েছে।');
      return;
    }

    const newNode: OrgNode = {
      id: `node_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      parentId: activeAddParentNode.id,
      type: 'department',
      departmentId: dept.id,
      name: dept.name,
      designation: 'DEPARTMENT'
    };

    setNodes(prev => [...prev, newNode]);
    setActiveAddParentNode(null);
    toast.success('বিভাগ সফলভাবে রেখাচিত্রে যোগ করা হয়েছে!');
  };

  const handleAddEmployeeNode = () => {
    if (!activeAddParentNode || !selectedEmpId) return;
    const emp = users.find(u => u.employeeId === selectedEmpId);
    if (!emp) return;

    const newNode: OrgNode = {
      id: `node_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      parentId: activeAddParentNode.id,
      type: 'employee',
      employeeId: emp.employeeId,
      name: emp.name,
      designation: emp.designation || 'Officer'
    };

    setNodes(prev => [...prev, newNode]);
    setActiveAddParentNode(null);
    toast.success('কর্মচারী সফলভাবে রেখাচিত্রে যোগ করা হয়েছে!');
  };

  const handleDeleteNode = (nodeId: string) => {
    if (!isAdmin) {
      toast.error('শুধুমাত্র অ্যাডমিন নোড মুছতে পারবেন।');
      return;
    }
    if (nodeId === 'root') {
      toast.error('প্রধান রুট নোড মুছে ফেলা সম্ভব নয়!');
      return;
    }

    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    const confirmMsg = node.type === 'department' 
      ? `আপনি কি নিশ্চিতভাবে "${node.name}" বিভাগ এবং এর অধীনস্থ সকল কর্মকর্তা/কর্মচারী মুছে ফেলতে চান?`
      : `আপনি কি নিশ্চিতভাবে "${node.name}" নোড এবং এর অধীনস্থ সকল সদস্যকে মুছে ফেলতে চান?`;

    if (confirm(confirmMsg)) {
      const getDescendantIds = (id: string): string[] => {
        const children = nodes.filter(n => n.parentId === id);
        const childIds = children.map(c => c.id);
        const grandChildIds = childIds.flatMap(cid => getDescendantIds(cid));
        return [...childIds, ...grandChildIds];
      };

      const toDelete = [nodeId, ...getDescendantIds(nodeId)];
      setNodes(prev => prev.filter(n => !toDelete.includes(n.id)));
      toast.success('নোড সফলভাবে মুছে ফেলা হয়েছে।');
    }
  };

  const handleSaveHierarchyTree = async () => {
    setSaving(true);
    try {
      const payload: Hierarchy = {
        id: 'unified_org_hierarchy',
        departmentId: 'unified_org',
        layers: nodes as any, // Saved safely inside the general layers wrapper
        updatedAt: new Date().toISOString()
      };

      // 1. Save Tree Hierarchy document to database/localStorage
      await orgService.saveHierarchy(payload);

      // 2. Transitive Reporting Chain Propagation
      const getEmployeeReportingChain = (nodeId: string): string[] => {
        const chain: string[] = [];
        let current = nodes.find(n => n.id === nodeId);
        while (current && current.parentId) {
          const parent = nodes.find(n => n.id === current.parentId);
          if (parent && parent.type === 'employee' && parent.employeeId) {
            chain.push(parent.employeeId);
          }
          current = parent;
        }
        return chain;
      };

      const getEmployeeSubordinates = (nodeId: string): string[] => {
        const subs: string[] = [];
        const children = nodes.filter(n => n.parentId === nodeId);
        for (const child of children) {
          if (child.type === 'employee' && child.employeeId) {
            subs.push(child.employeeId);
          }
          subs.push(...getEmployeeSubordinates(child.id));
        }
        return subs;
      };

      toast.info('রিপোর্টিং চেইন এবং সাব-অর্ডিনেট ডেটা আপডেট করা হচ্ছে...');

      // Update users roster links dynamically
      for (const emp of users) {
        const empNode = nodes.find(n => n.type === 'employee' && n.employeeId === emp.employeeId);
        
        if (empNode) {
          // Direct supervisor/manager (closest employee node up the chain)
          let managerId = '';
          let currParentId = empNode.parentId;
          while (currParentId) {
            const pNode = nodes.find(n => n.id === currParentId);
            if (pNode && pNode.type === 'employee' && pNode.employeeId) {
              managerId = pNode.employeeId;
              break;
            }
            currParentId = pNode ? pNode.parentId : null;
          }

          const reportingChain = getEmployeeReportingChain(empNode.id);
          const subordinates = getEmployeeSubordinates(empNode.id);

          await userService.updateUser(emp.id, {
            managerId,
            reportingChain,
            subordinates
          });
        }
      }

      toast.success('দলগত সাংগঠনিক চেইন সফলভাবে ডেটাবেজে সংরক্ষিত ও প্রচার করা হয়েছে!');
      await loadAllData();
    } catch (err) {
      console.error(err);
      toast.error('রেখাচিত্র সংরক্ষণ করতে সমস্যা হয়েছে।');
    } finally {
      setSaving(false);
    }
  };

  // ----------------------------------------------------
  // INTERACTIVE STATS DRAWER (DETAILS SIDEBAR)
  // ----------------------------------------------------
  const handleNodeClick = async (node: OrgNode) => {
    if (node.type !== 'employee' || !node.employeeId) return;
    
    const emp = users.find(u => u.employeeId === node.employeeId);
    if (!emp) {
      toast.error('কর্মচারীর বিবরণ পাওয়া যায়নি।');
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
    const children = nodes.filter(n => n.parentId === node.id);
    const matches = isNodeMatchingQuery(node);

    return (
      <li key={node.id}>
        <div className="inline-block relative">
          <div 
            onClick={() => handleNodeClick(node)}
            className={cn(
              "w-56 bg-white border-2 rounded-xl shadow-xs overflow-hidden text-center transition-all duration-300 relative group cursor-pointer",
              matches 
                ? "border-amber-400 ring-4 ring-amber-400/30 scale-[1.05] shadow-lg" 
                : "border-slate-200 hover:border-[#978C21] hover:shadow-md hover:scale-[1.02]",
              node.type === 'root' && "border-[#0359B3]/40 bg-gradient-to-b from-blue-50/20 to-white",
              node.type === 'department' && "border-slate-300 bg-gradient-to-b from-slate-50/20 to-white",
              node.type === 'employee' && "border-slate-200"
            )}
          >
            {/* Header / Top label */}
            <div className={cn(
              "text-[10px] font-black uppercase tracking-widest py-1.5 px-3 border-b text-center font-sans",
              node.type === 'root' && "bg-blue-100/80 border-blue-200 text-[#0359B3]",
              node.type === 'department' && "bg-slate-100/90 border-slate-200 text-slate-700",
              node.type === 'employee' && "bg-[#978C21]/10 border-amber-200/50 text-[#978C21]"
            )}>
              {node.designation || (node.type === 'department' ? 'DEPARTMENT' : 'MEMBER')}
            </div>

            {/* Core / Bottom label */}
            <div className="p-3">
              <p className="text-sm font-extrabold text-slate-800 tracking-tight block">
                {node.name}
              </p>
              {node.employeeId && (
                <span className="text-[9px] font-bold text-slate-400 mt-1 font-mono block">
                  ID: {node.employeeId}
                </span>
              )}
            </div>

            {/* Quick Action Overlay (Visible only to Admin for editing) */}
            {isAdmin && (
              <div className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 bg-white/90 backdrop-blur-xs p-1 rounded-md shadow-xs border border-slate-100">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleAddNodeClick(node);
                  }}
                  className="p-1 text-emerald-600 hover:bg-emerald-50 rounded-sm"
                  title={node.type === 'root' ? 'বিভাগ যোগ করুন (Add Dept)' : 'কর্মচারী যোগ করুন (Add Employee)'}
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
                {node.id !== 'root' && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteNode(node.id);
                    }}
                    className="p-1 text-red-500 hover:bg-red-50 rounded-sm"
                    title="মুছে ফেলুন (Delete Node)"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}
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

  // Filter lists inside Modals
  const activeDeptBranchId = activeAddParentNode ? getBranchDepartmentId(activeAddParentNode) : undefined;
  
  const alreadyAssignedEmployeeIds = nodes
    .filter(n => n.type === 'employee')
    .map(n => n.employeeId);

  const unassignedEmployees = users.filter(
    u => !alreadyAssignedEmployeeIds.includes(u.employeeId)
  );

  // Check if we have unassigned employees matching this department ID
  const hasEmployeesInDept = activeDeptBranchId 
    ? unassignedEmployees.some(u => u.departmentId === activeDeptBranchId)
    : false;

  // Filter available employees: strictly filter if matching employees exist, otherwise show all unassigned employees as fallback
  const availableEmployees = hasEmployeesInDept
    ? unassignedEmployees.filter(u => u.departmentId === activeDeptBranchId)
    : unassignedEmployees;

  const isFilteredByDept = hasEmployeesInDept;

  return (
    <div className="space-y-6 pb-24 bg-white font-sans min-h-screen">
      {/* 1. Header Section */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 border-b border-slate-100 pb-6">
        <div>
          <h1 className="text-3xl font-black tracking-tight text-slate-900 uppercase italic">
            দলগত চেইন রেখাচিত্র (Organizational Hierarchy)
          </h1>
          <p className="text-slate-400 font-bold text-[10px] uppercase tracking-[0.25em] mt-1.5 italic">
            Establish dynamic department levels, designations, and employee routing maps
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
              সাংগঠনিক চার্ট (Org Chart)
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
              তালিকা ভিউ (Subordinates)
            </button>
          </div>

          {/* Search tool for Chart */}
          {activeTab === 'chart' && (
            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-lg w-64 shadow-xs">
              <Search className="w-3.5 h-3.5 text-slate-400" />
              <input 
                type="text" 
                placeholder="খুঁজুন (Search name/ID)..." 
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

          {/* Save Button for Admin only */}
          {activeTab === 'chart' && isAdmin && (
            <button
              type="button"
              disabled={saving}
              onClick={handleSaveHierarchyTree}
              className="flex items-center gap-2 px-5 py-2.5 bg-[#978C21] hover:bg-[#857b1c] text-white text-xs font-bold uppercase tracking-wider rounded-lg shadow-sm transition-all disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              {saving ? 'সংরক্ষণ করা হচ্ছে...' : 'সংরক্ষণ করুন (Save Tree)'}
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
                  ← নোড দেখতে ডানে/বামে স্ক্রোল করুন (Drag or scroll horizontally to explore chart) →
                </span>
                
                {/* Zoom Controls */}
                <div className="flex items-center gap-1.5">
                  <button 
                    onClick={handleZoomOut} 
                    className="p-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 rounded-md transition-colors"
                    title="Zoom Out"
                  >
                    <ZoomOut className="w-4 h-4" />
                  </button>
                  <span className="text-xs font-mono font-bold text-slate-500 px-2 min-w-10 text-center">
                    {Math.round(zoom * 100)}%
                  </span>
                  <button 
                    onClick={handleZoomIn} 
                    className="p-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 rounded-md transition-colors"
                    title="Zoom In"
                  >
                    <ZoomIn className="w-4 h-4" />
                  </button>
                  <button 
                    onClick={handleZoomReset} 
                    className="p-1.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 rounded-md transition-colors"
                    title="Reset Zoom"
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
                    {nodes.filter(n => n.parentId === null).map(rootNode => renderTreeNode(rootNode))}
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
                  আপনার রিপোর্টিং লাইনে কোনো সরাসরি কর্মী নিযুক্ত নেই।
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
                            <p className="text-[8px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Leads</p>
                            <p className="text-base font-extrabold text-slate-800">{member.totalLeads}</p>
                          </div>
                          <div>
                            <p className="text-[8px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Meetings</p>
                            <p className="text-base font-extrabold text-[#0359B3]">{member.meetingsCompleted}</p>
                          </div>
                          <div>
                            <p className="text-[8px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Ratio</p>
                            <p className="text-base font-extrabold text-emerald-500">{member.conversionRate}</p>
                          </div>
                        </div>
                      </div>

                      <div className="bg-[#FBFAF8] p-4 rounded-lg border border-slate-100 flex items-center justify-between">
                        <div>
                          <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">Collected NCP</p>
                          <p className="text-[13px] font-extrabold text-[#978C21]">৳{member.collectedNCP.toLocaleString()}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">Projected NCP</p>
                          <p className="text-[11px] font-bold text-slate-500">৳{member.projectedNCP.toLocaleString()}</p>
                        </div>
                      </div>

                      <div className="flex items-center justify-end text-right text-[9px] font-bold text-[#978C21] uppercase tracking-widest italic mt-4 gap-1 group-hover:translate-x-1 transition-transform">
                        <span>Details Progress Matrix</span>
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
          MODAL: ADD NODE DIALOG (DEPT OR EMPLOYEE)
         ---------------------------------------------------- */}
      <AnimatePresence>
        {activeAddParentNode && (
          <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white w-full max-w-md rounded-2xl shadow-xl overflow-hidden border border-slate-100"
            >
              {/* Modal Header */}
              <div className="bg-slate-50 border-b border-slate-100 px-6 py-4 flex items-center justify-between">
                <div>
                  <h3 className="text-base font-extrabold text-slate-900">
                    {activeAddParentNode.type === 'root' 
                      ? 'নতুন বিভাগ যুক্ত করুন (Add Department)' 
                      : 'নতুন কর্মকর্তা/কর্মচারী যোগ করুন (Add Employee)'}
                  </h3>
                  <p className="text-[10px] text-slate-400 mt-0.5 font-bold uppercase tracking-widest">
                    Parent Node: {activeAddParentNode.name}
                  </p>
                </div>
                <button 
                  type="button"
                  onClick={() => setActiveAddParentNode(null)}
                  className="p-1 rounded-full hover:bg-slate-200 text-slate-400 hover:text-slate-700 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Modal Body */}
              <div className="p-6 space-y-4">
                {activeAddParentNode.type === 'root' ? (
                  // DEPARTMENT SELECTION DROPDOWN
                  <div className="space-y-2">
                    <label className="text-[11px] font-bold text-slate-600 uppercase block">
                      বিভাগ নির্বাচন করুন (Select Department):
                    </label>
                    <select
                      value={selectedDeptId}
                      onChange={(e) => setSelectedDeptId(e.target.value)}
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 focus:bg-white focus:border-[#978C21] rounded-lg text-sm outline-none font-medium text-slate-700"
                    >
                      <option value="">-- বিভাগ বেছে নিন --</option>
                      {departments.map(d => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                    <p className="text-[10px] text-slate-400 italic">
                      * এই বিভাগটি রুট অ্যাডমিন (Admin) এর নিচে সরাসরি প্রথম স্তর হিসেবে যুক্ত হবে।
                    </p>
                  </div>
                ) : (
                  // EMPLOYEE SELECTION DROPDOWN (Strictly filtered by branch's department!)
                  <div className="space-y-2">
                    <div className={cn(
                      "p-3 rounded-lg text-xs border",
                      isFilteredByDept 
                        ? "bg-[#978C21]/5 border-[#978C21]/30 text-slate-700" 
                        : "bg-amber-50 border-amber-200/60 text-slate-700"
                    )}>
                      <span className={cn("font-bold block", isFilteredByDept ? "text-[#978C21]" : "text-amber-700")}>
                        {isFilteredByDept ? t('deptFilterActive') : t('deptFilterRelaxed')}
                      </span>
                      <p className="font-medium mt-0.5">
                        {isFilteredByDept ? (
                          t('deptFilterActiveDesc', { deptName: departments.find(d => d.id === activeDeptBranchId)?.name || activeDeptBranchId })
                        ) : (
                          t('deptFilterRelaxedDesc', { deptName: departments.find(d => d.id === activeDeptBranchId)?.name || 'N/A' })
                        )}
                      </p>
                    </div>

                    <label className="text-[11px] font-bold text-slate-600 uppercase block mt-3">
                      কর্মচারী নির্বাচন করুন (Select Employee):
                    </label>
                    
                    {availableEmployees.length === 0 ? (
                      <div className="p-4 bg-amber-50 text-amber-800 text-xs font-semibold rounded-lg border border-amber-200">
                        ⚠️ এই বিভাগের কোনো কর্মচারী খালি নেই (সবাই ইতিমধ্যে যুক্ত হয়েছেন অথবা কোনো কর্মচারী রেজিস্টার্ড নেই)। অনুগ্রহ করে প্রথমে ইউজার ম্যানেজমেন্টে নতুন কর্মচারী যোগ করুন।
                      </div>
                    ) : (
                      <select
                        value={selectedEmpId}
                        onChange={(e) => setSelectedEmpId(e.target.value)}
                        className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 focus:bg-white focus:border-[#978C21] rounded-lg text-sm outline-none font-medium text-slate-700 uppercase"
                      >
                        <option value="">-- কর্মচারী বেছে নিন --</option>
                        {availableEmployees.map(u => (
                          <option key={u.id} value={u.employeeId}>
                            {u.name} ({u.employeeId}) - {u.designation || 'Officer'}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
              </div>

              {/* Modal Footer */}
              <div className="bg-slate-50 border-t border-slate-100 px-6 py-4 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setActiveAddParentNode(null)}
                  className="px-4 py-2 bg-white hover:bg-slate-100 border border-slate-200 text-slate-600 text-xs font-bold uppercase tracking-wider rounded-lg transition-colors"
                >
                  বাতিল (Cancel)
                </button>
                <button
                  type="button"
                  disabled={activeAddParentNode.type === 'root' ? !selectedDeptId : !selectedEmpId}
                  onClick={activeAddParentNode.type === 'root' ? handleAddDepartmentNode : handleAddEmployeeNode}
                  className="px-5 py-2 bg-[#978C21] hover:bg-[#857b1c] disabled:opacity-50 text-white text-xs font-bold uppercase tracking-wider rounded-lg transition-colors shadow-xs"
                >
                  নিশ্চিত করুন (Confirm)
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

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
                        Clearance: {selectedMember.role} reporting branch
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
                        <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest mb-1">Assigned Leads</p>
                        <h4 className="text-2xl font-extrabold text-slate-800 leading-none">{selectedMemberStats?.totalLeads ?? 0}</h4>
                      </div>
                      <div className="p-4 bg-slate-50 border border-slate-200/50 rounded-xl text-center">
                        <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest mb-1">Contacted</p>
                        <h4 className="text-2xl font-extrabold text-brand-blue leading-none">{selectedMemberStats?.contactedCalls ?? 0}</h4>
                      </div>
                      <div className="p-4 bg-slate-50 border border-slate-200/50 rounded-xl text-center">
                        <p className="text-[8px] font-bold text-emerald-600 uppercase tracking-widest mb-1">Collected NCP</p>
                        <h4 className="text-2xl font-extrabold text-emerald-600 leading-none">৳{(selectedMemberStats?.collectedNCP ?? 0).toLocaleString()}</h4>
                      </div>
                      <div className="p-4 bg-slate-50 border border-slate-200/50 rounded-xl text-center">
                        <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest mb-1">Conversion %</p>
                        <h4 className="text-2xl font-extrabold text-slate-800 leading-none">{selectedMemberStats?.conversionRate ?? '0%'}</h4>
                      </div>
                    </div>

                    {/* Member Profile Details card */}
                    <div className="p-5 border border-slate-200/60 rounded-xl bg-slate-50/50 space-y-3.5 mb-6 text-xs text-slate-600">
                      <h4 className="text-[11px] font-black text-slate-800 uppercase tracking-widest">কর্মকর্তা পরিচিতি (Profile Summary)</h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="flex items-center gap-2">
                          <Users className="w-4 h-4 text-slate-400" />
                          <span><strong>ID:</strong> {selectedMember.employeeId}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Briefcase className="w-4 h-4 text-slate-400" />
                          <span><strong>Designation:</strong> {selectedMember.designation || 'Officer'}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Mail className="w-4 h-4 text-slate-400" />
                          <span><strong>Email:</strong> {selectedMember.email}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Phone className="w-4 h-4 text-slate-400" />
                          <span><strong>Contact:</strong> {selectedMember.contact || 'No Number Provided'}</span>
                        </div>
                      </div>
                    </div>

                    {/* Lead table */}
                    <div>
                      <h4 className="text-[11px] font-black text-slate-800 uppercase tracking-widest mb-3">
                        সাম্প্রতিক লিড বিবরণী (Latest Lead Registry)
                      </h4>
                      
                      <div className="border border-slate-200/80 rounded-xl overflow-hidden shadow-xs bg-white">
                        <div className="overflow-x-auto">
                          <table className="w-full text-left">
                            <thead className="bg-[#FBFAF8] text-[8px] font-black text-slate-500 uppercase tracking-widest border-b border-slate-200/60">
                              <tr>
                                <th className="px-5 py-3.5">Client Name</th>
                                <th className="px-5 py-3.5">Area</th>
                                <th className="px-5 py-3.5 text-right">NCP Collected</th>
                                <th className="px-5 py-3.5 text-center">Status</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100 text-[11px]">
                              {selectedMemberLeads.length === 0 ? (
                                <tr>
                                  <td colSpan={4} className="text-center py-12 text-slate-400 font-bold uppercase tracking-widest text-[9px] italic">
                                    No active lead rows registered
                                  </td>
                                </tr>
                              ) : (
                                selectedMemberLeads.slice(0, 10).map((lead, index) => (
                                  <tr key={index} className="hover:bg-slate-50/40 transition-colors">
                                    <td className="px-5 py-3 font-bold text-slate-700">{lead.prospectName || 'Unknown'}</td>
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
                  বিবরণী বন্ধ করুন (Close Details)
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
