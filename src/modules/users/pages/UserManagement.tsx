import React, { useEffect, useState } from 'react';
import {
  Users,
  UserPlus,
  Shield,
  Trash2,
  Edit2,
  X,
  Plus,
  Search,
  Building,
  Phone,
  Lock,
  Save,
  Check,
  ArrowLeft,
  AlertTriangle,
  Layers,
  Mail,
  UserCheck,
  UserX
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { userService } from '../services/userService';
import { adminService } from '../../admin/services/adminService';
import { orgService, Department, HierarchyConfig, ReportingOption } from '../../hierarchy/services/orgService';
import { useAuthStore } from '../../auth/store/authStore';
import { RolePermission, User } from '../../shared/types';
import { useTranslation } from '../../shared/utils/translations';


/* ------------------------------------------------------------------ */
/*  Feature metadata for role permissions (simplified labels)          */
/* ------------------------------------------------------------------ */
interface FeatureMeta {
  key: string;
  label: string;
  desc: string;
  suboptions?: { key: string; label: string; desc: string }[];
}

const APP_FEATURES: FeatureMeta[] = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    desc: 'Home page analytics and KPIs.',
    suboptions: [
      { key: 'view_calls_stats', label: 'Contact & Meeting Stats', desc: 'Show call and meeting counts on dashboard.' },
      { key: 'view_pipeline_ncp', label: 'Pipeline & NCP Figures', desc: 'Show pipeline volumes and targets.' },
      { key: 'view_division_table', label: 'Division Performance Table', desc: 'Show regional division statistics.' },
      { key: 'view_ncp_chart', label: 'NCP Collection Chart', desc: 'Show collected vs projected chart.' },
      { key: 'view_trend_chart', label: 'Campaign Trend Chart', desc: 'Show daily campaign trends.' },
      { key: 'view_campaign_pie', label: 'Campaign Breakdown Chart', desc: 'Show campaign pie chart.' },
      { key: 'view_critical_alerts', label: 'Critical Alerts', desc: 'Show alerts panel on dashboard.' },
      { key: 'view_agent_table', label: 'Agent Rankings', desc: 'Show agent performance table.' },
      { key: 'view_task_calendar', label: 'Task Calendar', desc: 'Show task calendar on dashboard.' },
    ],
  },
  {
    key: 'lead_generate',
    label: 'Lead Generation',
    desc: 'Create new leads manually.',
    suboptions: [
      { key: 'create', label: 'Create Leads', desc: 'Allow creating new leads.' },
    ],
  },
  {
    key: 'lead_upload',
    label: 'Bulk Upload',
    desc: 'Upload leads via Excel.',
    suboptions: [
      { key: 'upload', label: 'Upload Excel File', desc: 'Allow uploading lead spreadsheets.' },
      { key: 'delete', label: 'Delete Campaign Leads', desc: 'Allow deleting entire campaign leads.' },
    ],
  },
  {
    key: 'lead_tracking',
    label: 'Lead Tracking',
    desc: 'View and update lead statuses.',
    suboptions: [
      { key: 'status_update', label: 'Update Lead Status', desc: 'Allow changing lead statuses.' },
      { key: 'view_all_leads_tab', label: 'All Leads Tab', desc: 'Show All Leads in sidebar menu.' },
    ],
  },
  { key: 'execution_intelligence', label: 'Execution Intelligence', desc: 'View execution dashboard.' },
  { key: 'ncp_progress', label: 'NCP Progress', desc: 'View NCP collection tracking.' },
  { key: 'trend_charts', label: 'Trend Charts', desc: 'View performance charts.' },
  { key: 'campaign_breakdown', label: 'Campaign Breakdown', desc: 'View campaign details.' },
  { key: 'follow_up_strategy', label: 'Follow-up Strategy', desc: 'View follow-up lists.' },
  { key: 'task_calendar', label: 'Task Calendar', desc: 'View monthly task calendar.' },
  { key: 'activities', label: 'Activities', desc: 'View today and tomorrow activity list.' },
  { key: 'team_progress', label: 'Team Progress', desc: 'View team hierarchy and members.' },
  {
    key: 'user_management',
    label: 'User Management',
    desc: 'Manage employees, roles and departments.',
    suboptions: [
      { key: 'dept_view', label: 'View Departments', desc: 'Can view department list.' },
      { key: 'dept_create', label: 'Add Departments', desc: 'Can create departments.' },
      { key: 'dept_edit', label: 'Edit Departments', desc: 'Can edit departments.' },
      { key: 'dept_delete', label: 'Delete Departments', desc: 'Can remove departments.' },
      { key: 'role_view', label: 'View Roles', desc: 'Can view roles and permissions.' },
      { key: 'role_create', label: 'Create Roles', desc: 'Can create custom roles.' },
      { key: 'role_edit', label: 'Edit Roles', desc: 'Can modify roles.' },
      { key: 'role_delete', label: 'Delete Roles', desc: 'Can delete custom roles.' },
      { key: 'user_view', label: 'View Employees', desc: 'Can view employee list.' },
      { key: 'user_create', label: 'Add Employees', desc: 'Can onboard new employees.' },
      { key: 'user_edit', label: 'Edit Employees', desc: 'Can edit employee details.' },
      { key: 'user_delete', label: 'Delete Employees', desc: 'Can remove employees.' },
      { key: 'hier_view', label: 'View Hierarchy', desc: 'Can view reporting hierarchy.' },
      { key: 'hier_create', label: 'Create Hierarchy', desc: 'Can add hierarchy levels.' },
      { key: 'hier_edit', label: 'Edit Hierarchy', desc: 'Can modify hierarchy.' },
      { key: 'hier_delete', label: 'Delete Hierarchy', desc: 'Can remove hierarchy levels.' },
    ],
  },
  {
    key: 'settings_control',
    label: 'Settings',
    desc: 'Access to system settings and configuration.',
    suboptions: [
      { key: 'view_profile', label: 'Edit Profile', desc: 'Allow editing name and avatar.' },
      { key: 'view_security', label: 'Change Password', desc: 'Allow changing password.' },
      { key: 'view_notifications', label: 'Notification Settings', desc: 'Allow managing notifications.' },
      { key: 'view_system', label: 'System Settings', desc: 'Allow changing system appearance.' },
      { key: 'view_sync', label: 'Sync Settings', desc: 'Allow manual sync and DB check.' },
      { key: 'configure_parameters', label: 'Manage Parameters', desc: 'Allow adding/editing areas, products, campaigns.' },
    ],
  },
];

