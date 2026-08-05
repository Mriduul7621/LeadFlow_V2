import React, { useEffect, useState } from 'react';
import { 
  Users, 
  UserPlus, 
  Mail, 
  Shield, 
  MoreVertical,
  CheckCircle2,
  XCircle,
  ChevronRight,
  ShieldCheck,
  Zap,
  Trash2,
  Edit2,
  X,
  Plus,
  Search,
  Building,
  ArrowRightCircle,
  FolderOpen,
  Sliders,
  Phone,
  Briefcase,
  AlertCircle,
  Layers,
  Lock,
  Save,
  ChevronDown,
  Check,
  ArrowLeft
} from 'lucide-react';
import { cn } from '../lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { userService } from '../services/userService';
import { adminService, ensureFeaturePermissions } from '../services/adminService';
import { orgService, Department, Hierarchy, HierarchyLayer } from '../services/orgService';
import { useAuthStore } from '../store/authStore';
import { RolePermission, User } from '../types';

interface FeatureMeta {
  key: string;
  label: string;
  desc: string;
  suboptions?: { key: string; label: string; desc: string }[];
}

const APP_FEATURES_METADATA: FeatureMeta[] = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    desc: 'Access home analytics counters, KPIs and pipeline visual stats.',
    suboptions: [
      { key: 'view_calls_stats', label: 'View Contact & Meet Counts', desc: 'Shows connected calls, completed meetings & follow-ups set.' },
      { key: 'view_pipeline_ncp', label: 'View Pipeline & NCP Figures', desc: 'Shows total pipeline currency volumes & target metrics.' },
      { key: 'view_division_table', label: 'View Regional Division stats', desc: 'Displays Division-wise performance stats table.' },
      { key: 'view_ncp_chart', label: 'View Financial Extraction Area Chart', desc: 'Renders Collected vs Projected weekly trajectory.' },
      { key: 'view_trend_chart', label: 'View Daily Campaign Trend Chart', desc: 'Renders campaign generation volume trends.' },
      { key: 'view_campaign_pie', label: 'View Campaign Volume breakdown', desc: 'Shows campaign performance pie chart and listing.' },
      { key: 'view_critical_alerts', label: 'View Critical Alerts Panel', desc: 'Displays alarms & pending alert metrics.' },
      { key: 'view_agent_table', label: 'View Executive Rankings', desc: 'Renders agent ranking tables & individual details.' },
      { key: 'view_task_calendar', label: 'View Task Calendar on Dashboard', desc: 'Renders the Task Calendar view at the bottom of the main dashboard.' }
    ]
  },
  {
    key: 'lead_generate',
    label: 'Lead Generation',
    desc: 'Register novel prospects & build direct draft profiles.',
    suboptions: [
      { key: 'create', label: 'Lead Create Button', desc: 'Permits executing and saving new manual lead generations.' }
    ]
  },
  {
    key: 'lead_upload',
    label: 'Bulk Batch Upload (Lead Upload)',
    desc: 'Process & save xlsx bulk lead registrations.',
    suboptions: [
      { key: 'upload', label: 'Process Excel Upload', desc: 'Grants access to upload, format & save spreadsheets.' },
      { key: 'delete', label: 'Campaign Wise Lead Purge', desc: 'Grants permission to wipe entire campaign datasets.' }
    ]
  },
  {
    key: 'lead_tracking',
    label: 'Lead Tracking & Pipeline',
    desc: 'Analyze target lists, followup pipelines & view files.',
    suboptions: [
      { key: 'status_update', label: 'Modify Tracking Statuses', desc: 'Unlocks transitioning statuses and saving remarks.' },
      { key: 'view_all_leads_tab', label: 'Access All Leads Tab', desc: 'Permits viewing the All Leads tab in sidebar/navigation menu.' }
    ]
  },
  {
    key: 'execution_intelligence',
    label: 'Execution Intelligence',
    desc: 'Analyze business execution dashboard indexes.'
  },
  {
    key: 'ncp_progress',
    label: 'NCP Progress',
    desc: 'Verify ncp collections and pending objectives tracking.'
  },
  {
    key: 'trend_charts',
    label: 'Trend Charts',
    desc: 'Evaluate weekly and monthly performance progressions.'
  },
  {
    key: 'campaign_breakdown',
    label: 'Campaign Breakdown',
    desc: 'Monitor visual campaign allocations & productivity factors.'
  },
  {
    key: 'follow_up_strategy',
    label: 'Follow Up Strategy',
    desc: 'Review follow-up cadences and next call set lists.'
  },
  {
    key: 'task_calendar',
    label: 'Task Calendar',
    desc: 'Interactive monthly task calendar supporting Year, Month, Week and Day views.'
  },
  {
    key: 'team_progress',
    label: 'Team Progress',
    desc: 'Establish and monitor divisions, branches & agents teams.'
  },
  {
    key: 'user_management',
    label: 'User Accounts & Clearance (User Management)',
    desc: 'Control permissions, department listings & user onboarding.',
    suboptions: [
      { key: 'dept_view', label: 'Departments: View', desc: 'Can view department groups.' },
      { key: 'dept_create', label: 'Departments: Create', desc: 'Can add departments.' },
      { key: 'dept_edit', label: 'Departments: Edit', desc: 'Can modify departments.' },
      { key: 'dept_delete', label: 'Departments: Delete', desc: 'Can remove departments.' },
      { key: 'role_view', label: 'Clearance Controls: View', desc: 'Can inspect role clearance boundaries.' },
      { key: 'role_create', label: 'Clearance Controls: Create', desc: 'Can create roles.' },
      { key: 'role_edit', label: 'Clearance Controls: Edit', desc: 'Can modify roles.' },
      { key: 'role_delete', label: 'Clearance Controls: Delete', desc: 'Can purge custom roles.' },
      { key: 'user_view', label: 'Employee Onboarding: View', desc: 'Can view employee logs.' },
      { key: 'user_create', label: 'Employee Onboarding: Create', desc: 'Can onboard employees & assign credentials.' },
      { key: 'user_edit', label: 'Employee Onboarding: Edit', desc: 'Can edit employee roles, departments, statuses.' },
      { key: 'user_delete', label: 'Employee Onboarding: Delete', desc: 'Can delete employee accounts.' },
      { key: 'hier_view', label: 'Reporting Structures: View', desc: 'Can view reporting hierarchy mappings.' },
      { key: 'hier_create', label: 'Reporting Structures: Create', desc: 'Can add layers to the team hierarchy.' },
      { key: 'hier_edit', label: 'Reporting Structures: Edit', desc: 'Can modify hierarchies.' },
      { key: 'hier_delete', label: 'Reporting Structures: Delete', desc: 'Can delete hierarchies.' }
    ]
  },
  {
    key: 'settings_control',
    label: 'Settings Configuration & Options (Network Settings)',
    desc: 'Control access to dynamic configurations, passwords, and manual sync inside Settings.',
    suboptions: [
      { key: 'view_profile', label: 'Identity Settings: View/Edit', desc: 'Allow user to edit display name & custom avatar.' },
      { key: 'view_security', label: 'Security & Passwords: View/Edit', desc: 'Allow user to modify account authorization passwords.' },
      { key: 'view_notifications', label: 'Push Intelligence: View/Edit', desc: 'Allow user to review push alerts and notification triggers.' },
      { key: 'view_system', label: 'System Configuration: View/Edit', desc: 'Allow user to change layout animations and visual period settings.' },
      { key: 'view_sync', label: 'Network & Sync: View/Edit', desc: 'Allow user to run manual cloud syncing and review database mode.' },
      { key: 'configure_parameters', label: 'Strategy Parameters: View/Edit', desc: 'Allow user to add/delete area, source, product, campaign parameters.' }
    ]
  }
];

