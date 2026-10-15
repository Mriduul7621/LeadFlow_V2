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
  UserX,
  Upload,
  ShieldCheck,
  Sparkles,
  Bookmark,
  Loader2
} from 'lucide-react';
import { UserBulkImportModal } from '../components/UserBulkImportModal';
import EnterpriseAccessPanel from '../components/EnterpriseAccessPanel';
import { cn } from '../../../lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { userService } from '../services/userService';
import { adminService, RoleTemplate } from '../../admin/services/adminService';
import { orgService, Department, HierarchyConfig, ReportingOption } from '../../hierarchy/services/orgService';
import { ApiError } from '../../shared/api/http';
import { useAuthStore } from '../../auth/store/authStore';
import { RolePermission, User } from '../../shared/types';


/* ------------------------------------------------------------------ */
/*  Feature metadata for role permissions.                             */
/*  FEATURE ACCESS = MODULE / PAGE VISIBILITY ONLY.                    */
/*                                                                     */
/*  Granular actions live exclusively in ACTION_PERMISSION_GROUPS      */
/*  below (canonical, server-enforced). The legacy action-like         */
/*  sub-options ("Create Leads", "Upload Excel File", "Update Lead     */
/*  Status", the dept/role/user/hier child toggles,                    */
/*  configure_parameters, …) were duplicates of canonical codes and    */
/*  are no longer exposed.                                             */
/* ------------------------------------------------------------------ */
interface FeatureMeta {
  key: string;
  label: string;
  desc: string;
  group: string;
  path: string;
  defaultEnabled?: boolean;
}

const APP_FEATURES: FeatureMeta[] = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    desc: 'View performance summary, pipeline, follow-up discipline and daily execution.',
    group: 'Primary navigation',
    path: '/',
  },
  {
    key: 'workbench',
    label: 'Daily Workbench',
    desc: "Manage today's calls, meetings, follow-ups and tasks from one execution workspace.",
    group: 'Primary navigation',
    path: '/workbench',
  },
  {
    key: 'activities',
    label: 'Activities',
    desc: 'Open the activity history from More → Reports.',
    group: 'More → Reports',
    path: '/activities',
  },
  {
    key: 'task_calendar',
    label: 'Task Calendar',
    desc: 'View scheduled calls, meetings, follow-ups and tasks from More → Reports.',
    group: 'More → Reports',
    path: '/task-calendar',
  },
  {
    key: 'follow_up_strategy',
    label: 'Follow-up Queue',
    desc: 'View overdue, today and upcoming follow-ups from More → Reports.',
    group: 'More → Reports',
    path: '/follow-up',
  },
  {
    key: 'lead_tracking',
    label: 'Lead Workspace',
    desc: 'Open the lead workspace; what the role can do inside it follows Action Permissions.',
    group: 'Primary navigation',
    path: '/leads',
  },
  {
    key: 'lead_generate',
    label: 'Add New Lead',
    desc: 'Open the manual lead creation page; creating leads is governed by the Leads Create action.',
    group: 'Primary navigation',
    path: '/leads/new',
  },
  {
    key: 'lead_upload',
    label: 'Bulk Upload',
    desc: 'Open the bulk upload page; importing is governed by the Leads Import action.',
    group: 'Administration',
    path: '/leads/upload',
  },
  {
    key: 'all_leads',
    label: 'Lead Pool',
    desc: 'Open the lead pool; actual data scope still follows server Data Visibility.',
    group: 'Administration',
    path: '/leads/all',
  },
  { key: 'execution_intelligence', label: 'Performance', desc: 'View sales execution and performance insights.', group: 'More → Reports', path: '/execution-intelligence' },
  { key: 'ncp_progress', label: 'NCP Progress', desc: 'View collected and projected NCP progress.', group: 'More → Reports', path: '/ncp-progress' },
  { key: 'trend_charts', label: 'Trends', desc: 'View available performance trend analytics.', group: 'More → Reports', path: '/trend-charts' },
  { key: 'campaign_breakdown', label: 'Campaigns', desc: 'View campaign-level lead performance.', group: 'More → Reports', path: '/campaign-breakdown' },
  { key: 'team_progress', label: 'Team', desc: 'View reporting hierarchy and team information from More → Reports.', group: 'More → Reports', path: '/team' },
  {
    key: 'user_management',
    label: 'Users',
    desc: 'Open the Users workspace (employees, departments, roles, hierarchy); administration actions follow Action Permissions.',
    group: 'Administration',
    path: '/users',
  },
  {
    key: 'settings_control',
    label: 'Settings',
    desc: 'Open Personal Settings (name, mobile, email and password); administration and system tools remain admin-only.',
    group: 'More',
    path: '/settings',
  },
  {
    key: 'roadshow_follow_up',
    label: 'Roadshow Follow-up',
    desc: 'Plan and track assigned roadshows, with a separate performance report.',
    group: 'More',
    path: '/roadshows',
  },
  { key: 'notifications', label: 'Notifications', desc: 'View and manage personal notifications.', group: 'More', path: '/notifications', defaultEnabled: true },
  { key: 'help_support', label: 'Help & Support', desc: 'Open product help and support information.', group: 'More', path: '/help', defaultEnabled: true },
  { key: 'about_leadflow', label: 'About LeadFlow', desc: 'View information about LeadFlow.', group: 'More', path: '/about', defaultEnabled: true },
];
const APP_FEATURE_GROUPS = [...new Set(APP_FEATURES.map(feature => feature.group))];

/* ------------------------------------------------------------------ */
/*  Canonical action permissions (permissions × role_permissions).     */
/*  These are the granular, server-enforced action grants — separate   */
/*  from feature/menu visibility (APP_FEATURES) and data visibility.   */
/*                                                                     */
/*  Every code below already exists in the `permissions` catalog       */
/*  seeded by migration 025 — no code is invented here. Each mapped    */
/*  action is enforced server-side (production.routes.ts).             */
/* ------------------------------------------------------------------ */
interface ActionPermissionMeta {
  code: string;
  label: string;
  desc: string;
}

const ACTION_PERMISSION_GROUPS: { module: string; items: ActionPermissionMeta[] }[] = [
  {
    module: 'Dashboard',
    items: [
      { code: 'dashboard.view', label: 'View', desc: 'Open the Dashboard (performance summary, pipeline, follow-up discipline, daily execution).' },
    ],
  },
  {
    module: 'Leads',
    items: [
      { code: 'leads.view', label: 'View', desc: 'View leads within this role’s data-visibility scope.' },
      { code: 'leads.create', label: 'Create', desc: 'Create new leads (Add New Lead).' },
      { code: 'leads.edit', label: 'Edit', desc: 'Update lead status / record follow-ups. Also gates Daily Workbench and Task Calendar complete, edit, cancel and reschedule.' },
      { code: 'leads.delete', label: 'Delete', desc: 'Delete leads (Lead Pool).' },
      { code: 'leads.assign', label: 'Assign', desc: 'Assign / reassign lead ownership.' },
      { code: 'leads.transfer', label: 'Transfer', desc: 'Transfer lead ownership between users.' },
      { code: 'leads.import', label: 'Import', desc: 'Bulk-import leads (Bulk Upload).' },
      { code: 'leads.export', label: 'Export', desc: 'Export lead audit logs.' },
    ],
  },
  {
    module: 'Users',
    items: [
      { code: 'users.create', label: 'Create', desc: 'Onboard new employees.' },
      { code: 'users.edit', label: 'Edit', desc: 'Edit employee details and activate/deactivate accounts. Password resets are administrator-only, and self-service password changes never require this.' },
      { code: 'users.delete', label: 'Delete', desc: 'Remove employees.' },
    ],
  },
  {
    module: 'Roles',
    items: [
      { code: 'roles.manage', label: 'Manage Roles', desc: 'Create, update and delete roles.' },
      { code: 'permissions.manage', label: 'Manage User Permission Overrides', desc: 'Set per-user permission overrides. Editing the role permission matrix stays admin-only.' },
    ],
  },
  {
    module: 'Departments',
    items: [
      { code: 'departments.manage', label: 'Manage', desc: 'Create, update and remove departments.' },
    ],
  },
  {
    module: 'Hierarchy & Teams',
    items: [
      { code: 'teams.manage', label: 'Manage Teams', desc: 'Create, update and remove teams.' },
      { code: 'hierarchy.manage', label: 'Manage Reporting Hierarchy', desc: 'Change the company reporting ladder and manager assignments.' },
    ],
  },
  {
    module: 'Settings',
    items: [
      { code: 'settings.manage', label: 'Manage Parameters', desc: 'Manage metadata parameters (areas, products, campaigns, statuses). Self-service profile/password/notification settings follow the Settings module toggle, not this action.' },
      { code: 'workflow.manage', label: 'Manage Workflow Rules', desc: 'Configure lead status transition rules (follow-up flow). Self-service password change and the forced first-login reset are NOT governed by this.' },
    ],
  },
  {
    module: 'Roadshows',
    items: [
      { code: 'roadshows.view', label: 'View', desc: 'Open Roadshow Follow-up and view roadshow status.' },
      { code: 'roadshows.create', label: 'Create', desc: 'Schedule roadshows and assign active users.' },
      { code: 'roadshows.edit', label: 'Edit', desc: 'Update pending roadshows, reschedule, or execute them. Executed roadshows are locked for non-admins.' },
      { code: 'roadshows.cancel', label: 'Cancel', desc: 'Cancel a pending or rescheduled roadshow.' },
      { code: 'roadshows.report', label: 'Performance report', desc: 'View collected lead totals and lead-status breakdowns by executed roadshow.' },
    ],
  },
];