/* ================================================================== */
/*  MAIN COMPONENT                                                     */
/* ================================================================== */

type TabKey = 'employees' | 'departments' | 'roles' | 'hierarchy';

export default function UserManagement() {
  const { user: currentUser } = useAuthStore();
  const { t } = useTranslation();

  // ---- Global loading & data ----
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<User[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [roles, setRoles] = useState<RolePermission[]>([]);

  // ---- Active tab ----
  const [activeTab, setActiveTab] = useState<TabKey>('employees');

  // ---- Employee states ----
  const [userQuery, setUserQuery] = useState('');
  const [filterDeptId, setFilterDeptId] = useState('');
  const [filterRole, setFilterRole] = useState('');
  const [isUserModalOpen, setIsUserModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [userForm, setUserForm] = useState({
    name: '',
    employeeId: '',
    contact: '',
    email: '',
    designation: '',
    role: '',
    departmentId: '',
    managerId: '',
    password: '',
    status: 'Active' as 'Active' | 'Inactive',
  });

  // ---- Department states ----
  const [deptFormName, setDeptFormName] = useState('');
  const [editingDeptId, setEditingDeptId] = useState<string | null>(null);

  // ---- Role states ----
  const [selectedRole, setSelectedRole] = useState<RolePermission | null>(null);
  const [roleFormName, setRoleFormName] = useState('');
  const [roleFormSlug, setRoleFormSlug] = useState('');
  const [roleFormVisibility, setRoleFormVisibility] = useState<'Own' | 'DownTeam' | 'FullTeam' | 'Organization'>('Own');
  const [roleFormFeatures, setRoleFormFeatures] = useState<Record<string, Record<string, boolean>>>({});
  const [showRoleForm, setShowRoleForm] = useState(false);

  // ---- Hierarchy (company-wide reporting ladder) states ----
  const [hierConfig, setHierConfig] = useState<HierarchyConfig | null>(null);
  const [ladderAssignments, setLadderAssignments] = useState<Record<string, number>>({});
  const [savingLadder, setSavingLadder] = useState(false);
  const [managerOptions, setManagerOptions] = useState<ReportingOption[]>([]);
  const [loadingManagers, setLoadingManagers] = useState(false);

  /* ------------------------------------------------------------------ */
  /*  Load all data                                                      */
  /* ------------------------------------------------------------------ */
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [roster, depts, accessRoles] = await Promise.all([
        userService.getAllUsers(),
        orgService.getDepartments(),
        adminService.getRoles(),
      ]);
      setUsers(roster);
      setDepartments(depts);
      setRoles(accessRoles);
    } catch (err) {
      toast.error(t('couldNotLoadData'));
    } finally {
      setLoading(false);
    }
  };

  /* ================================================================== */
  /*  EMPLOYEE HANDLERS                                                  */
  /* ================================================================== */
  const openCreateUser = () => {
    setEditingUser(null);
    setUserForm({
      name: '', employeeId: '', contact: '', email: '',
      designation: '',
      role: roles.length > 0 ? roles[0].roleId : 'ADMIN',
      departmentId: departments.length > 0 ? departments[0].id : '',
      managerId: '',
      password: '', status: 'Active',
    });
    setManagerOptions([]);
    setIsUserModalOpen(true);
  };

  const openEditUser = (u: User) => {
    setEditingUser(u);
    setUserForm({
      name: u.name || '',
      employeeId: u.employeeId || '',
      contact: (u as any).contact || '',
      email: u.email || '',
      designation: u.designation || '',
      role: u.role || (roles.length > 0 ? roles[0].roleId : 'ADMIN'),
      departmentId: (u as any).departmentId || '',
      managerId: (u as any).managerId || (u as any).reportingManagerId || '',
      password: '',
      status: u.status || 'Active',
    });
    setManagerOptions([]);
    setIsUserModalOpen(true);
  };

  const handleSaveUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userForm.name.trim() || !userForm.employeeId.trim() || !userForm.email.trim()) {
      toast.error(t('fillNameEmpIdEmail'));
      return;
    }
    const formRoleLevel = (roles.find(r => r.roleId === userForm.role) as any)?.hierarchyLevel ?? 0;
    if (formRoleLevel > 1 && formRoleLevel < 99 && !userForm.managerId) {
      toast.error(t('selectReportingManager'));
      return;
    }
    if (formRoleLevel === 1 && userForm.managerId) {
      toast.error(t('level1NoManager'));
      return;
    }

    const cleanEmpId = userForm.employeeId.trim().toUpperCase();
    const isDuplicate = users.some(u =>
      u.employeeId.trim().toUpperCase() === cleanEmpId &&
      (!editingUser || u.id !== editingUser.id)
    );
    if (isDuplicate) {
      toast.error(t('employeeIdExists', { id: cleanEmpId }));
      return;
    }

    const genTempPw = () => {
      const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
      let out = '';
      for (let i = 0; i < 10; i++) out += c[Math.floor(Math.random() * c.length)];
      return out;
    };

    try {
      const uid = editingUser ? editingUser.id : `u_${Date.now()}`;
      const payload: User = {
        id: uid,
        name: userForm.name.trim(),
        employeeId: cleanEmpId,
        email: userForm.email.trim().toLowerCase(),
        contact: userForm.contact.trim() as any,
        designation: userForm.designation.trim() || 'Officer',
        role: userForm.role,
        departmentId: userForm.departmentId as any,
        status: userForm.status,
        createdDate: editingUser ? editingUser.createdDate : new Date().toISOString(),
        password: userForm.password ? userForm.password : (editingUser ? undefined : genTempPw()),
        mustChangePassword: editingUser
          ? (userForm.password ? true : (editingUser.mustChangePassword ?? false))
          : true,
        managerId: userForm.managerId,
      };

      if (editingUser) {
        await userService.updateUser(uid, payload as any);
        toast.success(t('profileUpdated'));
      } else {
        await userService.createUser(payload);
        toast.success(t('addedTempPassword', { name: payload.name, password: String(payload.password) }));
      }

      setIsUserModalOpen(false);
      await loadData();
    } catch (err) {
      toast.error(t('couldNotSave'));
    }
  };

  const handleDeleteUser = async (id: string, name: string) => {
    if (confirm(t('confirmDeleteUser', { name }))) {
      try {
        await userService.deleteUser(id);
        toast.success(t('userRemoved', { name }));
        await loadData();
      } catch (e) {
        toast.error(t('couldNotDelete'));
      }
    }
  };

  /* ================================================================== */
  /*  REPORTING MANAGER OPTIONS (ladder-driven dropdown)                 */
  /* ================================================================== */
  useEffect(() => {
    if (!isUserModalOpen) return;
    const roleLevel = (roles.find(r => r.roleId === userForm.role) as any)?.hierarchyLevel ?? 0;
    if (!userForm.role || roleLevel === 1) {
      setManagerOptions([]);
      return;
    }
    let cancelled = false;
    setLoadingManagers(true);
    orgService
      .getReportingOptions(userForm.role, userForm.departmentId || undefined)
      .then(options => { if (!cancelled) setManagerOptions(options); })
      .catch(() => { if (!cancelled) setManagerOptions([]); })
      .finally(() => { if (!cancelled) setLoadingManagers(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isUserModalOpen, userForm.role, userForm.departmentId, roles]);

  // Clear a stale manager selection when the role/department filter changes.
  useEffect(() => {
    if (!isUserModalOpen) return;
    if (userForm.managerId && managerOptions.length > 0 && !managerOptions.some(o => o.employeeId === userForm.managerId)) {
      setUserForm(prev => ({ ...prev, managerId: '' }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managerOptions]);

  /* ================================================================== */
  /*  DEPARTMENT HANDLERS                                                */
  /* ================================================================== */
  const handleSaveDept = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deptFormName.trim()) { toast.error(t('deptNameEmpty')); return; }
    try {
      const id = editingDeptId || `dept_${Date.now()}`;
      await orgService.saveDepartment({ id, name: deptFormName.trim(), createdDate: new Date().toISOString() });
      toast.success(editingDeptId ? t('deptUpdated') : t('deptAdded'));
      setDeptFormName('');
      setEditingDeptId(null);
      await loadData();
    } catch (e) {
      toast.error(t('couldNotSaveDept'));
    }
  };

  const handleDeleteDept = async (id: string) => {
    if (confirm(t('confirmDeleteDepartment'))) {
      try {
        await orgService.deleteDepartment(id);
        toast.success(t('deptDeleted'));
        await loadData();
      } catch (e) {
        toast.error(t('couldNotDeleteDept'));
      }
    }
  };

  /* ================================================================== */
  /*  ROLE HANDLERS                                                      */
  /* ================================================================== */
  const applyRoleToForm = (role: RolePermission) => {
    setSelectedRole(role);
    setRoleFormName(role.roleName);
    setRoleFormSlug(role.roleId);
    setRoleFormVisibility((role.dataVisibility as any) || 'Own');
    setRoleFormFeatures(role.featurePermissions || {});
  };

  const handleNewRole = () => {
    setSelectedRole(null);
    setRoleFormName('');
    setRoleFormSlug('');
    setRoleFormVisibility('Own');
    const defaults: Record<string, Record<string, boolean>> = {};
    APP_FEATURES.forEach(f => {
      defaults[f.key] = { view: false };
      f.suboptions?.forEach(s => { defaults[f.key][s.key] = false; });
    });
    setRoleFormFeatures(defaults);
    setShowRoleForm(true);
  };

  const handleSaveRole = async () => {
    if (!roleFormName.trim()) { toast.error(t('roleNameRequired')); return; }
    const slug = roleFormSlug.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!slug) { toast.error(t('validRoleIdRequired')); return; }

    try {
      const isAdm = slug === 'admin' || slug === 'superadmin';
      const payload: RolePermission = {
        roleId: slug,
        roleName: roleFormName.trim(),
        isCustom: selectedRole ? selectedRole.isCustom : true,
        menuAccess: {
          '/': roleFormFeatures?.dashboard?.view ?? false,
          '/leads/new': roleFormFeatures?.lead_generate?.view ?? false,
          '/leads/upload': roleFormFeatures?.lead_upload?.view ?? false,
          '/leads/all': roleFormFeatures?.lead_tracking?.view_all_leads_tab ?? false,
          '/leads': roleFormFeatures?.lead_tracking?.view ?? false,
          '/execution-intelligence': roleFormFeatures?.execution_intelligence?.view ?? false,
          '/ncp-progress': roleFormFeatures?.ncp_progress?.view ?? false,
          '/trend-charts': roleFormFeatures?.trend_charts?.view ?? false,
          '/campaign-breakdown': roleFormFeatures?.campaign_breakdown?.view ?? false,
          '/follow-up': roleFormFeatures?.follow_up_strategy?.view ?? false,
          '/task-calendar': roleFormFeatures?.task_calendar?.view ?? false,
          '/activities': roleFormFeatures?.activities?.view ?? false,
          '/team': roleFormFeatures?.team_progress?.view ?? false,
          '/users': roleFormFeatures?.user_management?.view ?? isAdm,
          '/settings': roleFormFeatures?.settings_control?.view ?? isAdm,
        },
        dataVisibility: roleFormVisibility,
        actions: {
          view: roleFormFeatures?.lead_tracking?.view ?? true,
          create: roleFormFeatures?.lead_generate?.create ?? false,
          edit: roleFormFeatures?.lead_tracking?.status_update ?? false,
          delete: roleFormFeatures?.lead_upload?.delete ?? false,
          approve: roleFormFeatures?.lead_tracking?.status_update ?? false,
          upload: roleFormFeatures?.lead_upload?.upload ?? false,
        },
        featurePermissions: roleFormFeatures,
      };

      await adminService.saveRole(payload);
      toast.success(t('roleSaved'));
      setShowRoleForm(false);
      await loadData();
    } catch (err) {
      toast.error(t('couldNotSaveRole'));
    }
  };

  const handleDeleteRole = async (slug: string) => {
    if (slug.toUpperCase() === 'ADMIN') { toast.error(t('adminRoleCannotDelete')); return; }
    if (confirm(t('confirmDeleteRole', { slug }))) {
      try {
        await adminService.deleteRole(slug);
        toast.success(t('roleDeleted'));
        setSelectedRole(null);
        await loadData();
      } catch (e) {
        toast.error(t('couldNotDeleteRole'));
      }
    }
  };

  /* ================================================================== */
  /*  HIERARCHY (COMPANY-WIDE LADDER) HANDLERS                           */
  /* ================================================================== */
  const loadHierarchyConfig = async () => {
    try {
      const config = await orgService.getHierarchyConfig();
      setHierConfig(config);
      const assignments: Record<string, number> = {};
      for (const level of config.levels) {
        for (const role of level.roles) assignments[role.roleId] = level.level;
      }
      for (const role of config.unassignedRoles) assignments[role.roleId] = 0; // 0 = not in ladder
      setLadderAssignments(assignments);
    } catch {
      toast.error(t('couldNotLoadHierarchy'));
    }
  };

  useEffect(() => {
    if (activeTab === 'hierarchy') loadHierarchyConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const setRoleLadderLevel = (roleId: string, level: number) => {
    setLadderAssignments(prev => ({ ...prev, [roleId]: level }));
  };

  const saveLadder = async () => {
    // Every known role is sent; level 0 removes the role from the ladder.
    const assignments: Array<{ roleId: string; level: number }> = [];
    for (const roleId of Object.keys(ladderAssignments)) {
      assignments.push({ roleId, level: Number(ladderAssignments[roleId] ?? 0) });
    }
    if (!assignments.some(a => a.level > 0)) {
      toast.error(t('placeRoleInLadder'));
      return;
    }
    if (!assignments.some(a => a.level === 1)) {
      toast.error(t('level1Required'));
      return;
    }
    setSavingLadder(true);
    try {
      const config = await orgService.saveHierarchyConfig(assignments);
      setHierConfig(config);
      toast.success(t('ladderSaved'));
    } catch (e: any) {
      toast.error(e?.message || t('couldNotSaveLadder'));
    } finally {
      setSavingLadder(false);
    }
  };

  /* ================================================================== */
  /*  FILTERED DATA                                                      */
  /* ================================================================== */
  const filteredUsers = users.filter(u => {
    const text = `${u.name} ${u.employeeId} ${u.designation || ''} ${u.email || ''}`.toLowerCase();
    const q = userQuery.toLowerCase();
    const matchQuery = !q || text.includes(q);
    const matchDept = !filterDeptId || (u as any).departmentId === filterDeptId;
    const matchRole = !filterRole || u.role === filterRole;
    return matchQuery && matchDept && matchRole;
  });

  /* ================================================================== */
  /*  TABS CONFIG                                                        */
  /* ================================================================== */
  const tabs: { key: TabKey; label: string; icon: React.ReactNode; count?: number }[] = [
    { key: 'employees', label: t('employees'), icon: <Users className="w-4 h-4" />, count: users.length },
    { key: 'departments', label: t('departments'), icon: <Building className="w-4 h-4" />, count: departments.length },
    { key: 'roles', label: t('rolesAccess'), icon: <Shield className="w-4 h-4" />, count: roles.length },
    { key: 'hierarchy', label: t('hierarchy'), icon: <Layers className="w-4 h-4" />, count: hierConfig?.levels.length ?? 0 },
  ];

  /* ================================================================== */
  /*  RENDER                                                             */
  /* ================================================================== */
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center space-y-3">
          <div className="w-8 h-8 border-2 border-t-[#978C21] border-slate-200 rounded-full animate-spin mx-auto" />
          <p className="text-sm text-slate-400">{t('loadingData')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{t('userManagementTitle')}</h1>
          <p className="text-sm text-slate-500 mt-1">{t('userManagementSubtitle')}</p>
        </div>
        {activeTab === 'employees' && (
          <button
            onClick={openCreateUser}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#978C21] hover:bg-[#83781C] text-white text-sm font-semibold rounded-lg transition-colors shadow-sm"
          >
            <UserPlus className="w-4 h-4" /> {t('addEmployee')}
          </button>
        )}
      </div>

      {/* Tab navigation */}
      <div className="flex gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => { setActiveTab(tab.key); if (tab.key === 'roles') setShowRoleForm(false); }}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-all",
              activeTab === tab.key
                ? "bg-white text-[#978C21] shadow-sm border border-slate-200"
                : "text-slate-500 hover:text-slate-700 hover:bg-white/50"
            )}
          >
            {tab.icon}
            <span className="hidden sm:inline">{tab.label}</span>
            {tab.count !== undefined && (
              <span className={cn(
                "text-xs px-1.5 py-0.5 rounded-full",
                activeTab === tab.key ? "bg-[#978C21]/10 text-[#978C21]" : "bg-slate-200 text-slate-500"
              )}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ================================================================ */}
      {/*  TAB 1: EMPLOYEES                                                */}
      {/* ================================================================ */}
      {activeTab === 'employees' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="flex flex-col md:flex-row gap-3 bg-white border border-slate-200 rounded-xl p-4">
            <div className="flex-1 flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
              <Search className="w-4 h-4 text-slate-400" />
              <input
                type="text"
                value={userQuery}
                onChange={e => setUserQuery(e.target.value)}
                placeholder={t('searchByNameIdEmail')}
                className="flex-1 bg-transparent outline-none text-sm text-slate-700 placeholder:text-slate-400"
              />
            </div>
            <select
              value={filterDeptId}
              onChange={e => setFilterDeptId(e.target.value)}
              className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21]"
            >
              <option value="">{t('allDepartments')}</option>
              {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <select
              value={filterRole}
              onChange={e => setFilterRole(e.target.value)}
              className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21]"
            >
              <option value="">{t('allRoles')}</option>
              {roles.map(r => <option key={r.roleId} value={r.roleId}>{r.roleName}</option>)}
            </select>
          </div>

          {/* Employee table */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500">{t('employee')}</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500">{t('roleAndDepartment')}</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500">{t('status')}</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500">{t('contact')}</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500 text-right">{t('actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredUsers.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-16 text-center text-sm text-slate-400">
                        {t('noEmployeesFound')}
                      </td>
                    </tr>
                  ) : (
                    filteredUsers.map(u => {
                      const dept = departments.find(d => d.id === (u as any).departmentId);
                      return (
                        <tr key={u.id} className="hover:bg-slate-50 transition-colors">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <div className="w-9 h-9 rounded-full bg-slate-800 text-white flex items-center justify-center text-sm font-semibold">
                                {u.name.charAt(0).toUpperCase()}
                              </div>
                              <div>
                                <p className="text-sm font-medium text-slate-800">{u.name}</p>
                                <p className="text-xs text-slate-400">{t('idLabel')}: {u.employeeId}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="space-y-1">
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-slate-100 text-slate-700 text-xs font-medium rounded-md">
                                <Shield className="w-3 h-3 text-[#978C21]" />
                                {roles.find(r => r.roleId === u.role)?.roleName || u.role}
                              </span>
                              {dept && <p className="text-xs text-slate-400">{dept.name}</p>}
                              {u.designation && <p className="text-xs text-slate-400">{u.designation}</p>}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span className={cn(
                              "inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full",
                              u.status === 'Active'
                                ? "bg-emerald-50 text-emerald-700"
                                : "bg-slate-100 text-slate-500"
                            )}>
                              {u.status === 'Active' ? <UserCheck className="w-3 h-3" /> : <UserX className="w-3 h-3" />}
                              {u.status}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <div className="text-xs text-slate-500 space-y-0.5">
                              {u.email && <p className="flex items-center gap-1"><Mail className="w-3 h-3" />{u.email}</p>}
                              {(u as any).contact && <p className="flex items-center gap-1"><Phone className="w-3 h-3" />{(u as any).contact}</p>}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex gap-1 justify-end">
                              <button
                                onClick={() => openEditUser(u)}
                                className="p-2 text-slate-400 hover:text-sky-600 hover:bg-sky-50 rounded-lg transition-colors"
                                title={t('edit')}
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                              {u.employeeId !== 'ADMIN' && u.id !== currentUser?.id && (
                                <button
                                  onClick={() => handleDeleteUser(u.id, u.name)}
                                  className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                  title={t('delete')}
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/*  TAB 2: DEPARTMENTS                                              */}
      {/* ================================================================ */}
      {activeTab === 'departments' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Form */}
          <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <h3 className="text-base font-semibold text-slate-800">
              {editingDeptId ? t('editDepartment') : t('addDepartment')}
            </h3>
            <form onSubmit={handleSaveDept} className="space-y-4">
              <div>
                <label className="text-sm font-medium text-slate-600 mb-1 block">{t('departmentName')}</label>
                <input
                  type="text"
                  value={deptFormName}
                  onChange={e => setDeptFormName(e.target.value)}
                  placeholder={t('departmentNamePlaceholder')}
                  className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] transition-colors"
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  className="flex-1 py-2.5 bg-[#978C21] hover:bg-[#83781C] text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  <Save className="w-4 h-4" />
                  {editingDeptId ? t('update') : t('addDepartment')}
                </button>
                {editingDeptId && (
                  <button
                    type="button"
                    onClick={() => { setEditingDeptId(null); setDeptFormName(''); }}
                    className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 text-sm rounded-lg"
                  >
                    {t('cancel')}
                  </button>
                )}
              </div>
            </form>
          </div>

          {/* List */}
          <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl p-6">
            <h3 className="text-base font-semibold text-slate-800 mb-4">
              {t('departmentsCount', { count: String(departments.length) })}
            </h3>
            {departments.length === 0 ? (
              <div className="py-12 text-center text-sm text-slate-400 border border-dashed border-slate-200 rounded-lg">
                {t('noDepartmentsYet')}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {departments.map(dept => (
                  <div key={dept.id} className="flex items-center justify-between p-4 bg-slate-50 border border-slate-100 rounded-lg hover:shadow-sm transition-shadow">
                    <div>
                      <h4 className="text-sm font-medium text-slate-800">{dept.name}</h4>
                      <p className="text-xs text-slate-400 mt-0.5">{t('employeesCount', { count: String(users.filter(u => (u as any).departmentId === dept.id).length) })}</p>
                    </div>
                    <div className="flex gap-1">
                      <button
                        onClick={() => { setEditingDeptId(dept.id); setDeptFormName(dept.name); }}
                        className="p-2 text-slate-400 hover:text-sky-600 hover:bg-sky-50 rounded-lg transition-colors"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDeleteDept(dept.id)}
                        className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/*  TAB 3: ROLES & ACCESS                                            */}
      {/* ================================================================ */}
      {activeTab === 'roles' && (
        <div className="space-y-4">
          {!showRoleForm ? (
            <>
              <div className="flex justify-between items-center">
                <h3 className="text-base font-semibold text-slate-800">{t('rolesCount', { count: String(roles.length) })}</h3>
                <button
                  onClick={handleNewRole}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-[#978C21] hover:bg-[#83781C] text-white text-sm font-medium rounded-lg transition-colors"
                >
                  <Plus className="w-4 h-4" /> {t('addRoleTitle')}
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {roles.map(r => (
                  <div key={r.roleId} className="bg-white border border-slate-200 rounded-xl p-5 hover:shadow-md transition-shadow">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h4 className="text-sm font-semibold text-slate-800">{r.roleName}</h4>
                        <p className="text-xs text-slate-400 mt-0.5">{r.roleId}</p>
                      </div>
                      <span className={cn(
                        "text-xs px-2 py-0.5 rounded-full font-medium",
                        r.isCustom ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-600"
                      )}>
                        {r.isCustom ? t('custom') : t('system')}
                      </span>
                    </div>

                    <div className="space-y-2 text-xs text-slate-500">
                      <p>{t('dataAccess')}: <span className="font-medium text-slate-700">{r.dataVisibility || 'Own'}</span></p>
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(r.menuAccess || {})
                          .filter(([_, v]) => v)
                          .map(([path]) => {
                            const name = path === '/' ? 'Dashboard' : path.replace('/', '').replace(/-/g, ' ');
                            return (
                              <span key={path} className="px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded text-[10px] font-medium capitalize">
                                {name}
                              </span>
                            );
                          })}
                      </div>
                    </div>

                    <div className="flex gap-2 mt-4 pt-3 border-t border-slate-100">
                      <button
                        onClick={() => { applyRoleToForm(r); setShowRoleForm(true); }}
                        className="flex-1 py-2 bg-slate-50 hover:bg-[#978C21] hover:text-white border border-slate-200 text-slate-600 text-xs font-medium rounded-lg transition-colors text-center"
                      >
                        {t('configureFeature')}
                      </button>
                      {r.roleId.toUpperCase() !== 'ADMIN' && (
                        <button
                          onClick={() => handleDeleteRole(r.roleId)}
                          className="px-3 py-2 border border-slate-200 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            /* Role form / editor */
            <div className="space-y-4">
              <button
                onClick={() => setShowRoleForm(false)}
                className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700"
              >
                <ArrowLeft className="w-4 h-4" /> {t('backToRoles')}
              </button>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                {/* Role basic info */}
                <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                  <h3 className="text-base font-semibold text-slate-800">
                    {selectedRole ? t('editRole') : t('newRole')}
                  </h3>

                  <div>
                    <label className="text-sm font-medium text-slate-600 mb-1 block">{t('roleName')}</label>
                    <input
                      type="text"
                      value={roleFormName}
                      onChange={e => setRoleFormName(e.target.value)}
                      placeholder={t('roleNamePlaceholder')}
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21]"
                    />
                  </div>

                  {!selectedRole && (
                    <div>
                      <label className="text-sm font-medium text-slate-600 mb-1 block">{t('roleId')}</label>
                      <input
                        type="text"
                        value={roleFormSlug}
                        onChange={e => setRoleFormSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                        placeholder={t('roleIdPlaceholder')}
                        className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] font-mono"
                      />
                      <p className="text-xs text-slate-400 mt-1">{t('roleIdHint')}</p>
                    </div>
                  )}

                  {/* Data visibility */}
                  <div>
                    <label className="text-sm font-medium text-slate-600 mb-2 block">{t('dataVisibility')}</label>
                    <div className="grid grid-cols-2 gap-2">
                      {(['Own', 'DownTeam', 'FullTeam', 'Organization'] as const).map(scope => {
                        const desc = scope === 'Own' ? t('ownOnly')
                          : scope === 'DownTeam' ? t('ownTeamBelow')
                          : scope === 'FullTeam' ? t('allTeamData')
                          : t('entireOrganization');
                        return (
                          <button
                            key={scope}
                            type="button"
                            onClick={() => setRoleFormVisibility(scope)}
                            className={cn(
                              "p-2.5 border rounded-lg text-xs text-left transition-all",
                              roleFormVisibility === scope
                                ? "border-[#978C21] bg-[#978C21]/5 text-[#978C21] font-medium"
                                : "border-slate-200 text-slate-500 hover:border-slate-300"
                            )}
                          >
                            <span className="block font-medium">{scope}</span>
                            <span className="text-[10px] opacity-70">{desc}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <button
                    onClick={handleSaveRole}
                    className="w-full py-2.5 bg-[#978C21] hover:bg-[#83781C] text-white text-sm font-medium rounded-lg flex items-center justify-center gap-2 transition-colors"
                  >
                    <Save className="w-4 h-4" /> {t('saveRole')}
                  </button>
                </div>

                {/* Feature permissions */}
                <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                  <h3 className="text-base font-semibold text-slate-800">{t('featureAccess')}</h3>
                  <p className="text-sm text-slate-500">{t('featureAccessDesc')}</p>

                  <div className="space-y-3">
                    {APP_FEATURES.map(item => {
                      const feat = roleFormFeatures[item.key] || { view: false };
                      const isOn = !!feat.view;
                      return (
                        <div key={item.key} className={cn(
                          "border rounded-lg overflow-hidden transition-all",
                          isOn ? "border-[#978C21]/30 bg-[#978C21]/[0.02]" : "border-slate-200"
                        )}>
                          <div className="p-3 flex items-center justify-between bg-slate-50/50">
                            <div>
                              <span className="text-sm font-medium text-slate-800">{item.label}</span>
                              <p className="text-xs text-slate-400">{item.desc}</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                const newVal = !isOn;
                                const updated = { ...feat, view: newVal };
                                if (!newVal) {
                                  Object.keys(updated).forEach(k => { if (k !== 'view') updated[k] = false; });
                                }
                                setRoleFormFeatures({ ...roleFormFeatures, [item.key]: updated });
                              }}
                              className={cn(
                                "px-3 py-1.5 text-xs font-medium rounded-md border transition-all",
                                isOn
                                  ? "bg-[#978C21] text-white border-[#978C21]"
                                  : "bg-white text-slate-400 border-slate-200"
                              )}
                            >
                              {isOn ? '✓ ' + t('enabled') : t('disabled')}
                            </button>
                          </div>
                          {isOn && item.suboptions && item.suboptions.length > 0 && (
                            <div className="p-4 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-2 gap-3">
                              {item.suboptions.map(sub => {
                                const isSubOn = !!feat[sub.key];
                                return (
                                  <label key={sub.key} className="flex items-start gap-2 cursor-pointer p-2 rounded-md hover:bg-slate-50">
                                    <input
                                      type="checkbox"
                                      checked={isSubOn}
                                      onChange={() => {
                                        setRoleFormFeatures({
                                          ...roleFormFeatures,
                                          [item.key]: { ...feat, [sub.key]: !isSubOn }
                                        });
                                      }}
                                      className="mt-0.5 w-4 h-4 accent-[#978C21]"
                                    />
                                    <div>
                                      <span className="text-xs font-medium text-slate-700">{sub.label}</span>
                                      <p className="text-[10px] text-slate-400">{sub.desc}</p>
                                    </div>
                                  </label>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ================================================================ */}
      {/*  TAB 4: HIERARCHY                                                */}
      {/* ================================================================ */}
      {activeTab === 'hierarchy' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-slate-800">{t('companyHierarchyLadder')}</h3>
              <p className="text-sm text-slate-500">
                {t('hierarchyDesc')}
              </p>
            </div>
            <button
              onClick={saveLadder}
              disabled={savingLadder}
              className="inline-flex items-center gap-2 px-6 py-2.5 bg-[#978C21] hover:bg-[#83781C] text-white text-sm font-medium rounded-lg transition-colors shadow-sm disabled:opacity-60"
            >
              <Save className="w-4 h-4" /> {savingLadder ? t('savingLadder') : t('saveLadder')}
            </button>
          </div>

          {/* Reporting setup progress */}
          {hierConfig && (() => {
            // "Missing reporting manager" only counts Level 2+ employees.
            // The Level-1 (CEO) org root is excluded from the denominator.
            const managerBase =
              hierConfig.setup.usersWithManager + hierConfig.setup.usersWithoutManager;
            const pct = managerBase > 0 ? Math.round((hierConfig.setup.usersWithManager / managerBase) * 100) : 0;
            const invalid = hierConfig.setup.invalidLinks;
            return (
            <div className="space-y-3">
              {/* Admin warning: a hierarchy / role-level change can invalidate
                  existing reporting relationships. We surface them but never
                  auto-edit stored manager_id values. */}
              {invalid.length > 0 && (
                <div className="bg-amber-50 border border-amber-300 rounded-xl p-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-amber-800">
                        {t('hierarchyChangedNeedCorrection')}
                      </p>
                      <p className="text-xs text-amber-700 mt-1">
                        {t('needsCorrectionNotAutoChanged', { count: String(invalid.length) })}
                        
                        
                        
                      </p>
                      <ul className="mt-2 space-y-1 max-h-48 overflow-auto pr-1">
                        {invalid.map(link => (
                          <li key={link.employeeId} className="text-xs text-amber-800">
                            <span className="font-medium">{link.employeeName}</span> ({link.employeeId}): {link.reason}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              )}

              <div className="bg-white border border-slate-200 rounded-xl p-5">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-slate-700">{t('reportingSetup')}</span>
                  <span className="text-sm text-slate-500">
                    {t('employeesHaveManager', { with: String(hierConfig.setup.usersWithManager), total: String(managerBase) })}
                    <span className="text-slate-400">  ·  {t('level1Excluded')}</span>
                  </span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-[#978C21] transition-all" style={{ width: `${pct}%` }} />
                </div>
                {hierConfig.setup.usersWithoutManager > 0 ? (
                  <p className="mt-2 text-xs text-red-600">
                    {t('employeesMissingManager', { count: String(hierConfig.setup.usersWithoutManager) })}
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-emerald-600">{t('allEmployeesHaveManager')}</p>
                )}
              </div>
            </div>
            );
          })()}

          {/* Ladder levels */}
          <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            {hierConfig && hierConfig.levels.length > 0 ? (
              hierConfig.levels.map(level => (
                <div key={level.level} className="flex flex-col sm:flex-row sm:items-center gap-3 pb-4 border-b border-slate-100 last:border-0 last:pb-0">
                  <div className="flex items-center gap-3 min-w-[150px]">
                    <div className={`h-9 w-9 rounded-full flex items-center justify-center text-sm font-bold ${level.level === 1 ? 'bg-[#0359B3] text-white' : 'bg-[#978C21] text-white'}`}>
                      {level.level}
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-slate-800">{t('level')} {level.level}</div>
                      <div className="text-xs text-slate-400">{level.level === 1 ? t('ceoTopOfCompany') : t('reportsToLevel', { level: String(level.level - 1) })}</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 flex-1">
                    {level.roles.map(role => (
                      <div key={role.roleId} className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5">
                        <span className="text-sm text-slate-700 font-medium">{role.roleName}</span>
                        <span className="text-xs text-slate-400">{t('empAbbrev', { count: String(role.employeeCount) })}</span>
                        <select
                          value={ladderAssignments[role.roleId] ?? level.level}
                          onChange={e => setRoleLadderLevel(role.roleId, Number(e.target.value))}
                          className="text-xs border border-slate-200 rounded px-1 py-0.5 bg-white"
                          title={t('moveRoleToAnotherLevel')}
                        >
                          {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
                            <option key={n} value={n}>L{n}</option>
                          ))}
                          <option value={0}>— {t('off')}</option>
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div className="text-sm text-slate-500">{t('noRolesInLadder')}</div>
            )}

            {/* Unassigned roles */}
            {hierConfig && hierConfig.unassignedRoles.length > 0 && (
              <div className="pt-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">{t('roleNotInLadder')}</div>
                <div className="flex flex-wrap gap-2">
                  {hierConfig.unassignedRoles.map(role => (
                    <div key={role.roleId} className="flex items-center gap-2 bg-slate-50 border border-dashed border-slate-300 rounded-lg px-3 py-1.5">
                      <span className="text-sm text-slate-600">{role.roleName}</span>
                      <span className="text-xs text-slate-400">{t('empAbbrev', { count: String(role.employeeCount) })}</span>
                      <select
                        value={ladderAssignments[role.roleId] ?? 0}
                        onChange={e => setRoleLadderLevel(role.roleId, Number(e.target.value))}
                        className="text-xs border border-slate-200 rounded px-1 py-0.5 bg-white"
                        title={t('placeRoleIntoLevel')}
                      >
                        <option value={0}>— {t('off')}</option>
                        {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
                          <option key={n} value={n}>L{n}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/*  EMPLOYEE ADD/EDIT MODAL                                         */}
      {/* ================================================================ */}
      <AnimatePresence>
        {isUserModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => setIsUserModalOpen(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl"
              onClick={e => e.stopPropagation()}
            >
              {/* Modal header */}
              <div className="sticky top-0 bg-white border-b border-slate-100 px-6 py-4 flex items-center justify-between z-10">
                <div>
                  <h2 className="text-lg font-semibold text-slate-800">
                    {editingUser ? t('editEmployee') : t('addNewEmployee')}
                  </h2>
                  <p className="text-sm text-slate-500">{t('fillEmployeeDetails')}</p>
                </div>
                <button
                  onClick={() => setIsUserModalOpen(false)}
                  className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Modal form */}
              <form onSubmit={handleSaveUser} className="p-6 space-y-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium text-slate-600 mb-1 block">{t('fullName')} *</label>
                    <input
                      type="text"
                      required
                      value={userForm.name}
                      onChange={e => setUserForm({ ...userForm, name: e.target.value })}
                      placeholder={t('namePlaceholder')}
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] transition-colors"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-slate-600 mb-1 block">{t('employeeId')} *</label>
                    <input
                      type="text"
                      required
                      value={userForm.employeeId}
                      onChange={e => setUserForm({ ...userForm, employeeId: e.target.value })}
                      placeholder={t('empIdPlaceholder')}
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] transition-colors"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-slate-600 mb-1 block">{t('phoneNumber')}</label>
                    <input
                      type="text"
                      value={userForm.contact}
                      onChange={e => setUserForm({ ...userForm, contact: e.target.value })}
                      placeholder={t('phonePlaceholder')}
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] transition-colors"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-slate-600 mb-1 block">{t('emailAddress')} *</label>
                    <input
                      type="email"
                      required
                      value={userForm.email}
                      onChange={e => setUserForm({ ...userForm, email: e.target.value })}
                      placeholder={t('emailPlaceholder')}
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] transition-colors"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-slate-600 mb-1 block">{t('designation')}</label>
                    <input
                      type="text"
                      value={userForm.designation}
                      onChange={e => setUserForm({ ...userForm, designation: e.target.value })}
                      placeholder={t('designationPlaceholder')}
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] transition-colors"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-slate-600 mb-1 block">{t('role')}</label>
                    <select
                      value={userForm.role}
                      onChange={e => setUserForm({ ...userForm, role: e.target.value })}
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] bg-white"
                    >
                      {roles.map(r => (
                        <option key={r.roleId} value={r.roleId}>{r.roleName}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-slate-600 mb-1 block">{t('department')}</label>
                    <select
                      value={userForm.departmentId}
                      onChange={e => setUserForm({ ...userForm, departmentId: e.target.value })}
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] bg-white"
                    >
                      <option value="">{t('noDepartment')}</option>
                      {departments.map(d => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-slate-600 mb-1 block">{t('reportingManager')}</label>
                    {(roles.find(r => r.roleId === userForm.role) as any)?.hierarchyLevel === 1 ? (
                      <div className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm text-slate-500 bg-slate-50">
                        {t('level1ReportsToNone')}
                      </div>
                    ) : (
                      <select
                        value={userForm.managerId}
                        onChange={e => setUserForm({ ...userForm, managerId: e.target.value })}
                        disabled={loadingManagers}
                        className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] bg-white disabled:bg-slate-50"
                      >
                        <option value="">{loadingManagers ? t('loadingData') : t('selectManager')}</option>
                        {managerOptions.map(o => (
                          <option key={o.employeeId} value={o.employeeId}>
                            {o.fullName} ({o.employeeId}) — {o.roleName}
                          </option>
                        ))}
                      </select>
                    )}
                    <p className="text-xs text-slate-400 mt-1">
                      {t('managerDropdownHint')}
                    </p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-slate-600 mb-1 block">{t('status')}</label>
                    <select
                      value={userForm.status}
                      onChange={e => setUserForm({ ...userForm, status: e.target.value as any })}
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] bg-white"
                    >
                      <option value="Active">{t('active')}</option>
                      <option value="Inactive">{t('inactive')}</option>
                    </select>
                  </div>
                </div>

                {/* Password section */}
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
                  <label className="text-sm font-medium text-slate-700 flex items-center gap-2">
                    <Lock className="w-4 h-4 text-[#978C21]" />
                    {editingUser ? t('resetPassword') : t('password')}
                  </label>
                  <input
                    type="text"
                    value={userForm.password}
                    onChange={e => setUserForm({ ...userForm, password: e.target.value })}
                    placeholder={editingUser ? t('leaveBlankKeepPassword') : t('leaveBlankAutoGenerate')}
                    className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] bg-white"
                  />
                  <p className="text-xs text-slate-400">
                    {editingUser ? t('resetPasswordHint') : t('autoPasswordHint')}
                  </p>
                </div>

                {/* Actions */}
                <div className="flex gap-3 justify-end pt-2">
                  <button
                    type="button"
                    onClick={() => setIsUserModalOpen(false)}
                    className="px-5 py-2.5 border border-slate-200 text-slate-600 hover:bg-slate-50 text-sm font-medium rounded-lg transition-colors"
                  >
                    {t('cancel')}
                  </button>
                  <button
                    type="submit"
                    className="px-6 py-2.5 bg-[#978C21] hover:bg-[#83781C] text-white text-sm font-medium rounded-lg transition-colors shadow-sm"
                  >
                    {editingUser ? t('saveChanges') : t('addEmployee')}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