export default function UserManagement() {
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<User[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [roles, setRoles] = useState<RolePermission[]>([]);
  const [hierarchies, setHierarchies] = useState<Hierarchy[]>([]);

  // Wizard tab layout state (Step 1 to Step 4)
  const [activeStep, setActiveStep] = useState<1 | 2 | 3 | 4>(3);

  // Search queries
  const [userQuery, setUserQuery] = useState('');
  const [selectedDeptId, setSelectedDeptId] = useState<string>('');

  // ----------------------------------------------------
  // STEP 1 STATE: DEPARTMENTS
  // ----------------------------------------------------
  const [deptFormName, setDeptFormName] = useState('');
  const [editingDeptId, setEditingDeptId] = useState<string | null>(null);

  // ----------------------------------------------------
  // STEP 2 STATE: CUSTOM ROLE MATRIX
  // ----------------------------------------------------
  const [selectedRole, setSelectedRole] = useState<RolePermission | null>(null);
  const [isEditingRoleSlug, setIsEditingRoleSlug] = useState(false);
  const [roleFormName, setRoleFormName] = useState('');
  const [roleFormSlug, setRoleFormSlug] = useState('');
  const [roleFormVisibility, setRoleFormVisibility] = useState<'Own' | 'DownTeam' | 'FullTeam' | 'Organization'>('Own');
  const [roleFormActions, setRoleFormActions] = useState({
    view: true,
    create: true,
    edit: true,
    delete: false,
    upload: false
  });
  const [roleFormFeatures, setRoleFormFeatures] = useState<Record<string, Record<string, boolean>>>({});
  const [showRoleForm, setShowRoleForm] = useState(false);

  // ----------------------------------------------------
  // STEP 3 STATE: USER REGISTER RENDER
  // ----------------------------------------------------
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
    password: '',
    status: 'Active' as 'Active' | 'Inactive'
  });

  // ----------------------------------------------------
  // STEP 4 STATE: HIERARCHY ENGINE
  // ----------------------------------------------------
  const [activeHierDeptId, setActiveHierDeptId] = useState<string>('');
  const [hierLayers, setHierLayers] = useState<HierarchyLayer[]>([]);

  const { user: currentUser } = useAuthStore();

  useEffect(() => {
    loadAllOperationalData();
  }, []);

  const loadAllOperationalData = async () => {
    setLoading(true);
    try {
      const roster = await userService.getAllUsers();
      setUsers(roster);

      const depts = await orgService.getDepartments();
      setDepartments(depts);
      if (depts.length > 0 && !activeHierDeptId) {
        setActiveHierDeptId(depts[0].id);
      }

      const accessRoles = await adminService.getRoles();
      setRoles(accessRoles);

      const hiers = await orgService.getHierarchies();
      setHierarchies(hiers);
    } catch (err) {
      toast.error('Uplink failed to download operations mapping.');
    } finally {
      setLoading(false);
    }
  };

  // ----------------------------------------------------
  // STEP 1 ACTIONS: DEPARTMENTS
  // ----------------------------------------------------
  const handleSaveDepartment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deptFormName.trim()) {
      toast.error('Department name cannot be blank.');
      return;
    }

    try {
      const id = editingDeptId || `dept_${Date.now()}`;
      const payload: Department = {
        id,
        name: deptFormName.trim(),
        createdDate: new Date().toISOString()
      };

      await orgService.saveDepartment(payload);
      toast.success(editingDeptId ? 'Department updated successfully.' : 'Department launched successfully.');
      setDeptFormName('');
      setEditingDeptId(null);
      await loadAllOperationalData();
    } catch (e) {
      toast.error('Could not commit department changes.');
    }
  };

  const handleDeleteDept = async (id: string) => {
    if (confirm('Are you absolutely sure you want to delete this department? This will orphan users inside it.')) {
      try {
        await orgService.deleteDepartment(id);
        toast.success('Department deleted successfully.');
        await loadAllOperationalData();
      } catch (e) {
        toast.error('Failed to purge department documentation.');
      }
    }
  };

  // ----------------------------------------------------
  // STEP 2 ACTIONS: ROLE PERMISSION MATRIX
  // ----------------------------------------------------
  const applyRoleToForm = async (role: RolePermission) => {
    setSelectedRole(role);
    setIsEditingRoleSlug(false);
    setRoleFormName(role.roleName);
    setRoleFormSlug(role.roleId);
    setRoleFormVisibility(role.dataVisibility as any || 'Own');
    setRoleFormActions({
      view: role.actions?.view ?? true,
      create: role.actions?.create ?? false,
      edit: role.actions?.edit ?? false,
      delete: role.actions?.delete ?? false,
      upload: role.actions?.upload ?? false
    });
    setRoleFormFeatures(role.featurePermissions || {});
  };

  const handleCreateNewRoleEmpty = () => {
    setSelectedRole(null);
    setIsEditingRoleSlug(true);
    setRoleFormName('');
    setRoleFormSlug('');
    setRoleFormVisibility('Own');
    setRoleFormActions({
      view: true,
      create: false,
      edit: false,
      delete: false,
      upload: false
    });
    
    // Auto populate blank features schema from standard mappings
    const defaultSec: Record<string, Record<string, boolean>> = {
      dashboard: { 
        view: false, 
        view_calls_stats: false, 
        view_pipeline_ncp: false, 
        view_division_table: false, 
        view_ncp_chart: false, 
        view_trend_chart: false, 
        view_campaign_pie: false, 
        view_critical_alerts: false, 
        view_agent_table: false,
        view_task_calendar: false
      },
      lead_generate: { view: false, create: false },
      lead_upload: { view: false, upload: false, delete: false },
      lead_tracking: { view: false, status_update: false },
      execution_intelligence: { view: false },
      ncp_progress: { view: false },
      trend_charts: { view: false },
      campaign_breakdown: { view: false },
      follow_up_strategy: { view: false },
      team_progress: { view: false },
      user_management: {
        view: false,
        dept_view: false, dept_create: false, dept_edit: false, dept_delete: false,
        role_view: false, role_create: false, role_edit: false, role_delete: false,
        user_view: false, user_create: false, user_edit: false, user_delete: false,
        hier_view: false, hier_create: false, hier_edit: false, hier_delete: false
      },
      settings_control: {
        view: false,
        view_profile: false,
        view_security: false,
        view_notifications: false,
        view_system: false,
        view_sync: false,
        configure_parameters: false
      }
    };
    setRoleFormFeatures(defaultSec);
  };

  const handleSaveRoleMatrix = async () => {
    if (!roleFormName.trim()) {
      toast.error('Role listing name required.');
      return;
    }
    const cleanSlug = roleFormSlug.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!cleanSlug) {
      toast.error('Valid lowercase Role Slug is required.');
      return;
    }

    try {
      const payload: RolePermission = {
        roleId: cleanSlug,
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
          '/team': roleFormFeatures?.team_progress?.view ?? false,
          '/users': roleFormFeatures?.user_management?.view ?? (cleanSlug === 'admin' || cleanSlug === 'superadmin'),
          '/settings': roleFormFeatures?.settings_control?.view ?? (cleanSlug === 'admin' || cleanSlug === 'superadmin')
        },
        dataVisibility: roleFormVisibility,
        actions: {
          view: roleFormFeatures?.lead_tracking?.view ?? true,
          create: roleFormFeatures?.lead_generate?.create ?? false,
          edit: roleFormFeatures?.lead_tracking?.status_update ?? false,
          delete: roleFormFeatures?.lead_upload?.delete ?? false,
          approve: roleFormFeatures?.lead_tracking?.status_update ?? false,
          upload: roleFormFeatures?.lead_upload?.upload ?? false
        },
        featurePermissions: roleFormFeatures
      };

      await adminService.saveRole(payload);

      toast.success('Access configuration matrix updated successfully.');
      await loadAllOperationalData();
      setShowRoleForm(false);
    } catch (err) {
      toast.error('Matrix saving encountered PostgreSQL restrictions.');
    }
  };

  const handleDeleteRole = async (slug: string) => {
    if (slug === 'admin' || slug === 'ADMIN') {
      toast.error('The default administration access layer cannot be soft-purged.');
      return false;
    }
    if (confirm(`Do you wish to delete the custom role: ${slug}?`)) {
      try {
        await adminService.deleteRole(slug);
        toast.success('Custom security configuration purged.');
        setSelectedRole(null);
        await loadAllOperationalData();
        return true;
      } catch (e) {
        toast.error('Purge routine failed.');
        return false;
      }
    }
    return false;
  };

  // ----------------------------------------------------
  // STEP 3 ACTIONS: USER REGISTER WORKBOX
  // ----------------------------------------------------
  const openCreateUserModal = () => {
    setEditingUser(null);
    setUserForm({
      name: '',
      employeeId: '',
      contact: '',
      email: '',
      designation: '',
      role: roles.length > 0 ? roles[0].roleId : 'ADMIN',
      departmentId: departments.length > 0 ? departments[0].id : '',
      password: '',
      status: 'Active'
    });
    setIsUserModalOpen(true);
  };

  const openEditUserModal = (u: User) => {
    setEditingUser(u);
    setUserForm({
      name: u.name || '',
      employeeId: u.employeeId || '',
      contact: (u as any).contact || '',
      email: u.email || '',
      designation: u.designation || '',
      role: u.role || (roles.length > 0 ? roles[0].roleId : 'ADMIN'),
      departmentId: (u as any).departmentId || '',
      password: '', // Hidden/Protected unless intentionally overwritten
      status: u.status || 'Active'
    });
    setIsUserModalOpen(true);
  };

  const handleSaveUserFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userForm.name.trim() || !userForm.employeeId.trim() || !userForm.email.trim()) {
      toast.error('Please complete Name, Employee ID and Email address.');
      return;
    }

    const cleanEmpId = userForm.employeeId.trim().toUpperCase();

    // Verify duplicate Employee ID check
    const isDuplicate = users.some(u => 
      u.employeeId.trim().toUpperCase() === cleanEmpId && 
      (!editingUser || u.id !== editingUser.id)
    );

    if (isDuplicate) {
      toast.error(`Constraint failure: Employee ID "${cleanEmpId}" already exists!`);
      return;
    }

    try {
      const generatedUid = editingUser ? editingUser.id : `u_ops_${Date.now()}`;
      // New users without an explicit password get a random temporary
      // password (shown once to the admin below) instead of a fixed,
      // guessable default. They are always required to change it on
      // first login (mustChangePassword below).
      const generateTempPassword = () => {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
        let out = '';
        for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
        return out;
      };

      const payload: User = {
        id: generatedUid,
        name: userForm.name.trim(),
        employeeId: cleanEmpId,
        email: userForm.email.trim().toLowerCase(),
        contact: userForm.contact.trim() as any,
        designation: userForm.designation.trim() || 'Officer',
        role: userForm.role,
        departmentId: userForm.departmentId as any,
        status: userForm.status,
        createdDate: editingUser ? editingUser.createdDate : new Date().toISOString(),
        // Save provided password; if editing and left blank, the server
        // preserves the existing hash. For a brand-new user with no
        // password entered, generate a random temporary one.
        password: userForm.password ? userForm.password : (editingUser ? undefined : generateTempPassword()),
        // Set mustChangePassword true for new users or if password is explicitly edited
        mustChangePassword: editingUser 
          ? (userForm.password ? true : (editingUser.mustChangePassword ?? false))
          : true,
        reportingChain: editingUser ? (editingUser.reportingChain || []) : [],
        subordinates: editingUser ? (editingUser.subordinates || []) : []
      };

      if (editingUser) {
        await userService.updateUser(generatedUid, payload as any);
        toast.success(`Employee profile for ${payload.name} updated.`);
      } else {
        await userService.createUser(payload);
        toast.success(`Success: ${payload.name} registered with Temporary Password: "${payload.password}".`);
      }

      setIsUserModalOpen(false);
      await loadAllOperationalData();
    } catch (err) {
      toast.error('Uplink failed: Check PostgreSQL database connection configuration.');
    }
  };

  const handleDeleteUser = async (id: string, name: string) => {
    if (confirm(`Are you sure you want to delete ${name}'s system credentials?`)) {
      try {
        await userService.deleteUser(id);
        toast.success('Roster profile removed securely.');
        await loadAllOperationalData();
      } catch (e) {
        toast.error('Delete process returned error.');
      }
    }
  };

  // ----------------------------------------------------
  // STEP 4 ACTIONS: HIERARCHY ENGINE
  // ----------------------------------------------------
  useEffect(() => {
    if (activeHierDeptId) {
      const matched = hierarchies.find(h => h.departmentId === activeHierDeptId);
      if (matched && matched.layers && matched.layers.length > 0) {
        // Upgrade legacy flat array to tree if needed
        const hasTreeFields = matched.layers.every(l => l.id !== undefined);
        if (hasTreeFields) {
          setHierLayers(matched.layers);
        } else {
          const migrated: HierarchyLayer[] = matched.layers.map((l, index) => {
            const id = l.id || `node_legacy_${index}`;
            const parentId = index === 0 ? null : (matched.layers[index - 1].id || `node_legacy_${index - 1}`);
            return {
              ...l,
              id,
              parentId
            };
          });
          setHierLayers(migrated);
        }
      } else {
        const defaultRole = roles.length > 0 ? roles[0].roleId : 'ADMIN';
        setHierLayers([
          {
            id: 'root',
            parentId: null,
            roleId: defaultRole,
            employeeIds: []
          }
        ]);
      }
    }
  }, [activeHierDeptId, hierarchies, roles]);

  const handleToggleEmployeeInTreeLayer = (nodeId: string, empId: string) => {
    setHierLayers(prev => prev.map(l => {
      if (l.id === nodeId) {
        const currentList = l.employeeIds || [];
        const updatedList = currentList.includes(empId)
          ? currentList.filter(id => id !== empId)
          : [...currentList, empId];
        return { ...l, employeeIds: updatedList };
      }
      return l;
    }));
  };

  const handleRootRoleChange = (roleId: string) => {
    setHierLayers(prev => {
      const rootNode = prev.find(l => l.parentId === null || l.id === 'root');
      if (rootNode) {
        return prev.map(l => {
          if (l.id === rootNode.id) {
            return { ...l, roleId, employeeIds: [] };
          }
          return l;
        });
      }
      return prev;
    });
  };

  const handleToggleChildRoleInNode = (parentNodeId: string, roleId: string) => {
    setHierLayers(prev => {
      const existingChild = prev.find(l => l.parentId === parentNodeId && l.roleId === roleId);
      if (existingChild) {
        const getDescendantIds = (parentId: string): string[] => {
          const children = prev.filter(l => l.parentId === parentId);
          const childIds = children.map(c => c.id!);
          const grandChildIds = childIds.flatMap(id => getDescendantIds(id));
          return [...childIds, ...grandChildIds];
        };
        const toDeleteIds = [existingChild.id!, ...getDescendantIds(existingChild.id!)];
        return prev.filter(l => !toDeleteIds.includes(l.id!));
      } else {
        const newNodeId = `node_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        const newNode: HierarchyLayer = {
          id: newNodeId,
          parentId: parentNodeId,
          roleId: roleId,
          employeeIds: []
        };
        return [...prev, newNode];
      }
    });
  };

  const handleSaveDepartmentHierarchyEngine = async () => {
    if (!activeHierDeptId) {
      toast.error('Please select an active department first.');
      return;
    }

    try {
      const hierarchyDocId = `${activeHierDeptId}_hierarchy`;
      const payload: Hierarchy = {
        id: hierarchyDocId,
        departmentId: activeHierDeptId,
        layers: hierLayers,
        updatedAt: new Date().toISOString()
      };

      // 1. Commit the master building-block tree array
      await orgService.saveHierarchy(payload);

      // ----------------------------------------------------
      // RECURSIVE MATERIALIZED TRAVERSAL: CALCULATING CLIENT-SIDE REPORTING AND SUBORDINATES
      // ----------------------------------------------------
      toast.info('Generating dynamic Materialized reporting chains...', { duration: 4000 });

      // Gather all users to ensure their reporting chains are updated based on the active tree structure
      const deptUsers = users;

      for (const u of deptUsers) {
        const empId = u.employeeId;

        // Find which node(s) this employee belongs to
        const myNode = hierLayers.find(l => l.employeeIds.includes(empId));

        if (!myNode) {
          // Reset hierarchy links since they are not assigned to active layers
          await userService.updateUser(u.id, {
            reportingChain: [],
            subordinates: []
          });
          continue;
        }

        // 1. Supervisors reportingChain = Everyone in layers above us
        const getTransitiveAncestors = (nodeId: string, layers: HierarchyLayer[]): HierarchyLayer[] => {
          const node = layers.find(l => l.id === nodeId);
          if (!node || !node.parentId) return [];
          const parent = layers.find(l => l.id === node.parentId);
          if (!parent) return [];
          return [parent, ...getTransitiveAncestors(parent.id!, layers)];
        };

        const ancestorsNodes = getTransitiveAncestors(myNode.id!, hierLayers);
        const reportingChain: string[] = ancestorsNodes.flatMap(node => node.employeeIds);

        // 2. Subordinates = Everyone in layers under us
        const getTransitiveDescendants = (nodeId: string, layers: HierarchyLayer[]): HierarchyLayer[] => {
          const directChildren = layers.filter(l => l.parentId === nodeId);
          const results: HierarchyLayer[] = [...directChildren];
          directChildren.forEach(child => {
            results.push(...getTransitiveDescendants(child.id!, layers));
          });
          return results;
        };

        const descendantNodes = getTransitiveDescendants(myNode.id!, hierLayers);
        const subordinates: string[] = descendantNodes.flatMap(node => node.employeeIds);

        // 3. Update the user document to cache values for fast NoSQL queries
        await userService.updateUser(u.id, {
          reportingChain,
          subordinates
        });
      }

      toast.success('Organizational chains generated and propagated successfully!');
      await loadAllOperationalData();
    } catch (e) {
      toast.error('Dynamic tree traversal failed to write schemas.');
    }
  };

  // Recursive renderer for building dynamic Hierarchy Trees
  const renderTreeNode = (node: HierarchyLayer, depth: number = 0) => {
    if (!node) return null;

    // Find children of this node
    const children = hierLayers.filter(l => l.parentId === node.id);

    // Find matched employees with this node's role
    const matchedEmployees = users.filter(u =>
      u.role === node.roleId
    );

    // Gather ancestors of this node to prevent redundant role assignment
    const getAncestors = (nodeId: string, layers: HierarchyLayer[]): string[] => {
      const n = layers.find(l => l.id === nodeId);
      if (!n || !n.parentId) return [];
      const parent = layers.find(l => l.id === n.parentId);
      if (!parent) return [];
      return [parent.roleId, ...getAncestors(parent.id!, layers)];
    };

    const ancestorRoleIds = getAncestors(node.id!, hierLayers);
    // Self is also not allowed to review down the chain
    const prohibitedRoleIds = [...ancestorRoleIds, node.roleId];

    // Candidate roles: any role from the active list that is not already selected above (any ancestor role + self)
    const availableChildRoles = roles.filter(r => !prohibitedRoleIds.includes(r.roleId));

    return (
      <div key={node.id} className="relative mt-5 last:mb-2 pl-6 animate-in fade-in duration-200">
        {/* Connection flow lines */}
        {depth > 0 && (
          <div className="absolute left-0 top-0 bottom-0 border-l border-dashed border-slate-300 w-6 h-10 border-b rounded-bl-md pointer-events-none" />
        )}

        <div className={cn(
          "bg-white border p-6 space-y-5 transition-all relative rounded-md shadow-sm hover:shadow-md",
          depth === 0 ? "border-l-4 border-l-[#978C21] border-slate-200" : "border-l-4 border-l-slate-400 border-slate-200"
        )}>
          {/* Node Meta bar */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-100 pb-3.5">
            <div className="flex items-center gap-3">
              <div className="h-7 w-7 rounded-full bg-slate-900 text-[10px] text-white flex items-center justify-center font-bold font-sans">
                {depth + 1}
              </div>
              <div>
                <span className="text-[11px] font-bold text-[#978C21] block">
                  {depth === 0 ? '🏆 প্রধান অ্যাডমিন / লিডার নোড (Top Leader Node)' : `ধাপ ${depth + 1} রিপোর্টিং নোড (Level ${depth + 1} Reporting Node)`}
                </span>
                <span className="text-[9px] text-slate-400 block mt-0.5 font-sans font-medium">
                  Node ID: {node.id?.toUpperCase()}
                </span>
              </div>
            </div>

            {/* Target Node Role Selector */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500 font-medium">নির্ধারিত পদবি (Assigned Role):</span>
              {depth === 0 ? (
                <select
                  value={node.roleId}
                  onChange={(e) => handleRootRoleChange(e.target.value)}
                  className="px-3 py-1.5 bg-slate-50 border border-slate-200 focus:border-[#978C21] focus:bg-white outline-none text-[11px] font-bold text-slate-700 cursor-pointer rounded-sm"
                >
                  {roles.map(r => (
                    <option key={r.roleId} value={r.roleId}>{r.roleName}</option>
                  ))}
                </select>
              ) : (
                <span className="px-3 py-1 bg-amber-50 text-[#978C21] border border-amber-200 text-[11px] font-bold rounded-sm uppercase">
                  {roles.find(r => r.roleId === node.roleId)?.roleName || node.roleId.toUpperCase()}
                </span>
              )}
            </div>
          </div>

          {/* User MultiSelector */}
          <div className="space-y-2 pt-1">
            <label className="text-[11px] font-bold text-slate-600 flex items-center justify-between">
              <span>কর্মচারী নির্বাচন করুন (Assigned Employees - {matchedEmployees.length} registered under this role):</span>
              <span className="text-[9px] text-slate-400 font-normal">ক্লিক করে রিপোর্ট সক্রিয় বা নিষ্ক্রিয় করুন</span>
            </label>

            {matchedEmployees.length === 0 ? (
              <p className="text-[11px] text-slate-500 leading-relaxed bg-amber-50/50 border border-dashed border-amber-200 p-3.5 rounded-sm">
                ⚠️ "{node.roleId.toUpperCase()}" পদবির কোনো কর্মচারী এখনো যুক্ত করা হয়নি। অনুগ্রহ করে ৩ নম্বর ধাপে কর্মচারী যোগ করুন। (No employees assigned to this role).
              </p>
            ) : (
              <div className="flex flex-wrap gap-2 p-3.5 border border-slate-100 bg-[#FBFAF8] rounded-sm max-h-36 overflow-y-auto">
                {matchedEmployees.map((emp) => {
                  const active = (node.employeeIds || []).includes(emp.employeeId);
                  return (
                    <button
                      key={emp.employeeId}
                      type="button"
                      onClick={() => handleToggleEmployeeInTreeLayer(node.id!, emp.employeeId)}
                      className={cn(
                        "px-3 py-2 text-[10px] font-medium flex items-center gap-1.5 cursor-pointer transition-all border rounded-sm",
                        active
                          ? "bg-[#978C21] border-[#978C21] text-white shadow-sm"
                          : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                      )}
                    >
                      {emp.name} ({emp.employeeId})
                      {active && <Check className="w-3 h-3 stroke-[3]" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Child Toggles matrix (Bengali requirement 1 & 2) */}
          <div className="border-t border-slate-100 pt-4 space-y-2">
            <span className="text-[11px] font-bold text-slate-600 block leading-none">
              অধীনস্থ পদবি নির্বাচন করুন (Configure reporting sub-roles under {roles.find(r => r.roleId === node.roleId)?.roleName || node.roleId.toUpperCase()}):
            </span>

            {availableChildRoles.length > 0 ? (
              <div className="flex flex-wrap gap-2 bg-slate-50/50 p-3 border border-slate-200/60 rounded-sm">
                {availableChildRoles.map(r => {
                  const isReporting = children.some(c => c.roleId === r.roleId);
                  return (
                    <button
                      key={r.roleId}
                      type="button"
                      onClick={() => handleToggleChildRoleInNode(node.id!, r.roleId)}
                      className={cn(
                        "px-3 py-2 text-[10px] font-bold transition-all cursor-pointer flex items-center gap-1.5 border rounded-sm",
                        isReporting
                          ? "bg-[#978C21] border-[#978C21] text-white shadow-sm"
                          : "bg-white border-slate-200 text-slate-600 hover:border-[#978C21] hover:text-[#978C21]"
                      )}
                    >
                      <span>{r.roleName}</span>
                      {isReporting ? (
                        <Check className="w-3 h-3 stroke-[3]" />
                      ) : (
                        <Plus className="w-3 h-3 text-slate-400" />
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-[10px] text-slate-400 italic bg-slate-50/30 p-2 border border-dashed border-slate-200 rounded-sm">
                আর কোনো অধীনস্থ পদবি উপলব্ধ নেই (No further child roles available).
              </p>
            )}
          </div>
        </div>

        {/* Render nested kids */}
        {children.length > 0 && (
          <div className="pl-6 border-l border-dashed border-slate-300 space-y-3.5 mt-3.5">
            {children.map(child => renderTreeNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  // Filtered users roster
  const filteredUsers = users.filter(u => {
    const text = (u.name + ' ' + u.employeeId + ' ' + (u.designation || '')).toLowerCase();
    const queryMatch = text.includes(userQuery.toLowerCase());
    const deptMatch = !selectedDeptId || (u as any).departmentId === selectedDeptId;
    return queryMatch && deptMatch;
  });

  return (
    <div className="space-y-10 max-w-7xl mx-auto pb-16">
      {/* Visual Workspace Sub-Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
        <div className="space-y-1.5">
          <p className="text-[10px] font-black tracking-widest text-[#978C21] uppercase italic leading-none">Global Control Terminal</p>
          <h1 className="text-3xl font-black uppercase tracking-tight text-slate-900 leading-none">Security & Operations Manager</h1>
          <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider">
            Enterprise Governance Portal: Configure departments, adjust access matrix, map corporate reporting flow.
          </p>
        </div>

        {/* Step Wizard controls */}
        <div className="flex items-center gap-1 border border-slate-200/60 p-1.5 rounded-sm bg-[#FBFAF8] shadow-sm">
          {[1, 2, 3, 4].map((step) => {
            const label = step === 1 ? '1. Depts' : step === 2 ? '2. Roles' : step === 3 ? '3. Roster' : '4. Hierarchy';
            return (
              <button
                key={step}
                onClick={() => setActiveStep(step as any)}
                className={cn(
                  "px-4 py-2 text-[9px] font-black uppercase tracking-wider italic cursor-pointer transition-all",
                  activeStep === step 
                    ? "bg-[#978C21] text-white shadow-md shadow-[#978C21]/15" 
                    : "text-slate-400 hover:text-slate-800 hover:bg-slate-100"
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {loading ? (
        <div className="h-64 flex flex-col items-center justify-center gap-4">
          <div className="w-8 h-8 border-2 border-t-[#978C21] border-slate-200 rounded-full animate-spin" />
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest italic animate-pulse">Retrieving organization documents...</p>
        </div>
      ) : (
        <div className="min-h-[400px]">
          {/* ----------------------------------------------------
              STEP 1: DEPARTMENTS SETUP PANEL
              ---------------------------------------------------- */}
          {activeStep === 1 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
              <div className="lg:col-span-4 bg-[#FBFAF8] border border-slate-200 p-6 rounded-sm space-y-6">
                <div className="space-y-1">
                  <h4 className="text-xs font-black uppercase tracking-widest text-[#978C21]">
                    {editingDeptId ? 'Modify Department Name' : 'Establish Department Profile'}
                  </h4>
                  <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                    Insert organizational departments downstream structure.
                  </p>
                </div>

                <form onSubmit={handleSaveDepartment} className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest italic font-bold">Department Name</label>
                    <input
                      type="text"
                      value={deptFormName}
                      onChange={(e) => setDeptFormName(e.target.value)}
                      placeholder="E.G. ACTUARIAL OPERATIONS"
                      className="w-full px-4 py-3 bg-white border border-slate-200 focus:border-[#978C21] outline-none text-xs rounded-none transition-all uppercase tracking-widest font-mono"
                    />
                  </div>

                  <div className="flex gap-2">
                    <button
                      type="submit"
                      className="flex-1 py-3 bg-[#978C21] hover:bg-[#83781C] text-white font-black text-[10px] uppercase tracking-widest italic transition-colors shadow-lg shadow-[#978C21]/10 flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <Save className="w-3.5 h-3.5" />
                      {editingDeptId ? 'Update Department' : 'Establish Department'}
                    </button>
                    {editingDeptId && (
                      <button
                        type="button"
                        onClick={() => { setEditingDeptId(null); setDeptFormName(''); }}
                        className="px-4 py-3 bg-slate-100 hover:bg-slate-200 text-slate-500 font-bold text-[10px] uppercase tracking-wider cursor-pointer"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </form>
              </div>

              <div className="lg:col-span-8 space-y-4">
                <div className="bg-[#FBFAF8] border border-slate-200 p-6 rounded-sm">
                  <div className="flex items-center gap-2 mb-6">
                    <Building className="w-4 h-4 text-[#978C21]" />
                    <h3 className="text-xs font-black uppercase tracking-widest text-slate-900 leading-none">Departments Register ({departments.length})</h3>
                  </div>

                  {departments.length === 0 ? (
                    <div className="py-12 border border-dashed border-slate-200 text-center text-[10px] text-slate-400 font-bold uppercase tracking-widest italic bg-white">
                      No departments have been established.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {departments.map((dept) => (
                        <div key={dept.id} className="p-4 bg-white border border-slate-200 flex items-center justify-between hover:shadow-md transition-shadow">
                          <div className="space-y-1">
                            <h4 className="text-xs font-black uppercase tracking-wider text-slate-800">{dept.name}</h4>
                            <p className="text-[8px] text-slate-400 font-mono italic">ID: {dept.id}</p>
                          </div>
                          <div className="flex gap-1.5 shrink-0">
                            <button
                              onClick={() => { setEditingDeptId(dept.id); setDeptFormName(dept.name); }}
                              className="p-2 hover:bg-sky-50 text-sky-600 rounded-sm hover:-translate-y-0.5 transition-all cursor-pointer"
                              title="Edit"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleDeleteDept(dept.id)}
                              className="p-2 hover:bg-red-50 text-red-500 rounded-sm hover:-translate-y-0.5 transition-all cursor-pointer"
                              title="Purge"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {/* ----------------------------------------------------
              STEP 2: CUSTOM ROLE PERMISSIONS COMPOSER
              ---------------------------------------------------- */}
          {activeStep === 2 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
              {!showRoleForm ? (
                /* Pure Overview: Elegant grid of all corporate roles available */
                <div className="bg-[#FBFAF8] border border-slate-200 p-6 rounded-sm space-y-6">
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-4 border-b border-slate-150">
                    <div className="space-y-1">
                      <h3 className="text-sm font-black uppercase tracking-widest text-[#978C21]">Corporate Roles Registry</h3>
                      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                        Inspect active organizational clearance levels and customize horizontal authorization layers
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        handleCreateNewRoleEmpty();
                        setShowRoleForm(true);
                      }}
                      className="px-4 py-2 bg-[#978C21] text-white hover:bg-[#83781C] transition-colors flex items-center gap-2 text-xs font-black uppercase tracking-widest italic cursor-pointer shadow-md shadow-[#978C21]/10"
                      title="Declare Custom Role"
                    >
                      <Plus className="w-4 h-4" /> Declare New Role
                    </button>
                  </div>

                  {roles.length === 0 ? (
                    <div className="py-12 text-center text-slate-400 uppercase tracking-wider text-xs font-bold font-mono">
                      No roles configured in system register catalog.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                      {roles.map((r) => (
                        <div 
                          key={r.roleId} 
                          className="bg-white border border-slate-200 p-5 rounded-none flex flex-col justify-between hover:border-[#978C21] transition-all hover:shadow-md group product-card"
                        >
                          <div className="space-y-3">
                            <div className="flex justify-between items-start gap-2">
                              <span className="text-[11px] uppercase tracking-wider font-extrabold text-slate-800 block leading-snug">
                                {r.roleName}
                              </span>
                              <span className={cn(
                                "text-[8px] px-2 py-0.5 rounded-none font-black uppercase tracking-widest",
                                r.isCustom ? "bg-amber-50 text-amber-600 border border-amber-200" : "bg-slate-50 text-slate-500 border border-slate-200"
                              )}>
                                {r.isCustom ? "Custom" : "System"}
                              </span>
                            </div>
                            
                            <div className="space-y-1 text-[9px] font-mono text-slate-400 uppercase tracking-wider">
                              <div>Slug Identifier: <span className="text-slate-700 font-bold lowercase">{r.roleId}</span></div>
                              <div>Data Visibility: <span className="text-[#978C21] font-bold">{r.dataVisibility || 'Own'}</span></div>
                            </div>

                            <div className="pt-2 border-t border-slate-100">
                              <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest italic block mb-1">ACCESSIBLE SECTIONS</span>
                              <div className="flex flex-wrap gap-1 max-h-[80px] overflow-hidden">
                                {Object.entries(r.menuAccess || {})
                                  .filter(([_, enabled]) => enabled)
                                  .map(([path]) => {
                                    const part = path === '/' ? 'Dashboard' : path.split('/').pop() || 'HQ';
                                    const cleanName = part.replace(/-/g, ' ');
                                    return (
                                      <span key={path} className="text-[7.5px] bg-slate-50 border border-slate-100 text-slate-500 px-1.5 py-0.5 font-bold uppercase tracking-wider">
                                        {cleanName}
                                      </span>
                                    );
                                  })}
                              </div>
                            </div>
                          </div>

                          <div className="pt-4 mt-4 border-t border-slate-105 flex items-center gap-2">
                            <button
                              onClick={() => {
                                applyRoleToForm(r);
                                setShowRoleForm(true);
                              }}
                              className="flex-1 py-2 bg-slate-50 hover:bg-[#978C21] hover:text-white border border-slate-200 text-slate-600 text-[9px] font-black uppercase tracking-widest transition-all cursor-pointer text-center"
                            >
                              Configure Matrix
                            </button>
                            {r.roleId !== 'admin' && r.roleId.toUpperCase() !== 'ADMIN' && (
                              <button
                                onClick={() => handleDeleteRole(r.roleId)}
                                className="p-2 border border-red-150 hover:border-red-300 text-red-500 hover:text-red-700 hover:bg-red-50 transition-colors cursor-pointer"
                                title="Delete Role"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                /* Matrix Editor & Clearance Composer workspace */
                <div className="space-y-6">
                  <div className="flex items-center justify-between">
                    <button
                      onClick={() => setShowRoleForm(false)}
                      className="px-3.5 py-2 border border-slate-200 hover:bg-slate-50 text-slate-700 text-[9px] font-black uppercase tracking-widest italic flex items-center gap-2 transition-colors cursor-pointer"
                    >
                      <ArrowLeft className="w-3.5 h-3.5" /> Back to Roles Registry
                    </button>
                    <span className="text-[9px] font-mono text-slate-400 uppercase tracking-widest italic">
                      {selectedRole ? `Configuring: ${selectedRole.roleId}` : 'Declaring Custom Organizational Role'}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
                    {/* Compact Rollback Left Sidebar listing */}
                    <div className="lg:col-span-3 bg-[#FBFAF8] border border-slate-200 p-5 rounded-sm space-y-4">
                      <div className="space-y-1 pb-2 border-b border-slate-200">
                        <h4 className="text-[10px] font-black uppercase tracking-widest text-[#978C21]">Roles Index</h4>
                        <p className="text-[8px] text-slate-400 font-bold uppercase tracking-wider">Quick context switch</p>
                      </div>

                      <div className="divide-y divide-slate-100 max-h-[350px] overflow-y-auto pr-1">
                        {roles.map((r) => (
                          <button
                            key={r.roleId}
                            onClick={() => applyRoleToForm(r)}
                            className={cn(
                              "w-full px-3 py-2 text-left flex items-center justify-between transition-all group border-l-2 cursor-pointer",
                              selectedRole?.roleId === r.roleId 
                                ? "bg-white border-[#978C21] font-black text-slate-900" 
                                : "border-transparent text-slate-400 hover:text-slate-700 hover:bg-white text-[10px]"
                            )}
                          >
                            <span className="text-[9px] uppercase tracking-wider font-bold truncate pr-2">{r.roleName}</span>
                            <ChevronRight className="w-3 h-3 text-slate-300 shrink-0" />
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Full Composer Matrix Form */}
                    <div className="lg:col-span-9 bg-[#FBFAF8] border border-slate-200 p-6 rounded-sm space-y-8">
                      {/* Form Header */}
                      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 pb-4 border-b border-slate-100">
                        <div className="space-y-1">
                          <h2 className="text-sm font-black uppercase tracking-widest text-slate-900">
                            {selectedRole ? `Clearance Matrix: ${selectedRole.roleName}` : 'Declare New Custom Role'}
                          </h2>
                          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                            Define feature menus availability and data boundary rules.
                          </p>
                        </div>
                        {selectedRole && selectedRole.roleId !== 'admin' && selectedRole.roleId.toUpperCase() !== 'ADMIN' && (
                          <button
                            onClick={async () => {
                              const deleted = await handleDeleteRole(selectedRole.roleId);
                              if (deleted) setShowRoleForm(false);
                            }}
                            className="px-3.5 py-1.5 border border-red-200 text-red-500 hover:bg-red-50 text-[9px] font-black uppercase tracking-widest italic flex items-center gap-1.5 transition-colors cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" /> Purge Role
                          </button>
                        )}
                      </div>

                      {/* Display / Slug Inputs */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="space-y-2">
                          <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest italic font-bold">Role Display Name</label>
                          <input
                            type="text"
                            value={roleFormName}
                            onChange={(e) => setRoleFormName(e.target.value)}
                            placeholder="E.G. RELATIONSHIP EXECUTIVE"
                            className="w-full px-4 py-3 bg-white border border-slate-200 focus:border-[#978C21] outline-none text-xs rounded-none transition-all uppercase tracking-widest font-mono"
                          />
                        </div>

                        <div className="space-y-2">
                          <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest italic font-bold">Role Identifier Slug</label>
                          <input
                            type="text"
                            disabled={!isEditingRoleSlug}
                            value={roleFormSlug}
                            onChange={(e) => setRoleFormSlug(e.target.value)}
                            placeholder="E.G. relationship_exec"
                            className="w-full px-4 py-3 bg-white border border-slate-200 disabled:bg-slate-50 disabled:text-slate-400 focus:border-[#978C21] outline-none text-xs rounded-none transition-all lowercase tracking-widest font-mono"
                          />
                        </div>
                      </div>

                      {/* Action Data Visibility boundaries */}
                      <div className="space-y-4">
                        <div className="space-y-1">
                          <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest italic font-bold">Action Data Visibility boundaries</h4>
                          <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wider">Restricts read parameters across corporate vertical directory structures.</p>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                          {['Own', 'DownTeam', 'FullTeam', 'Organization'].map((scope) => {
                            const desc = scope === 'Own' ? 'Own Data View' : scope === 'DownTeam' ? 'Down the Team View' : scope === 'FullTeam' ? 'Full Team View' : 'Organizational View';
                            return (
                              <button
                                key={scope}
                                type="button"
                                onClick={() => setRoleFormVisibility(scope as any)}
                                className={cn(
                                  "p-3 border text-center transition-all cursor-pointer flex flex-col justify-center items-center gap-1.5",
                                  roleFormVisibility === scope 
                                    ? "bg-white border-[#978C21] shadow-slate-900/5 shadow-md font-bold" 
                                    : "border-slate-200 hover:bg-slate-50"
                                )}
                              >
                                <span className="text-[10px] font-black uppercase tracking-wider text-slate-800">{scope}</span>
                                <span className="text-[8px] text-slate-400 uppercase tracking-widest leading-normal text-center">{desc}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Feature Clearance matrix */}
                      <div className="space-y-6">
                        <div className="space-y-1">
                          <h4 className="text-[10px] font-black text-[#978C21] uppercase tracking-widest italic font-bold">Feature Group Clearance Matrix</h4>
                          <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wider">Enable target sidebar pages and toggle fine-grained action checklist authorizations.</p>
                        </div>

                        <div className="space-y-4">
                          {APP_FEATURES_METADATA.map((item) => {
                            const featConfig = roleFormFeatures[item.key] || { view: false };
                            const isMainActive = !!featConfig.view;

                            return (
                              <div key={item.key} className={cn(
                                "border rounded-sm transition-all overflow-hidden",
                                isMainActive ? "border-[#978C21]/60 bg-[#FBFAF8]" : "border-slate-100 bg-white"
                              )}>
                                {/* Feature Header */}
                                <div className="p-4 flex items-center justify-between gap-4 select-none bg-slate-50/50">
                                  <div className="space-y-0.5">
                                    <span className="text-[11px] font-black uppercase tracking-wider text-slate-900 flex items-center gap-2">
                                      {item.label}
                                    </span>
                                    <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wide leading-tight">{item.desc}</p>
                                  </div>

                                  <button
                                    type="button"
                                    onClick={() => {
                                      const nowActive = !isMainActive;
                                      const updated = { ...featConfig, view: nowActive };
                                      // If turning off, clear sub-options as well
                                      if (!nowActive) {
                                        Object.keys(updated).forEach(k => {
                                          if (k !== 'view') updated[k] = false;
                                        });
                                      }
                                      setRoleFormFeatures({
                                        ...roleFormFeatures,
                                        [item.key]: updated
                                      });
                                    }}
                                    className={cn(
                                      "text-[10px] font-bold uppercase tracking-widest px-4 py-2 border cursor-pointer transition-all flex items-center gap-1.5",
                                      isMainActive
                                        ? "bg-[#978C21] text-white border-[#978C21] shadow-sm shadow-[#978C21]/20"
                                        : "bg-white text-slate-400 border-slate-200 hover:text-slate-600 hover:border-slate-300"
                                    )}
                                  >
                                    {isMainActive ? (
                                      <>
                                        <CheckCircle2 className="w-3.5 h-3.5" />
                                        ACTIVE
                                      </>
                                    ) : (
                                      "DISABLED"
                                    )}
                                  </button>
                                </div>

                                {/* Nested Suboptions checklist */}
                                {isMainActive && item.suboptions && item.suboptions.length > 0 && (
                                  <motion.div 
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: "auto" }}
                                    className="p-5 border-t border-slate-100 bg-white space-y-4"
                                  >
                                    <div className="space-y-1">
                                      <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest italic block">FINE-GRAINED FEATURE CONTROLS</span>
                                    </div>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                      {item.suboptions.map((subItem) => {
                                        const isSubActive = !!featConfig[subItem.key];
                                        return (
                                          <div 
                                            key={subItem.key}
                                            onClick={() => {
                                              setRoleFormFeatures({
                                                ...roleFormFeatures,
                                                [item.key]: {
                                                  ...featConfig,
                                                  [subItem.key]: !isSubActive
                                                }
                                              });
                                            }}
                                            className={cn(
                                              "p-3 border rounded-sm flex items-start gap-3 cursor-pointer transition-all select-none hover:bg-slate-50",
                                              isSubActive ? "border-[#978C21]/40 bg-[#978C21]/5" : "border-slate-100 bg-[#FBFAF8]"
                                            )}
                                          >
                                            <button
                                              type="button"
                                              className={cn(
                                                "w-5 h-5 border transition-all rounded-none shrink-0 flex items-center justify-center cursor-pointer",
                                                isSubActive ? "bg-[#978C21] border-[#978C21] text-white" : "border-slate-200 bg-white"
                                              )}
                                            >
                                              {isSubActive && <CheckCircle2 className="w-3.5 h-3.5" />}
                                            </button>
                                            <div className="space-y-0.5">
                                              <span className="text-[10px] font-black uppercase tracking-wider text-slate-800">{subItem.label}</span>
                                              <p className="text-[8px] text-slate-400 uppercase tracking-widest leading-normal">{subItem.desc}</p>
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </motion.div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      {/* Save Console Button */}
                      <button
                        type="button"
                        onClick={handleSaveRoleMatrix}
                        className="w-full py-4.5 bg-[#978C21] hover:bg-[#83781C] text-white font-black text-xs uppercase tracking-widest italic transition-all shadow-xl shadow-[#978C21]/20 flex items-center justify-center gap-2 cursor-pointer border-0"
                      >
                        <Save className="w-4 h-4" /> Save Access Definition Matrix
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* ----------------------------------------------------
              STEP 3: USER PROFILES & ONBOARDING ROSTER
              ---------------------------------------------------- */}
          {activeStep === 3 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
              {/* Toolbar */}
              <div className="bg-[#FBFAF8] border border-slate-200/60 p-4 rounded-sm flex flex-col md:flex-row justify-between items-center gap-4">
                <div className="flex flex-1 items-center gap-3 w-full max-w-lg bg-white border border-slate-200 px-3 py-2">
                  <Search className="w-4 h-4 text-slate-400" />
                  <input
                    type="text"
                    value={userQuery}
                    onChange={(e) => setUserQuery(e.target.value)}
                    placeholder="Search by Employee ID, Name, Job title..."
                    className="flex-1 outline-none text-xs text-slate-800 uppercase tracking-wide font-mono"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
                  <select
                    value={selectedDeptId}
                    onChange={(e) => setSelectedDeptId(e.target.value)}
                    className="px-3 py-2 bg-white border border-slate-200 text-[10px] uppercase font-black italic tracking-widest outline-none text-slate-600 rounded-none cursor-pointer"
                  >
                    <option value="">All Departments</option>
                    {departments.map(d => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>

                  <button
                    onClick={openCreateUserModal}
                    className="px-4.5 py-2.5 bg-[#978C21] hover:bg-[#83781C] text-white text-[9px] font-black uppercase tracking-widest italic transition-colors flex items-center gap-1.5 shadow-md shadow-[#978C21]/15 cursor-pointer"
                  >
                    <UserPlus className="w-3.5 h-3.5" /> Onboard Employee
                  </button>
                </div>
              </div>

              {/* Roster list */}
              <div className="bg-[#FBFAF8] border border-slate-200/60 rounded-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 bg-white">
                        <th className="p-4 text-[9px] font-black text-slate-400 uppercase tracking-widest italic">Identity Map</th>
                        <th className="p-4 text-[9px] font-black text-slate-400 uppercase tracking-widest italic">Role & department</th>
                        <th className="p-4 text-[9px] font-black text-slate-400 uppercase tracking-widest italic">Credentials Status</th>
                        <th className="p-4 text-[9px] font-black text-slate-400 uppercase tracking-widest italic">Reporting Line Cache</th>
                        <th className="p-4 text-[9px] font-black text-slate-400 uppercase tracking-widest italic text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {filteredUsers.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="py-20 text-center text-[10px] text-slate-400 font-bold uppercase tracking-widest italic bg-white border border-dashed border-slate-100">
                            No employees matched the query filters.
                          </td>
                        </tr>
                      ) : (
                        filteredUsers.map((u) => {
                          const matchedDept = departments.find(d => d.id === (u as any).departmentId);
                          const isSuperAdmin = u.role === 'admin' || u.role === 'ADMIN' || u.role === 'superadmin' || u.role === 'ADMINISTRATOR';
                          return (
                            <tr key={u.id} className="hover:bg-slate-50 transition-colors">
                              <td className="p-4">
                                <div className="flex items-center gap-3">
                                  <div className="w-9 h-9 rounded-none bg-slate-900 border border-slate-800 text-white flex items-center justify-center font-bold font-mono text-sm">
                                    {u.name.charAt(0)}
                                  </div>
                                  <div className="space-y-0.5">
                                    <h4 className="text-xs font-black uppercase text-slate-850 tracking-tight leading-none">{u.name}</h4>
                                    <span className="text-[9px] text-[#978C21] font-mono font-black italic block">ID: {u.employeeId}</span>
                                    {u.email && <span className="text-[8px] text-slate-400 block font-light shrink-0 truncate max-w-[200px]">{u.email}</span>}
                                  </div>
                                </div>
                              </td>
                              <td className="p-4">
                                <div className="space-y-1">
                                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 border border-slate-150 text-[8px] font-black uppercase tracking-widest bg-slate-50 text-slate-650">
                                    <Shield className={cn("w-2.5 h-2.5", isSuperAdmin ? "text-red-500" : "text-[#978C21]")} />
                                    {u.role}
                                  </span>
                                  {matchedDept && (
                                    <span className="text-[9px] text-slate-400 font-mono tracking-wider font-bold uppercase block">
                                      🏬 {matchedDept.name}
                                    </span>
                                  )}
                                  {u.designation && (
                                    <span className="text-[9px] text-slate-400 font-bold uppercase tracking-wider block">
                                      💼 {u.designation}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="p-4">
                                <div className="space-y-1">
                                  <span className={cn(
                                    "inline-flex items-center gap-1 px-2 py-0.5 text-[8px] font-black uppercase tracking-widest",
                                    u.status === 'Active' ? "bg-emerald-50 text-emerald-600" : "bg-slate-50 text-slate-400"
                                  )}>
                                    {u.status === 'Active' ? 'Active App Access' : 'Inactive'}
                                  </span>
                                  
                                  {u.mustChangePassword ? (
                                    <span className="inline-flex items-center gap-1 bg-amber-55/10 text-amber-600 px-2 py-0.5 text-[8px] font-black uppercase tracking-widest animate-pulse border border-amber-500/10">
                                      🔑 Temp Creds (Onboarding)
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 bg-sky-50 text-sky-600 px-2 py-0.5 text-[8px] font-black uppercase tracking-widest border border-sky-100">
                                      🛡️ Credentials Rotated
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="p-4">
                                <div className="space-y-0.5 max-w-[200px]">
                                  {u.reportingChain && u.reportingChain.length > 0 ? (
                                    <div className="space-y-1 text-slate-500">
                                      <p className="text-[9px] font-black uppercase tracking-wider text-slate-400">Reports up to:</p>
                                      <div className="flex flex-wrap items-center gap-1">
                                        {u.reportingChain.slice(0, 3).map((id, index) => (
                                          <span key={id} className="text-[8px] font-mono font-black italic bg-slate-50 border border-slate-100 px-1 py-0.5 text-slate-600 leading-none">
                                            {id} {index < Math.min(u.reportingChain.length, 3) - 1 ? '➔' : ''}
                                          </span>
                                        ))}
                                        {u.reportingChain.length > 3 && <span className="text-[8px] font-bold text-[#978C21] block font-mono">+{u.reportingChain.length - 3} more</span>}
                                      </div>
                                    </div>
                                  ) : (
                                    <span className="text-[8px] text-slate-300 font-bold uppercase tracking-wider block italic">Dynamic Root Supervisor / Not Mapped</span>
                                  )}
                                  
                                  {u.subordinates && u.subordinates.length > 0 ? (
                                    <span className="text-[8px] font-black text-emerald-500 block uppercase tracking-wider leading-none mt-1">
                                      👥 Cascade Control: {u.subordinates.length} Employees Downward
                                    </span>
                                  ) : null}
                                </div>
                              </td>
                              <td className="p-4 text-right">
                                <div className="flex gap-1.5 justify-end">
                                  <button
                                    onClick={() => openEditUserModal(u)}
                                    className="p-2 border border-slate-100 hover:bg-sky-50 text-sky-600 rounded-sm hover:-translate-y-0.5 transition-all cursor-pointer"
                                    title="Edit Profile"
                                  >
                                    <Edit2 className="w-3.5 h-3.5" />
                                  </button>
                                  {u.employeeId !== 'ADMIN' && u.id !== currentUser?.id && (
                                    <button
                                      onClick={() => handleDeleteUser(u.id, u.name)}
                                      className="p-2 border border-slate-100 hover:bg-red-50 text-red-500 rounded-sm hover:-translate-y-0.5 transition-all cursor-pointer"
                                      title="Purge Profile"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
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
            </motion.div>
          )}

          {/* ----------------------------------------------------
              STEP 4: DYNAMIC HIERARCHY TRAVERSAL ENGINE
              ---------------------------------------------------- */}
          {activeStep === 4 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
              {/* Left sidebar: Department select descriptor */}
              <div className="lg:col-span-4 bg-[#FBFAF8] border border-slate-200 p-6 rounded-sm space-y-6">
                <div className="space-y-1">
                  <h3 className="text-xs font-black uppercase tracking-widest text-[#978C21]">Hierarchy Workspace</h3>
                  <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Select targeting corporate department to architect reporting maps.</p>
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest italic font-bold">🏢 Department Focus</label>
                  <select
                    value={activeHierDeptId}
                    onChange={(e) => setActiveHierDeptId(e.target.value)}
                    className="w-full px-4 py-3 bg-white border border-slate-200 focus:border-[#978C21] outline-none text-xs rounded-none transition-all uppercase tracking-widest font-mono cursor-pointer"
                  >
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                </div>

                <div className="bg-white border border-slate-150 p-4 space-y-3.5">
                  <h5 className="text-[10px] uppercase tracking-widest font-black text-slate-700 leading-none">Hierarchy Rules</h5>
                  <ul className="space-y-2 text-[9px] text-slate-400 tracking-wider font-bold uppercase leading-normal">
                    <li className="flex items-start gap-1.5 text-slate-550">
                      <ChevronRight className="w-3.5 h-3.5 text-[#978C21] shrink-0" />
                      Root is the single top administration role.
                    </li>
                    <li className="flex items-start gap-1.5 text-slate-555">
                      <ChevronRight className="w-3.5 h-3.5 text-[#978C21] shrink-0" />
                      Toggle roles reporter sub-branches reporting.
                    </li>
                    <li className="flex items-start gap-1.5 text-slate-555">
                      <ChevronRight className="w-3.5 h-3.5 text-[#978C21] shrink-0" />
                      Path roles are automatically pruned downwards.
                    </li>
                    <li className="flex items-start gap-1.5 text-slate-555">
                      <ChevronRight className="w-3.5 h-3.5 text-[#978C21] shrink-0" />
                      Compiling materializes dynamic supervision chains.
                    </li>
                  </ul>
                </div>
              </div>

              {/* Right side: Layer orchestrator tree */}
              <div className="lg:col-span-8 bg-[#FBFAF8] border border-slate-200 p-6 rounded-sm space-y-6">
                <div className="flex justify-between items-center pb-4 border-b border-slate-100">
                  <div className="space-y-1">
                    <h3 className="text-sm font-black uppercase tracking-widest text-slate-900 leading-none">Chains Matrix architect</h3>
                    <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Dynamic layout editor per Department</p>
                  </div>
                  <span className="px-2.5 py-1 bg-green-50 text-green-700 border border-green-200 text-[8px] font-mono font-black uppercase tracking-widest">
                    🌳 Tree Topology Active
                  </span>
                </div>

                {hierLayers.length === 0 ? (
                  <div className="py-20 border border-dashed border-slate-200 text-center text-[10px] text-slate-400 font-bold uppercase tracking-widest italic bg-white flex flex-col justify-center items-center gap-4">
                    <span>Initializing tree topology...</span>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {(() => {
                      const rootNode = hierLayers.find(l => l.parentId === null) || hierLayers[0];
                      return rootNode ? renderTreeNode(rootNode, 0) : null;
                    })()}

                    {/* Commit Save */}
                    <button
                      type="button"
                      onClick={handleSaveDepartmentHierarchyEngine}
                      className="w-full py-4.5 bg-[#978C21] hover:bg-[#83781C] text-white font-black text-xs uppercase tracking-widest italic transition-all shadow-xl shadow-[#978C21]/20 flex items-center justify-center gap-2 cursor-pointer mt-4"
                    >
                      <Save className="w-4 h-4 text-white" /> Compile and Deploy Hierarchy Chains
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </div>
      )}

      {/* ----------------------------------------------------
          MODAL CONSOLE: USER ONBOARDING & EDIT PROFILE
          ---------------------------------------------------- */}
      <AnimatePresence>
        {isUserModalOpen && (
          <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 15 }}
              className="bg-white border border-slate-200 w-full max-w-xl shadow-2xl overflow-hidden"
            >
              {/* Modal header */}
              <div className="bg-[#FBFAF8] p-6 border-b border-slate-100 flex items-center justify-between">
                <div className="space-y-1">
                  <h3 className="text-sm font-black uppercase tracking-widest text-[#978C21] leading-none italic">
                    {editingUser ? `Modify Employee: ${editingUser.name}` : 'Onboard New Corporate Employee'}
                  </h3>
                  <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                    Provide credentials, map department, allocate targeting permissions role.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsUserModalOpen(false)}
                  className="p-1.5 text-slate-400 hover:text-slate-700 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Modal form */}
              <form onSubmit={handleSaveUserFormSubmit} className="p-6 space-y-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Name */}
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest italic font-bold">Full Name</label>
                    <input
                      type="text"
                      required
                      value={userForm.name}
                      onChange={(e) => setUserForm({ ...userForm, name: e.target.value })}
                      placeholder="E.G. ABDUR RAHMAN"
                      className="w-full px-3.5 py-2.5 bg-[#FBFAF8] border border-slate-200 focus:border-[#978C21] outline-none text-xs rounded-none transition-all uppercase tracking-widest font-mono"
                    />
                  </div>

                  {/* Employee ID */}
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest italic font-bold">Unique Employee ID</label>
                    <input
                      type="text"
                      required
                      value={userForm.employeeId}
                      onChange={(e) => setUserForm({ ...userForm, employeeId: e.target.value })}
                      placeholder="E.G. RM7859"
                      className="w-full px-3.5 py-2.5 bg-[#FBFAF8] border border-slate-200 focus:border-[#978C21] outline-none text-xs rounded-none transition-all uppercase tracking-widest font-mono"
                    />
                  </div>

                  {/* Contact */}
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest italic font-bold">Contact Number</label>
                    <input
                      type="text"
                      value={userForm.contact}
                      onChange={(e) => setUserForm({ ...userForm, contact: e.target.value })}
                      placeholder="E.G. 01712345678"
                      className="w-full px-3.5 py-2.5 bg-[#FBFAF8] border border-slate-200 focus:border-[#978C21] outline-none text-xs rounded-none transition-all uppercase tracking-widest font-mono"
                    />
                  </div>

                  {/* Email */}
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest italic font-bold">Email ID</label>
                    <input
                      type="email"
                      required
                      value={userForm.email}
                      onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
                      placeholder="E.G. ABDUR@SHANTALIFE.COM"
                      className="w-full px-3.5 py-2.5 bg-[#FBFAF8] border border-slate-200 focus:border-[#978C21] outline-none text-xs rounded-none transition-all uppercase tracking-widest font-mono"
                    />
                  </div>

                  {/* Designation */}
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest italic font-bold">Designation Title</label>
                    <input
                      type="text"
                      value={userForm.designation}
                      onChange={(e) => setUserForm({ ...userForm, designation: e.target.value })}
                      placeholder="E.G. SENIOR MANAGER"
                      className="w-full px-3.5 py-2.5 bg-[#FBFAF8] border border-slate-200 focus:border-[#978C21] outline-none text-xs rounded-none transition-all uppercase tracking-widest font-mono"
                    />
                  </div>

                  {/* Role App Access */}
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest italic font-bold">App Access Role</label>
                    <select
                      value={userForm.role}
                      onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}
                      className="w-full px-3.5 py-3 bg-[#FBFAF8] border border-slate-200 focus:border-[#978C21] outline-none text-[10px] uppercase font-black italic tracking-widest cursor-pointer text-slate-650"
                    >
                      {roles.map(r => (
                        <option key={r.roleId} value={r.roleId}>{r.roleName}</option>
                      ))}
                    </select>
                  </div>

                  {/* Department */}
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest italic font-bold">Assigned Department</label>
                    <select
                      value={userForm.departmentId}
                      onChange={(e) => setUserForm({ ...userForm, departmentId: e.target.value })}
                      className="w-full px-3.5 py-3 bg-[#FBFAF8] border border-slate-200 focus:border-[#978C21] outline-none text-[10px] uppercase font-black italic tracking-widest cursor-pointer text-slate-650"
                    >
                      <option value="">No Department</option>
                      {departments.map(d => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                  </div>

                  {/* Status */}
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest italic font-bold">Operational Status</label>
                    <select
                      value={userForm.status}
                      onChange={(e) => setUserForm({ ...userForm, status: e.target.value as any })}
                      className="w-full px-3.5 py-3 bg-[#FBFAF8] border border-slate-200 focus:border-[#978C21] outline-none text-[10px] uppercase font-black italic tracking-widest cursor-pointer text-slate-650"
                    >
                      <option value="Active">Active App Access</option>
                      <option value="Inactive">Inactive</option>
                    </select>
                  </div>
                </div>

                {/* Password / Temporary password */}
                <div className="p-4 bg-slate-50 border border-slate-100 rounded-sm space-y-2">
                  <div className="flex justify-between items-center">
                    <label className="text-[10px] font-black text-slate-650 uppercase tracking-widest italic flex items-center gap-1.5">
                      <Lock className="w-3.5 h-3.5 text-[#978C21]" />
                      {editingUser ? 'Overwrite Security Password' : 'Set Temporary Password'}
                    </label>
                    <span className="text-[8px] font-mono bg-[#978C21]/15 text-[#978C21] px-1.5 py-0.5 rounded-sm uppercase tracking-wider font-black">
                      Onboarding Constraint Active
                    </span>
                  </div>
                  <input
                    type="text"
                    value={userForm.password}
                    onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
                    placeholder={editingUser ? "LEAVE BLANK TO RETAIN CURRENT SECURITY PASSWORD" : "LEAVE BLANK TO AUTO-GENERATE A TEMPORARY PASSWORD"}
                    className="w-full px-3.5 py-2.5 bg-white border border-slate-200 focus:border-[#978C21] outline-none text-xs rounded-none transition-all uppercase tracking-widest font-mono"
                  />
                  <p className="text-[9px] text-slate-400 leading-normal tracking-wide italic">
                    {editingUser 
                      ? "Entering a value will format a credentials reset, pushing a mandatory change-password rotation on the user's next terminal access."
                      : "The newborn credential will enforce dynamic onboarding blocks requiring immediate password rotation upon user verification."}
                  </p>
                </div>

                {/* Confirm Buttons */}
                <div className="flex gap-3 justify-end pt-2">
                  <button
                    type="button"
                    onClick={() => setIsUserModalOpen(false)}
                    className="px-4.5 py-3 border border-slate-200 text-slate-500 hover:bg-slate-50 font-black text-[10px] uppercase tracking-widest italic transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>

                  <button
                    type="submit"
                    className="px-5 py-3 bg-[#978C21] hover:bg-[#83781C] text-white font-black text-[10px] uppercase tracking-widest italic transition-colors shadow-lg shadow-[#978C21]/15 cursor-pointer"
                  >
                    {editingUser ? 'Save Employee Profile' : 'Onboard Employee'}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
