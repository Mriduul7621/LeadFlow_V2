import React, { useEffect, useRef, useState } from 'react';
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
  AlertTriangle,
  Timer,
  CalendarDays,
  ShieldAlert,
  Lock,
  Upload,
  Download,
  FileJson,
  SlidersHorizontal
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
import { calendarService, type CalendarHoliday, type HolidayImportResult } from '../../calendar/services/calendarService';
import { notificationSettingsService, type NotificationSettings } from '../services/notificationSettingsService';
import { operationsSettingsService, OPERATIONS_LIMITS, DEFAULT_OPERATIONS_SETTINGS, type OperationsSettings } from '../services/operationsSettingsService';
import { dangerZoneService, type DangerZoneOverview } from '../services/dangerZoneService';
import DangerZoneLeadQuality from '../components/DangerZoneLeadQuality';
import DangerZoneRoleDefaults from '../components/DangerZoneRoleDefaults';
import DangerZoneSecurityPolicy from '../components/DangerZoneSecurityPolicy';
import { DropdownOption, MetadataType, FormField, FormFieldType, WorkflowRule, UserRole } from '../../shared/types';
import { toast } from 'sonner';
import { cn } from '../../../lib/utils';

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_LABELS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const STATUS_COLOR_CHOICES = ['slate', 'blue', 'amber', 'orange', 'teal', 'indigo', 'purple', 'violet', 'yellow', 'green', 'red'];
const STATUS_COLOR_HEX: Record<string, string> = {
  slate: '#94a3b8', blue: '#3b82f6', amber: '#f59e0b', orange: '#f97316',
  teal: '#14b8a6', indigo: '#6366f1', purple: '#a855f7', violet: '#8b5cf6',
  yellow: '#eab308', green: '#22c55e', red: '#ef4444',
};

