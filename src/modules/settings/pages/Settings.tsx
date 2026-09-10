import React, { useEffect, useState } from 'react';
import { 
  Users, 
  Settings as SettingsIcon, 
  ShieldCheck, 
  Bell, 
  Database,
  Key,
  ChevronRight,
  Globe,
  Plus,
  Trash2,
  Save,
  X,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  Power,
  Radio,
  Wifi,
  CheckCircle2,
  AlertTriangle
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../auth/store/authStore';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { motion, AnimatePresence } from 'framer-motion';
import { settingsService } from '../../../services/settingsService';
import { metadataService } from '../../metadata/services/metadataService';
import { formBuilderService } from '../../forms/services/formBuilderService';
import { workflowService } from '../../workflow/services/workflowService';
import { userService } from '../../users/services/userService';
import { leadService } from '../../leads/services/leadService';
import { databaseStatusService } from '../../../services/syncService';
import { DropdownOption, MetadataType, FormField, FormFieldType, WorkflowRule, UserRole } from '../../shared/types';
import { toast } from 'sonner';
import { cn } from '../../../lib/utils';
import { useTranslation } from '../../shared/utils/translations';

const STATUS_COLOR_CHOICES = ['slate', 'blue', 'amber', 'orange', 'teal', 'indigo', 'purple', 'violet', 'yellow', 'green', 'red'];
const STATUS_COLOR_HEX: Record<string, string> = {
  slate: '#94a3b8', blue: '#3b82f6', amber: '#f59e0b', orange: '#f97316',
  teal: '#14b8a6', indigo: '#6366f1', purple: '#a855f7', violet: '#8b5cf6',
  yellow: '#eab308', green: '#22c55e', red: '#ef4444',
};

export default function Settings() {
  const { user, logout, login, isOfflineMode } = useAuthStore();
  const { t } = useTranslation();
  const { canAccess } = usePermissions();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'overview' | 'dropdowns' | 'formbuilder' | 'workflow'>('overview');
  const [options, setOptions] = useState<DropdownOption[]>([]);
  const [metadataTypes, setMetadataTypes] = useState<MetadataType[]>([]);
  const [editingOption, setEditingOption] = useState<{type: string, value: string}>({ type: 'Area', value: '' });
  const [newTypeForm, setNewTypeForm] = useState({ label: '', description: '' });
  const [isAddingType, setIsAddingType] = useState(false);
  const [formFields, setFormFields] = useState<FormField[]>([]);
  const [isAddingField, setIsAddingField] = useState(false);
  const [newFieldForm, setNewFieldForm] = useState<{ label: string; fieldType: FormFieldType; metadataTypeKey: string; isMandatory: boolean }>({
    label: '', fieldType: 'text', metadataTypeKey: '', isMandatory: false,
  });
  const [workflowRules, setWorkflowRules] = useState<WorkflowRule[]>([]);
  const [allStatuses, setAllStatuses] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState(user?.name || '');
  const [avatarUrl, setAvatarUrl] = useState(user?.avatarUrl || '');
  const [activeSection, setActiveSection] = useState('overview');

  // Password management states
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);

  // Supabase connection signal states
  const [dbStatus, setDbStatus] = useState<{ connected: boolean; message: string } | null>(null);
  const [dbChecking, setDbChecking] = useState(false);

  const checkDbStatus = async () => {
    setDbChecking(true);
    try {
      const res = await fetch('/api/db-status');
      if (res.ok) {
        const data = await res.json();
        setDbStatus(data);
      } else {
        setDbStatus({ connected: false, message: t('dbConnectionFailed') });
      }
    } catch (e) {
      setDbStatus({ connected: false, message: t('syncFailedGeneric') });
    } finally {
      setDbChecking(false);
    }
  };

  useEffect(() => {
    if (activeSection === 'sync') {
      checkDbStatus();
    }
  }, [activeSection]);

  const handleUpdateName = async () => {
    if (!user || !newName.trim()) return;
    setLoading(true);
    try {
      const updatedUser = { ...user, name: newName, avatarUrl: avatarUrl };
      await userService.updateUser(user.id, updatedUser);
      login(updatedUser, useAuthStore.getState().token || undefined, isOfflineMode);
      toast.success(t('identitySynced'));
    } catch (err) {
      toast.error(t('networkSyncFailure'));
    } finally {
      setLoading(false);
    }
  };

  const handleUpdatePassword = async () => {
    if (!user) return;
    if (!currentPassword || !newPassword || !confirmPassword) {
      toast.error(t('allPasswordFieldsRequired'));
      return;
    }
    if (newPassword.length < 5) {
      toast.error(t('newPasswordMin5'));
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error(t('newPasswordsMismatch'));
      return;
    }

    setPasswordLoading(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.id,
          currentPassword,
          newPassword,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || t('currentPasswordIncorrect'));
        return;
      }

      toast.success(t('passwordUpdated'));
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      console.error(err);
      toast.error(t('passwordUpdateFailed'));
    } finally {
      setPasswordLoading(false);
    }
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  useEffect(() => {
    if (activeTab === 'dropdowns') {
      loadOptions();
    } else if (activeTab === 'formbuilder') {
      loadFormFields();
    } else if (activeTab === 'workflow') {
      loadWorkflow();
    }
  }, [activeTab]);

  const loadOptions = async () => {
    setLoading(true);
    try {
      const types = await metadataService.getTypes();
      setMetadataTypes(types);
      if (types.length > 0 && !types.some(t => t.key === editingOption.type)) {
        setEditingOption(prev => ({ ...prev, type: types[0].key }));
      }
      const all: DropdownOption[] = [];
      for (const t of types) {
        const res = await metadataService.getAllValues(t.key, true);
        all.push(...res);
      }
      setOptions(all);
    } finally {
      setLoading(false);
    }
  };

  const handleAddType = async () => {
    if (!newTypeForm.label.trim()) {
      toast.error(t('enterMetadataTypeName'));
      return;
    }
    try {
      await metadataService.createType(
        newTypeForm.label.trim().replace(/\s+/g, ''),
        newTypeForm.label.trim(),
        newTypeForm.description.trim()
      );
      toast.success(t('metadataTypeCreated', { name: newTypeForm.label }));
      setNewTypeForm({ label: '', description: '' });
      setIsAddingType(false);
      loadOptions();
    } catch (err: any) {
      toast.error(err.message || t('metadataTypeCreateFailed'));
    }
  };

  const handleDeleteType = async (type: MetadataType) => {
    if (type.isSystem) {
      toast.error(t('systemTypeCannotDelete'));
      return;
    }
    if (!confirm(t('confirmDeleteMetadataType', { name: type.label }))) return;
    try {
      await metadataService.deleteType(type.key);
      toast.success(t('metadataTypeRemoved', { name: type.label }));
      loadOptions();
    } catch (err: any) {
      toast.error(err.message || t('metadataTypeDeleteFailed'));
    }
  };

  const handleToggleActive = async (option: DropdownOption) => {
    try {
      await metadataService.toggleActive(option);
      loadOptions();
    } catch {
      toast.error(t('statusUpdateFailed'));
    }
  };

  const handleMove = async (type: string, index: number, direction: -1 | 1) => {
    const forType = options.filter(o => o.type === type).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= forType.length) return;
    const reordered = [...forType];
    [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
    try {
      await metadataService.reorder(type, reordered.map(o => o.id!).filter(Boolean));
      loadOptions();
    } catch {
      toast.error(t('reorderFailed'));
    }
  };

  const handleSetStatusColor = async (option: DropdownOption, color: string) => {
    try {
      await metadataService.updateValue({ ...option, meta: { ...(option.meta || {}), color } });
      loadOptions();
    } catch {
      toast.error(t('colorUpdateFailed'));
    }
  };

  const loadFormFields = async () => {
    setLoading(true);
    try {
      // Metadata types are needed for the "Values From" selector when
      // creating a new dropdown field.
      if (metadataTypes.length === 0) {
        const types = await metadataService.getTypes();
        setMetadataTypes(types);
      }
      const fields = await formBuilderService.getFields(true);
      setFormFields(fields);
    } finally {
      setLoading(false);
    }
  };

  const handleAddField = async () => {
    if (!newFieldForm.label.trim()) {
      toast.error(t('enterFieldLabel'));
      return;
    }
    if (newFieldForm.fieldType === 'dropdown' && !newFieldForm.metadataTypeKey) {
      toast.error(t('selectDropdownSource'));
      return;
    }
    try {
      const fieldKey = 'custom_' + newFieldForm.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
      await formBuilderService.saveField({
        fieldKey,
        label: newFieldForm.label.trim(),
        fieldType: newFieldForm.fieldType,
        section: 'Additional',
        isMandatory: newFieldForm.isMandatory,
        isVisible: true,
        metadataTypeKey: newFieldForm.fieldType === 'dropdown' ? newFieldForm.metadataTypeKey : null,
      });
      toast.success(t('fieldAdded', { name: newFieldForm.label }));
      setNewFieldForm({ label: '', fieldType: 'text', metadataTypeKey: '', isMandatory: false });
      setIsAddingField(false);
      loadFormFields();
    } catch (err: any) {
      toast.error(err.message || t('fieldCreateFailed'));
    }
  };

  const handleDeleteField = async (field: FormField) => {
    if (!confirm(t('confirmRemoveField', { name: field.label }))) return;
    try {
      await formBuilderService.deleteField(field.id);
      toast.success(t('fieldRemoved'));
      loadFormFields();
    } catch (err: any) {
      toast.error(err.message || t('fieldDeleteFailed'));
    }
  };

  const handleToggleFieldMandatory = async (field: FormField) => {
    try {
      await formBuilderService.saveField({ ...field, isMandatory: !field.isMandatory });
      loadFormFields();
    } catch {
      toast.error(t('fieldUpdateFailed'));
    }
  };

  const handleToggleFieldVisible = async (field: FormField) => {
    try {
      await formBuilderService.saveField({ ...field, isVisible: !field.isVisible });
      loadFormFields();
    } catch {
      toast.error(t('fieldUpdateFailed'));
    }
  };

  const handleMoveField = async (section: string, index: number, direction: -1 | 1) => {
    const inSection = formFields.filter(f => f.section === section).sort((a, b) => a.sortOrder - b.sortOrder);
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= inSection.length) return;
    const reordered = [...inSection];
    [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
    try {
      await formBuilderService.reorder(reordered.map(f => f.id));
      loadFormFields();
    } catch {
      toast.error(t('reorderFieldsFailed'));
    }
  };

  const loadWorkflow = async () => {
    setLoading(true);
    try {
      const statuses = await metadataService.getActiveValues('FollowUpStatus');
      setAllStatuses(statuses);
      const rules = await workflowService.getRules(true);
      setWorkflowRules(rules);
    } finally {
      setLoading(false);
    }
  };

  const getRuleForStatus = (status: string): WorkflowRule | undefined => workflowRules.find(r => r.status === status);

  const handleToggleNextStatus = async (status: string, target: string) => {
    const existing = getRuleForStatus(status);
    const current = existing?.allowedNextStatuses;
    // null/empty = currently unrestricted (all allowed). Clicking a
    // target for the first time switches this status into "restricted"
    // mode starting from just that one target.
    let updated: string[];
    if (!current || current.length === 0) {
      updated = allStatuses.filter(s => s !== status && s !== target);
    } else if (current.includes(target)) {
      updated = current.filter(s => s !== target);
    } else {
      updated = [...current, target];
    }
    try {
      await workflowService.saveRule({ ...existing, status, allowedNextStatuses: updated });
      loadWorkflow();
    } catch (err: any) {
      toast.error(err.message || t('workflowRuleUpdateFailed'));
    }
  };

  const handleResetToUnrestricted = async (status: string) => {
    const existing = getRuleForStatus(status);
    try {
      await workflowService.saveRule({ ...existing, status, allowedNextStatuses: null });
      toast.success(t('statusUnrestricted', { status }));
      loadWorkflow();
    } catch (err: any) {
      toast.error(err.message || t('workflowRuleUpdateFailed'));
    }
  };

  const handleToggleRequirement = async (status: string, field: 'requiresLossReason' | 'requiresMeetingType' | 'requiresFollowUpType' | 'requiresNote') => {
    const existing = getRuleForStatus(status);
    try {
      await workflowService.saveRule({ ...existing, status, [field]: !existing?.[field] });
      loadWorkflow();
    } catch (err: any) {
      toast.error(err.message || t('workflowRuleUpdateFailed'));
    }
  };

  const handleAddOption = async () => {
    if (!editingOption.value) return;
    try {
      await metadataService.addValue(editingOption.type, editingOption.value);
      toast.success(t('paramAdded'));
      setEditingOption({ ...editingOption, value: '' });
      loadOptions();
    } catch (err) {
      toast.error(t('paramUpdateFailed'));
    }
  };

  const handleDeleteOption = async (option: DropdownOption) => {
    if (!confirm(t('confirmDecommissionParam'))) return;
    try {
      await metadataService.deleteValue(option.type, option.value);
      toast.success(t('paramDecommissioned'));
      loadOptions();
    } catch (err) {
      toast.error(t('decommissionFailed'));
    }
  };

  const handleClearData = async () => {
    if (!confirm(t('confirmClearAllData'))) return;
    try {
      await leadService.clearAllLeads();
      toast.success(t('clearDataSuccess'));
    } catch (err) {
      toast.error(t('clearDataFailed'));
    }
  };

  const userRoleNormalized = (user?.role || '').toUpperCase();

  const sections = [
    { id: 'profile', label: t('identitySettings'), icon: Users, desc: t('identitySettingsDesc'), allowed: canAccess('settings_control', 'view_profile') },
    { id: 'security', label: t('securityAccess'), icon: Key, desc: t('securityAccessDesc'), allowed: canAccess('settings_control', 'view_security') },
    { id: 'notifications', label: t('pushIntelligence'), icon: Bell, desc: t('pushIntelligenceDesc'), allowed: canAccess('settings_control', 'view_notifications') },
    { id: 'system', label: t('systemConfiguration'), icon: SettingsIcon, desc: t('systemConfigDesc'), allowed: canAccess('settings_control', 'view_system') },
    { id: 'sync', label: t('networkSync'), icon: Globe, desc: t('networkSyncDesc'), allowed: canAccess('settings_control', 'view_sync') },
  ].filter(section => section.allowed);

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-20">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-[#978C21]/5 rounded-sm border border-[#978C21]/10 flex items-center justify-center text-[#978C21]">
            <SettingsIcon className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-800">{t('settingsTitle')}</h1>
            <p className="text-sm text-slate-500 mt-1">{t('settingsSubtitle')}</p>
          </div>
        </div>

        <div className="flex gap-2 bg-slate-50 p-1 rounded-sm border border-slate-100 italic">
          <button 
            onClick={() => setActiveTab('overview')}
            className={cn(
              "px-5 py-2.5 text-sm font-medium rounded-lg transition-all",
              activeTab === 'overview' ? "bg-white text-brand-text shadow-sm" : "text-slate-400 hover:text-slate-600"
            )}
          >
            {t('overview')}
          </button>
          {canAccess('admin_settings', 'configure_global_metadata') && (
            <button 
              onClick={() => setActiveTab('dropdowns')}
              className={cn(
                "px-5 py-2.5 text-sm font-medium rounded-lg transition-all",
                activeTab === 'dropdowns' ? "bg-white text-brand-text shadow-sm" : "text-slate-400 hover:text-slate-600"
              )}
            >
              {t('strategyParameters')}
            </button>
          )}
          {canAccess('admin_settings', 'configure_global_metadata') && (
            <button 
              onClick={() => setActiveTab('formbuilder')}
              className={cn(
                "px-5 py-2.5 text-sm font-medium rounded-lg transition-all",
                activeTab === 'formbuilder' ? "bg-white text-brand-text shadow-sm" : "text-slate-400 hover:text-slate-600"
              )}
            >
              {t('formBuilder')}
            </button>
          )}
          {canAccess('admin_settings', 'configure_global_metadata') && (
            <button 
              onClick={() => setActiveTab('workflow')}
              className={cn(
                "px-5 py-2.5 text-sm font-medium rounded-lg transition-all",
                activeTab === 'workflow' ? "bg-white text-brand-text shadow-sm" : "text-slate-400 hover:text-slate-600"
              )}
            >
              {t('workflow')}
            </button>
          )}
        </div>
      </div>

      <AnimatePresence mode="wait">
        {activeTab === 'overview' ? (
          <motion.div 
            key="overview"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="grid grid-cols-1 lg:grid-cols-3 gap-8"
          >
            <div className="lg:col-span-1 space-y-6">
              <div className="bg-white p-10 rounded-sm border border-slate-100 text-center shadow-sm italic">
                <div className="w-24 h-24 rounded-sm bg-[#978C21]/5 flex items-center justify-center text-[#978C21] text-3xl font-black mx-auto mb-6 border border-[#978C21]/10 shadow-lg overflow-hidden">
                  {user?.avatarUrl ? (
                    <img src={user.avatarUrl} alt={user.name} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                  ) : (
                    user?.name.charAt(0)
                  )}
                </div>
                <h3 className="font-bold text-xl text-slate-800">{user?.name}</h3>
                <p className="text-sm font-medium text-[#978C21] mt-2">{user?.role}</p>
                
                <div className="mt-8 pt-8 border-t border-slate-50 space-y-4">
                  <div className="flex items-center justify-center gap-3">
                    <div className="px-4 py-1.5 bg-emerald-50 text-emerald-600 rounded-sm text-xs font-medium border border-emerald-200 rounded-full">{t('active')}</div>
                    <span className="text-sm text-slate-500">{t('idLabel')}: {user?.employeeId}</span>
                  </div>
                  
                  <button 
                    onClick={handleLogout}
                    className="w-full py-4 text-red-500 border border-red-100 hover:bg-red-50 rounded-sm font-black text-[10px] uppercase tracking-[0.3em] transition-all flex items-center justify-center gap-2"
                  >
                    {t('terminateSession')}
                  </button>
                </div>
              </div>

              <div className="bg-[#3C3C3C] p-8 rounded-sm shadow-xl italic">
                <div className="flex items-center gap-3 mb-4">
                  <ShieldCheck className="w-5 h-5 text-[#978C21]" />
                  <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-white">{t('systemInfo')}</h4>
                </div>
                <p className="text-[11px] font-bold leading-relaxed text-slate-400 uppercase tracking-tight">{t('systemInfoDesc')}</p>
              </div>
            </div>

            <div className="lg:col-span-2 space-y-4">
              {activeSection === 'overview' ? (
                <>
                  {sections.map((section, idx) => (
                    <div 
                      key={section.id}
                      onClick={() => setActiveSection(section.id)}
                      className="bg-white p-8 rounded-sm border border-slate-100 flex items-center justify-between group cursor-pointer hover:border-[#978C21]/30 transition-all shadow-sm italic"
                    >
                      <div className="flex items-center gap-5">
                        <div className="p-4 bg-slate-50 rounded-sm group-hover:bg-[#978C21]/5 transition-colors border border-slate-50">
                          <section.icon className="w-5 h-5 text-slate-400 group-hover:text-[#978C21]" />
                        </div>
                        <div>
                          <h4 className="font-semibold text-slate-800">{section.label}</h4>
                          <p className="text-[10px] text-slate-400 font-bold uppercase mt-1 tracking-tight">{section.desc}</p>
                        </div>
                      </div>
                      <ChevronRight className="w-5 h-5 text-slate-200 group-hover:text-[#978C21] transition-all transform group-hover:translate-x-1" />
                    </div>
                  ))}
                  
                  {userRoleNormalized === 'ADMIN' && (
                    <div className="pt-6">
                      <div className="bg-red-50/20 rounded-sm border border-red-100 p-8 flex items-center justify-between italic">
                        <div className="flex items-center gap-4">
                           <div className="p-4 bg-red-50 text-red-500 rounded-sm border border-red-100">
                              <Database className="w-5 h-5" />
                           </div>
                           <div>
                              <h4 className="font-semibold text-red-600">{t('systemTools')}</h4>
                              <p className="text-[10px] text-red-400 font-bold uppercase mt-1 tracking-tight italic">{t('systemToolsDesc')}</p>
                           </div>
                        </div>
                        <div className="flex items-center gap-4">
                          <button className="text-sm font-medium text-[#978C21] hover:underline" onClick={() => { setActiveSection('sync'); }}>{t('checkConnection')}</button>
                          <button className="text-sm font-medium text-red-600 hover:underline" onClick={handleClearData}>{t('clearAllData')}</button>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              ) : activeSection === 'profile' ? (
                <motion.div 
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="bg-white p-10 rounded-sm border border-slate-100 shadow-sm space-y-10 italic"
                >
                  <div className="flex items-center justify-between border-b border-slate-50 pb-8">
                    <div className="flex items-center gap-4">
                      <button onClick={() => setActiveSection('overview')} className="p-2 hover:bg-slate-50 rounded-sm">
                        <ArrowRight className="w-5 h-5 text-slate-300 rotate-180" />
                      </button>
                      <h3 className="font-bold text-xl text-slate-800">{t('updateProfile')}</h3>
                    </div>
                  </div>

                  <div className="space-y-8">
                    <div className="space-y-3">
                      <label className="text-sm font-medium text-slate-600">{t('displayName')}</label>
                      <input 
                        type="text"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-black uppercase tracking-tight focus:ring-2 focus:ring-[#978C21]/20 focus:border-[#978C21] outline-none"
                      />
                    </div>

                    <div className="space-y-3">
                      <label className="text-sm font-medium text-slate-600">{t('identityAvatarProfile')}</label>
                      
                      <div className="flex flex-col sm:flex-row items-center gap-8 p-6 bg-[#FBFAF8] rounded-sm border border-slate-100">
                        {/* Avatar Preview */}
                        <div className="w-20 h-20 rounded-sm bg-slate-900 flex items-center justify-center text-white text-2xl font-black border border-slate-800 shadow-md overflow-hidden shrink-0">
                          {avatarUrl ? (
                            <img src={avatarUrl} alt={t('preview')} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                          ) : (
                            newName.charAt(0) || 'U'
                          )}
                        </div>

                        {/* Controls */}
                        <div className="flex-1 space-y-4 w-full text-left">
                          <p className="text-[11px] text-slate-500 leading-normal uppercase tracking-tight font-bold">
                            {t('avatarHint')}
                          </p>
                          
                          <div className="flex flex-wrap gap-3">
                            <label className="px-4 py-3 bg-slate-900 hover:bg-black text-[#FBFAF8] text-[9px] font-black uppercase tracking-widest rounded-sm transition-all cursor-pointer shadow-md inline-block">
                              {t('uploadCustomImage')}
                              <input 
                                type="file" 
                                accept="image/*" 
                                className="hidden" 
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  if (file) {
                                    if (file.size > 1.5 * 1024 * 1024) {
                                      toast.error(t('assetLimitExceeded'));
                                      return;
                                    }
                                    const reader = new FileReader();
                                    reader.onload = () => {
                                      if (typeof reader.result === 'string') {
                                        setAvatarUrl(reader.result);
                                        toast.success(t('assetUploaded'));
                                      }
                                    };
                                    reader.readAsDataURL(file);
                                  }
                                }}
                              />
                            </label>

                            {avatarUrl && (
                              <button 
                                type="button"
                                onClick={() => {
                                  setAvatarUrl('');
                                  toast.success(t('avatarCleared'));
                                }}
                                className="px-4 py-3 border border-red-200 hover:bg-red-50 text-red-600 text-[9px] font-black uppercase tracking-widest rounded-sm transition-all"
                              >
                                {t('purgeAvatar')}
                              </button>
                            )}
                          </div>

                          <div className="space-y-2 pt-3 border-t border-slate-100">
                            <p className="text-xs font-medium text-slate-500">{t('quickPresets')}</p>
                            <div className="flex flex-wrap gap-2.5">
                              {[
                                'https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&q=80&w=150',
                                'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?auto=format&fit=crop&q=80&w=150',
                                'https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&q=80&w=150',
                                'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?auto=format&fit=crop&q=80&w=150',
                                'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&q=80&w=150'
                              ].map((preset, index) => (
                                <button
                                  key={index}
                                  type="button"
                                  onClick={() => {
                                    setAvatarUrl(preset);
                                    toast.success(t('presetChosen', { n: String(index + 1) }));
                                  }}
                                  className={`w-9 h-9 rounded-sm border overflow-hidden transition-all relative ${avatarUrl === preset ? 'ring-2 ring-[#978C21] border-[#978C21] scale-105' : 'border-slate-200 hover:border-slate-400'}`}
                                >
                                  <img src={preset} alt={`preset-${index}`} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                                </button>
                              ))}
                            </div>
                          </div>

                        </div>
                      </div>
                    </div>
                    
                    <button 
                      onClick={handleUpdateName}
                      disabled={loading}
                      className="w-full py-5 bg-slate-900 hover:bg-black text-white text-[11px] font-black uppercase tracking-[0.4em] transition-all rounded-sm flex items-center justify-center gap-4 italic disabled:opacity-50 shadow-xl"
                    >
                      {loading ? t('executingSync') : t('persistIntelligence')}
                    </button>
                  </div>
                </motion.div>
              ) : activeSection === 'security' ? (
                <motion.div 
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="bg-white p-10 rounded-sm border border-slate-100 shadow-sm space-y-8 italic"
                >
                  <div className="flex items-center justify-between border-b border-slate-50 pb-8">
                    <div className="flex items-center gap-4">
                      <button onClick={() => {
                        setActiveSection('overview');
                        setCurrentPassword('');
                        setNewPassword('');
                        setConfirmPassword('');
                      }} className="p-2 hover:bg-slate-50 rounded-sm">
                        <ArrowRight className="w-5 h-5 text-slate-300 rotate-180" />
                      </button>
                      <h3 className="font-bold text-xl text-slate-800">{t('securityAccessProtocol')}</h3>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest italic">{t('previousPassword')} *</label>
                      <input 
                        type="password"
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-black uppercase tracking-tight focus:ring-2 focus:ring-[#978C21]/20 focus:border-[#978C21] outline-none"
                        placeholder={t('enterPreviousPassword').toUpperCase()}
                      />
                    </div>

                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest italic">{t('newPasswordLabel')} *</label>
                      <input 
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-black uppercase tracking-tight focus:ring-2 focus:ring-[#978C21]/20 focus:border-[#978C21] outline-none"
                        placeholder={t('enterNewPassword').toUpperCase()}
                      />
                    </div>

                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest italic">{t('confirmNewPasswordLabel')} *</label>
                      <input 
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-black uppercase tracking-tight focus:ring-2 focus:ring-[#978C21]/20 focus:border-[#978C21] outline-none"
                        placeholder={t('repeatNewPassword').toUpperCase()}
                      />
                    </div>
                    
                    <button 
                      onClick={handleUpdatePassword}
                      disabled={passwordLoading}
                      className="w-full py-5 bg-[#978C21] hover:bg-[#867B1E] text-white text-[11px] font-black uppercase tracking-[0.4em] transition-all rounded-sm flex items-center justify-center gap-4 italic disabled:opacity-50 mt-4 shadow-xl"
                    >
                      {passwordLoading ? t('updatingEncryption') : t('updatePasswordProtocol')}
                    </button>
                  </div>
                </motion.div>
              ) : activeSection === 'sync' ? (
                <motion.div 
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="bg-white p-10 rounded-sm border border-slate-100 shadow-sm space-y-8 italic text-left"
                >
                  <div className="flex items-center justify-between border-b border-slate-50 pb-8">
                    <div className="flex items-center gap-4">
                      <button onClick={() => setActiveSection('overview')} className="p-2 hover:bg-slate-50 rounded-sm">
                        <ArrowRight className="w-5 h-5 text-slate-300 rotate-180" />
                      </button>
                      <h3 className="font-bold text-xl text-slate-800">{t('networkIntegrationSync')}</h3>
                    </div>
                  </div>

                  <div className="p-8 bg-[#FBFAF8] rounded-sm border border-slate-100 space-y-8">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6 border-b border-slate-200/50 pb-6">
                      <div>
                        <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-500">{t('operationalDatabaseMode')}</h4>
                        <p className="text-[14px] font-black uppercase tracking-tight mt-2 flex items-center gap-2">
                          <span className={cn("w-2.5 h-2.5 rounded-full inline-block animate-pulse", isOfflineMode ? "bg-amber-500" : "bg-emerald-500")} />
                          {isOfflineMode ? t('localStorageMode') : t('cloudDatabaseMode')}
                        </p>
                      </div>
                      <button
                        onClick={() => {
                          const targetState = !isOfflineMode;
                          useAuthStore.getState().setOfflineMode(targetState);
                           toast.success(targetState ? t('offlineModeEnabled') : t('onlineModeEnabled'));
                        }}
                        className={cn(
                          "px-6 py-3 text-[10px] font-black uppercase tracking-widest rounded-sm transition-all shadow-md border",
                          isOfflineMode ? "bg-emerald-50 border-emerald-200 text-emerald-600 hover:bg-emerald-100" : "bg-amber-50 border-amber-200 text-amber-600 hover:bg-amber-100"
                        )}
                      >
                        {isOfflineMode ? t('enableCloud') : t('disconnectOffline')}
                      </button>
                    </div>

                    {/* Database connection signal tracker */}
                    <div className="border-b border-slate-200/50 pb-6 space-y-4">
                      <div className="flex items-center justify-between">
                        <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-500">{t('databaseConnectionSignal')}</h4>
                        <button 
                          onClick={checkDbStatus}
                          disabled={dbChecking}
                          className="text-[9px] font-black uppercase tracking-widest text-[#978C21] hover:underline"
                        >
                          {dbChecking ? t('executingSync') : t('pingDatabase')}
                        </button>
                      </div>

                      {dbChecking ? (
                        <div className="p-4 bg-slate-50 rounded-sm border border-slate-100 flex items-center justify-center gap-3">
                          <span className="w-2.5 h-2.5 rounded-full inline-block bg-slate-400 animate-pulse" />
                          <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">{t('probingDatabase')}</p>
                        </div>
                      ) : dbStatus?.connected ? (
                        <div className="p-5 bg-emerald-50/50 rounded-sm border border-emerald-100 space-y-3">
                          <div className="flex items-center gap-3">
                            <Radio className="w-5 h-5 text-emerald-600 animate-pulse" />
                            <div>
                              <p className="text-[11px] font-black text-emerald-600 uppercase tracking-widest">{t('excellentSignal')}</p>
                              <p className="text-[10px] text-emerald-500 font-bold uppercase mt-0.5">{dbStatus.message}</p>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="p-5 bg-amber-50/50 rounded-sm border border-amber-100 space-y-4 text-left">
                          <div className="flex items-start gap-3">
                            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                            <div>
                              <p className="text-[11px] font-black text-amber-700 uppercase tracking-widest">{t('noSignalFallback')}</p>
                              <p className="text-[10px] text-amber-600 font-bold uppercase mt-1 leading-relaxed">
                                {dbStatus?.message || t('noConnectionMessage')}
                              </p>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="space-y-4">
                      <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-500">{t('databaseSynchronization')}</h4>
                      <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider leading-relaxed">
                        {t('syncSectionDesc')}
                      </p>
                      <button
                        onClick={async () => {
                          setLoading(true);
                          try {
                            const result = await databaseStatusService.checkDatabaseStatus();
                            if (result && result.connected) {
                              toast.success(t('syncConnectedOk'));
                            } else {
                              toast.error(result?.message || t('dbConnectionFailed'));
                            }
                          } catch (err) {
                            toast.error(t('syncFailedGeneric'));
                          } finally {
                            setLoading(false);
                          }
                        }}
                        disabled={loading}
                        className="w-full flex items-center justify-center gap-3 bg-slate-900 hover:bg-black text-[#FBFAF8] text-[10px] font-black uppercase tracking-widest py-4 rounded shadow-md transition-all active:scale-[0.99] group cursor-pointer disabled:opacity-50"
                      >
                        <Globe className="w-4 h-4 text-[#978C21] transition-transform group-hover:rotate-12" />
                        {loading ? t('executingSync') : t('runCloudSync')}
                      </button>
                    </div>
                  </div>
                </motion.div>
              ) : activeSection === 'notifications' ? (
                <motion.div 
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="bg-white p-10 rounded-sm border border-slate-100 shadow-sm space-y-8 italic text-left"
                >
                  <div className="flex items-center justify-between border-b border-slate-50 pb-8">
                    <div className="flex items-center gap-4">
                      <button onClick={() => setActiveSection('overview')} className="p-2 hover:bg-slate-50 rounded-sm">
                        <ArrowRight className="w-5 h-5 text-slate-300 rotate-180" />
                      </button>
                      <h3 className="font-bold text-xl text-slate-800">{t('pushIntelligenceAlerts')}</h3>
                    </div>
                  </div>

                  <div className="p-8 bg-[#FBFAF8] rounded-sm border border-slate-100 space-y-6">
                    <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-500">{t('customAlertsConfig')}</h4>
                    <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider leading-relaxed">
                      {t('alertsConfigDesc')}
                    </p>

                    <div className="space-y-4 pt-4 border-t border-slate-150">
                      {[
                        { label: t('notifAssignments'), desc: t('notifAssignmentsDesc'), enabled: true },
                        { label: t('notifManagers'), desc: t('notifManagersDesc'), enabled: true },
                        { label: t('notifTomorrow'), desc: t('notifTomorrowDesc'), enabled: true },
                      ].map((n, i) => (
                        <div key={i} className="flex items-center justify-between p-4 bg-white border border-slate-100 rounded-sm">
                          <div>
                            <p className="text-[11px] font-black text-slate-700 uppercase">{n.label}</p>
                            <p className="text-[9px] font-bold text-slate-400 uppercase mt-1">{n.desc}</p>
                          </div>
                          <span className="px-3 py-1 bg-emerald-50 text-emerald-600 text-[9px] font-black uppercase tracking-widest rounded border border-emerald-150">{t('active')}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </motion.div>
              ) : activeSection === 'system' ? (
                <motion.div 
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="bg-white p-10 rounded-sm border border-slate-100 shadow-sm space-y-8 italic text-left"
                >
                  <div className="flex items-center justify-between border-b border-slate-50 pb-8">
                    <div className="flex items-center gap-4">
                      <button onClick={() => setActiveSection('overview')} className="p-2 hover:bg-slate-50 rounded-sm">
                        <ArrowRight className="w-5 h-5 text-slate-300 rotate-180" />
                      </button>
                      <h3 className="font-bold text-xl text-slate-800">{t('systemConfiguration')}</h3>
                    </div>
                  </div>

                  <div className="p-8 bg-[#FBFAF8] rounded-sm border border-slate-100 space-y-6">
                    <div>
                      <h4 className="text-[11px] font-black uppercase tracking-widest text-[#978C21]">{t('interfaceCustomization')}</h4>
                      <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider leading-relaxed mt-2">
                        {t('interfaceCustomizationDesc')}
                      </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-slate-150">
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase">{t('defaultVizPeriod')}</label>
                        <select className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest outline-none" defaultValue="TODAY">
                          <option value="TODAY">{t('todayOnly')}</option>
                          <option value="THIS MONTH">{t('currentMonth')}</option>
                          <option value="LAST MONTH">{t('lastMonth')}</option>
                        </select>
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] font-black text-slate-400 uppercase">{t('animationsRate')}</label>
                        <select className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest outline-none" defaultValue="NORMAL">
                          <option value="NORMAL">{t('animStandard')}</option>
                          <option value="FAST">{t('animFast')}</option>
                          <option value="REDUCED">{t('animReduced')}</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </motion.div>
              ) : (
                <motion.div 
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="bg-white p-20 rounded-sm border border-slate-100 shadow-sm text-center italic"
                >
                  <button onClick={() => setActiveSection('overview')} className="mb-10 text-[10px] font-black text-[#978C21] uppercase tracking-widest flex items-center gap-2 mx-auto">
                    <ArrowRight className="w-4 h-4 rotate-180" /> {t('returnToCommand')}
                  </button>
                  <h3 className="text-2xl font-black uppercase tracking-tighter text-slate-200 serif">{t('protocolOffline')}</h3>
                  <p className="text-[10px] font-black text-slate-300 uppercase tracking-[0.3em] mt-4">{t('moduleClearanceRequired')}</p>
                </motion.div>
              )}
            </div>
          </motion.div>
        ) : activeTab === 'dropdowns' ? (
          <motion.div 
            key="dropdowns"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="bg-white rounded-sm border border-slate-100 shadow-sm overflow-hidden italic"
          >
            <div className="p-10 border-b border-slate-50 bg-[#FBFAF8] flex flex-col md:flex-row md:items-end justify-between gap-6">
              <div className="space-y-4 flex-1 max-w-md">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">{t('parameterCategory')}</label>
                <select 
                  value={editingOption.type}
                  onChange={(e) => setEditingOption({ ...editingOption, type: e.target.value })}
                  className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest focus:ring-2 focus:ring-[#978C21]/10 outline-none"
                >
                  {metadataTypes.map(t => (
                    <option key={t.key} value={t.key}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-4 flex-1 max-w-md">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">{t('newMatrixProperty')}</label>
                <div className="flex gap-2">
                  <input 
                    type="text"
                    value={editingOption.value}
                    onChange={(e) => setEditingOption({ ...editingOption, value: e.target.value })}
                    placeholder={t('enterValue').toUpperCase()}
                    className="flex-1 bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest focus:ring-2 focus:ring-[#978C21]/10 outline-none placeholder:opacity-30"
                  />
                  <button 
                    onClick={handleAddOption}
                    className="bg-[#978C21] text-white px-6 py-3 rounded-sm font-black text-[11px] uppercase tracking-widest hover:bg-black transition-all flex items-center gap-2 shadow-lg"
                  >
                    <Plus className="w-4 h-4" />
                    {t('inject')}
                  </button>
                </div>
              </div>
              <div className="space-y-4">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">&nbsp;</label>
                <button
                  onClick={() => setIsAddingType(v => !v)}
                  className="border border-[#978C21]/30 text-[#978C21] px-6 py-3 rounded-sm font-black text-[11px] uppercase tracking-widest hover:bg-[#978C21]/5 transition-all flex items-center gap-2"
                >
                  <Plus className="w-4 h-4" />
                  {t('newFieldType')}
                </button>
              </div>
            </div>

            {isAddingType && (
              <div className="px-10 py-6 border-b border-slate-50 bg-white flex flex-col md:flex-row items-end gap-4">
                <div className="flex-1 space-y-2 w-full">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">{t('newTypeName')}</label>
                  <input
                    type="text"
                    value={newTypeForm.label}
                    onChange={(e) => setNewTypeForm({ ...newTypeForm, label: e.target.value })}
                    placeholder={t('newTypeNamePlaceholder')}
                    className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest focus:ring-2 focus:ring-[#978C21]/10 outline-none placeholder:opacity-30"
                  />
                </div>
                <div className="flex-1 space-y-2 w-full">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">{t('descriptionOptional')}</label>
                  <input
                    type="text"
                    value={newTypeForm.description}
                    onChange={(e) => setNewTypeForm({ ...newTypeForm, description: e.target.value })}
                    placeholder={t('descriptionPlaceholder')}
                    className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest focus:ring-2 focus:ring-[#978C21]/10 outline-none placeholder:opacity-30"
                  />
                </div>
                <button
                  onClick={handleAddType}
                  className="bg-[#978C21] text-white px-6 py-3 rounded-sm font-black text-[11px] uppercase tracking-widest hover:bg-black transition-all shadow-lg whitespace-nowrap"
                >
                  {t('createType')}
                </button>
              </div>
            )}

            <div className="p-10">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {metadataTypes.map((t) => {
                  const values = options
                    .filter(o => o.type === t.key)
                    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
                  return (
                    <div key={t.key} className="space-y-4">
                      <div className="flex items-center justify-between border-b-2 border-[#978C21]/20 pb-2">
                        <div className="flex items-center gap-2">
                          <h5 className="text-[11px] font-black text-brand-text uppercase tracking-[0.2em] italic">{t.label}</h5>
                          {t.isSystem && (
                            <span className="text-[8px] font-black text-[#978C21] bg-[#978C21]/10 px-1.5 py-0.5 rounded-sm uppercase tracking-wider">{t('system')}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-slate-500">{t('entriesCount', { count: String(values.length) })}</span>
                          {!t.isSystem && (
                            <button
                              onClick={() => handleDeleteType(t)}
                              title={t('deleteThisType')}
                              className="text-slate-300 hover:text-red-500 transition-all"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="space-y-2 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar">
                        {values.map((option, i) => (
                          <div 
                            key={option.id || i}
                            className={cn(
                              "flex items-center justify-between px-4 py-3 bg-slate-50 border border-slate-100 rounded-sm group hover:bg-white hover:border-[#978C21]/30 transition-all gap-2",
                              option.status !== 'Active' && "opacity-50"
                            )}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              {t.key === 'FollowUpStatus' && (
                                <select
                                  value={option.meta?.color || 'slate'}
                                  onChange={(e) => handleSetStatusColor(option, e.target.value)}
                                  style={{ backgroundColor: STATUS_COLOR_HEX[option.meta?.color || 'slate'] }}
                                  className="w-5 h-5 rounded-full border-0 text-[0px] shrink-0 cursor-pointer appearance-none"
                                  title={t('statusColor')}
                                >
                                  {STATUS_COLOR_CHOICES.map(c => <option key={c} value={c}>{c}</option>)}
                                </select>
                              )}
                              <span className="text-[11px] font-bold text-slate-600 uppercase tracking-tight truncate">{option.label || option.value}</span>
                            </div>
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                              <button onClick={() => handleMove(t.key, i, -1)} disabled={i === 0} className="p-1 text-slate-300 hover:text-[#978C21] disabled:opacity-20 disabled:cursor-not-allowed">
                                <ArrowUp className="w-3.5 h-3.5" />
                              </button>
                              <button onClick={() => handleMove(t.key, i, 1)} disabled={i === values.length - 1} className="p-1 text-slate-300 hover:text-[#978C21] disabled:opacity-20 disabled:cursor-not-allowed">
                                <ArrowDown className="w-3.5 h-3.5" />
                              </button>
                              <button onClick={() => handleToggleActive(option)} title={option.status === 'Active' ? t('deactivate') : t('activate')} className="p-1 text-slate-300 hover:text-[#978C21]">
                                <Power className="w-3.5 h-3.5" />
                              </button>
                              <button 
                                onClick={() => handleDeleteOption(option)}
                                className="p-1 text-slate-300 hover:text-red-500 transition-all"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        ))}
                        {values.length === 0 && (
                          <p className="text-[10px] text-slate-300 uppercase tracking-widest italic py-4 text-center">{t('noValuesYet')}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </motion.div>
        ) : activeTab === 'formbuilder' ? (
          <motion.div 
            key="formbuilder"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="bg-white rounded-sm border border-slate-100 shadow-sm overflow-hidden italic"
          >
            <div className="p-10 border-b border-slate-50 bg-[#FBFAF8] flex flex-col md:flex-row md:items-end justify-between gap-6">
              <div>
                <h5 className="text-[13px] font-black text-brand-text uppercase tracking-[0.15em]">{t('leadGenerateFormFields')}</h5>
                <p className="text-[10px] text-slate-400 uppercase tracking-widest mt-2 not-italic">
                  {t('formFieldsDesc')}
                </p>
              </div>
              <button
                onClick={() => setIsAddingField(true)}
                className="bg-[#978C21] text-white px-6 py-3 rounded-sm font-black text-[11px] uppercase tracking-widest hover:bg-black transition-all flex items-center gap-2 shadow-lg whitespace-nowrap"
              >
                <Plus className="w-4 h-4" />
                {t('newField')}
              </button>
            </div>

            {isAddingField && (
              <div className="px-10 py-6 border-b border-slate-50 bg-white grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 items-end">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">{t('fieldLabel')}</label>
                  <input
                    type="text"
                    value={newFieldForm.label}
                    onChange={(e) => setNewFieldForm({ ...newFieldForm, label: e.target.value })}
                    placeholder={t('fieldLabelPlaceholder')}
                    className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest focus:ring-2 focus:ring-[#978C21]/10 outline-none placeholder:opacity-30"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">{t('fieldType')}</label>
                  <select
                    value={newFieldForm.fieldType}
                    onChange={(e) => setNewFieldForm({ ...newFieldForm, fieldType: e.target.value as FormFieldType })}
                    className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest focus:ring-2 focus:ring-[#978C21]/10 outline-none"
                  >
                    <option value="text">{t('text')}</option>
                    <option value="number">{t('number')}</option>
                    <option value="dropdown">{t('dropdown')}</option>
                    <option value="date">{t('date')}</option>
                    <option value="textarea">{t('longText')}</option>
                    <option value="checkbox">{t('checkbox')}</option>
                  </select>
                </div>
                {newFieldForm.fieldType === 'dropdown' && (
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">{t('valuesFrom')}</label>
                    <select
                      value={newFieldForm.metadataTypeKey}
                      onChange={(e) => setNewFieldForm({ ...newFieldForm, metadataTypeKey: e.target.value })}
                      className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest focus:ring-2 focus:ring-[#978C21]/10 outline-none"
                    >
                      <option value="">{t('selectMetadataType')}</option>
                      {metadataTypes.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
                    </select>
                  </div>
                )}
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">{t('mandatory')}?</label>
                  <button
                    onClick={() => setNewFieldForm({ ...newFieldForm, isMandatory: !newFieldForm.isMandatory })}
                    className={cn(
                      "w-full border rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest transition-all",
                      newFieldForm.isMandatory ? "bg-[#978C21] text-white border-[#978C21]" : "bg-white text-slate-400 border-slate-200"
                    )}
                  >
                    {newFieldForm.isMandatory ? t('required') : t('optional')}
                  </button>
                </div>
                <button
                  onClick={handleAddField}
                  className="bg-[#978C21] text-white px-6 py-3 rounded-sm font-black text-[11px] uppercase tracking-widest hover:bg-black transition-all shadow-lg"
                >
                  {t('createField')}
                </button>
              </div>
            )}

            <div className="p-10 space-y-8">
              {['Identity', 'Location', 'Business', 'Additional'].map(section => {
                const fields = formFields
                  .filter(f => f.section === section)
                  .sort((a, b) => a.sortOrder - b.sortOrder);
                if (fields.length === 0) return null;
                return (
                  <div key={section} className="space-y-3">
                    <h6 className="text-[11px] font-black text-brand-text uppercase tracking-[0.2em] border-b-2 border-[#978C21]/20 pb-2">{section}</h6>
                    <div className="space-y-2">
                      {fields.map((field, i) => (
                        <div
                          key={field.id}
                          className={cn(
                            "flex items-center justify-between px-4 py-3 bg-slate-50 border border-slate-100 rounded-sm group hover:bg-white hover:border-[#978C21]/30 transition-all gap-3",
                            !field.isVisible && "opacity-50"
                          )}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <span className="text-[11px] font-bold text-slate-600 uppercase tracking-tight truncate">{field.label}</span>
                            <span className="text-[8px] font-black text-slate-400 bg-slate-200/60 px-1.5 py-0.5 rounded-sm uppercase tracking-wider shrink-0">{field.fieldType}</span>
                            {field.isSystem && (
                              <span className="text-[8px] font-black text-[#978C21] bg-[#978C21]/10 px-1.5 py-0.5 rounded-sm uppercase tracking-wider shrink-0">{t('system')}</span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 shrink-0">
                            <button
                              onClick={() => handleToggleFieldMandatory(field)}
                              className={cn(
                                "text-[9px] font-black uppercase tracking-widest px-2 py-1 rounded-sm border",
                                field.isMandatory ? "bg-red-50 text-red-600 border-red-100" : "bg-white text-slate-400 border-slate-200"
                              )}
                            >
                              {field.isMandatory ? t('required') : t('optional')}
                            </button>
                            <button onClick={() => handleMoveField(section, i, -1)} disabled={i === 0} className="p-1 text-slate-300 hover:text-[#978C21] disabled:opacity-20 disabled:cursor-not-allowed">
                              <ArrowUp className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => handleMoveField(section, i, 1)} disabled={i === fields.length - 1} className="p-1 text-slate-300 hover:text-[#978C21] disabled:opacity-20 disabled:cursor-not-allowed">
                              <ArrowDown className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => handleToggleFieldVisible(field)} title={field.isVisible ? t('hideField') : t('showField')} className="p-1 text-slate-300 hover:text-[#978C21]">
                              <Power className="w-3.5 h-3.5" />
                            </button>
                            {!field.isSystem && (
                              <button onClick={() => handleDeleteField(field)} className="p-1 text-slate-300 hover:text-red-500 transition-all">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </motion.div>
        ) : (
          <motion.div 
            key="workflow"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="bg-white rounded-sm border border-slate-100 shadow-sm overflow-hidden italic"
          >
            <div className="p-10 border-b border-slate-50 bg-[#FBFAF8]">
              <h5 className="text-[13px] font-black text-brand-text uppercase tracking-[0.15em]">{t('workflowTitle')}</h5>
              <p className="text-[10px] text-slate-400 uppercase tracking-widest mt-2 not-italic">
                {t('workflowDesc')}
              </p>
            </div>

            <div className="p-10 space-y-6">
              {allStatuses.map(status => {
                const rule = getRuleForStatus(status);
                const isRestricted = !!(rule?.allowedNextStatuses && rule.allowedNextStatuses.length > 0);
                return (
                  <div key={status} className="border border-slate-100 rounded-sm overflow-hidden">
                    <div className="px-6 py-4 bg-slate-50 flex items-center justify-between flex-wrap gap-3">
                      <h6 className="text-[12px] font-black text-brand-text uppercase tracking-[0.15em]">{status}</h6>
                      <div className="flex items-center gap-4 flex-wrap">
                        <label className="flex items-center gap-2 text-[9px] font-black uppercase tracking-widest text-slate-500 cursor-pointer">
                          <input type="checkbox" checked={!!rule?.requiresLossReason} onChange={() => handleToggleRequirement(status, 'requiresLossReason')} />
                          {t('requiresLossReason')}
                        </label>
                        <label className="flex items-center gap-2 text-[9px] font-black uppercase tracking-widest text-slate-500 cursor-pointer">
                          <input type="checkbox" checked={!!rule?.requiresMeetingType} onChange={() => handleToggleRequirement(status, 'requiresMeetingType')} />
                          {t('requiresMeetingType')}
                        </label>
                        <label className="flex items-center gap-2 text-[9px] font-black uppercase tracking-widest text-slate-500 cursor-pointer">
                          <input type="checkbox" checked={!!rule?.requiresFollowUpType} onChange={() => handleToggleRequirement(status, 'requiresFollowUpType')} />
                          {t('requiresFollowUpType')}
                        </label>
                        <label className="flex items-center gap-2 text-[9px] font-black uppercase tracking-widest text-slate-500 cursor-pointer">
                          <input type="checkbox" checked={!!rule?.requiresNote} onChange={() => handleToggleRequirement(status, 'requiresNote')} />
                          {t('requiresNote')}
                        </label>
                      </div>
                    </div>
                    <div className="p-6">
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">
                          {t('canMoveTo', { target: isRestricted ? `(${rule!.allowedNextStatuses!.length})` : t('anyStatusUnrestricted') })}
                        </p>
                        {isRestricted && (
                          <button onClick={() => handleResetToUnrestricted(status)} className="text-[9px] font-black text-[#978C21] uppercase tracking-widest hover:underline">
                            {t('resetToUnrestricted')}
                          </button>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {allStatuses.filter(s => s !== status).map(target => {
                          const isAllowed = !isRestricted || rule!.allowedNextStatuses!.includes(target);
                          return (
                            <button
                              key={target}
                              onClick={() => handleToggleNextStatus(status, target)}
                              className={cn(
                                "px-3 py-1.5 rounded-sm text-[9px] font-black uppercase tracking-widest border transition-all",
                                isAllowed ? "bg-[#978C21]/10 text-[#978C21] border-[#978C21]/30" : "bg-slate-50 text-slate-300 border-slate-100"
                              )}
                            >
                              {target}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}
              {allStatuses.length === 0 && (
                <p className="text-[10px] text-slate-300 uppercase tracking-widest italic py-8 text-center">
                  {t('noStatusesFound')}
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