/* Which Feature Access module toggles keep each action group active.
   Permissions are always STORED; when every mapped module is hidden the
   editor marks the group inactive (visually disabled, grants preserved). */
const ACTION_MODULE_FEATURE_KEYS: Record<string, string[]> = {
  'Dashboard': ['dashboard'],
  'Leads': ['lead_tracking', 'lead_generate', 'lead_upload', 'all_leads'],
  'Users': ['user_management'],
  'Roles': ['user_management'],
  'Departments': ['user_management'],
  'Hierarchy & Teams': ['user_management', 'team_progress'],
  'Settings': ['settings_control'],
  'Roadshows': ['roadshow_follow_up'],
};

/* ================================================================== */
/*  MAIN COMPONENT                                                     */
/* ================================================================== */

type TabKey = 'employees' | 'departments' | 'roles' | 'hierarchy';

export default function UserManagement() {
  const { user: currentUser } = useAuthStore();

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
    // Extra department seats (Phase D): one person may belong to more than
    // one department, which is what lets a single head lead several.
    departmentIds: [] as string[],
    managerId: '',
    password: '',
    status: 'Active' as 'Active' | 'Inactive',
  });

  // ---- Department states ----
  const [deptFormName, setDeptFormName] = useState('');
  const [editingDeptId, setEditingDeptId] = useState<string | null>(null);

  // ---- Lead hand-over (Phase E: nobody is switched off while they still
  //      own open leads — the server refuses, the admin picks the successor
  //      here, and the same modal cleans up a person who was already off) ----
  const [handover, setHandover] = useState<{
    kind: 'update' | 'delete';
    userId: string;
    userName: string;
    leadCount: number;
    leads: Array<{ leadCode: string; customerName: string; mobile: string; currentStatus: string }>;
    suggestions: Array<{ userId: string; employeeId: string; fullName: string; roleCode: string; isManager: boolean }>;
    targetId: string;
    /** The exact body the server refused, replayed with the chosen successor. */
    pendingPayload?: any;
  } | null>(null);
  const [savingHandover, setSavingHandover] = useState(false);

  // ---- Department heads (Phase C: one primary head + optional co-heads) ----
  const [headDept, setHeadDept] = useState<Department | null>(null);
  const [headForm, setHeadForm] = useState<{ primaryUserId: string; coHeadUserIds: string[] }>({
    primaryUserId: '',
    coHeadUserIds: [],
  });
  const [savingHeads, setSavingHeads] = useState(false);

  // ---- Role states ----
  const [selectedRole, setSelectedRole] = useState<RolePermission | null>(null);
  const [roleFormName, setRoleFormName] = useState('');
  const [roleFormSlug, setRoleFormSlug] = useState('');
  const [roleFormVisibility, setRoleFormVisibility] = useState<'Own' | 'DownTeam' | 'FullTeam' | 'Organization'>('Own');
  const [roleFormFeatures, setRoleFormFeatures] = useState<Record<string, Record<string, boolean>>>({});
  const [roleFormActions, setRoleFormActions] = useState<Record<string, boolean>>({});
  const [showRoleForm, setShowRoleForm] = useState(false);

  // ---- Role templates (F16 Phase F) ----
  // `available` is false on a database without migration 047: the baselines are
  // still listed (they are derived from the roles, not stored), but saving a new
  // snapshot is impossible and the screen says so instead of throwing.
  const [roleTemplates, setRoleTemplates] = useState<RoleTemplate[]>([]);
  const [templatesAvailable, setTemplatesAvailable] = useState(false);
  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templateDesc, setTemplateDesc] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);

  // ---- Effective Access (F16 Phase F) ----
  const [accessReviewUser, setAccessReviewUser] = useState<{ id: string; name: string } | null>(null);
  // The access review answers for anybody, but only an administrator may read
  // it (the endpoint is admin-only). The button follows the same rule, so
  // nobody is offered a screen that would answer 403.
  const isPlatformAdmin = ['ADMIN', 'SUPERADMIN'].includes(String(currentUser?.role || '').toUpperCase());

  // ---- Hierarchy (company-wide reporting ladder) states ----
  const [hierConfig, setHierConfig] = useState<HierarchyConfig | null>(null);
  const [ladderAssignments, setLadderAssignments] = useState<Record<string, number>>({});
  const [savingLadder, setSavingLadder] = useState(false);
  const [managerOptions, setManagerOptions] = useState<ReportingOption[]>([]);
  const [loadingManagers, setLoadingManagers] = useState(false);

  // ---- Bulk import ----
  const [showBulkImport, setShowBulkImport] = useState(false);

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
      toast.error('Could not load data. Please check your connection.');
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
      departmentIds: [],
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
      // Only the EXTRA seats are edited here; the primary department is the
      // dropdown above.
      departmentIds: (((u as any).departmentIds || []) as string[])
        .filter(id => id !== (u as any).departmentId),
      managerId: (u as any).managerId || (u as any).reportingManagerId || '',
      password: '',
      status: u.status || 'Active',
    });
    setManagerOptions([]);
    setIsUserModalOpen(true);
  };

  /** Turn the server's refusal into the picker (never a dead-end toast). */
  const openHandover = (
    kind: 'update' | 'delete',
    user: { id: string; name: string },
    refused: any,
    pendingPayload?: any
  ) => {
    const suggestions = Array.isArray(refused?.suggestions) ? refused.suggestions : [];
    setHandover({
      kind,
      userId: user.id,
      userName: user.name,
      leadCount: Number(refused?.leadCount) || (Array.isArray(refused?.leads) ? refused.leads.length : 0),
      leads: Array.isArray(refused?.leads) ? refused.leads : [],
      suggestions,
      targetId: suggestions[0]?.userId || '',
      pendingPayload,
    });
  };

  const isHandoverRefusal = (err: unknown): any | null =>
    err instanceof ApiError && err.status === 409 && (err.data as any)?.code === 'LEADS_REQUIRE_TRANSFER'
      ? err.data
      : null;

  /** The single write path for "save this user", with or without a hand-over. */
  const submitUser = async (payload: any, transferLeadsTo?: string) => {
    const body: any = transferLeadsTo ? { ...payload, transferLeadsTo } : payload;
    if (editingUser) {
      await userService.updateUser(editingUser.id, body);
      return;
    }
    await userService.createUser(body);
  };

  const handleSaveUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userForm.name.trim() || !userForm.employeeId.trim() || !userForm.email.trim()) {
      toast.error('Please fill in Name, Employee ID and Email.');
      return;
    }
    const formRoleLevel = (roles.find(r => r.roleId === userForm.role) as any)?.hierarchyLevel ?? 0;
    if (formRoleLevel > 1 && formRoleLevel < 99 && !userForm.managerId) {
      toast.error('Please select a reporting manager (one or two levels up, same department).');
      return;
    }
    if (formRoleLevel === 1 && userForm.managerId) {
      toast.error('A Level-1 (CEO) employee cannot have a reporting manager.');
      return;
    }

    const cleanEmpId = userForm.employeeId.trim().toUpperCase();
    const isDuplicate = users.some(u =>
      u.employeeId.trim().toUpperCase() === cleanEmpId &&
      (!editingUser || u.id !== editingUser.id)
    );
    if (isDuplicate) {
      toast.error(`Employee ID "${cleanEmpId}" already exists.`);
      return;
    }

    const genTempPw = () => {
      const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
      let out = '';
      for (let i = 0; i < 10; i++) out += c[Math.floor(Math.random() * c.length)];
      return out;
    };

    // Declared outside the try so the Phase E refusal handler can replay the
    // EXACT body the server rejected (a retry must not rebuild it).
    let payload: User & { departmentIds?: any } = null as any;
    try {
      const uid = editingUser ? editingUser.id : `u_${Date.now()}`;
      payload = {
        id: uid,
        name: userForm.name.trim(),
        employeeId: cleanEmpId,
        email: userForm.email.trim().toLowerCase(),
        contact: userForm.contact.trim() as any,
        designation: userForm.designation.trim() || 'Officer',
        role: userForm.role,
        departmentId: userForm.departmentId as any,
        // Primary + extra seats, deduped: the server ignores the primary when
        // it writes the extra seats.
        departmentIds: Array.from(
          new Set([userForm.departmentId, ...userForm.departmentIds].filter(Boolean))
        ) as any,
        status: userForm.status,
        createdDate: editingUser ? editingUser.createdDate : new Date().toISOString(),
        password: userForm.password ? userForm.password : (editingUser ? undefined : genTempPw()),
        mustChangePassword: editingUser
          ? (userForm.password ? true : (editingUser.mustChangePassword ?? false))
          : true,
        managerId: userForm.managerId,
      };

      if (editingUser) {
        await submitUser(payload as any);
        toast.success(`${payload.name}'s profile has been updated.`);
      } else {
        await userService.createUser(payload);
        toast.success(`${payload.name} has been added. Temporary password: "${payload.password}"`);
      }

      setIsUserModalOpen(false);
      await loadData();
    } catch (err) {
      // Phase E: switching somebody off does not silently strand their book.
      // The server answers 409 with the leads and the suggested successors;
      // the picker opens on top of the form (the form stays filled).
      const refusal = isHandoverRefusal(err);
      if (refusal) {
        openHandover('update', { id: editingUser?.id || '', name: userForm.name.trim() }, refusal, {
          ...(payload as any),
        });
        return;
      }
      toast.error(err instanceof ApiError ? err.message : 'Could not save. Please check your database connection.');
    }
  };

  /** Finish a deactivation/removal after the successor was chosen. */
  const confirmHandover = async () => {
    if (!handover || !handover.targetId) {
      toast.error('Choose who takes these leads over.');
      return;
    }
    setSavingHandover(true);
    try {
      if (handover.kind === 'delete') {
        await userService.deleteUser(handover.userId, handover.targetId);
      } else {
        await submitUser(handover.pendingPayload || {}, handover.targetId);
      }
      const target = handover.suggestions.find(s => s.userId === handover.targetId);
      toast.success(
        `${handover.leadCount} lead${handover.leadCount === 1 ? '' : 's'} transferred to ` +
        `${target?.fullName || 'the selected colleague'}.`
      );
      setHandover(null);
      setIsUserModalOpen(false);
      await loadData();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not complete the hand-over.');
    } finally {
      setSavingHandover(false);
    }
  };

  const handleDeleteUser = async (id: string, name: string) => {
    if (confirm(`Are you sure you want to delete ${name}?`)) {
      try {
        await userService.deleteUser(id);
        toast.success(`${name} has been removed.`);
        await loadData();
      } catch (e) {
        // Phase E: removal has the same rule as deactivation.
        const refusal = isHandoverRefusal(e);
        if (refusal) {
          openHandover('delete', { id, name }, refusal);
          return;
        }
        toast.error(e instanceof ApiError ? e.message : 'Could not delete. Please try again.');
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
    if (!deptFormName.trim()) { toast.error('Department name cannot be empty.'); return; }
    try {
      // The server owns the department id (and its mirror team's): a new
      // department is sent WITHOUT an id instead of a made-up client one.
      await orgService.saveDepartment(
        editingDeptId
          ? { id: editingDeptId, name: deptFormName.trim() }
          : { name: deptFormName.trim() }
      );
      toast.success(editingDeptId ? 'Department updated.' : 'Department added.');
      setDeptFormName('');
      setEditingDeptId(null);
      await loadData();
    } catch (e) {
      toast.error('Could not save department.');
    }
  };

  const handleDeleteDept = async (id: string) => {
    if (confirm('Are you sure you want to delete this department?')) {
      try {
        await orgService.deleteDepartment(id);
        toast.success('Department deleted.');
        await loadData();
      } catch (e) {
        toast.error('Could not delete department.');
      }
    }
  };

  /* ================================================================== */
  /*  DEPARTMENT HEADS HANDLERS (Phase C)                                */
  /* ================================================================== */
  /** Everyone who may be picked as a head: the department's ACTIVE members
   *  (the server rejects anybody else, so the picker never offers them).
   *  Phase D: membership — not the single legacy `departmentId` — decides who
   *  belongs, so a person whose seat in this department is an EXTRA one is
   *  offered too (that is how one head can lead several departments). */
  const belongsToDepartment = (u: User, departmentId: string) => {
    const seats = ((u as any).departmentIds || []) as string[];
    return seats.length > 0 ? seats.includes(departmentId) : (u as any).departmentId === departmentId;
  };

  const headCandidates = (dept: Department | null) =>
    dept ? users.filter(u => belongsToDepartment(u, dept.id) && u.status !== 'Inactive') : [];

  const openHeadsModal = (dept: Department) => {
    setHeadDept(dept);
    setHeadForm({ primaryUserId: dept.primaryHead?.id || '', coHeadUserIds: [] });
  };

  const toggleCoHead = (userId: string) => {
    setHeadForm(prev => ({
      ...prev,
      coHeadUserIds: prev.coHeadUserIds.includes(userId)
        ? prev.coHeadUserIds.filter(id => id !== userId)
        : [...prev.coHeadUserIds, userId],
    }));
  };

  const handleSaveHeads = async () => {
    if (!headDept) return;
    setSavingHeads(true);
    try {
      // The primary head is never also sent as a co-head.
      await orgService.setDepartmentHeads(headDept.id, {
        primaryUserId: headForm.primaryUserId || null,
        coHeadUserIds: headForm.coHeadUserIds.filter(id => id !== headForm.primaryUserId),
      });
      toast.success('Department heads updated.');
      setHeadDept(null);
      await loadData();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : 'Could not update the department heads.'
      );
    } finally {
      setSavingHeads(false);
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
    const features: Record<string, Record<string, boolean>> = { ...(role.featurePermissions || {}) };
    APP_FEATURES.forEach(feature => {
      if (typeof features[feature.key]?.view === 'boolean') return;
      const configuredVisibility = role.menuAccess?.[feature.path];
      const view = configuredVisibility ?? Boolean(feature.defaultEnabled);
      features[feature.key] = { ...features[feature.key], view };
    });
    setRoleFormFeatures(features);
    setRoleFormActions({});
    // Load the canonical action grants for this role (server-authoritative,
    // persisted in role_permissions — never reconstructed from localStorage).
    adminService
      .getRolePermissions(role.roleId)
      .then(grants => {
        const map: Record<string, boolean> = {};
        grants.forEach(g => { map[g.code] = g.allowed; });
        setRoleFormActions(map);
      })
      .catch(() => setRoleFormActions({}));
  };

  const handleNewRole = () => {
    setSelectedRole(null);
    setRoleFormName('');
    setRoleFormSlug('');
    setRoleFormVisibility('Own');
    // Feature Access starts as pure module visibility (view only).
    const defaults: Record<string, Record<string, boolean>> = {};
    APP_FEATURES.forEach(f => {
      defaults[f.key] = { view: false };
    });
    setRoleFormFeatures(defaults);
    // New roles start fail-closed on every canonical action (Admin grants
    // each action explicitly).
    const actions: Record<string, boolean> = {};
    ACTION_PERMISSION_GROUPS.forEach(g => g.items.forEach(i => { actions[i.code] = false; }));
    setRoleFormActions(actions);
    setShowRoleForm(true);
  };

  /* ================================================================== */
  /*  ROLE TEMPLATES (F16 Phase F)                                       */
  /*                                                                     */
  /*  A template is a STARTING POINT, never a second source of truth:     */
  /*  applying one fills this editor, the administrator sees every toggle, */
  /*  and the save goes through the ONE existing role save path. Nothing  */
  /*  here writes access by itself.                                      */
  /* ================================================================== */
  const loadRoleTemplates = async () => {
    try {
      const result = await adminService.getRoleTemplates();
      setRoleTemplates(result.templates);
      setTemplatesAvailable(result.available);
    } catch {
      // A role manager without the templates table, or an offline shell: the
      // section simply does not appear — it must never block role editing.
      setRoleTemplates([]);
      setTemplatesAvailable(false);
    }
  };

  const handleUseTemplate = (template: RoleTemplate) => {
    setSelectedRole(null);
    // "Manager baseline" becomes "Manager"; a saved snapshot keeps its own name.
    setRoleFormName(template.source === 'system' ? template.name.replace(/\s+baseline$/i, '') : template.name);
    // The Role ID stays EMPTY on purpose: the role save upserts on the role id,
    // so a prefilled id could quietly overwrite an existing role. The
    // administrator names the new role deliberately.
    setRoleFormSlug('');
    setRoleFormVisibility((template.dataVisibility as any) || 'Own');
    const granted = new Set(template.grants || []);
    const actions: Record<string, boolean> = {};
    ACTION_PERMISSION_GROUPS.forEach(g => g.items.forEach(i => { actions[i.code] = granted.has(i.code); }));
    setRoleFormActions(actions);
    // Pages: the template's own page set wins where it has an opinion; where it
    // has none the shipped default applies — the exact rule `applyRoleToForm`
    // uses, so loading a role and loading its baseline land on the same screen.
    const features: Record<string, Record<string, boolean>> = {};
    APP_FEATURES.forEach(feature => {
      const configured = template.menuAccess?.[feature.path];
      features[feature.key] = { view: configured ?? Boolean(feature.defaultEnabled) };
    });
    setRoleFormFeatures(features);
    setShowRoleForm(true);
    toast.success(`Template “${template.name}” loaded.`, {
      description: 'Review every toggle and give the role an ID before saving — the template wrote nothing on its own.',
    });
  };

  const handleSaveAsTemplate = async () => {
    const fromRole = roleFormSlug.trim().toLowerCase() || selectedRole?.roleId || '';
    if (!fromRole) {
      toast.error('Save the role first — a template snapshots what the role holds on the server.');
      return;
    }
    if (!templateName.trim()) { toast.error('Give the template a name.'); return; }
    setSavingTemplate(true);
    try {
      await adminService.saveRoleTemplate({
        name: templateName.trim(),
        description: templateDesc.trim() || undefined,
        fromRole,
      });
      toast.success('Template saved.', {
        description: 'It may drift from the role from now on — that is the point of a snapshot. Delete it when it stops being useful.',
      });
      setShowTemplateForm(false);
      setTemplateName('');
      setTemplateDesc('');
      await loadRoleTemplates();
    } catch (err: any) {
      toast.error(err?.message || 'Could not save the template.');
    } finally {
      setSavingTemplate(false);
    }
  };

  const handleDeleteTemplate = async (template: RoleTemplate) => {
    try {
      await adminService.deleteRoleTemplate(template.id);
      toast.success(`Template “${template.name}” removed.`);
      await loadRoleTemplates();
    } catch (err: any) {
      toast.error(err?.message || 'Could not remove the template.');
    }
  };

  const handleSaveRole = async () => {
    if (!roleFormName.trim()) { toast.error('Role name is required.'); return; }
    const slug = roleFormSlug.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!slug) { toast.error('A valid role ID is required (lowercase letters/numbers).'); return; }

    try {
      const isAdm = slug === 'admin' || slug === 'superadmin';
      // Canonical action grants edited in the Action Permissions section.
      // They are persisted to role_permissions (server-side) and are the
      // single source of truth the server enforces.
      const grants = ACTION_PERMISSION_GROUPS.flatMap(g => g.items.map(i => ({
        code: i.code,
        allowed: !!roleFormActions[i.code],
      })));
      const granted = (code: string) => grants.some(g => g.code === code && g.allowed);
      const featureOn = (key: string) => !!roleFormFeatures?.[key]?.view;

      const payload: RolePermission = {
        roleId: slug,
        roleName: roleFormName.trim(),
        isCustom: selectedRole ? selectedRole.isCustom : true,
        menuAccess: {
          '/': featureOn('dashboard'),
          '/more': true,
          // NOTE: the retired "/reports" aggregate module key is gone — every
          // report page now has its own route + module toggle below, and a
          // stale key here would only let an admin toggle a path that no
          // route or menu item reads.
          '/administration': isAdm,
          '/notifications': featureOn('notifications'),
          '/help': featureOn('help_support'),
          '/about': featureOn('about_leadflow'),
          '/workbench': featureOn('workbench'),
          '/leads/new': featureOn('lead_generate'),
          '/leads/upload': featureOn('lead_upload'),
          '/leads/all': featureOn('all_leads'),
          '/leads': featureOn('lead_tracking'),
          '/execution-intelligence': featureOn('execution_intelligence'),
          '/ncp-progress': featureOn('ncp_progress'),
          '/trend-charts': featureOn('trend_charts'),
          '/campaign-breakdown': featureOn('campaign_breakdown'),
          '/follow-up': featureOn('follow_up_strategy'),
          '/task-calendar': featureOn('task_calendar'),
          '/activities': featureOn('activities'),
          '/team': featureOn('team_progress'),
          '/users': featureOn('user_management') || isAdm,
          '/settings': featureOn('settings_control') || isAdm,
          '/settings/system': isAdm,
          '/roadshows': featureOn('roadshow_follow_up'),
        },
        dataVisibility: roleFormVisibility,
        // Legacy `actions` JSONB, now derived from the canonical grants so
        // the stored proxy values match what the server actually enforces.
        actions: {
          view: granted('leads.view') || featureOn('lead_tracking'),
          create: granted('leads.create'),
          edit: granted('leads.edit'),
          delete: granted('leads.delete'),
          approve: granted('leads.edit'),
          upload: granted('leads.import'),
        },
        // Legacy compatibility mapping: featurePermissions keep the
        // historical sub-option keys, derived from the canonical grants, so
        // older client fallbacks (server permission sheet unavailable)
        // preserve the same effective behaviour. The editor itself no
        // longer exposes these duplicate toggles.
        featurePermissions: {
          ...Object.fromEntries(APP_FEATURES.map(f => [f.key, { view: featureOn(f.key) }])),
          lead_generate: { view: featureOn('lead_generate'), create: granted('leads.create') },
          lead_upload: { view: featureOn('lead_upload'), upload: granted('leads.import'), delete: granted('leads.delete') },
          lead_tracking: { view: featureOn('lead_tracking'), status_update: granted('leads.edit') },
        },
      };

      await adminService.saveRole(payload);
      // Persist the canonical action grants separately (role_permissions).
      // Only codes the server already knows are stored; unknown codes are
      // ignored server-side (fail closed).
      try {
        await adminService.saveRolePermissions(slug, grants);
      } catch (permErr) {
        // Role metadata/config is already committed; the action grants are
        // NOT. Report the partial failure honestly and keep the editor open
        // so the admin can retry — never claim full success.
        toast.error('Role settings were saved, but action permissions could not be saved. Please retry.');
        return;
      }
      toast.success('Role saved successfully.');
      setShowRoleForm(false);
      await loadData();
    } catch (err) {
      toast.error('Could not save role. Please try again.');
    }
  };

  const handleDeleteRole = async (slug: string) => {
    if (slug.toUpperCase() === 'ADMIN') { toast.error('Admin role cannot be deleted.'); return; }
    if (confirm(`Delete role "${slug}"?`)) {
      try {
        await adminService.deleteRole(slug);
        toast.success('Role deleted.');
        setSelectedRole(null);
        await loadData();
      } catch (e) {
        toast.error('Could not delete role.');
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
      toast.error('Could not load the hierarchy configuration.');
    }
  };

  useEffect(() => {
    if (activeTab === 'hierarchy') loadHierarchyConfig();
    // Templates are read when the Roles tab is opened — not on every mount of
    // the page, and not before an administrator asks for them.
    if (activeTab === 'roles') loadRoleTemplates();
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
      toast.error('Place at least one role in the ladder before saving.');
      return;
    }
    if (!assignments.some(a => a.level === 1)) {
      toast.error('Level 1 (CEO) is required — the ladder starts at the top.');
      return;
    }
    setSavingLadder(true);
    try {
      const config = await orgService.saveHierarchyConfig(assignments);
      setHierConfig(config);
      toast.success('Company ladder saved.');
    } catch (e: any) {
      toast.error(e?.message || 'Could not save the ladder.');
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
    const matchDept = !filterDeptId || belongsToDepartment(u, filterDeptId);
    const matchRole = !filterRole || u.role === filterRole;
    return matchQuery && matchDept && matchRole;
  });

  /* ================================================================== */
  /*  TABS CONFIG                                                        */
  /* ================================================================== */
  const tabs: { key: TabKey; label: string; icon: React.ReactNode; count?: number }[] = [
    { key: 'employees', label: 'Employees', icon: <Users className="w-4 h-4" />, count: users.length },
    { key: 'departments', label: 'Departments', icon: <Building className="w-4 h-4" />, count: departments.length },
    { key: 'roles', label: 'Roles & Access', icon: <Shield className="w-4 h-4" />, count: roles.length },
    { key: 'hierarchy', label: 'Hierarchy', icon: <Layers className="w-4 h-4" />, count: hierConfig?.levels.length ?? 0 },
  ];

  /* ================================================================== */
  /*  RENDER                                                             */
  /* ================================================================== */
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center space-y-3">
          <div className="w-8 h-8 border-2 border-t-[#978C21] border-slate-200 rounded-full animate-spin mx-auto" />
          <p className="text-sm text-slate-400">Loading data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">User Management</h1>
          <p className="text-sm text-slate-500 mt-1">Manage employees, departments, roles and organizational hierarchy.</p>
        </div>
        {activeTab === 'employees' && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowBulkImport(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 text-sm font-medium rounded-lg transition-colors shadow-sm"
            >
              <Upload className="w-4 h-4" /> Bulk Import Users
            </button>
            <button
              onClick={openCreateUser}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#978C21] hover:bg-[#83781C] text-white text-sm font-semibold rounded-lg transition-colors shadow-sm"
            >
              <UserPlus className="w-4 h-4" /> Add Employee
            </button>
          </div>
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
                placeholder="Search by name, ID, email..."
                className="flex-1 bg-transparent outline-none text-sm text-slate-700 placeholder:text-slate-400"
              />
            </div>
            <select
              value={filterDeptId}
              onChange={e => setFilterDeptId(e.target.value)}
              className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21]"
            >
              <option value="">All Departments</option>
              {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <select
              value={filterRole}
              onChange={e => setFilterRole(e.target.value)}
              className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21]"
            >
              <option value="">All Roles</option>
              {roles.map(r => <option key={r.roleId} value={r.roleId}>{r.roleName}</option>)}
            </select>
          </div>

          {/* Employee table */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50">
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500">Employee</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500">Role & Department</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500">Status</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500">Contact</th>
                    <th className="px-4 py-3 text-xs font-semibold text-slate-500 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredUsers.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-16 text-center text-sm text-slate-400">
                        No employees found.
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
                                <p className="text-xs text-slate-400">ID: {u.employeeId}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="space-y-1">
                              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-slate-100 text-slate-700 text-xs font-medium rounded-md">
                                <Shield className="w-3 h-3 text-[#978C21]" />
                                {roles.find(r => r.roleId === u.role)?.roleName || u.role}
                              </span>
                              {dept && (
                                <p className="text-xs text-slate-400">
                                  {dept.name}
                                  {(() => {
                                    const extras = (((u as any).departmentIds || []) as string[])
                                      .filter(id => id !== (u as any).departmentId)
                                      .map(id => departments.find(d => d.id === id)?.name)
                                      .filter(Boolean);
                                    return extras.length > 0 ? (
                                      <span className="text-[#978C21] font-medium"> +{extras.join(', ')}</span>
                                    ) : null;
                                  })()}
                                </p>
                              )}
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
                                title="Edit"
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                              {isPlatformAdmin && (
                                <button
                                  onClick={() => setAccessReviewUser({ id: u.id, name: u.name })}
                                  className="p-2 text-slate-400 hover:text-[#978C21] hover:bg-[#978C21]/10 rounded-lg transition-colors"
                                  title="Effective Access — what this person can actually do, and which layer decided it"
                                >
                                  <ShieldCheck className="w-4 h-4" />
                                </button>
                              )}
                              {u.employeeId !== 'ADMIN' && u.id !== currentUser?.id && (
                                <button
                                  onClick={() => handleDeleteUser(u.id, u.name)}
                                  className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                                  title="Delete"
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
              {editingDeptId ? 'Edit Department' : 'Add Department'}
            </h3>
            <form onSubmit={handleSaveDept} className="space-y-4">
              <div>
                <label className="text-sm font-medium text-slate-600 mb-1 block">Department Name</label>
                <input
                  type="text"
                  value={deptFormName}
                  onChange={e => setDeptFormName(e.target.value)}
                  placeholder="e.g. Operations, Finance"
                  className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] transition-colors"
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  className="flex-1 py-2.5 bg-[#978C21] hover:bg-[#83781C] text-white text-sm font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  <Save className="w-4 h-4" />
                  {editingDeptId ? 'Update' : 'Add Department'}
                </button>
                {editingDeptId && (
                  <button
                    type="button"
                    onClick={() => { setEditingDeptId(null); setDeptFormName(''); }}
                    className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-600 text-sm rounded-lg"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>
          </div>

          {/* List */}
          <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl p-6">
            <h3 className="text-base font-semibold text-slate-800 mb-4">
              Departments ({departments.length})
            </h3>
            {departments.length === 0 ? (
              <div className="py-12 text-center text-sm text-slate-400 border border-dashed border-slate-200 rounded-lg">
                No departments added yet. Create one using the form.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {departments.map(dept => {
                  const memberCount = dept.memberCount ?? users.filter(u => u.departmentId === dept.id).length;
                  const headCount = dept.headCount ?? (dept.primaryHead ? 1 : 0);
                  const coHeadCount = Math.max(0, headCount - 1);
                  return (
                    <div key={dept.id} className="p-4 bg-slate-50 border border-slate-100 rounded-lg hover:shadow-sm transition-shadow">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <h4 className="text-sm font-medium text-slate-800 truncate">{dept.name}</h4>
                          <p className="text-xs text-slate-400 mt-0.5">
                            {memberCount} {memberCount === 1 ? 'employee' : 'employees'}
                            {headCount > 0 && ` · ${headCount} ${headCount === 1 ? 'head' : 'heads'}`}
                          </p>
                        </div>
                        <div className="flex gap-1 shrink-0">
                          <button
                            onClick={() => openHeadsModal(dept)}
                            className="p-2 text-slate-400 hover:text-[#978C21] hover:bg-[#978C21]/10 rounded-lg transition-colors"
                            title="Set department heads"
                          >
                            <UserCheck className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => { setEditingDeptId(dept.id); setDeptFormName(dept.name); }}
                            className="p-2 text-slate-400 hover:text-sky-600 hover:bg-sky-50 rounded-lg transition-colors"
                            title="Edit"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDeleteDept(dept.id)}
                            className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                            title="Delete"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                      <div className="mt-2 flex items-center gap-1.5 text-xs">
                        {dept.primaryHead ? (
                          <>
                            <UserCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                            <span className="text-slate-700 font-medium truncate">
                              {dept.primaryHead.fullName || dept.primaryHead.employeeId}
                            </span>
                            {dept.primaryHead.employeeId && (
                              <span className="text-slate-400 shrink-0">{dept.primaryHead.employeeId}</span>
                            )}
                            {coHeadCount > 0 && (
                              <span className="text-slate-400 shrink-0">+{coHeadCount} co-head{coHeadCount > 1 ? 's' : ''}</span>
                            )}
                          </>
                        ) : (
                          <>
                            <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                            <span className="text-amber-600">No head assigned</span>
                          </>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400 mt-1">
                        Team: {dept.mirrorTeamId ? 'auto-managed from this department' : 'not synced yet'}
                      </p>
                    </div>
                  );
                })}
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
              {roleTemplates.length > 0 && (
                <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
                  <div className="flex items-start gap-2">
                    <Sparkles className="w-4 h-4 text-[#978C21] mt-0.5" />
                    <div>
                      <h3 className="text-sm font-semibold text-slate-800">Start from a template</h3>
                      <p className="text-xs text-slate-500 mt-0.5">
                        A baseline reads the standard role live, so it can never drift from what that role holds.
                        A saved template is a snapshot you took on purpose. Either way the editor opens with every
                        toggle visible and nothing is saved until you save it.
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {roleTemplates.map(template => (
                      <div
                        key={template.id}
                        className="flex items-center gap-2 border border-slate-200 rounded-lg pl-3 pr-1.5 py-1.5 bg-slate-50"
                      >
                        <button
                          onClick={() => handleUseTemplate(template)}
                          className="text-left"
                          title={template.description}
                        >
                          <span className="block text-xs font-medium text-slate-700">{template.name}</span>
                          <span className="block text-[10px] text-slate-400">
                            {template.source === 'system' ? 'baseline · live' : 'saved snapshot'} ·{' '}
                            {template.grants.length} action{template.grants.length === 1 ? '' : 's'} ·{' '}
                            {template.dataVisibility}
                          </span>
                        </button>
                        {template.source === 'saved' && (
                          <button
                            onClick={() => handleDeleteTemplate(template)}
                            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                            title="Delete this saved template"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                    {!templatesAvailable && (
                      <p className="text-[11px] text-slate-400 self-center">
                        Saving your own snapshots needs migration 047 on this database; the baselines above work without it.
                      </p>
                    )}
                  </div>
                </div>
              )}

              <div className="flex justify-between items-center">
                <h3 className="text-base font-semibold text-slate-800">Roles ({roles.length})</h3>
                <button
                  onClick={handleNewRole}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-[#978C21] hover:bg-[#83781C] text-white text-sm font-medium rounded-lg transition-colors"
                >
                  <Plus className="w-4 h-4" /> Add Role
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
                        {r.isCustom ? 'Custom' : 'System'}
                      </span>
                    </div>

                    <div className="space-y-2 text-xs text-slate-500">
                      <p>Data Access: <span className="font-medium text-slate-700">{r.dataVisibility || 'Own'}</span></p>
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
                        Configure
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
              <div className="flex items-center justify-between gap-3">
                <button
                  onClick={() => setShowRoleForm(false)}
                  className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700"
                >
                  <ArrowLeft className="w-4 h-4" /> Back to Roles
                </button>
                <button
                  onClick={() => {
                    if (!selectedRole) {
                      toast.info('Save the role first — a template snapshots what the role actually holds on the server.');
                      return;
                    }
                    setTemplateName(`${roleFormName.trim() || selectedRole.roleName} snapshot`);
                    setShowTemplateForm(v => !v);
                  }}
                  className="inline-flex items-center gap-2 px-3 py-2 border border-slate-200 text-slate-600 hover:bg-slate-50 text-xs font-medium rounded-lg transition-colors"
                >
                  <Bookmark className="w-3.5 h-3.5" /> Save as template
                </button>
              </div>

              {showTemplateForm && selectedRole && (
                <div className="bg-white border border-[#978C21]/30 rounded-xl p-5 space-y-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-800">Save this role’s access as a template</h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      A snapshot of the <span className="font-medium">{selectedRole.roleId}</span> role as it is stored
                      on the server right now — {selectedRole.roleName}. Later edits to that role will not change the
                      snapshot, and loading the snapshot will not change the role.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <input
                      type="text"
                      value={templateName}
                      onChange={e => setTemplateName(e.target.value)}
                      placeholder="Template name"
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21]"
                    />
                    <input
                      type="text"
                      value={templateDesc}
                      onChange={e => setTemplateDesc(e.target.value)}
                      placeholder="What is it for? (optional)"
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21]"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleSaveAsTemplate}
                      disabled={savingTemplate}
                      className="inline-flex items-center gap-2 px-4 py-2 bg-[#978C21] hover:bg-[#83781C] text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                    >
                      {savingTemplate ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                      Save template
                    </button>
                    <button
                      onClick={() => setShowTemplateForm(false)}
                      className="px-4 py-2 text-sm text-slate-500 hover:text-slate-700"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                {/* 1. Role basic info */}
                <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                  <h3 className="text-base font-semibold text-slate-800">
                    1. Role Details
                  </h3>
                  <p className="text-xs text-slate-400 -mt-2">{selectedRole ? 'Edit the role identity and save.' : 'Create a new role.'}</p>

                  <div>
                    <label className="text-sm font-medium text-slate-600 mb-1 block">Role Name</label>
                    <input
                      type="text"
                      value={roleFormName}
                      onChange={e => setRoleFormName(e.target.value)}
                      placeholder="e.g. Area Manager"
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21]"
                    />
                  </div>

                  {!selectedRole && (
                    <div>
                      <label className="text-sm font-medium text-slate-600 mb-1 block">Role ID</label>
                      <input
                        type="text"
                        value={roleFormSlug}
                        onChange={e => setRoleFormSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                        placeholder="e.g. area_manager"
                        className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] font-mono"
                      />
                      <p className="text-xs text-slate-400 mt-1">Lowercase letters, numbers and underscores only.</p>
                    </div>
                  )}

                  {/* 2. Data visibility */}
                  <div>
                    <label className="text-sm font-medium text-slate-600 mb-2 block">2. Data Visibility</label>
                    <p className="text-xs text-slate-400 mb-2 -mt-1">Which records the role can access.</p>
                    <div className="grid grid-cols-2 gap-2">
                      {(['Own', 'DownTeam', 'FullTeam', 'Organization'] as const).map(scope => {
                        const desc = scope === 'Own' ? 'Only own data'
                          : scope === 'DownTeam' ? 'Own + team below'
                          : scope === 'FullTeam' ? 'All team data'
                          : 'Entire organization';
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
                    <Save className="w-4 h-4" /> Save Role
                  </button>
                </div>

                {/* 3. Feature permissions — module/page visibility only */}
                <div className="lg:col-span-8 space-y-4">
                  <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                    <h3 className="text-base font-semibold text-slate-800">3. Feature Access</h3>
                    <p className="text-sm text-slate-500">
                      Module and page visibility only. What the role can <em>do</em> inside a module
                      is configured under Action Permissions below.
                    </p>

                    <div className="space-y-5">
                      {APP_FEATURE_GROUPS.map(group => (
                        <section key={group} className="space-y-2">
                          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">{group}</h4>
                          <div className="space-y-2">
                            {APP_FEATURES.filter(item => item.group === group).map(item => {
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
                                        setRoleFormFeatures({
                                          ...roleFormFeatures,
                                          [item.key]: { ...feat, view: !isOn },
                                        });
                                      }}
                                      className={cn(
                                        "px-3 py-1.5 text-xs font-medium rounded-md border transition-all",
                                        isOn
                                          ? "bg-[#978C21] text-white border-[#978C21]"
                                          : "bg-white text-slate-400 border-slate-200"
                                      )}
                                    >
                                      {isOn ? '✓ Enabled' : 'Disabled'}
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </section>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* 4. Action permissions (canonical, server-enforced) */}
              <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
                <div>
                  <h3 className="text-base font-semibold text-slate-800">4. Action Permissions</h3>
                  <p className="text-sm text-slate-500">
                    Granular actions this role can perform. These are enforced by the server
                    and persist to the database — separate from page visibility and data access.
                  </p>
                  <p className="text-xs text-slate-400 mt-1">
                    Feature Access controls whether the module is available. Action Permissions
                    control what the role can do inside it.
                  </p>
                </div>
                {ACTION_PERMISSION_GROUPS.map(group => {
                  const featureKeys = ACTION_MODULE_FEATURE_KEYS[group.module] || [];
                  const groupActive = featureKeys.length === 0 || featureKeys.some(k => !!roleFormFeatures?.[k]?.view);
                  return (
                    <div key={group.module} className={cn(
                      "border rounded-lg overflow-hidden transition-all",
                      groupActive ? "border-slate-200" : "border-slate-200 opacity-60"
                    )}>
                      <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
                        <span className="text-xs font-bold uppercase tracking-wider text-slate-600">{group.module}</span>
                        {!groupActive && (
                          <span className="text-[10px] font-medium text-amber-600 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                            Module hidden in Feature Access — the role can't reach these actions in the UI. Grants stay saved and still apply at the API.
                          </span>
                        )}
                      </div>
                      <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {group.items.map(item => {
                          const isOn = !!roleFormActions[item.code];
                          return (
                            <label key={item.code} className={cn(
                              "flex items-start gap-2 p-2 rounded-md",
                              groupActive ? "cursor-pointer hover:bg-slate-50" : "cursor-not-allowed"
                            )}>
                              <input
                                type="checkbox"
                                checked={isOn}
                                disabled={!groupActive}
                                onChange={() => setRoleFormActions({ ...roleFormActions, [item.code]: !isOn })}
                                className="mt-0.5 w-4 h-4 accent-[#978C21] disabled:opacity-50"
                              />
                              <div>
                                <span className="text-xs font-medium text-slate-700">{item.label}</span>
                                <p className="text-[10px] text-slate-400">{item.desc}</p>
                                <p className="text-[10px] font-mono text-slate-300">{item.code}</p>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
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
              <h3 className="text-base font-semibold text-slate-800">Company Hierarchy Ladder</h3>
              <p className="text-sm text-slate-500">
                One company-wide ladder — Level 1 is the CEO. Every other employee reports to a specific manager one or two levels up, within the same department.
              </p>
            </div>
            <button
              onClick={saveLadder}
              disabled={savingLadder}
              className="inline-flex items-center gap-2 px-6 py-2.5 bg-[#978C21] hover:bg-[#83781C] text-white text-sm font-medium rounded-lg transition-colors shadow-sm disabled:opacity-60"
            >
              <Save className="w-4 h-4" /> {savingLadder ? 'Saving…' : 'Save Ladder'}
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
                        Hierarchy changed. Some existing reporting relationships are no longer valid and require correction.
                      </p>
                      <p className="text-xs text-amber-700 mt-1">
                        {invalid.length} reporting relationship{invalid.length === 1 ? '' : 's'} need correction. Your existing
                        manager assignments were <span className="font-semibold">not changed automatically</span> — open each
                        employee in the <span className="font-semibold">Employees</span> tab and set a valid reporting manager
                        (one or two levels up, same department).
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
                  <span className="text-sm font-medium text-slate-700">Reporting setup</span>
                  <span className="text-sm text-slate-500">
                    {hierConfig.setup.usersWithManager} / {managerBase} employees have a reporting manager
                    <span className="text-slate-400">  ·  Level 1 / CEO excluded (no manager required)</span>
                  </span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-[#978C21] transition-all" style={{ width: `${pct}%` }} />
                </div>
                {hierConfig.setup.usersWithoutManager > 0 ? (
                  <p className="mt-2 text-xs text-red-600">
                    {hierConfig.setup.usersWithoutManager} employee{hierConfig.setup.usersWithoutManager === 1 ? '' : 's'} on Level 2 or below
                    have no reporting manager.
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-emerald-600">All employees that require a manager have one.</p>
                )}
              </div>
            </div>
            );
          })()}

          {/* Department health (F16 Phase D): a department with members but no
              primary head, an empty department, a mirror team that drifted out
              of step with its memberships — each is listed instead of being
              silently averaged away by the ladder progress bar above. */}
          {hierConfig?.departments && !hierConfig.departments.available && (
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs text-slate-500">
              Department health needs the department-members layer (migration 046), which this database does not
              have yet. Run migrations, then reload.
            </div>
          )}
          {hierConfig?.departments && hierConfig.departments.available && (() => {
            const dh = hierConfig.departments!;
            const clean = dh.headless.length === 0 && dh.empty.length === 0 && dh.teamDrift.length === 0;
            return (
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-slate-700">Department health</span>
                  <span className="text-xs text-slate-500">
                    {dh.totalDepartments} department{dh.totalDepartments === 1 ? '' : 's'} · {dh.headless.length} without a
                    primary head · {dh.empty.length} empty · {dh.teamDrift.length} team{dh.teamDrift.length === 1 ? '' : 's'} out of sync
                  </span>
                </div>

                {clean ? (
                  <p className="text-xs text-emerald-600">
                    Every department has a head, at least one member, and a team that matches its members.
                  </p>
                ) : (
                  <>
                    {dh.headless.length > 0 && (
                      <div className="bg-amber-50 border border-amber-300 rounded-lg p-3">
                        <p className="text-xs font-semibold text-amber-800">
                          {dh.headless.length} department{dh.headless.length === 1 ? '' : 's'} have members but no primary head.
                        </p>
                        <p className="text-[11px] text-amber-700 mt-1">
                          A department is allowed to be headless — nobody is guessing a value here. Set the primary head
                          in the <span className="font-semibold">Departments</span> tab (the head must be a member).
                        </p>
                        <ul className="mt-2 space-y-1 max-h-40 overflow-auto pr-1">
                          {dh.headless.map(d => (
                            <li key={d.id} className="text-xs text-amber-800">
                              <span className="font-medium">{d.name}</span> — {d.memberCount} member{d.memberCount === 1 ? '' : 's'}
                              {d.coHeadCount > 0 ? `, ${d.coHeadCount} co-head${d.coHeadCount === 1 ? '' : 's'} waiting for a primary` : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {dh.teamDrift.length > 0 && (
                      <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                        <p className="text-xs font-semibold text-red-800">
                          {dh.teamDrift.length} department team{dh.teamDrift.length === 1 ? '' : 's'} no longer match their members.
                        </p>
                        <p className="text-[11px] text-red-700 mt-1">
                          The department is the source of truth: save the department (or any of its members) in the
                          <span className="font-semibold"> Departments</span> tab to re-sync its roster and leader.
                        </p>
                        <ul className="mt-2 space-y-1 max-h-40 overflow-auto pr-1">
                          {dh.teamDrift.map(d => (
                            <li key={d.id} className="text-xs text-red-800">
                              <span className="font-medium">{d.name}</span> — members {d.membershipCount}, team roster {d.rosterCount}
                              {d.issues.includes('missing-team') ? ', no team' : ''}
                              {d.issues.includes('leader-mismatch') ? ', team leader is not the primary head' : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {dh.empty.length > 0 && (
                      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                        <p className="text-xs font-semibold text-slate-700">
                          {dh.empty.length} empty department{dh.empty.length === 1 ? '' : 's'} (no members yet)
                        </p>
                        <p className="text-[11px] text-slate-500 mt-1">{dh.empty.map(d => d.name).join(', ')}</p>
                      </div>
                    )}
                  </>
                )}

                {dh.membersWithoutDepartment.length > 0 && (
                  <p className="text-[11px] text-slate-500">
                    {dh.membersWithoutDepartment.length} active employee{dh.membersWithoutDepartment.length === 1 ? '' : 's'} belong
                    to no department: {dh.membersWithoutDepartment.map(u => `${u.fullName || u.employeeId} (${u.employeeId})`).join(', ')}
                  </p>
                )}
                {dh.multiDepartmentHeads.length > 0 && (
                  <p className="text-[11px] text-slate-500">
                    Heads of more than one department: {dh.multiDepartmentHeads
                      .map(h => `${h.fullName || h.employeeId} (${h.departmentCount})`)
                      .join(', ')} — allowed by design; each department keeps its own team.
                  </p>
                )}
              </div>
            );
          })()}

          {/* Lead-ownership health (Phase E): the deactivation guard stops new
              cases only — anybody switched off BEFORE that rule still holds
              live leads, and this is where they surface. The fix is the same
              journey as any deactivation: open the person, pick the successor,
              save (which transfers the book). */}
          {hierConfig?.ownership && hierConfig.ownership.available && (
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-slate-700">Lead ownership</span>
                <span className="text-xs text-slate-500">
                  {hierConfig.ownership.totalOpenLeads} open lead
                  {hierConfig.ownership.totalOpenLeads === 1 ? '' : 's'} across the organization
                </span>
              </div>
              {hierConfig.ownership.inactiveOwnersWithOpenLeads.length === 0 ? (
                <p className="text-xs text-emerald-600">
                  Nobody who is switched off still owns an open lead — every live lead has an owner who can work it.
                </p>
              ) : (
                <div className="bg-amber-50 border border-amber-300 rounded-lg p-3">
                  <p className="text-xs font-semibold text-amber-800">
                    {hierConfig.ownership.inactiveOwnersWithOpenLeads.length} deactivated
                    {hierConfig.ownership.inactiveOwnersWithOpenLeads.length === 1 ? ' person still owns' : ' people still own'} open leads.
                  </p>
                  <p className="text-[11px] text-amber-700 mt-1">
                    These accounts cannot log in, so nobody is following their leads up. Open the person in{' '}
                    <span className="font-semibold">Employees</span>, choose who takes the leads over and save — the same
                    transfer step the deactivation flow uses.
                  </p>
                  <ul className="mt-2 space-y-1 max-h-40 overflow-auto pr-1">
                    {hierConfig.ownership.inactiveOwnersWithOpenLeads.map(o => (
                      <li key={o.employeeId} className="text-xs text-amber-800">
                        <button
                          type="button"
                          className="font-medium underline decoration-dotted"
                          onClick={() => {
                            const row = users.find(u => u.employeeId === o.employeeId);
                            if (row) openEditUser(row);
                          }}
                        >
                          {o.fullName || o.employeeId} ({o.employeeId})
                        </button>
                        {' '}— {o.openLeadCount} open lead{o.openLeadCount === 1 ? '' : 's'}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

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
                      <div className="text-sm font-semibold text-slate-800">Level {level.level}</div>
                      <div className="text-xs text-slate-400">{level.level === 1 ? 'CEO — top of the company' : level.level === 2 ? `Reports to Level ${level.level - 1}` : `Reports to Level ${level.level - 1} or ${level.level - 2}`}</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 flex-1">
                    {level.roles.map(role => (
                      <div key={role.roleId} className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5">
                        <span className="text-sm text-slate-700 font-medium">{role.roleName}</span>
                        <span className="text-xs text-slate-400">{role.employeeCount} emp.</span>
                        <select
                          value={ladderAssignments[role.roleId] ?? level.level}
                          onChange={e => setRoleLadderLevel(role.roleId, Number(e.target.value))}
                          className="text-xs border border-slate-200 rounded px-1 py-0.5 bg-white"
                          title="Move this role to another level"
                        >
                          {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
                            <option key={n} value={n}>L{n}</option>
                          ))}
                          <option value={0}>— off</option>
                        </select>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div className="text-sm text-slate-500">No roles placed in the ladder yet. Assign levels to the roles below and save.</div>
            )}

            {/* Unassigned roles */}
            {hierConfig && hierConfig.unassignedRoles.length > 0 && (
              <div className="pt-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">Roles not in the ladder</div>
                <div className="flex flex-wrap gap-2">
                  {hierConfig.unassignedRoles.map(role => (
                    <div key={role.roleId} className="flex items-center gap-2 bg-slate-50 border border-dashed border-slate-300 rounded-lg px-3 py-1.5">
                      <span className="text-sm text-slate-600">{role.roleName}</span>
                      <span className="text-xs text-slate-400">{role.employeeCount} emp.</span>
                      <select
                        value={ladderAssignments[role.roleId] ?? 0}
                        onChange={e => setRoleLadderLevel(role.roleId, Number(e.target.value))}
                        className="text-xs border border-slate-200 rounded px-1 py-0.5 bg-white"
                        title="Place this role into a ladder level"
                      >
                        <option value={0}>— off</option>
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
                    {editingUser ? 'Edit Employee' : 'Add New Employee'}
                  </h2>
                  <p className="text-sm text-slate-500">Fill in the employee details below.</p>
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
                    <label className="text-sm font-medium text-slate-600 mb-1 block">Full Name *</label>
                    <input
                      type="text"
                      required
                      value={userForm.name}
                      onChange={e => setUserForm({ ...userForm, name: e.target.value })}
                      placeholder="e.g. Abdur Rahman"
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] transition-colors"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-slate-600 mb-1 block">Employee ID *</label>
                    <input
                      type="text"
                      required
                      value={userForm.employeeId}
                      onChange={e => setUserForm({ ...userForm, employeeId: e.target.value })}
                      placeholder="e.g. RM001"
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] transition-colors"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-slate-600 mb-1 block">Phone Number</label>
                    <input
                      type="text"
                      value={userForm.contact}
                      onChange={e => setUserForm({ ...userForm, contact: e.target.value })}
                      placeholder="e.g. 01712345678"
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] transition-colors"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-slate-600 mb-1 block">Email Address *</label>
                    <input
                      type="email"
                      required
                      value={userForm.email}
                      onChange={e => setUserForm({ ...userForm, email: e.target.value })}
                      placeholder="e.g. abdur@company.com"
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] transition-colors"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-slate-600 mb-1 block">Designation</label>
                    <input
                      type="text"
                      value={userForm.designation}
                      onChange={e => setUserForm({ ...userForm, designation: e.target.value })}
                      placeholder="e.g. Senior Manager"
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] transition-colors"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-slate-600 mb-1 block">Role</label>
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
                    <label className="text-sm font-medium text-slate-600 mb-1 block">Department</label>
                    <select
                      value={userForm.departmentId}
                      onChange={e => setUserForm({ ...userForm, departmentId: e.target.value })}
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] bg-white"
                    >
                      <option value="">No Department</option>
                      {departments.map(d => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="text-sm font-medium text-slate-600 mb-1 block">
                      Additional Departments <span className="text-xs font-normal text-slate-400">(optional — the person is a team member there too)</span>
                    </label>
                    {departments.filter(d => d.id !== userForm.departmentId).length === 0 ? (
                      <p className="text-xs text-slate-400 px-4 py-2.5 border border-dashed border-slate-200 rounded-lg">
                        No other department available.
                      </p>
                    ) : (
                      <div className="grid sm:grid-cols-2 gap-2 px-4 py-3 border border-slate-200 rounded-lg">
                        {departments
                          .filter(d => d.id !== userForm.departmentId)
                          .map(d => {
                            const checked = userForm.departmentIds.includes(d.id);
                            return (
                              <label key={d.id} className="flex items-center gap-2 text-sm text-slate-700">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => setUserForm({
                                    ...userForm,
                                    departmentIds: checked
                                      ? userForm.departmentIds.filter(id => id !== d.id)
                                      : [...userForm.departmentIds, d.id],
                                  })}
                                  className="w-4 h-4 accent-[#978C21]"
                                />
                                {d.name}
                              </label>
                            );
                          })}
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="text-sm font-medium text-slate-600 mb-1 block">Reporting Manager</label>
                    {(roles.find(r => r.roleId === userForm.role) as any)?.hierarchyLevel === 1 ? (
                      <div className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm text-slate-500 bg-slate-50">
                        Level 1 (CEO) — reports to no one
                      </div>
                    ) : (
                      <select
                        value={userForm.managerId}
                        onChange={e => setUserForm({ ...userForm, managerId: e.target.value })}
                        disabled={loadingManagers}
                        className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] bg-white disabled:bg-slate-50"
                      >
                        <option value="">{loadingManagers ? 'Loading managers…' : 'Select manager (one or two levels up, same department)'}</option>
                        {managerOptions.map(o => (
                          <option key={o.employeeId} value={o.employeeId}>
                            {o.fullName} — {o.employeeId} — {o.roleName}{o.departmentName ? ` — ${o.departmentName}` : ''}
                          </option>
                        ))}
                      </select>
                    )}
                    <p className="text-xs text-slate-400 mt-1">
                      The dropdown lists employees whose role is one or two levels above this role, in the same department (Level 1 crosses departments).
                    </p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-slate-600 mb-1 block">Status</label>
                    <select
                      value={userForm.status}
                      onChange={e => setUserForm({ ...userForm, status: e.target.value as any })}
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] bg-white"
                    >
                      <option value="Active">Active</option>
                      <option value="Inactive">Inactive</option>
                    </select>
                  </div>
                  {/* Phase E: say it BEFORE the save, not as a refusal after it.
                      The count is the server's (roster payload), never guessed. */}
                  {editingUser && (editingUser as any).openLeadCount > 0 && userForm.status === 'Inactive' && (
                    <div className="sm:col-span-2 bg-amber-50 border border-amber-300 rounded-lg p-3">
                      <p className="text-xs font-semibold text-amber-800">
                        {(editingUser as any).openLeadCount} open lead
                        {(editingUser as any).openLeadCount === 1 ? '' : 's'} still belong to {editingUser.name}.
                      </p>
                      <p className="text-[11px] text-amber-700 mt-1">
                        A deactivated account cannot work them, so saving will ask you to pick the colleague who takes
                        them over — the leads move with their history intact.
                      </p>
                    </div>
                  )}
                </div>

                {/* Password section */}
                <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
                  <label className="text-sm font-medium text-slate-700 flex items-center gap-2">
                    <Lock className="w-4 h-4 text-[#978C21]" />
                    {editingUser ? 'Reset Password' : 'Password'}
                  </label>
                  <input
                    type="text"
                    value={userForm.password}
                    onChange={e => setUserForm({ ...userForm, password: e.target.value })}
                    placeholder={editingUser ? "Leave blank to keep current password" : "Leave blank to auto-generate"}
                    className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] bg-white"
                  />
                  <p className="text-xs text-slate-400">
                    {editingUser
                      ? "Enter a new password to reset (administrators only). The employee will be required to change it on next login."
                      : "A temporary password will be auto-generated if left blank. The employee must change it on first login."}
                  </p>
                </div>

                {/* Actions */}
                <div className="flex gap-3 justify-end pt-2">
                  <button
                    type="button"
                    onClick={() => setIsUserModalOpen(false)}
                    className="px-5 py-2.5 border border-slate-200 text-slate-600 hover:bg-slate-50 text-sm font-medium rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-6 py-2.5 bg-[#978C21] hover:bg-[#83781C] text-white text-sm font-medium rounded-lg transition-colors shadow-sm"
                  >
                    {editingUser ? 'Save Changes' : 'Add Employee'}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Lead hand-over modal (Phase E). Opened by the server's refusal, so it
          always shows the REAL count and the real lead rows — the administrator
          decides who takes the book over; nothing is auto-assigned. */}
      <AnimatePresence>
        {handover && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
            onClick={() => (savingHandover ? undefined : setHandover(null))}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-6 space-y-4"
              onClick={e => e.stopPropagation()}
            >
              <div>
                <h3 className="text-lg font-semibold text-slate-800">
                  {handover.kind === 'delete' ? 'Transfer leads before removing' : 'Transfer leads before deactivating'}
                </h3>
                <p className="text-sm text-slate-500 mt-1">
                  <span className="font-medium text-slate-700">{handover.userName}</span> still owns{' '}
                  <span className="font-medium text-slate-700">{handover.leadCount} open lead{handover.leadCount === 1 ? '' : 's'}</span>
                  . Pick the colleague who takes them over.
                </p>
              </div>

              {handover.leads.length > 0 && (
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 max-h-40 overflow-auto">
                  <ul className="space-y-1">
                    {handover.leads.map(l => (
                      <li key={l.leadCode || l.mobile} className="text-xs text-slate-600">
                        <span className="font-medium text-slate-700">{l.customerName || 'Unnamed'}</span>
                        {l.mobile ? ` · ${l.mobile}` : ''}
                        {l.currentStatus ? ` · ${l.currentStatus}` : ''}
                      </li>
                    ))}
                  </ul>
                  {handover.leadCount > handover.leads.length && (
                    <p className="text-[11px] text-slate-400 mt-2">
                      Showing the {handover.leads.length} most recent of {handover.leadCount}.
                    </p>
                  )}
                </div>
              )}

              <div>
                <label className="text-sm font-medium text-slate-600 mb-1 block">New owner</label>
                <select
                  value={handover.targetId}
                  onChange={e => setHandover({ ...handover, targetId: e.target.value })}
                  className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] bg-white"
                >
                  <option value="">Select a colleague…</option>
                  {/* Suggested first (same department, then the person's own
                      manager); every other active employee stays selectable. */}
                  {handover.suggestions.map(s => (
                    <option key={s.userId} value={s.userId}>
                      {s.fullName} — {s.employeeId} — {s.roleCode}{s.isManager ? ' (current manager)' : ''}
                    </option>
                  ))}
                  {users
                    .filter(u => u.status !== 'Inactive'
                      && u.id !== handover.userId
                      && !handover.suggestions.some(s => s.userId === u.id))
                    .map(u => (
                      <option key={u.id} value={u.id}>
                        {u.name} — {u.employeeId}{u.role ? ` — ${u.role}` : ''}
                      </option>
                    ))}
                </select>
                <p className="text-xs text-slate-400 mt-1">
                  Every transferred lead keeps its history: the previous owner, the new owner, who made the change and when.
                </p>
              </div>

              <div className="flex gap-3 justify-end pt-1">
                <button
                  type="button"
                  disabled={savingHandover}
                  onClick={() => setHandover(null)}
                  className="px-5 py-2.5 border border-slate-200 text-slate-600 hover:bg-slate-50 text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={savingHandover || !handover.targetId}
                  onClick={confirmHandover}
                  className="px-5 py-2.5 bg-[#978C21] hover:bg-[#83781C] text-white text-sm font-medium rounded-lg transition-colors shadow-sm disabled:opacity-50"
                >
                  {savingHandover
                    ? 'Transferring…'
                    : `Transfer ${handover.leadCount} lead${handover.leadCount === 1 ? '' : 's'} & ${handover.kind === 'delete' ? 'remove' : 'deactivate'}`}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Department heads modal (Phase C) */}
      <AnimatePresence>
        {headDept && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => setHeadDept(null)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto p-6 space-y-4"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-base font-semibold text-slate-800">Department heads</h3>
                  <p className="text-xs text-slate-400 mt-0.5">{headDept.name}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setHeadDept(null)}
                  className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {headCandidates(headDept).length === 0 ? (
                <p className="text-sm text-slate-500 bg-amber-50 border border-amber-100 rounded-lg p-3">
                  Nobody can head this department yet. Add employees to it first — a head must be an
                  active member of the department.
                </p>
              ) : (
                <>
                  <div>
                    <label className="text-sm font-medium text-slate-600 mb-1 block">Primary head</label>
                    <select
                      value={headForm.primaryUserId}
                      onChange={e => setHeadForm(prev => ({ ...prev, primaryUserId: e.target.value }))}
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-[#978C21] bg-white"
                    >
                      <option value="">No head (department left headless)</option>
                      {headCandidates(headDept).map(u => (
                        <option key={u.id} value={u.id}>
                          {u.name || u.fullName} — {u.employeeId}{(u as any).designation ? ` — ${(u as any).designation}` : ''}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-slate-400 mt-1">
                      The primary head leads the department&apos;s team — its roster is exactly this department&apos;s members.
                    </p>
                  </div>

                  <div>
                    <label className="text-sm font-medium text-slate-600 mb-1 block">
                      Co-heads (optional)
                    </label>
                    <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-56 overflow-y-auto">
                      {headCandidates(headDept)
                        .filter(u => u.id !== headForm.primaryUserId)
                        .map(u => (
                          <label
                            key={u.id}
                            className="flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={headForm.coHeadUserIds.includes(u.id)}
                              onChange={() => toggleCoHead(u.id)}
                              className="w-4 h-4 accent-[#978C21]"
                            />
                            <span className="truncate">{u.name || u.fullName}</span>
                            <span className="text-xs text-slate-400 ml-auto shrink-0">{u.employeeId}</span>
                          </label>
                        ))}
                    </div>
                    <p className="text-xs text-slate-400 mt-1">
                      Co-heads share the department&apos;s work but do not lead the team.
                    </p>
                  </div>
                </>
              )}

              <div className="flex gap-3 justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setHeadDept(null)}
                  className="px-5 py-2.5 border border-slate-200 text-slate-600 hover:bg-slate-50 text-sm font-medium rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveHeads}
                  disabled={savingHeads || headCandidates(headDept).length === 0}
                  className="px-6 py-2.5 bg-[#978C21] hover:bg-[#83781C] disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors shadow-sm"
                >
                  {savingHeads ? 'Saving…' : 'Save heads'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Effective Access — the whole access review for one person, including
          the layer that decided each permission. */}
      {accessReviewUser && (
        <EnterpriseAccessPanel
          userId={accessReviewUser.id}
          userName={accessReviewUser.name}
          onClose={() => setAccessReviewUser(null)}
        />
      )}

      {/* Bulk Import Modal */}
      <UserBulkImportModal
        open={showBulkImport}
        onClose={() => setShowBulkImport(false)}
        onCompleted={() => {
          void loadData();
        }}
      />
    </div>
  );
}