export default function Settings() {
  const { user, logout, login, isOfflineMode } = useAuthStore();
  const { canAccess } = usePermissions();
  const navigate = useNavigate();
  const userRoleNormalized = (user?.role || '').toUpperCase();
  const isSystemAdmin = ['ADMIN', 'SUPERADMIN'].includes(userRoleNormalized);
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
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearConfirmText, setClearConfirmText] = useState('');
  const [clearingData, setClearingData] = useState(false);

  // Lead Auto-Assignment feature switch (Phase 3): a Metadata Engine
  // option — type 'LeadAutoAssignment', value 'enabled', status is the
  // switch. Seeded Inactive by migration 049; missing row = OFF.
  const [autoAssignOption, setAutoAssignOption] = useState<DropdownOption | null>(null);
  const [autoAssignLoaded, setAutoAssignLoaded] = useState(false);
  const [autoAssignSaving, setAutoAssignSaving] = useState(false);
  const autoAssignEnabled = autoAssignOption?.status === 'Active';

  // First-Contact SLA (Phase 3 PR #3): Metadata Engine options — type
  // 'LeadSla': value 'enabled' is the switch (seeded Inactive by
  // migration 051; missing row = OFF), value 'firstContactHours'
  // carries the window in meta.hours (default 24).
  const [slaEnabledOption, setSlaEnabledOption] = useState<DropdownOption | null>(null);
  const [slaLoaded, setSlaLoaded] = useState(false);
  const [slaSaving, setSlaSaving] = useState(false);
  const [slaHoursDraft, setSlaHoursDraft] = useState('24');
  const slaEnabled = slaEnabledOption?.status === 'Active';

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
        setDbStatus({ connected: false, message: 'Endpoint returned an error status.' });
      }
    } catch (e) {
      setDbStatus({ connected: false, message: 'Could not contact backend system status service.' });
    } finally {
      setDbChecking(false);
    }
  };

  useEffect(() => {
    if (activeSection === 'sync') {
      checkDbStatus();
    }
  }, [activeSection]);

  useEffect(() => {
    if (!isSystemAdmin) return;
    let cancelled = false;
    metadataService.getAllValues('LeadAutoAssignment')
      .then(values => {
        if (cancelled) return;
        setAutoAssignOption(values.find(v => v.value === 'enabled') || null);
        setAutoAssignLoaded(true);
      })
      .catch(() => { if (!cancelled) setAutoAssignLoaded(true); });
    return () => { cancelled = true; };
  }, [isSystemAdmin]);

  useEffect(() => {
    if (!isSystemAdmin) return;
    let cancelled = false;
    metadataService.getAllValues('LeadSla')
      .then(values => {
        if (cancelled) return;
        setSlaEnabledOption(values.find(v => v.value === 'enabled') || null);
        const hoursRow = values.find(v => v.value === 'firstContactHours') || null;
        const h = Number(hoursRow?.meta?.hours);
        setSlaHoursDraft(String(Number.isFinite(h) && h > 0 ? Math.round(h) : 24));
        setSlaLoaded(true);
      })
      .catch(() => { if (!cancelled) setSlaLoaded(true); });
    return () => { cancelled = true; };
  }, [isSystemAdmin]);

  const handleToggleAutoAssign = async () => {
    if (autoAssignSaving) return;
    setAutoAssignSaving(true);
    try {
      if (!autoAssignOption) {
        // First enable on a database where the seeded row is absent
        // (e.g. legacy-adopted): create the switch in its ON state.
        const saved = await metadataService.addValue(
          'LeadAutoAssignment', 'enabled',
          { featureFlag: true, rule: 'least_loaded' },
          'Auto-assign unassigned leads'
        );
        setAutoAssignOption(saved);
        toast.success('Lead auto-assignment enabled');
      } else {
        const saved = await metadataService.toggleActive(autoAssignOption);
        setAutoAssignOption(saved);
        toast.success(saved.status === 'Active' ? 'Lead auto-assignment enabled' : 'Lead auto-assignment disabled');
      }
    } catch {
      toast.error('Could not update the auto-assignment switch');
    } finally {
      setAutoAssignSaving(false);
    }
  };

  const handleToggleSla = async () => {
    if (slaSaving) return;
    setSlaSaving(true);
    try {
      if (!slaEnabledOption) {
        // First enable on a database where the seeded row is absent
        // (e.g. legacy-adopted): create the switch in its ON state.
        const saved = await metadataService.addValue(
          'LeadSla', 'enabled',
          { featureFlag: true },
          'First-contact SLA tracking'
        );
        setSlaEnabledOption(saved);
        toast.success('First-contact SLA tracking enabled');
      } else {
        const saved = await metadataService.toggleActive(slaEnabledOption);
        setSlaEnabledOption(saved);
        toast.success(saved.status === 'Active' ? 'First-contact SLA tracking enabled' : 'First-contact SLA tracking disabled');
      }
    } catch {
      toast.error('Could not update the SLA switch');
    } finally {
      setSlaSaving(false);
    }
  };

  const handleSaveSlaHours = async () => {
    if (slaSaving) return;
    const hours = Math.round(Number(slaHoursDraft));
    if (!Number.isFinite(hours) || hours < 1 || hours > 720) {
      toast.error('SLA window must be between 1 and 720 hours');
      return;
    }
    setSlaSaving(true);
    try {
      await metadataService.addValue(
        'LeadSla', 'firstContactHours',
        { hours },
        'First-contact window (hours)'
      );
      setSlaHoursDraft(String(hours));
      toast.success(`First-contact SLA window set to ${hours}h`);
    } catch {
      toast.error('Could not update the SLA window');
    } finally {
      setSlaSaving(false);
    }
  };

  // Calendar Settings (calendar upgrade PR C): weekend days +
  // government holidays from GET /calendar/config; mutations are
  // gated server-side by settings.manage. Weekend default is
  // Fri + Sat ([5, 6]) — seeded by migration 056.
  const canEditCalendar = isSystemAdmin || canAccess('admin_settings', 'configure_global_metadata');

  // Notification toggles (Admin Control programme, DZ-1 — Honest
  // Settings): these are REAL persisted settings served by
  // GET /notifications/settings. The switches in Push Intelligence
  // write through immediately, and the server gates the actual
  // behaviour — assignment notifications and the daily push summary
  // genuinely stop when their switch is off. Nothing on that card is
  // display-only any more.
  const canEditNotifications = canEditCalendar;
  const [notifSettings, setNotifSettings] = useState<NotificationSettings>({ assigneeAlerts: true, uplineAlerts: true, assignmentAlerts: true, dailyPushSummary: true, meetingNotifications: true });
  const [notifLoaded, setNotifLoaded] = useState(false);
  const [notifSavingKey, setNotifSavingKey] = useState<string | null>(null);

  // Operations & Limits (Admin Control programme, DZ-2): the bounded
  // caps (G1/G2/M1) are real Settings values served by
  // GET /settings/operations. Loaded on mount because the profile
  // image upload in the Overview tab enforces the effective image
  // cap; until loaded, the defaults (the old hardcoded values) apply.
  const canEditOperations = canEditCalendar;
  const [opsSettings, setOpsSettings] = useState<OperationsSettings>({ ...DEFAULT_OPERATIONS_SETTINGS });
  const [opsDraft, setOpsDraft] = useState<OperationsSettings>({ ...DEFAULT_OPERATIONS_SETTINGS });
  const [opsLoaded, setOpsLoaded] = useState(false);
  const [opsSaving, setOpsSaving] = useState(false);
  const opsDirty = JSON.stringify(opsDraft) !== JSON.stringify(opsSettings);
  const [calendarLoaded, setCalendarLoaded] = useState(false);
  const [weekendDraft, setWeekendDraft] = useState<number[]>([5, 6]);
  const [weekendSaved, setWeekendSaved] = useState<number[]>([5, 6]);
  const [weekendSaving, setWeekendSaving] = useState(false);
  const [holidays, setHolidays] = useState<CalendarHoliday[]>([]);
  const [holidayYear, setHolidayYear] = useState<string>('all');
  const [holidayForm, setHolidayForm] = useState<{ date: string; name: string; nameBn: string; category: 'general' | 'executive'; moonDependent: boolean; regional: boolean }>({
    date: '', name: '', nameBn: '', category: 'general', moonDependent: false, regional: false,
  });
  const [editingHolidayId, setEditingHolidayId] = useState<string | null>(null);
  const [holidaySaving, setHolidaySaving] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Danger Zone (Admin Control programme, DZ-0): super-admin only.
  // The section renders only for ADMIN/SUPERADMIN sessions, but the
  // server is the real gate — it re-resolves the role from the
  // database, so a stale session lands on 'forbidden' here. The
  // client keeps NO unlock state: status is asked fresh on entry,
  // and a `danger_zone_locked` answer drops straight back to the
  // password prompt. The unlock lasts 10 minutes and never extends.
  type DzState = 'idle' | 'loading' | 'locked' | 'unlocked' | 'forbidden' | 'unavailable';
  const [dzState, setDzState] = useState<DzState>('idle');
  const [dzPassword, setDzPassword] = useState('');
  const [dzError, setDzError] = useState('');
  const [dzBusy, setDzBusy] = useState(false);
  const [dzSecondsLeft, setDzSecondsLeft] = useState(0);
  const [dzOverview, setDzOverview] = useState<DangerZoneOverview | null>(null);

  const loadDangerZone = async () => {
    setDzState('loading');
    setDzError('');
    try {
      const status = await dangerZoneService.getStatus();
      if (!status.unlocked) {
        setDzOverview(null);
        setDzSecondsLeft(0);
        setDzState('locked');
        return;
      }
      const overview = await dangerZoneService.getOverview();
      setDzOverview(overview);
      setDzSecondsLeft(overview.unlock.secondsRemaining);
      setDzState('unlocked');
    } catch (err: any) {
      if (err?.data?.error === 'danger_zone_locked') {
        setDzOverview(null);
        setDzState('locked');
      } else if (err?.status === 403) {
        setDzState('forbidden');
      } else {
        setDzState('unavailable');
      }
    }
  };

  useEffect(() => {
    if (activeSection !== 'danger-zone') return;
    setDzPassword('');
    void loadDangerZone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection]);

  useEffect(() => {
    if (dzState !== 'unlocked') return;
    const timer = setInterval(() => {
      setDzSecondsLeft(prev => {
        if (prev <= 1) {
          setDzOverview(null);
          setDzState('locked');
          toast.error('Danger Zone locked — the 10 minutes are up. Re-enter your password to continue.');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [dzState]);

  const handleDzUnlock = async () => {
    if (!dzPassword) {
      setDzError('Enter your login password.');
      return;
    }
    setDzBusy(true);
    setDzError('');
    try {
      await dangerZoneService.unlock(dzPassword);
      setDzPassword('');
      await loadDangerZone();
    } catch (err: any) {
      setDzError(err?.message || 'Unlock failed. Check your password and try again.');
    } finally {
      setDzBusy(false);
    }
  };

  const handleDzLock = async () => {
    setDzBusy(true);
    try {
      await dangerZoneService.lock();
    } catch {
      // Even if the call fails, drop the local view — the server-side
      // unlock expires on its own within the 10 minutes regardless.
    } finally {
      setDzBusy(false);
      setDzOverview(null);
      setDzSecondsLeft(0);
      setDzState('locked');
    }
  };

  useEffect(() => {
    if (activeSection !== 'calendar' || calendarLoaded) return;
    let cancelled = false;
    calendarService.getConfig()
      .then(cfg => {
        if (cancelled) return;
        setWeekendDraft(cfg.weekendDays);
        setWeekendSaved(cfg.weekendDays);
        setHolidays(cfg.holidays);
        setCalendarLoaded(true);
      })
      .catch(() => { if (!cancelled) setCalendarLoaded(true); });
    return () => { cancelled = true; };
  }, [activeSection, calendarLoaded]);

  useEffect(() => {
    if (activeSection !== 'notifications' || notifLoaded) return;
    let cancelled = false;
    notificationSettingsService.getSettings()
      .then(s => {
        if (cancelled) return;
        setNotifSettings(s);
        setNotifLoaded(true);
      })
      .catch(() => { if (!cancelled) setNotifLoaded(true); });
    return () => { cancelled = true; };
  }, [activeSection, notifLoaded]);

  // Operations limits load once (the image-upload cap in Overview
  // needs the effective value even before this section is opened).
  useEffect(() => {
    let cancelled = false;
    operationsSettingsService.getSettings()
      .then(s => {
        if (cancelled) return;
        setOpsSettings(s);
        setOpsDraft(s);
        setOpsLoaded(true);
      })
      .catch(() => { if (!cancelled) setOpsLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  const handleSaveOperations = async () => {
    if (!canEditOperations || opsSaving || !opsDirty) return;
    for (const [key, { min, max }] of Object.entries(OPERATIONS_LIMITS)) {
      const value = opsDraft[key as keyof OperationsSettings];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        toast.error(`${key} must be between ${min} and ${max}. Nothing was changed.`);
        return;
      }
    }
    setOpsSaving(true);
    try {
      const saved = await operationsSettingsService.saveSettings(opsDraft);
      setOpsSettings(saved);
      setOpsDraft(saved);
      toast.success('Operations limits saved — they apply right away.');
    } catch {
      toast.error('Could not save operations limits. Nothing was changed.');
    } finally {
      setOpsSaving(false);
    }
  };

  const handleToggleNotification = async (key: keyof NotificationSettings) => {
    if (!canEditNotifications || notifSavingKey) return;
    const next = !notifSettings[key];
    setNotifSavingKey(key);
    try {
      const saved = await notificationSettingsService.saveSettings({ [key]: next });
      setNotifSettings(saved);
      toast.success(next ? 'Turned on — it applies right away.' : 'Turned off — it applies right away.');
    } catch {
      toast.error('Could not save that setting. Nothing was changed.');
    } finally {
      setNotifSavingKey(null);
    }
  };

  const weekendDirty = JSON.stringify([...weekendDraft].sort()) !== JSON.stringify([...weekendSaved].sort());

  const toggleWeekendDay = (day: number) => {
    setWeekendDraft(prev => prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day].sort((a, b) => a - b));
  };

  const handleSaveWeekend = async () => {
    if (weekendSaving) return;
    setWeekendSaving(true);
    try {
      const saved = await calendarService.saveWeekendDays(weekendDraft);
      setWeekendDraft(saved);
      setWeekendSaved(saved);
      toast.success('Weekend updated');
    } catch {
      toast.error('Could not update the weekend');
    } finally {
      setWeekendSaving(false);
    }
  };

  const resetHolidayForm = () => {
    setHolidayForm({ date: '', name: '', nameBn: '', category: 'general', moonDependent: false, regional: false });
    setEditingHolidayId(null);
  };

  const handleHolidaySubmit = async () => {
    if (holidaySaving) return;
    if (!holidayForm.date || !holidayForm.name.trim()) {
      toast.error('Holiday date and name are required');
      return;
    }
    setHolidaySaving(true);
    try {
      const input = { ...holidayForm, name: holidayForm.name.trim(), nameBn: holidayForm.nameBn.trim() || null };
      if (editingHolidayId) {
        const saved = await calendarService.updateHoliday(editingHolidayId, input);
        setHolidays(prev => prev.map(h => h.id === saved.id ? saved : h).sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name)));
        toast.success('Holiday updated');
      } else {
        const saved = await calendarService.createHoliday(input);
        setHolidays(prev => [...prev, saved].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name)));
        toast.success('Holiday added');
      }
      resetHolidayForm();
    } catch (err: any) {
      toast.error(err?.message || 'Could not save the holiday');
    } finally {
      setHolidaySaving(false);
    }
  };

  const handleHolidayEdit = (h: CalendarHoliday) => {
    setEditingHolidayId(h.id);
    setDeleteConfirmId(null);
    setHolidayForm({ date: h.date, name: h.name, nameBn: h.nameBn ?? '', category: h.category, moonDependent: h.moonDependent, regional: h.regional });
  };

  const handleHolidayDelete = async (id: string) => {
    try {
      await calendarService.deleteHoliday(id);
      setHolidays(prev => prev.filter(h => h.id !== id));
      if (editingHolidayId === id) resetHolidayForm();
      setDeleteConfirmId(null);
      toast.success('Holiday deleted');
    } catch {
      toast.error('Could not delete the holiday');
    }
  };

  // Holiday JSON import (PR F): an admin uploads the canonical
  // holiday file for a future year; the server validates every row,
  // adds the new ones and skips (date + name) duplicates — no code
  // help needed when a new gazette list arrives.
  const holidayImportInputRef = useRef<HTMLInputElement | null>(null);
  const [holidayImportPreview, setHolidayImportPreview] = useState<{ fileName: string; rows: any[] } | null>(null);
  const [holidayImporting, setHolidayImporting] = useState(false);
  const [holidayImportResult, setHolidayImportResult] = useState<HolidayImportResult | null>(null);

  const handleHolidayImportFile = async (file: File | null) => {
    if (!file) return;
    setHolidayImportResult(null);
    let parsed: any;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      toast.error(`"${file.name}" is not valid JSON — nothing was sent.`);
      setHolidayImportPreview(null);
      return;
    }
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.holidays) ? parsed.holidays : null;
    if (!rows) {
      toast.error('This file has no "holidays" list — nothing was sent. Use the sample format.');
      setHolidayImportPreview(null);
      return;
    }
    if (rows.length === 0) {
      toast.error('This file contains no holiday rows.');
      setHolidayImportPreview(null);
      return;
    }
    setHolidayImportPreview({ fileName: file.name, rows });
  };

  const handleHolidayImportConfirm = async () => {
    if (!holidayImportPreview || holidayImporting) return;
    setHolidayImporting(true);
    try {
      const result = await calendarService.importHolidays(holidayImportPreview.rows);
      setHolidayImportResult(result);
      setHolidayImportPreview(null);
      const cfg = await calendarService.getConfig();
      setHolidays(cfg.holidays);
      if (result.added > 0) {
        toast.success(`Imported ${result.added} new holiday${result.added === 1 ? '' : 's'}`);
      } else {
        toast.success('Import finished — no new holidays were added');
      }
    } catch (err: any) {
      toast.error(err?.message || 'Holiday import failed');
    } finally {
      setHolidayImporting(false);
    }
  };

  const handleHolidaySampleDownload = () => {
    const sample = {
      holidays: [
        { date: '2028-02-21', name_en: 'Shaheed Day and International Mother Language Day', name_bn: 'শহীদ দিবস ও আন্তর্জাতিক মাতৃভাষা দিবস', type: 'general', moon_dependent: false },
        { date: '2028-03-20', name_en: 'Eid-ul-Fitr', name_bn: 'ঈদুল ফিতর', type: 'general', moon_dependent: true },
        { date: '2028-04-13', name_en: 'Chaitra Sankranti', name_bn: 'চৈত্র সংক্রান্তি', type: 'general', moon_dependent: false, scope: 'Rangamati, Khagrachhari and Bandarban hill districts only' },
      ],
    };
    const blob = new Blob([JSON.stringify(sample, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'holiday-import-sample.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const holidayImportYears: [string, number][] = [];
  if (holidayImportPreview) {
    const yearCounts = new Map<string, number>();
    for (const r of holidayImportPreview.rows) {
      const year = typeof r?.date === 'string' && /^\d{4}-/.test(r.date) ? r.date.slice(0, 4) : '—';
      yearCounts.set(year, (yearCounts.get(year) ?? 0) + 1);
    }
    for (const entry of yearCounts) holidayImportYears.push(entry);
    holidayImportYears.sort((a, b) => a[0].localeCompare(b[0]));
  }

  const holidayYears = Array.from(new Set(holidays.map(h => h.date.slice(0, 4)))).sort();
  const visibleHolidays = holidayYear === 'all' ? holidays : holidays.filter(h => h.date.slice(0, 4) === holidayYear);
  const holidayGroups: { year: string; months: { label: string; items: CalendarHoliday[] }[] }[] = [];
  for (const h of visibleHolidays) {
    const year = h.date.slice(0, 4);
    const monthLabel = MONTH_LABELS[Number(h.date.slice(5, 7)) - 1];
    let yg = holidayGroups.find(g => g.year === year);
    if (!yg) { yg = { year, months: [] }; holidayGroups.push(yg); }
    let mg = yg.months.find(m => m.label === monthLabel);
    if (!mg) { mg = { label: monthLabel, items: [] }; yg.months.push(mg); }
    mg.items.push(h);
  }

  const handleUpdateName = async () => {
    if (!user || !newName.trim()) return;
    setLoading(true);
    try {
      const updatedUser = { ...user, name: newName, avatarUrl: avatarUrl };
      await userService.updateUser(user.id, updatedUser);
      login(updatedUser, useAuthStore.getState().token || undefined, isOfflineMode);
      toast.success('Identity synchronized across network');
    } catch (err) {
      toast.error('Network synchronization failure');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdatePassword = async () => {
    if (!user) return;
    if (!currentPassword || !newPassword || !confirmPassword) {
      toast.error('All password fields are required');
      return;
    }
    // DZ-4: mirrors the Danger Zone security policy's default
    // minimum (8); the server enforces the live value.
    if (newPassword.length < 8) {
      toast.error('New password must be at least 8 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('New passwords do not match');
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
        toast.error(body.error || 'Current password is incorrect');
        return;
      }

      toast.success('Security password updated successfully');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      console.error(err);
      toast.error('Failed to update system security keys');
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
      toast.error('Please enter a name for the new metadata type');
      return;
    }
    try {
      await metadataService.createType(
        newTypeForm.label.trim().replace(/\s+/g, ''),
        newTypeForm.label.trim(),
        newTypeForm.description.trim()
      );
      toast.success(`New metadata type "${newTypeForm.label}" created`);
      setNewTypeForm({ label: '', description: '' });
      setIsAddingType(false);
      loadOptions();
    } catch (err: any) {
      toast.error(err.message || 'Failed to create metadata type');
    }
  };

  const handleDeleteType = async (type: MetadataType) => {
    if (type.isSystem) {
      toast.error('System metadata types cannot be deleted.');
      return;
    }
    if (!confirm(`Delete the "${type.label}" metadata type and all of its values? This cannot be undone.`)) return;
    try {
      await metadataService.deleteType(type.key);
      toast.success(`"${type.label}" removed`);
      loadOptions();
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete metadata type');
    }
  };

  const handleToggleActive = async (option: DropdownOption) => {
    try {
      await metadataService.toggleActive(option);
      loadOptions();
    } catch {
      toast.error('Failed to update status');
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
      toast.error('Failed to reorder');
    }
  };

  const handleSetStatusColor = async (option: DropdownOption, color: string) => {
    try {
      await metadataService.updateValue({ ...option, meta: { ...(option.meta || {}), color } });
      loadOptions();
    } catch {
      toast.error('Failed to update color');
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
      toast.error('Please enter a field label');
      return;
    }
    if (newFieldForm.fieldType === 'dropdown' && !newFieldForm.metadataTypeKey) {
      toast.error('Please select where this dropdown gets its values from');
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
      toast.success(`New field "${newFieldForm.label}" added to the Lead form`);
      setNewFieldForm({ label: '', fieldType: 'text', metadataTypeKey: '', isMandatory: false });
      setIsAddingField(false);
      loadFormFields();
    } catch (err: any) {
      toast.error(err.message || 'Failed to create field');
    }
  };

  const handleDeleteField = async (field: FormField) => {
    if (!confirm(`Remove the "${field.label}" field from the Lead form?`)) return;
    try {
      await formBuilderService.deleteField(field.id);
      toast.success('Field removed');
      loadFormFields();
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete field');
    }
  };

  const handleToggleFieldMandatory = async (field: FormField) => {
    try {
      await formBuilderService.saveField({ ...field, isMandatory: !field.isMandatory });
      loadFormFields();
    } catch {
      toast.error('Failed to update field');
    }
  };

  const handleToggleFieldVisible = async (field: FormField) => {
    try {
      await formBuilderService.saveField({ ...field, isVisible: !field.isVisible });
      loadFormFields();
    } catch {
      toast.error('Failed to update field');
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
      toast.error('Failed to reorder fields');
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
      toast.error(err.message || 'Failed to update workflow rule');
    }
  };

  const handleResetToUnrestricted = async (status: string) => {
    const existing = getRuleForStatus(status);
    try {
      await workflowService.saveRule({ ...existing, status, allowedNextStatuses: null });
      toast.success(`"${status}" can now move to any status`);
      loadWorkflow();
    } catch (err: any) {
      toast.error(err.message || 'Failed to update workflow rule');
    }
  };

  const handleToggleRequirement = async (status: string, field: 'requiresLossReason' | 'requiresMeetingType' | 'requiresFollowUpType' | 'requiresNote') => {
    const existing = getRuleForStatus(status);
    try {
      await workflowService.saveRule({ ...existing, status, [field]: !existing?.[field] });
      loadWorkflow();
    } catch (err: any) {
      toast.error(err.message || 'Failed to update workflow rule');
    }
  };

  const handleAddOption = async () => {
    if (!editingOption.value) return;
    try {
      await metadataService.addValue(editingOption.type, editingOption.value);
      toast.success('Strategy parameter added successfully');
      setEditingOption({ ...editingOption, value: '' });
      loadOptions();
    } catch (err) {
      toast.error('Failed to update system parameters');
    }
  };

  const handleDeleteOption = async (option: DropdownOption) => {
    if (!confirm('Are you sure you want to decommission this strategic parameter?')) return;
    try {
      await metadataService.deleteValue(option.type, option.value);
      toast.success('Matrix parameter decommissioned');
      loadOptions();
    } catch (err) {
      toast.error('Protocol failure during decommission');
    }
  };

  const handleClearData = async () => {
    // Typed-confirmation gate: the purge only runs when the admin has
    // typed CLEAR_ALL into the inline danger panel below. The server
    // enforces the same confirmation, so this is defence in depth.
    if (clearConfirmText !== 'CLEAR_ALL' || clearingData) return;
    setClearingData(true);
    try {
      await leadService.clearAllLeads();
      toast.success('Lead intelligence matrix purged successfully');
      setClearConfirmOpen(false);
      setClearConfirmText('');
    } catch (err) {
      toast.error('Database purge failed');
    } finally {
      setClearingData(false);
    }
  };

  const sections = [
    { id: 'notifications', label: 'Push Intelligence', icon: Bell, desc: 'Review real-time lead alert settings', allowed: isSystemAdmin || canAccess('settings_control', 'view_notifications') },
    { id: 'operations', label: 'Operations & Limits', icon: SlidersHorizontal, desc: 'Import row caps and image upload limit', allowed: isSystemAdmin || canAccess('settings_control', 'view_system') },
    { id: 'calendar', label: 'Calendar', icon: CalendarDays, desc: 'Weekend days and government holidays', allowed: isSystemAdmin || canAccess('settings_control', 'view_system') },
    { id: 'sync', label: 'Network & Sync', icon: Globe, desc: 'Check integration health and connection mode', allowed: isSystemAdmin || canAccess('settings_control', 'view_sync') },
    { id: 'danger-zone', label: 'Danger Zone', icon: ShieldAlert, desc: 'System rules — super admin only, password required', allowed: isSystemAdmin },
  ].filter(section => section.allowed);

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-20">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 bg-[#978C21]/5 rounded-sm border border-[#978C21]/10 flex items-center justify-center text-[#978C21]">
            <SettingsIcon className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-800">System</h1>
            <p className="text-sm text-slate-500 mt-1">Administration and workspace configuration</p>
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
            Overview
          </button>
          {(isSystemAdmin || canAccess('admin_settings', 'configure_global_metadata')) && (
            <button 
              onClick={() => setActiveTab('dropdowns')}
              className={cn(
                "px-5 py-2.5 text-sm font-medium rounded-lg transition-all",
                activeTab === 'dropdowns' ? "bg-white text-brand-text shadow-sm" : "text-slate-400 hover:text-slate-600"
              )}
            >
              Strategy Parameters
            </button>
          )}
          {(isSystemAdmin || canAccess('admin_settings', 'configure_global_metadata')) && (
            <button 
              onClick={() => setActiveTab('formbuilder')}
              className={cn(
                "px-5 py-2.5 text-sm font-medium rounded-lg transition-all",
                activeTab === 'formbuilder' ? "bg-white text-brand-text shadow-sm" : "text-slate-400 hover:text-slate-600"
              )}
            >
              Form Builder
            </button>
          )}
          {(isSystemAdmin || canAccess('admin_settings', 'configure_global_metadata')) && (
            <button 
              onClick={() => setActiveTab('workflow')}
              className={cn(
                "px-5 py-2.5 text-sm font-medium rounded-lg transition-all",
                activeTab === 'workflow' ? "bg-white text-brand-text shadow-sm" : "text-slate-400 hover:text-slate-600"
              )}
            >
              Workflow
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
              <div className="bg-white p-6 rounded-sm border border-slate-100 shadow-sm">
                <div className="flex items-center gap-3">
                  <ShieldCheck className="w-5 h-5 text-[#756c1b]" />
                  <h3 className="font-semibold text-base text-slate-800">System access</h3>
                </div>
                <p className="text-sm text-slate-500 mt-3">Workspace configuration for {user?.role || 'administrator'}.</p>
                <p className="text-xs text-slate-500 mt-4 pt-4 border-t border-slate-100">Employee ID · {user?.employeeId || '—'}</p>
              </div>

              <div className="bg-[#3C3C3C] p-6 rounded-sm">
                <div className="flex items-center gap-3 mb-4">
                  <ShieldCheck className="w-5 h-5 text-[#978C21]" />
                  <h4 className="text-sm font-semibold text-white">Access control</h4>
                </div>
                <p className="text-sm leading-6 text-stone-200">System actions remain limited to administrator roles and their existing permissions.</p>
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
                  
                  {isSystemAdmin && (
                    <div className="pt-6 space-y-4">
                      <div className="bg-white rounded-[12px] border border-stone-100 p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                        <div className="flex items-center gap-4">
                          <div className="w-10 h-10 rounded-[10px] bg-sky-50 border border-sky-100 flex items-center justify-center text-sky-600">
                            <Globe className="w-5 h-5" />
                          </div>
                          <div>
                            <h4 className="text-sm font-bold text-stone-700">System Connection</h4>
                            <p className="text-[11px] text-stone-400 font-medium mt-1">Check the current cloud database connection status.</p>
                          </div>
                        </div>
                        <button
                          onClick={async () => {
                            try {
                              const result = await databaseStatusService.checkDatabaseStatus();
                              if (result && (result as any).connected) {
                                toast.success("Cloud database connection is active.");
                              } else {
                                toast.error((result as any)?.message || "Cloud database connection could not be verified.");
                              }
                            } catch {
                              toast.error("Cloud database connection could not be verified.");
                            }
                          }}
                          className="px-4 py-2.5 bg-[#978C21] hover:bg-[#8a7f1e] text-white rounded-[10px] text-xs font-bold shadow-sm whitespace-nowrap flex items-center gap-2"
                        >
                          <Wifi className="w-4 h-4" /> Check Connection
                        </button>
                      </div>
                      <div className="bg-white rounded-[12px] border border-stone-100 p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                        <div className="flex items-center gap-4">
                          <div className="w-10 h-10 rounded-[10px] bg-emerald-50 border border-emerald-100 flex items-center justify-center text-emerald-600">
                            <Users className="w-5 h-5" />
                          </div>
                          <div>
                            <h4 className="text-sm font-bold text-stone-700">Lead Auto-Assignment</h4>
                            <p className="text-[11px] text-stone-400 font-medium mt-1">When on, a new lead with no assignee is routed to the least-loaded active member of the creator's team. Off by default; leads with an assignee are never changed.</p>
                          </div>
                        </div>
                        <label className="flex items-center gap-2 text-xs font-bold text-stone-600 whitespace-nowrap cursor-pointer">
                          <input
                            type="checkbox"
                            checked={autoAssignEnabled}
                            disabled={!autoAssignLoaded || autoAssignSaving}
                            onChange={handleToggleAutoAssign}
                          />
                          {autoAssignEnabled ? 'On' : 'Off'}
                        </label>
                      </div>
                      <div className="bg-white rounded-[12px] border border-stone-100 p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                        <div className="flex items-center gap-4">
                          <div className="w-10 h-10 rounded-[10px] bg-red-50 border border-red-100 flex items-center justify-center text-red-600">
                            <Timer className="w-5 h-5" />
                          </div>
                          <div>
                            <h4 className="text-sm font-bold text-stone-700">First-Contact SLA</h4>
                            <p className="text-[11px] text-stone-400 font-medium mt-1">When on, a newly assigned lead with no recorded first contact inside the window is badged in the Workbench, alerted to its assignee and escalated to their manager in the morning run. Off by default.</p>
                            <div className="flex items-center gap-2 mt-3">
                              <label className="text-[11px] font-bold text-stone-500" htmlFor="sla-hours-input">Window (hours)</label>
                              <input
                                id="sla-hours-input"
                                type="number"
                                min={1}
                                max={720}
                                value={slaHoursDraft}
                                disabled={!slaLoaded || slaSaving}
                                onChange={e => setSlaHoursDraft(e.target.value)}
                                className="w-20 px-2 py-1.5 border border-stone-200 rounded-[8px] text-xs font-bold text-stone-700"
                              />
                              <button
                                type="button"
                                onClick={handleSaveSlaHours}
                                disabled={!slaLoaded || slaSaving}
                                className="px-3 py-1.5 bg-stone-700 hover:bg-stone-800 text-white rounded-[8px] text-[11px] font-bold disabled:opacity-50"
                              >
                                Save
                              </button>
                            </div>
                          </div>
                        </div>
                        <label className="flex items-center gap-2 text-xs font-bold text-stone-600 whitespace-nowrap cursor-pointer">
                          <input
                            type="checkbox"
                            checked={slaEnabled}
                            disabled={!slaLoaded || slaSaving}
                            onChange={handleToggleSla}
                          />
                          {slaEnabled ? 'On' : 'Off'}
                        </label>
                      </div>
                      <div className="bg-red-50/20 rounded-sm border border-red-100 p-8 italic">
                        <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                           <div className="p-4 bg-red-50 text-red-500 rounded-sm border border-red-100">
                              <Database className="w-5 h-5" />
                           </div>
                           <div>
                              <h4 className="font-semibold text-red-600">System Tools</h4>
                              <p className="text-[10px] text-red-400 font-bold uppercase mt-1 tracking-tight italic">Advanced system operations for administrators.</p>
                           </div>
                        </div>
                        <button className="text-sm font-medium text-red-600 hover:underline" onClick={() => { setClearConfirmOpen(open => !open); setClearConfirmText(''); }}>{clearConfirmOpen ? 'Cancel' : 'Clear All Data'}</button>
                        </div>
                        {clearConfirmOpen && (
                          <div className="mt-6 pt-6 border-t border-red-100 space-y-4">
                            <p className="text-[11px] text-red-500 font-bold uppercase tracking-wider leading-relaxed">
                              Critical: this will purge all lead intelligence from the database. Type CLEAR_ALL to confirm.
                            </p>
                            <div className="flex flex-col sm:flex-row gap-3">
                              <input
                                value={clearConfirmText}
                                onChange={e => setClearConfirmText(e.target.value)}
                                placeholder="Type CLEAR_ALL"
                                className="flex-1 bg-white border border-red-200 rounded-sm px-4 py-3 text-sm font-bold tracking-widest outline-none placeholder:text-red-200"
                              />
                              <button
                                onClick={handleClearData}
                                disabled={clearConfirmText !== 'CLEAR_ALL' || clearingData}
                                className="px-5 py-3 bg-red-600 text-white rounded-sm text-xs font-black uppercase tracking-widest disabled:opacity-40 disabled:cursor-not-allowed hover:bg-red-700 transition-all whitespace-nowrap"
                              >
                                {clearingData ? 'Purging...' : 'Purge All Leads'}
                              </button>
                            </div>
                          </div>
                        )}
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
                      <h3 className="font-bold text-xl text-slate-800">Update Profile</h3>
                    </div>
                  </div>

                  <div className="space-y-8">
                    <div className="space-y-3">
                      <label className="text-sm font-medium text-slate-600">Display Name</label>
                      <input 
                        type="text"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-black uppercase tracking-tight focus:ring-2 focus:ring-[#978C21]/20 focus:border-[#978C21] outline-none"
                      />
                    </div>

                    <div className="space-y-3">
                      <label className="text-sm font-medium text-slate-600">Identity Avatar Profile</label>
                      
                      <div className="flex flex-col sm:flex-row items-center gap-8 p-6 bg-[#FBFAF8] rounded-sm border border-slate-100">
                        {/* Avatar Preview */}
                        <div className="w-20 h-20 rounded-sm bg-slate-900 flex items-center justify-center text-white text-2xl font-black border border-slate-800 shadow-md overflow-hidden shrink-0">
                          {avatarUrl ? (
                            <img src={avatarUrl} alt="Preview" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                          ) : (
                            newName.charAt(0) || 'U'
                          )}
                        </div>

                        {/* Controls */}
                        <div className="flex-1 space-y-4 w-full text-left">
                          <p className="text-[11px] text-slate-500 leading-normal uppercase tracking-tight font-bold">
                            Select an identity preset below, or upload a custom image (max {opsSettings.imageUploadMaxMb}MB JPEG/PNG) to synchronize across the network.
                          </p>
                          
                          <div className="flex flex-wrap gap-3">
                            <label className="px-4 py-3 bg-slate-900 hover:bg-black text-[#FBFAF8] text-[9px] font-black uppercase tracking-widest rounded-sm transition-all cursor-pointer shadow-md inline-block">
                              Upload Custom Image
                              <input 
                                type="file" 
                                accept="image/*" 
                                className="hidden" 
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  if (file) {
                                    // DZ-2 (M1): the image cap is a real Settings value now
                                    // (Operations & Limits); the default equals the old 1.5MB.
                                    if (file.size > opsSettings.imageUploadMaxMb * 1024 * 1024) {
                                      toast.error(`Asset limits exceeded: Maximum ${opsSettings.imageUploadMaxMb}MB allowed`);
                                      return;
                                    }
                                    const reader = new FileReader();
                                    reader.onload = () => {
                                      if (typeof reader.result === 'string') {
                                        setAvatarUrl(reader.result);
                                        toast.success('Identity asset uploaded successfully');
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
                                  toast.success('Avatar cleared. Defaulting to standard initial vector.');
                                }}
                                className="px-4 py-3 border border-red-200 hover:bg-red-50 text-red-600 text-[9px] font-black uppercase tracking-widest rounded-sm transition-all"
                              >
                                Purge Avatar
                              </button>
                            )}
                          </div>

                          <div className="space-y-2 pt-3 border-t border-slate-100">
                            <p className="text-xs font-medium text-slate-500">Quick Presets</p>
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
                                    toast.success(`Identity preset ${index + 1} chosen`);
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
                      {loading ? 'SYNCHRONIZING...' : 'Persist Intelligence'}
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
                      <h3 className="font-bold text-xl text-slate-800">Security & Access Protocol</h3>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest italic">Previous Password *</label>
                      <input 
                        type="password"
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-black uppercase tracking-tight focus:ring-2 focus:ring-[#978C21]/20 focus:border-[#978C21] outline-none"
                        placeholder="ENTER PREVIOUS PASSWORD"
                      />
                    </div>

                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest italic">New Password *</label>
                      <input 
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-black uppercase tracking-tight focus:ring-2 focus:ring-[#978C21]/20 focus:border-[#978C21] outline-none"
                        placeholder="ENTER NEW PASSWORD"
                      />
                    </div>

                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest italic">Confirm New Password *</label>
                      <input 
                        type="password"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-black uppercase tracking-tight focus:ring-2 focus:ring-[#978C21]/20 focus:border-[#978C21] outline-none"
                        placeholder="REPEAT NEW PASSWORD"
                      />
                    </div>
                    
                    <button 
                      onClick={handleUpdatePassword}
                      disabled={passwordLoading}
                      className="w-full py-5 bg-[#978C21] hover:bg-[#867B1E] text-white text-[11px] font-black uppercase tracking-[0.4em] transition-all rounded-sm flex items-center justify-center gap-4 italic disabled:opacity-50 mt-4 shadow-xl"
                    >
                      {passwordLoading ? 'UPDATING ENCRYPTION...' : 'Update Password Protocol'}
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
                      <h3 className="font-bold text-xl text-slate-800">Network Integration & Sync</h3>
                    </div>
                  </div>

                  <div className="p-8 bg-[#FBFAF8] rounded-sm border border-slate-100 space-y-8">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6 border-b border-slate-200/50 pb-6">
                      <div>
                        <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-500">Operational Database Mode</h4>
                        <p className="text-[14px] font-black uppercase tracking-tight mt-2 flex items-center gap-2">
                          <span className={cn("w-2.5 h-2.5 rounded-full inline-block animate-pulse", isOfflineMode ? "bg-amber-500" : "bg-emerald-500")} />
                          {isOfflineMode ? "Local Storage Mode (Offline)" : "Cloud Database Mode (Live)"}
                        </p>
                      </div>
                      <button
                        onClick={() => {
                          const targetState = !isOfflineMode;
                          useAuthStore.getState().setOfflineMode(targetState);
                           toast.success(targetState ? "Offline Mode Enabled: Data saved locally." : "Online Mode Enabled: Live Supabase PostgreSQL connection.");
                        }}
                        className={cn(
                          "px-6 py-3 text-[10px] font-black uppercase tracking-widest rounded-sm transition-all shadow-md border",
                          isOfflineMode ? "bg-emerald-50 border-emerald-200 text-emerald-600 hover:bg-emerald-100" : "bg-amber-50 border-amber-200 text-amber-600 hover:bg-amber-100"
                        )}
                      >
                        {isOfflineMode ? "Enable Cloud / Go Live" : "Disconnect / Work Offline"}
                      </button>
                    </div>

                    {/* Supabase Live Live Signal Tracker */}
                    <div className="border-b border-slate-200/50 pb-6 space-y-4">
                      <div className="flex items-center justify-between">
                        <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-500">Supabase Connection Signal</h4>
                        <button 
                          onClick={checkDbStatus}
                          disabled={dbChecking}
                          className="text-[9px] font-black uppercase tracking-widest text-[#978C21] hover:underline"
                        >
                          {dbChecking ? "CHANNELS BUSY..." : "PING DATABASE SIGNAL"}
                        </button>
                      </div>

                      {dbChecking ? (
                        <div className="p-4 bg-slate-50 rounded-sm border border-slate-100 flex items-center justify-center gap-3">
                          <span className="w-2.5 h-2.5 rounded-full inline-block bg-slate-400 animate-pulse" />
                          <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">PROBING SUPABASE CLOUD POSTGRESQL SIGNAL...</p>
                        </div>
                      ) : dbStatus?.connected ? (
                        <div className="p-5 bg-emerald-50/50 rounded-sm border border-emerald-100 space-y-3">
                          <div className="flex items-center gap-3">
                            <Radio className="w-5 h-5 text-emerald-600 animate-pulse" />
                            <div>
                              <p className="text-[11px] font-black text-emerald-600 uppercase tracking-widest">EXCELLENT SIGNAL (CLOUD ONLINE)</p>
                              <p className="text-[10px] text-emerald-500 font-bold uppercase mt-0.5">{dbStatus.message}</p>
                            </div>
                          </div>
                          <div className="pt-3 border-t border-emerald-100/50 grid grid-cols-2 gap-4 text-[9px] uppercase font-bold text-slate-500">
                            <div>
                              <span className="block text-slate-400">DATABASE SERVICE</span>
                              <span className="text-slate-800 font-black">Supabase PostgreSQL</span>
                            </div>
                            <div>
                              <span className="block text-slate-400">SECURITY HANDSHAKE</span>
                              <span className="text-slate-800 font-black">SSL Encrypted / Verified</span>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="p-5 bg-amber-50/50 rounded-sm border border-amber-100 space-y-4 text-left">
                          <div className="flex items-start gap-3">
                            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                            <div>
                              <p className="text-[11px] font-black text-amber-700 uppercase tracking-widest">NO SIGNAL / DEV MOCK FALLBACK</p>
                              <p className="text-[10px] text-amber-600 font-bold uppercase mt-1 leading-relaxed">
                                {dbStatus?.message || "No connection established because DATABASE_URL is not set as an Environment Secret yet."}
                              </p>
                            </div>
                          </div>

                          <div className="p-4 bg-slate-900 text-slate-100 rounded-sm font-mono text-[9px] uppercase space-y-3 leading-relaxed tracking-wider">
                            <p className="text-[#978C21] font-bold">⚠️ REQUIRED SYNC ACTION STEPS:</p>
                            <p>
                              1. CLICK <span className="text-amber-400 font-black">⚙️ SETTINGS</span> (TOP-RIGHT IN GOOGLE AI STUDIO CHAT BAR/TOOLBAR).
                            </p>
                            <p>
                              2. IN THE "SECRETS" / "ENVIRONMENT VARIABLES" SECTION, ADD A NEW KEY:
                              <br />
                              <strong className="text-white text-[11px] bg-slate-800 px-1 py-0.5 rounded">DATABASE_URL</strong>
                            </p>
                            <p className="normal-case">
                              3. PASTE YOUR SUPABASE PostgreSQL CONNECTION STRING. BIG RECOMMENDATION: USE THE TRANSACTION POOLER URL. EXAMPLE FORMAT:
                              <br />
                              <span className="text-emerald-400 text-[10px] font-black break-all">
                                postgres://postgres.wfpoqwmxpsvayhjyzdjx:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require
                              </span>
                            </p>
                            <p>
                              👉 <span className="text-amber-400 font-bold">REPLACE [YOUR-PASSWORD]</span> WITH YOUR SUPABASE DB USER PASSWORD.
                            </p>
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="space-y-4">
                      <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-500">Database Synchronization Sync</h4>
                      <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider leading-relaxed">
                        Manually upload any locally registered lead profiles, user credentials, and status logs on this device/browser into the secure cloud Supabase PostgreSQL database.
                      </p>
                      <button
                        onClick={async () => {
                          setLoading(true);
                          try {
                            const result = await databaseStatusService.checkDatabaseStatus();
                            if (result && result.connected) {
                              toast.success("Connected to the cloud database. All data is persisted directly to PostgreSQL.");
                            } else {
                              toast.error(result?.message || "Database connection failed. Changes cannot be persisted right now.");
                            }
                          } catch (err) {
                            toast.error("Failed to run sync. Check your cloud connection.");
                          } finally {
                            setLoading(false);
                          }
                        }}
                        disabled={loading}
                        className="w-full flex items-center justify-center gap-3 bg-slate-900 hover:bg-black text-[#FBFAF8] text-[10px] font-black uppercase tracking-widest py-4 rounded shadow-md transition-all active:scale-[0.99] group cursor-pointer disabled:opacity-50"
                      >
                        <Globe className="w-4 h-4 text-[#978C21] transition-transform group-hover:rotate-12" />
                        {loading ? "EXECUTING SYNC..." : "Run Cloud Synchronization Protocol"}
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
                      <h3 className="font-bold text-xl text-slate-800">Push Intelligence & Alerts</h3>
                    </div>
                  </div>

                  <div className="p-8 bg-[#FBFAF8] rounded-sm border border-slate-100 space-y-6">
                    <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-500">Custom System Alerts Configuration</h4>
                    <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider leading-relaxed">
                      Real switches — each one takes effect immediately and is recorded in the audit log:
                    </p>

                    <div className="space-y-4 pt-4 border-t border-slate-150">
                      {([
                        { key: 'assigneeAlerts', label: 'Assignee Assignment Alerts', desc: 'The assignee is notified in the app immediately' },
                        { key: 'uplineAlerts', label: 'Upline Assignment Alerts', desc: 'Managers up the chain are notified in the app immediately' },
                        { key: 'meetingNotifications', label: 'Meeting Notifications', desc: 'Invites, moves, cancellations, completions, RSVPs and reminders' },
                        { key: 'dailyPushSummary', label: 'Daily Push Summary', desc: 'Opt-in browser push each morning with due and overdue follow-ups' },
                      ] as const).map((n) => {
                        const enabled = notifSettings[n.key];
                        return (
                          <div key={n.key} className="flex items-center justify-between p-4 bg-white border border-slate-100 rounded-sm">
                            <div>
                              <p className="text-[11px] font-black text-slate-700 uppercase">{n.label}</p>
                              <p className="text-[9px] font-bold text-slate-400 uppercase mt-1">{n.desc}</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleToggleNotification(n.key)}
                              disabled={!canEditNotifications || !notifLoaded || notifSavingKey === n.key}
                              aria-pressed={enabled}
                              title={canEditNotifications ? (enabled ? 'Turn off' : 'Turn on') : 'Only settings managers can change this'}
                              className={enabled
                                ? "px-3 py-1 bg-emerald-50 text-emerald-600 text-[9px] font-black uppercase tracking-widest rounded border border-emerald-150 disabled:opacity-50"
                                : "px-3 py-1 bg-slate-50 text-slate-500 text-[9px] font-black uppercase tracking-widest rounded border border-slate-200 disabled:opacity-50"}
                            >
                              {notifSavingKey === n.key ? 'Saving…' : enabled ? 'Active' : 'Off'}
                            </button>
                          </div>
                        );
                      })}
                      {!canEditNotifications && (
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">You can see these settings, but only a settings manager can change them.</p>
                      )}
                    </div>
                  </div>
                </motion.div>
              ) : activeSection === 'calendar' ? (
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
                      <h3 className="font-bold text-xl text-slate-800">Calendar</h3>
                    </div>
                  </div>

                  <div className="p-8 bg-[#FBFAF8] rounded-sm border border-slate-100 space-y-6">
                    <div>
                      <h4 className="text-[11px] font-black uppercase tracking-widest text-[#978C21]">Weekend Days</h4>
                      <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider leading-relaxed mt-2">
                        Days shaded as the weekend on the Task Calendar. Default: Friday + Saturday.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 pt-4 border-t border-slate-150">
                      {WEEKDAY_LABELS.map((label, day) => (
                        <button
                          key={label}
                          type="button"
                          disabled={!canEditCalendar || weekendSaving}
                          onClick={() => toggleWeekendDay(day)}
                          className={cn(
                            "px-4 py-2.5 rounded-full text-[11px] font-black uppercase tracking-widest border transition-all disabled:opacity-50",
                            weekendDraft.includes(day)
                              ? "bg-[#978C21] text-white border-[#978C21]"
                              : "bg-white text-slate-500 border-slate-200 hover:border-[#978C21]/50"
                          )}
                        >
                          {label}
                        </button>
                      ))}
                      {canEditCalendar && (
                        <button
                          type="button"
                          onClick={handleSaveWeekend}
                          disabled={!weekendDirty || weekendSaving}
                          className="ml-2 px-4 py-2.5 bg-stone-700 hover:bg-stone-800 text-white rounded-[10px] text-xs font-bold disabled:opacity-40 flex items-center gap-2"
                        >
                          <Save className="w-4 h-4" /> {weekendSaving ? 'Saving...' : 'Save'}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="p-8 bg-[#FBFAF8] rounded-sm border border-slate-100 space-y-6">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h4 className="text-[11px] font-black uppercase tracking-widest text-[#978C21]">Government Holidays</h4>
                        <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider leading-relaxed mt-2">
                          Bangladesh government holidays (MoPA gazette). Add, edit or remove days whenever the government changes them.
                        </p>
                      </div>
                      <select
                        value={holidayYear}
                        onChange={e => setHolidayYear(e.target.value)}
                        className="bg-white border border-slate-200 rounded-sm px-3 py-2 text-[11px] font-black uppercase tracking-widest outline-none"
                      >
                        <option value="all">All years</option>
                        {holidayYears.map(y => <option key={y} value={y}>{y}</option>)}
                      </select>
                    </div>

                    {canEditCalendar && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 bg-white border border-slate-100 rounded-sm">
                        <div className="space-y-2">
                          <label className="text-[10px] font-black text-slate-400 uppercase">Date</label>
                          <input
                            type="date"
                            value={holidayForm.date}
                            onChange={e => setHolidayForm(f => ({ ...f, date: e.target.value }))}
                            className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest outline-none"
                          />
                        </div>
                        <div className="space-y-2">
                          <label className="text-[10px] font-black text-slate-400 uppercase">Name</label>
                          <input
                            type="text"
                            value={holidayForm.name}
                            onChange={e => setHolidayForm(f => ({ ...f, name: e.target.value }))}
                            placeholder="e.g. Victory Day"
                            className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest outline-none"
                          />
                        </div>
                        <div className="space-y-2">
                          <label className="text-[10px] font-black text-slate-400 uppercase">Bangla Name (Optional)</label>
                          <input
                            type="text"
                            value={holidayForm.nameBn}
                            onChange={e => setHolidayForm(f => ({ ...f, nameBn: e.target.value }))}
                            placeholder="e.g. বিজয় দিবস"
                            className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black tracking-widest outline-none"
                          />
                        </div>
                        <div className="space-y-2">
                          <label className="text-[10px] font-black text-slate-400 uppercase">Category</label>
                          <select
                            value={holidayForm.category}
                            onChange={e => setHolidayForm(f => ({ ...f, category: e.target.value as 'general' | 'executive' }))}
                            className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest outline-none"
                          >
                            <option value="general">General</option>
                            <option value="executive">Executive Order</option>
                          </select>
                        </div>
                        <div className="flex items-end gap-6 pb-2">
                          <label className="flex items-center gap-2 text-[11px] font-bold text-stone-600 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={holidayForm.moonDependent}
                              onChange={e => setHolidayForm(f => ({ ...f, moonDependent: e.target.checked }))}
                            />
                            Moon-dependent
                          </label>
                          <label className="flex items-center gap-2 text-[11px] font-bold text-stone-600 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={holidayForm.regional}
                              onChange={e => setHolidayForm(f => ({ ...f, regional: e.target.checked }))}
                            />
                            Regional only
                          </label>
                        </div>
                        <div className="md:col-span-2 flex items-center gap-3">
                          <button
                            type="button"
                            onClick={handleHolidaySubmit}
                            disabled={holidaySaving}
                            className="px-4 py-2.5 bg-[#978C21] hover:bg-[#8a7f1e] text-white rounded-[10px] text-xs font-bold disabled:opacity-40 flex items-center gap-2"
                          >
                            <Plus className="w-4 h-4" /> {editingHolidayId ? 'Update Holiday' : 'Add Holiday'}
                          </button>
                          {editingHolidayId && (
                            <button
                              type="button"
                              onClick={resetHolidayForm}
                              className="px-4 py-2.5 bg-white border border-slate-200 text-slate-500 rounded-[10px] text-xs font-bold flex items-center gap-2"
                            >
                              <X className="w-4 h-4" /> Cancel Edit
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {canEditCalendar && (
                      <div className="p-4 bg-white border border-slate-100 rounded-sm space-y-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <h5 className="text-[11px] font-black uppercase tracking-widest text-slate-600 flex items-center gap-2">
                              <FileJson className="w-4 h-4 text-[#978C21]" /> Import Holidays (JSON)
                            </h5>
                            <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider leading-relaxed mt-1">
                              Upload next year's government holiday file — new holidays are added to the database automatically. Entries whose date + name already exist are skipped, never duplicated.
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={handleHolidaySampleDownload}
                            className="px-3 py-2 bg-white border border-slate-200 text-slate-500 hover:border-[#978C21]/50 rounded-[10px] text-[11px] font-bold flex items-center gap-2"
                          >
                            <Download className="w-4 h-4" /> Download sample format
                          </button>
                        </div>

                        <input
                          ref={holidayImportInputRef}
                          type="file"
                          accept=".json,application/json"
                          className="hidden"
                          onChange={e => {
                            void handleHolidayImportFile(e.target.files?.[0] ?? null);
                            e.target.value = '';
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => holidayImportInputRef.current?.click()}
                          className="px-4 py-2.5 bg-[#978C21] hover:bg-[#8a7f1e] text-white rounded-[10px] text-xs font-bold flex items-center gap-2"
                        >
                          <Upload className="w-4 h-4" /> Choose JSON file
                        </button>

                        {holidayImportPreview && (
                          <div className="border border-slate-100 bg-[#FBFAF8] rounded-sm p-4 space-y-3">
                            <p className="text-[11px] font-bold text-slate-600">
                              {holidayImportPreview.fileName} — {holidayImportPreview.rows.length} holiday{holidayImportPreview.rows.length === 1 ? '' : 's'}
                              {holidayImportYears.length > 0 && (
                                <span className="text-slate-400"> ({holidayImportYears.map(([y, n]) => `${y}: ${n}`).join(' · ')})</span>
                              )}
                            </p>
                            <div className="space-y-1 max-h-56 overflow-y-auto">
                              {holidayImportPreview.rows.slice(0, 15).map((r: any, i: number) => (
                                <p key={i} className="text-[11px] font-bold text-slate-500">
                                  {String(r?.date ?? '—')} — {String(r?.name_en ?? r?.name ?? '(no name)')}
                                  <span className="text-slate-400"> · {String(r?.type ?? r?.category ?? 'general')}</span>
                                </p>
                              ))}
                              {holidayImportPreview.rows.length > 15 && (
                                <p className="text-[11px] font-bold text-slate-400">+{holidayImportPreview.rows.length - 15} more…</p>
                              )}
                            </div>
                            <p className="text-[11px] text-slate-400 font-bold leading-relaxed">
                              Holidays already in the list with the same date and name will be skipped.
                            </p>
                            <div className="flex items-center gap-3">
                              <button
                                type="button"
                                onClick={handleHolidayImportConfirm}
                                disabled={holidayImporting}
                                className="px-4 py-2.5 bg-stone-700 hover:bg-stone-800 text-white rounded-[10px] text-xs font-bold disabled:opacity-40"
                              >
                                {holidayImporting ? 'Importing...' : 'Confirm import'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setHolidayImportPreview(null)}
                                disabled={holidayImporting}
                                className="px-4 py-2.5 bg-white border border-slate-200 text-slate-500 rounded-[10px] text-xs font-bold disabled:opacity-40"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}

                        {holidayImportResult && (
                          <div className="border border-emerald-100 bg-emerald-50/50 rounded-sm p-4 space-y-2">
                            <p className="text-[11px] font-black uppercase tracking-widest text-emerald-700">
                              Added {holidayImportResult.added} · Skipped (already existed) {holidayImportResult.skippedDuplicates} · Rejected {holidayImportResult.rejected.length}
                            </p>
                            {holidayImportResult.rejected.length > 0 && (
                              <div className="space-y-1">
                                {holidayImportResult.rejected.map((rej, i) => (
                                  <p key={i} className="text-[11px] font-bold text-red-500">
                                    Row {rej.index + 1}{rej.date ? ` (${rej.date})` : ''}: {rej.reason}
                                  </p>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    <div className="space-y-6 pt-2">
                      {!calendarLoaded ? (
                        <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Loading holidays...</p>
                      ) : holidayGroups.length === 0 ? (
                        <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">No holidays in this selection.</p>
                      ) : holidayGroups.map(group => (
                        <div key={group.year} className="space-y-4">
                          <h5 className="text-sm font-black text-slate-700 tracking-tight">{group.year}</h5>
                          {group.months.map(monthGroup => (
                            <div key={monthGroup.label} className="space-y-2">
                              <h6 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">{monthGroup.label}</h6>
                              <div className="space-y-2">
                                {monthGroup.items.map(h => (
                                  <div key={h.id} className="flex flex-wrap items-center justify-between gap-3 p-4 bg-white border border-slate-100 rounded-sm">
                                    <div className="flex flex-wrap items-center gap-3 min-w-0">
                                      <span className="text-[11px] font-black text-slate-700 uppercase whitespace-nowrap">
                                        {new Date(`${h.date}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                                      </span>
                                      <span className="min-w-0">
                                        <span className="block text-[11px] font-bold text-slate-600">{h.name}</span>
                                        {h.nameBn && <span className="block text-[10px] font-bold text-slate-400">{h.nameBn}</span>}
                                      </span>
                                      <span className={cn(
                                        "px-2 py-0.5 text-[9px] font-black uppercase tracking-widest rounded border",
                                        h.category === 'general'
                                          ? "bg-emerald-50 text-emerald-600 border-emerald-100"
                                          : "bg-sky-50 text-sky-600 border-sky-100"
                                      )}>
                                        {h.category === 'general' ? 'General' : 'Executive Order'}
                                      </span>
                                      {h.moonDependent && (
                                        <span className="px-2 py-0.5 bg-amber-50 text-amber-600 text-[9px] font-black uppercase tracking-widest rounded border border-amber-100">Moon-dependent</span>
                                      )}
                                      {h.regional && (
                                        <span className="px-2 py-0.5 bg-violet-50 text-violet-600 text-[9px] font-black uppercase tracking-widest rounded border border-violet-100">Regional</span>
                                      )}
                                    </div>
                                    {canEditCalendar && (
                                      <div className="flex items-center gap-2">
                                        {deleteConfirmId === h.id ? (
                                          <>
                                            <button type="button" onClick={() => handleHolidayDelete(h.id)} className="px-3 py-1.5 bg-red-600 text-white rounded-[8px] text-[11px] font-bold">Confirm Delete</button>
                                            <button type="button" onClick={() => setDeleteConfirmId(null)} className="px-3 py-1.5 bg-white border border-slate-200 text-slate-500 rounded-[8px] text-[11px] font-bold">Cancel</button>
                                          </>
                                        ) : (
                                          <>
                                            <button type="button" onClick={() => handleHolidayEdit(h)} className="px-3 py-1.5 bg-white border border-slate-200 text-slate-600 rounded-[8px] text-[11px] font-bold hover:border-[#978C21]/50">Edit</button>
                                            <button type="button" onClick={() => setDeleteConfirmId(h.id)} className="p-1.5 text-slate-300 hover:text-red-500">
                                              <Trash2 className="w-4 h-4" />
                                            </button>
                                          </>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                </motion.div>
              ) : activeSection === 'operations' ? (
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
                      <h3 className="font-bold text-xl text-slate-800">Operations &amp; Limits</h3>
                    </div>
                  </div>

                  <div className="p-8 bg-[#FBFAF8] rounded-sm border border-slate-100 space-y-6">
                    <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-500">Bounded Operational Limits</h4>
                    <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider leading-relaxed">
                      Real limits — each one takes effect immediately and is recorded in the audit log. Every limit has a code ceiling (shown in brackets): you can lower it, never raise it above the ceiling.
                    </p>

                    <div className="space-y-4 pt-4 border-t border-slate-150">
                      {([
                        { key: 'leadBulkImportMaxRows', label: 'Lead Bulk Import Max Rows', desc: 'Max leads per bulk import request (ceiling 5,000)', step: 1 },
                        { key: 'userBulkImportMaxRows', label: 'User Bulk Import Max Rows', desc: 'Max users per bulk import request (ceiling 1,000)', step: 1 },
                        { key: 'imageUploadMaxMb', label: 'Image Upload Max Size (MB)', desc: 'Max profile/logo image size (ceiling 1.5 MB)', step: 0.1 },
                      ] as const).map((f) => {
                        const limits = OPERATIONS_LIMITS[f.key];
                        return (
                          <div key={f.key} className="flex items-center justify-between gap-4 p-4 bg-white border border-slate-100 rounded-sm">
                            <div>
                              <p className="text-[11px] font-black text-slate-700 uppercase">{f.label}</p>
                              <p className="text-[9px] font-bold text-slate-400 uppercase mt-1">{f.desc}</p>
                            </div>
                            <input
                              type="number"
                              min={limits.min}
                              max={limits.max}
                              step={f.step}
                              value={opsDraft[f.key]}
                              disabled={!canEditOperations || !opsLoaded || opsSaving}
                              onChange={(e) => setOpsDraft((prev) => ({ ...prev, [f.key]: Number(e.target.value) }))}
                              className="w-24 px-2 py-1.5 border border-stone-200 rounded-[8px] text-xs font-bold text-stone-700 text-right disabled:opacity-50"
                              aria-label={f.label}
                            />
                          </div>
                        );
                      })}
                      {!canEditOperations && (
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">You can see these settings, but only a settings manager can change them.</p>
                      )}
                      {canEditOperations && (
                        <button
                          type="button"
                          onClick={handleSaveOperations}
                          disabled={!opsDirty || opsSaving || !opsLoaded}
                          className="px-4 py-2.5 bg-stone-700 hover:bg-stone-800 text-white rounded-[10px] text-xs font-bold disabled:opacity-40 flex items-center gap-2"
                        >
                          <Save className="w-4 h-4" /> {opsSaving ? 'Saving...' : 'Save Limits'}
                        </button>
                      )}
                    </div>
                  </div>
                </motion.div>
              ) : activeSection === 'danger-zone' ? (
                <motion.div
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="bg-white p-10 rounded-sm border border-red-100 shadow-sm space-y-8 italic text-left"
                >
                  <div className="flex items-center justify-between border-b border-slate-50 pb-8">
                    <div className="flex items-center gap-4">
                      <button onClick={() => setActiveSection('overview')} className="p-2 hover:bg-slate-50 rounded-sm">
                        <ArrowRight className="w-5 h-5 text-slate-300 rotate-180" />
                      </button>
                      <h3 className="font-bold text-xl text-red-700 flex items-center gap-2">
                        <ShieldAlert className="w-5 h-5" /> Danger Zone
                      </h3>
                    </div>
                    {dzState === 'unlocked' && (
                      <div className="flex items-center gap-3">
                        <span className="px-3 py-1.5 bg-red-50 border border-red-100 text-red-600 text-[10px] font-black uppercase tracking-widest rounded">
                          Unlocked — {Math.floor(dzSecondsLeft / 60)}:{String(dzSecondsLeft % 60).padStart(2, '0')} left
                        </span>
                        <button
                          type="button"
                          onClick={handleDzLock}
                          disabled={dzBusy}
                          className="px-4 py-2 bg-stone-700 hover:bg-stone-800 text-white rounded-[10px] text-xs font-bold disabled:opacity-40 flex items-center gap-2"
                        >
                          <Lock className="w-3.5 h-3.5" /> Lock now
                        </button>
                      </div>
                    )}
                  </div>

                  {dzState === 'loading' || dzState === 'idle' ? (
                    <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Checking access...</p>
                  ) : dzState === 'forbidden' ? (
                    <div className="p-8 bg-[#FBFAF8] rounded-sm border border-slate-100">
                      <p className="text-sm font-bold text-slate-600 leading-relaxed">
                        This area is not available for your account. The Danger Zone opens only for the super admin,
                        and the server checks that against the database — not against this screen.
                      </p>
                    </div>
                  ) : dzState === 'unavailable' ? (
                    <div className="p-8 bg-[#FBFAF8] rounded-sm border border-slate-100 space-y-4">
                      <p className="text-sm font-bold text-slate-600 leading-relaxed">
                        The Danger Zone could not be reached just now. Nothing was changed.
                      </p>
                      <button type="button" onClick={() => void loadDangerZone()} className="px-4 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-[10px] text-xs font-bold">
                        Try again
                      </button>
                    </div>
                  ) : dzState === 'locked' ? (
                    <div className="p-8 bg-red-50/50 rounded-sm border border-red-100 space-y-6">
                      <div className="flex items-start gap-3">
                        <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                        <div>
                          <h4 className="text-[11px] font-black uppercase tracking-widest text-red-600">Super admin only — password required</h4>
                          <p className="text-[11px] text-slate-500 font-bold uppercase tracking-wider leading-relaxed mt-2">
                            This area holds the rules the whole app runs on. To enter, type your own login password
                            again. The unlock lasts 10 minutes and then locks itself — it never extends.
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <input
                          type="password"
                          value={dzPassword}
                          onChange={e => setDzPassword(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') void handleDzUnlock(); }}
                          placeholder="Your login password"
                          autoComplete="current-password"
                          className="px-4 py-2.5 bg-white border border-red-200 rounded-[10px] text-sm font-bold text-slate-700 w-72"
                        />
                        <button
                          type="button"
                          onClick={() => void handleDzUnlock()}
                          disabled={dzBusy}
                          className="px-5 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-[10px] text-xs font-bold disabled:opacity-40"
                        >
                          {dzBusy ? 'Checking...' : 'Unlock'}
                        </button>
                      </div>
                      {dzError && <p className="text-[11px] font-bold text-red-500">{dzError}</p>}
                    </div>
                  ) : dzOverview ? (
                    <div className="space-y-8">
                      <div className="p-8 bg-[#3C3C3C] rounded-sm space-y-4">
                        <h4 className="text-[11px] font-black uppercase tracking-widest text-red-300">These never change — not even here</h4>
                        <ul className="space-y-2">
                          {dzOverview.invariants.map((line, i) => (
                            <li key={i} className="text-[12px] font-bold text-stone-200 leading-relaxed flex gap-2">
                              <span className="text-red-300">•</span>
                              <span>{line}</span>
                            </li>
                          ))}
                        </ul>
                      </div>

                      {/* DZ-3 — Lead Quality scoring config (audit §2.6 F1–F6). */}
                      <DangerZoneLeadQuality
                        onLocked={() => {
                          setDzOverview(null);
                          setDzSecondsLeft(0);
                          setDzState('locked');
                        }}
                      />

                      {/* DZ-4 — Security policy (audit §2.1 A1/A5/A8/A9). */}
                      <DangerZoneSecurityPolicy
                        onLocked={() => {
                          setDzOverview(null);
                          setDzSecondsLeft(0);
                          setDzState('locked');
                        }}
                      />

                      {/* DZ-5 — Role defaults (audit §2.2 B6). */}
                      <DangerZoneRoleDefaults
                        onLocked={() => {
                          setDzOverview(null);
                          setDzSecondsLeft(0);
                          setDzState('locked');
                        }}
                      />

                      <div className="space-y-4">
                        <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-500">Rules you can see (read-only)</h4>
                        <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider leading-relaxed">
                          These rules run the app today. They are shown so the super admin can see them in one place —
                          changing them is not a setting; where a rule ever becomes adjustable, it will appear here as
                          its own control in a later step.
                        </p>
                        <div className="grid grid-cols-1 gap-4">
                          {dzOverview.cards.map(card => (
                            <div key={card.id} className="p-6 bg-[#FBFAF8] rounded-sm border border-slate-100 space-y-2">
                              <div className="flex items-center justify-between gap-3">
                                <h5 className="text-sm font-black text-slate-700">{card.title}</h5>
                                <span className="px-2 py-0.5 bg-slate-100 text-slate-400 text-[9px] font-black uppercase tracking-widest rounded border border-slate-200">{card.id}</span>
                              </div>
                              <p className="text-[12px] font-bold text-slate-500 leading-relaxed">{card.rule}</p>
                              <p className="text-[12px] font-bold text-slate-700 leading-relaxed">
                                <span className="text-[10px] font-black uppercase tracking-widest text-[#978C21]">Now: </span>
                                {card.currentValue}
                              </p>
                              <p className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">{card.source}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </motion.div>
              ) : (
                <motion.div
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="bg-white p-20 rounded-sm border border-slate-100 shadow-sm text-center italic"
                >
                  <button onClick={() => setActiveSection('overview')} className="mb-10 text-[10px] font-black text-[#978C21] uppercase tracking-widest flex items-center gap-2 mx-auto">
                    <ArrowRight className="w-4 h-4 rotate-180" /> Return to Command
                  </button>
                  <h3 className="text-2xl font-black uppercase tracking-tighter text-slate-200 serif">Protocol Offline</h3>
                  <p className="text-[10px] font-black text-slate-300 uppercase tracking-[0.3em] mt-4">Module Clearance Level 4 Required</p>
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
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Parameter Category</label>
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
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">New Matrix Property</label>
                <div className="flex gap-2">
                  <input 
                    type="text"
                    value={editingOption.value}
                    onChange={(e) => setEditingOption({ ...editingOption, value: e.target.value })}
                    placeholder="ENTER VALUE..."
                    className="flex-1 bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest focus:ring-2 focus:ring-[#978C21]/10 outline-none placeholder:opacity-30"
                  />
                  <button 
                    onClick={handleAddOption}
                    className="bg-[#978C21] text-white px-6 py-3 rounded-sm font-black text-[11px] uppercase tracking-widest hover:bg-black transition-all flex items-center gap-2 shadow-lg"
                  >
                    <Plus className="w-4 h-4" />
                    Inject
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
                  New Field Type
                </button>
              </div>
            </div>

            {isAddingType && (
              <div className="px-10 py-6 border-b border-slate-50 bg-white flex flex-col md:flex-row items-end gap-4">
                <div className="flex-1 space-y-2 w-full">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">New Type Name</label>
                  <input
                    type="text"
                    value={newTypeForm.label}
                    onChange={(e) => setNewTypeForm({ ...newTypeForm, label: e.target.value })}
                    placeholder="e.g. Industry, Referral Channel..."
                    className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest focus:ring-2 focus:ring-[#978C21]/10 outline-none placeholder:opacity-30"
                  />
                </div>
                <div className="flex-1 space-y-2 w-full">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Description (optional)</label>
                  <input
                    type="text"
                    value={newTypeForm.description}
                    onChange={(e) => setNewTypeForm({ ...newTypeForm, description: e.target.value })}
                    placeholder="What is this field for?"
                    className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest focus:ring-2 focus:ring-[#978C21]/10 outline-none placeholder:opacity-30"
                  />
                </div>
                <button
                  onClick={handleAddType}
                  className="bg-[#978C21] text-white px-6 py-3 rounded-sm font-black text-[11px] uppercase tracking-widest hover:bg-black transition-all shadow-lg whitespace-nowrap"
                >
                  Create Type
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
                            <span className="text-[8px] font-black text-[#978C21] bg-[#978C21]/10 px-1.5 py-0.5 rounded-sm uppercase tracking-wider">System</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-slate-500">{values.length} Entries</span>
                          {!t.isSystem && (
                            <button
                              onClick={() => handleDeleteType(t)}
                              title="Delete this metadata type"
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
                                  title="Status color"
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
                              <button onClick={() => handleToggleActive(option)} title={option.status === 'Active' ? 'Deactivate' : 'Activate'} className="p-1 text-slate-300 hover:text-[#978C21]">
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
                          <p className="text-[10px] text-slate-300 uppercase tracking-widest italic py-4 text-center">No values yet</p>
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
                <h5 className="text-[13px] font-black text-brand-text uppercase tracking-[0.15em]">Lead Generate Form Fields</h5>
                <p className="text-[10px] text-slate-400 uppercase tracking-widest mt-2 not-italic">
                  Control which fields appear on the Lead Generate form, whether they're required, and their order.
                </p>
              </div>
              <button
                onClick={() => setIsAddingField(true)}
                className="bg-[#978C21] text-white px-6 py-3 rounded-sm font-black text-[11px] uppercase tracking-widest hover:bg-black transition-all flex items-center gap-2 shadow-lg whitespace-nowrap"
              >
                <Plus className="w-4 h-4" />
                New Field
              </button>
            </div>

            {isAddingField && (
              <div className="px-10 py-6 border-b border-slate-50 bg-white grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 items-end">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Field Label</label>
                  <input
                    type="text"
                    value={newFieldForm.label}
                    onChange={(e) => setNewFieldForm({ ...newFieldForm, label: e.target.value })}
                    placeholder="e.g. Reference Name"
                    className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest focus:ring-2 focus:ring-[#978C21]/10 outline-none placeholder:opacity-30"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Field Type</label>
                  <select
                    value={newFieldForm.fieldType}
                    onChange={(e) => setNewFieldForm({ ...newFieldForm, fieldType: e.target.value as FormFieldType })}
                    className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest focus:ring-2 focus:ring-[#978C21]/10 outline-none"
                  >
                    <option value="text">Text</option>
                    <option value="number">Number</option>
                    <option value="dropdown">Dropdown</option>
                    <option value="date">Date</option>
                    <option value="textarea">Long Text</option>
                    <option value="checkbox">Checkbox</option>
                  </select>
                </div>
                {newFieldForm.fieldType === 'dropdown' && (
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Values From</label>
                    <select
                      value={newFieldForm.metadataTypeKey}
                      onChange={(e) => setNewFieldForm({ ...newFieldForm, metadataTypeKey: e.target.value })}
                      className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest focus:ring-2 focus:ring-[#978C21]/10 outline-none"
                    >
                      <option value="">Select a metadata type...</option>
                      {metadataTypes.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
                    </select>
                  </div>
                )}
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Mandatory?</label>
                  <button
                    onClick={() => setNewFieldForm({ ...newFieldForm, isMandatory: !newFieldForm.isMandatory })}
                    className={cn(
                      "w-full border rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest transition-all",
                      newFieldForm.isMandatory ? "bg-[#978C21] text-white border-[#978C21]" : "bg-white text-slate-400 border-slate-200"
                    )}
                  >
                    {newFieldForm.isMandatory ? 'Required' : 'Optional'}
                  </button>
                </div>
                <button
                  onClick={handleAddField}
                  className="bg-[#978C21] text-white px-6 py-3 rounded-sm font-black text-[11px] uppercase tracking-widest hover:bg-black transition-all shadow-lg"
                >
                  Create Field
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
                              <span className="text-[8px] font-black text-[#978C21] bg-[#978C21]/10 px-1.5 py-0.5 rounded-sm uppercase tracking-wider shrink-0">System</span>
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
                              {field.isMandatory ? 'Required' : 'Optional'}
                            </button>
                            <button onClick={() => handleMoveField(section, i, -1)} disabled={i === 0} className="p-1 text-slate-300 hover:text-[#978C21] disabled:opacity-20 disabled:cursor-not-allowed">
                              <ArrowUp className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => handleMoveField(section, i, 1)} disabled={i === fields.length - 1} className="p-1 text-slate-300 hover:text-[#978C21] disabled:opacity-20 disabled:cursor-not-allowed">
                              <ArrowDown className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => handleToggleFieldVisible(field)} title={field.isVisible ? 'Hide field' : 'Show field'} className="p-1 text-slate-300 hover:text-[#978C21]">
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
              <h5 className="text-[13px] font-black text-brand-text uppercase tracking-[0.15em]">Lead Status Pipeline & Workflow Rules</h5>
              <p className="text-[10px] text-slate-400 uppercase tracking-widest mt-2 not-italic">
                For each status, control which statuses a lead can move to next, and what information is required to enter that status.
                By default every status can move to any other status.
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
                          Requires Loss Reason
                        </label>
                        <label className="flex items-center gap-2 text-[9px] font-black uppercase tracking-widest text-slate-500 cursor-pointer">
                          <input type="checkbox" checked={!!rule?.requiresMeetingType} onChange={() => handleToggleRequirement(status, 'requiresMeetingType')} />
                          Requires Meeting Type
                        </label>
                        <label className="flex items-center gap-2 text-[9px] font-black uppercase tracking-widest text-slate-500 cursor-pointer">
                          <input type="checkbox" checked={!!rule?.requiresFollowUpType} onChange={() => handleToggleRequirement(status, 'requiresFollowUpType')} />
                          Requires Follow-up Type
                        </label>
                        <label className="flex items-center gap-2 text-[9px] font-black uppercase tracking-widest text-slate-500 cursor-pointer">
                          <input type="checkbox" checked={!!rule?.requiresNote} onChange={() => handleToggleRequirement(status, 'requiresNote')} />
                          Requires Note
                        </label>
                      </div>
                    </div>
                    <div className="p-6">
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">
                          Can move to {isRestricted ? `(${rule!.allowedNextStatuses!.length} allowed)` : '(any status - unrestricted)'}
                        </p>
                        {isRestricted && (
                          <button onClick={() => handleResetToUnrestricted(status)} className="text-[9px] font-black text-[#978C21] uppercase tracking-widest hover:underline">
                            Reset to Unrestricted
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
                  No lead statuses found. Add some under Strategy Parameters first.
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
