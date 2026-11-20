import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  User as UserIcon,
  ShieldCheck,
  Check,
  AlertCircle
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from '../../shared/utils/translations';
import { cn } from '../../../lib/utils';
import { motion } from 'framer-motion';
import { leadService } from '../services/leadService';
import { buildLeadSchema } from '../utils/leadFormSchema';
import CreatableSelect from '../components/CreatableSelect';
import { metadataService } from '../../metadata/services/metadataService';
import { formBuilderService } from '../../forms/services/formBuilderService';
import { FormField } from '../../shared/types';
import { useAuthStore } from '../../auth/store/authStore';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { useCallerTeam } from '../../team/hooks/useCallerTeam';
import { downlineOf } from '../../team/services/teamOverviewService';
import { BANGLADESH_GEOGRAPHY } from '../../shared/utils/bangladeshGeography';
import { EnterprisePageHeader } from '../../workspace/components/EnterprisePrimitives';

// System fields whose presence/format is essential to a lead record -
// these stay in the form regardless of admin visibility settings, so
// the Form Builder can't be used to accidentally break lead creation.
const ALWAYS_VISIBLE_FIELDS = new Set(['prospectName', 'mobile']);

// Fields that live behind the "More details" toggle (Agent workspace
// rebuild, 2026-11-20). A failed submit re-opens the section when an
// error sits inside one of these, so a hidden mandatory field can
// never silently block the save.
const MORE_DETAILS_FIELDS = [
  'profession', 'occupation', 'maritalStatus', 'noOfChildren',
  'familyMember', 'division', 'district', 'thana',
  'residenceAddress', 'officeAddress', 'productName', 'campaignName',
  'customFields',
];

// The validation schema lives in ../utils/leadFormSchema.ts: the Form
// Builder "Required" flag is the ONLY source of required-ness there —
// conditional rules may decide when a field applies, never whether it is
// required (owner decision, 2026-11-11).
// EDIT MODE (2026-11-20): the same form edits customer information
// when rendered at /leads/:id/edit (Lead360's Edit button). The route
// used to not exist at all, so the catch-all sent the user home —
// that was the reported bug. In edit mode the form loads the lead,
// pre-fills every field (system + custom), and saves through
// leadService.updateLead — the EXISTING server upsert, which matches
// by lead code, preserves status/assignment/history, and enforces
// leads.edit + visibility server-side. Status/remarks stay in
// LeadUpdate; assignment changes stay in Reassign; this form never
// touches them. (Pattern ported from the superseded PR #158 onto
// current main — #158's diff itself is pre-enterprise and must never
// be merged or cherry-picked.)
export default function LeadGenerate() {
  const { user } = useAuthStore();
  const { t, language } = useTranslation();
  const { canAccess, userRole } = usePermissions();
  const navigate = useNavigate();
  const { id: editLeadId } = useParams<{ id: string }>();
  const isEditMode = Boolean(editLeadId);

  /**
   * Capability check — EVALUATED, never early-returned, before the hooks.
   *
   * `canAccess()` is NOT synchronous for non-admin roles: the role matrix
   * arrives one tick later (localStorage read in usePermissions' effect,
   * then a server permission sheet). Returning the AccessDenied tree
   * BEFORE the hooks below therefore made the first render shorter than
   * the second one, and React aborted the page with error #310
   * ("Rendered more hooks than during the previous render") for every
   * MANAGER / TEAM_LEAD / EMPLOYEE — and the route boundary then kept the
   * whole session showing "Something went wrong" until a full reload.
   *
   * The decision is still enforced, exactly as strictly as before; it is
   * simply enforced AFTER the hook list (see the single `if` below), so
   * the hook order is identical on every render.
   */
  const mayCreateLead = canAccess('lead_generate', 'create');
  // Edit mode is gated on the same grant as Lead360's Edit button
  // (lead_tracking.edit → the canonical leads.edit); create mode
  // keeps its own grant. The server re-checks both, plus
  // visibility, on the actual save.
  const mayEditLead = canAccess('lead_tracking', 'edit');
  const mayUseForm = isEditMode ? mayEditLead : mayCreateLead;

  const [options, setOptions] = useState<any>({});
  const [fieldConfigs, setFieldConfigs] = useState<FormField[]>([]);
  const [fieldsLoaded, setFieldsLoaded] = useState(false);
  // Edit mode: the loaded lead, its load state, and the pre-fill
  // guards. prefilledRef runs the pre-fill exactly once (the
  // field-config list arriving later must not reset the user's
  // edits); prefillingRef holds the division/district cascade
  // effects off while reset() writes all three geography fields
  // at once (without it they would wipe district/thana the moment
  // division landed).
  const [editLead, setEditLead] = useState<any | null>(null);
  const [editLoading, setEditLoading] = useState(isEditMode);
  const [editLoadError, setEditLoadError] = useState<string | null>(null);
  const prefilledRef = useRef(false);
  const prefillingRef = useRef(false);
  // Agent workspace rebuild (2026-11-20): the "More details"
  // toggle (collapsed by default in create mode, open in edit
  // mode — an editor should see the pre-filled details, not hunt
  // for them behind a collapsed section) and the Assign-to
  // options — the caller's full downline, resolved from the team
  // overview. Both hooks sit here, BEFORE the capability gate
  // below, so the hook order never changes (React #310).
  const [showMoreDetails, setShowMoreDetails] = useState(isEditMode);
  const callerTeam = useCallerTeam();
  const assignOptions = useMemo(() => {
    if (!user || !callerTeam.overview) return [];
    return downlineOf(callerTeam.overview.people, user.employeeId);
  }, [callerTeam.overview, user]);
  const fieldConfigMap = useMemo(() => {
    const map: Record<string, FormField> = {};
    fieldConfigs.forEach(f => { map[f.fieldKey] = f; });
    return map;
  }, [fieldConfigs]);
  const customFieldDefs = useMemo(
    () => fieldConfigs.filter(f => !f.isSystem && f.isVisible).sort((a, b) => a.sortOrder - b.sortOrder),
    [fieldConfigs]
  );
  const isFieldVisible = (key: string) => {
    if (ALWAYS_VISIBLE_FIELDS.has(key)) return true;
    return fieldConfigMap[key] ? fieldConfigMap[key].isVisible : true;
  };
  const leadSchema = useMemo(() => buildLeadSchema(fieldConfigMap), [fieldConfigMap]);

  const { register, handleSubmit, watch, reset, setValue, control, formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(leadSchema),
    defaultValues: {
      prospectName: '',
      mobile: '',
      email: '',
      assignedTo: '',
      profession: '',
      occupation: '',
      priority: '',
      maritalStatus: '',
      noOfChildren: '',
      division: '',
      district: '',
      thana: '',
      source: '',
      productName: '',
      campaignName: '',
      residenceAddress: '',
      officeAddress: '',
      otherInfo: '',
      familyMember: '',
      customFields: {} as Record<string, string>,
    }
  });

  useEffect(() => {
    const loadOptions = async () => {
      try {
        const types = ['Profession', 'Occupation', 'MaritalStatus', 'Area', 'Source', 'Product', 'Campaign', 'Priority'];
        const results = await Promise.all(types.map(t => metadataService.getActiveValues(t, t === 'Source')));
        const newOptions: any = {};
        types.forEach((t, i) => { newOptions[t] = results[i]; });
        // Also preload values for any custom dropdown field's metadata type
        const fields = await formBuilderService.getFields();
        setFieldConfigs(fields);
        const customDropdownTypes = fields
          .filter(f => !f.isSystem && f.fieldType === 'dropdown' && f.metadataTypeKey)
          .map(f => f.metadataTypeKey!);
        const customResults = await Promise.all(customDropdownTypes.map(t => metadataService.getActiveValues(t)));
        customDropdownTypes.forEach((t, i) => { newOptions[t] = customResults[i]; });
        setOptions(newOptions);
      } finally {
        // Even when the dictionaries fail, the pre-fill must still
        // run (system fields only) instead of hanging on a spinner.
        setFieldsLoaded(true);
      }
    };
    // A user without the capability never sees the form, so the option
    // dictionaries are not worth a request for them. The guard is inside
    // the effect (not around it) so the hook list stays unconditional.
    if (!mayUseForm) return;
    loadOptions();
  }, [mayUseForm]);

  const maritalStatus = watch('maritalStatus');
  const selectedDivision = watch('division');
  const selectedDistrict = watch('district');

  useEffect(() => {
    // While a pre-fill reset is landing, the cascade must not wipe
    // the district/thana the same reset just wrote (edit mode).
    if (prefillingRef.current) return;
    setValue('district', '');
    setValue('thana', '');
  }, [selectedDivision, setValue]);

  useEffect(() => {
    if (prefillingRef.current) return;
    setValue('thana', '');
  }, [selectedDistrict, setValue]);

  // Edit mode: load the lead (GET /api/leads/:id — lead code or
  // UUID; the server 404s out-of-scope leads, never leaks them).
  useEffect(() => {
    if (!isEditMode || !editLeadId || !mayEditLead) return;
    let cancelled = false;
    setEditLoading(true);
    setEditLoadError(null);
    leadService.getLead(editLeadId)
      .then(lead => {
        if (cancelled) return;
        if (!lead) {
          setEditLoadError('Lead not found. It may have been deleted, or it is outside your scope.');
          return;
        }
        setEditLead(lead);
      })
      .catch(() => {
        if (!cancelled) setEditLoadError('Could not load this lead. Please try again.');
      })
      .finally(() => {
        if (!cancelled) setEditLoading(false);
      });
    return () => { cancelled = true; };
  }, [isEditMode, editLeadId, mayEditLead]);

  // Edit mode: pre-fill once the lead AND the field configs have
  // both arrived (custom fields need the config list for their
  // keys). The server stores thana in custom_fields and the area
  // string as "thana, district, division" — prefer the stored
  // thana, fall back to parsing the area string.
  useEffect(() => {
    if (!isEditMode || !editLead || !fieldsLoaded || prefilledRef.current) return;
    prefilledRef.current = true;
    prefillingRef.current = true;
    const areaParts = String(editLead.area || '').split(',').map((s: string) => s.trim()).filter(Boolean);
    const thana = String(editLead.thana || '') || (areaParts.length >= 3 ? areaParts[0] : '');
    const custom: Record<string, string> = {};
    customFieldDefs.forEach(f => {
      const v = (editLead as any)[f.fieldKey];
      if (v !== undefined && v !== null && v !== '') custom[f.fieldKey] = String(v);
    });
    reset({
      prospectName: editLead.prospectName || editLead.customerName || '',
      mobile: editLead.mobile || '',
      email: editLead.email || '',
      // Assignment is never edited here (Reassign owns it) — the
      // field is hidden in edit mode and the edit submit never
      // reads it; blank keeps the reset shape complete.
      assignedTo: '',
      profession: editLead.profession || editLead.occupation || '',
      occupation: editLead.occupation || '',
      priority: editLead.priority || '',
      maritalStatus: editLead.maritalStatus || '',
      noOfChildren: editLead.noOfChildren != null ? String(editLead.noOfChildren) : '',
      division: editLead.division || '',
      district: editLead.district || '',
      thana,
      source: editLead.source || '',
      productName: editLead.productName || '',
      campaignName: editLead.campaignName || '',
      residenceAddress: editLead.residenceAddress || '',
      officeAddress: editLead.officeAddress || '',
      otherInfo: editLead.otherInfo || '',
      familyMember: editLead.familyMember || '',
      customFields: custom,
    });
    // The division/district cascade effects run on the same render
    // cycle as this reset — keep the guard up until they have run.
    setTimeout(() => { prefillingRef.current = false; }, 0);
  }, [isEditMode, editLead, fieldsLoaded, customFieldDefs, reset]);

  /**
   * The capability gate — placed after EVERY hook call on purpose.
   * Reordering this above the hooks re-introduces React #310; see the
   * `mayCreateLead` note at the top of the component.
   */
  if (!mayUseForm) {
    return (
      <div className="ep-page" style={{ maxWidth: 640 }}>
        <div className="ep-card" style={{ textAlign: 'center', marginTop: 48 }}>
        <div className="w-16 h-16 rounded-full bg-amber-50 border border-amber-100 flex items-center justify-center text-[#978C21] shrink-0 transform hover:rotate-12 transition-transform">
          <AlertCircle className="w-8 h-8" />
        </div>
        <div className="space-y-2">
          <span className="text-sm font-medium text-[#978C21]">{t("accessRestricted")}</span>
          <h2 className="text-xl font-bold text-slate-900">Access Denied</h2>
          <p className="text-xs text-slate-500 leading-relaxed font-sans">
            {t('accessDeniedMsg')}
          </p>
        </div>
        <div className="pt-2 border-t border-slate-100 w-full text-[9px] font-mono text-slate-400 uppercase tracking-widest leading-none">
          Strict Security Level: Feature {isEditMode ? 'lead_tracking.edit' : 'lead_generate.create'} Required
        </div>
        </div>
      </div>
    );
  }

  // Edit mode: loading / not-found states (after the hooks, like
  // the capability gate above).
  if (isEditMode && editLoading) {
    return (
      <div className="ep-page ep-leadform lead-generate-page space-y-4" role="status" aria-label="Loading lead">
        <div className="h-16 bg-stone-100 rounded-[12px] animate-pulse" />
        <div className="h-96 bg-stone-100 rounded-[12px] animate-pulse" />
      </div>
    );
  }

  if (isEditMode && editLoadError) {
    return (
      <div className="ep-page" style={{ maxWidth: 640 }}>
        <div className="ep-card" style={{ textAlign: 'center', marginTop: 48 }}>
          <div className="w-16 h-16 rounded-full bg-red-50 border border-red-100 flex items-center justify-center text-red-500 shrink-0">
            <AlertCircle className="w-8 h-8" />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-bold text-slate-900">Could not open this lead</h2>
            <p className="text-xs text-slate-500 leading-relaxed font-sans">{editLoadError}</p>
          </div>
          <button
            type="button"
            onClick={() => navigate('/leads')}
            className="ep-btn ep-btn-primary"
          >
            Back to Leads
          </button>
        </div>
      </div>
    );
  }

  const divisions = Object.keys(BANGLADESH_GEOGRAPHY);
  const districts = selectedDivision ? Object.keys(BANGLADESH_GEOGRAPHY[selectedDivision] || {}) : [];
  const thanas = (selectedDivision && selectedDistrict) ? (BANGLADESH_GEOGRAPHY[selectedDivision]?.[selectedDistrict] || []) : [];

  /**
   * The "+" on every metadata dropdown: persist the typed option via
   * the server's narrow quick-add path (shared — it lands in everyone's
   * dropdown), mirror it into this form's option list, and resolve with
   * the canonical value so CreatableSelect selects it for this lead.
   * A case-insensitive namesake resolves with the STORED spelling
   * (`existing`) — no duplicate is created. Errors toast here and
   * rethrow so the component keeps the typed text for retry/cancel.
   */
  const handleAddOption = async (type: string, rawValue: string): Promise<string> => {
    try {
      const saved = await metadataService.quickAddOption(type, rawValue);
      const canonical = saved.label || saved.value;
      setOptions((prev: any) => {
        const list: string[] = prev[type] || [];
        if (list.some(v => v.toLowerCase() === canonical.toLowerCase())) return prev;
        return { ...prev, [type]: [...list, canonical] };
      });
      if ((saved as any).existing) {
        toast.info(`"${canonical}" is already on the list — selected it for you.`);
      } else {
        toast.success(`"${canonical}" added — it is now available for everyone.`);
      }
      return canonical;
    } catch (err: any) {
      toast.error(err?.message || 'Could not add the option. Please try again.');
      throw err;
    }
  };

  const onSubmit = async (data: any) => {
    if (!user) return;

    const combinedArea = `${data.thana}, ${data.district}, ${data.division}`;
    const childPresence = ['Married', 'Divorced', 'Widowed', 'Widow'].includes(data.maritalStatus);

    // Edit mode: customer information only — no status, no
    // assignment, no creation fields. updateLead merges these onto
    // the loaded lead and POSTs the full record to the server
    // upsert, which matches by lead code (so a changed mobile can
    // never retarget the write) and preserves status, assignment,
    // history and documents. The server enforces leads.edit +
    // visibility; a 403/404 there surfaces as an error toast.
    if (isEditMode && editLeadId) {
      try {
        await leadService.updateLead(editLeadId, {
          prospectName: data.prospectName,
          mobile: data.mobile,
          email: data.email,
          profession: data.profession,
          occupation: data.occupation,
          priority: data.priority,
          maritalStatus: data.maritalStatus,
          noOfChildren: childPresence ? data.noOfChildren : '0',
          hasChild: childPresence && Number(data.noOfChildren) > 0,
          division: data.division,
          district: data.district,
          thana: data.thana,
          area: combinedArea,
          source: data.source,
          productName: data.productName,
          campaignName: data.campaignName,
          residenceAddress: data.residenceAddress,
          officeAddress: data.officeAddress,
          otherInfo: data.otherInfo,
          familyMember: data.familyMember,
          customFields: data.customFields || {},
        });
        toast.success('Lead updated successfully');
        navigate(`/leads/${encodeURIComponent(editLeadId)}`);
      } catch (err: any) {
        toast.error(err?.message || 'Could not save the changes. Please try again.');
      }
      return;
    }

    try {
      // F12: the server upserts a lead when the MOBILE NUMBER already exists
      // (documented behaviour). Without this the operator saw "Lead created
      // successfully" while the existing record was being overwritten — the
      // classic double-entry accident going unnoticed until reporting.
      let matchedBy: 'leadCode' | 'mobile' | null = null;
      await leadService.createLead(
        {
          ...data,
          area: combinedArea,
          hasChild: childPresence && Number(data.noOfChildren) > 0,
          noOfChildren: childPresence ? data.noOfChildren : '0',
          // Agent workspace rebuild (2026-11-20): the Assign-to
          // dropdown may name a downline member; blank still means
          // "myself". The server re-validates the target against the
          // caller's scope and rejects anything outside it.
          assignedTo: data.assignedTo || user.employeeId,
          assignedBy: user.employeeId,
          currentStatus: 'New',
          projectedNCP: 0,
          collectedNCP: 0,
          creationDate: new Date().toISOString(),
          timestamp: new Date().toISOString()
        },
        { onMatch: info => { matchedBy = info.matchedBy; } }
      );
      if (matchedBy === 'mobile') {
        toast.warning(
          `A lead with the mobile number ${data.mobile} already existed — that record was updated instead of creating a duplicate. Open Leads to review it.`,
          { duration: 8000 }
        );
      } else {
        toast.success(t('leadCreatedSuccess'));
      }
      reset();
      setShowMoreDetails(false);
    } catch (err) {
      toast.error(t('leadCreatedError'));
    }
  };

  // A failed submit re-opens More details when any error sits inside
  // it, so a hidden mandatory field is never the silent blocker.
  const onInvalid = (formErrors: Record<string, unknown>) => {
    if (MORE_DETAILS_FIELDS.some(key => formErrors[key])) setShowMoreDetails(true);
  };

  return (
    <div className="ep-page ep-leadform lead-generate-page space-y-4">
      {/* Enterprise Preview restyle (2026-11-19): the sample's Add Lead
          page — eyebrow + H1 + the sample's own description, the form
          in sample cards, the sample's input style (via .ep-leadform
          CSS) and a "Save lead" submit. Agent workspace rebuild
          (2026-11-20): the simple first screen from Mahadi's demo,
          with the extras behind "More details" — no field removed,
          required-ness still the Form Builder's alone. */}
      <EnterprisePageHeader path={isEditMode ? '/leads/:id/edit' : '/leads/new'} />

      <form onSubmit={handleSubmit(onSubmit, onInvalid)} className="space-y-4">
        {/* Agent workspace rebuild (2026-11-20): the demo's simple
            "Add new lead" form — name, phone, email, source,
            priority, assign-to, notes — with every existing extra
            field behind a "More details" button. NO field is
            removed; the extras are only collapsed, and a failed
            submit re-opens them when an error sits inside. */}
        <motion.section 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="ep-card"
        >
          <div className="flex items-center gap-3 mb-6 border-b border-slate-50 pb-4">
            <UserIcon className="w-6 h-6 text-[#978C21]" />
            <h2 className="font-semibold text-base text-slate-800">{isEditMode ? 'Edit lead' : 'New lead'}</h2>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-700">{t("customerName")} *</label>
              <input 
                {...register('prospectName')}
                className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-black uppercase tracking-tight italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none" 
                placeholder={t("customerNamePh")}
              />
              {errors.prospectName && <p className="text-xs text-red-500">{errors.prospectName.message}</p>}
            </div>

            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-700 flex items-center justify-between">
                <span>{t("mobileNumber")} *</span>
                <span className="text-[8px] text-[#978C21] font-black normal-case"></span>
              </label>
              <input 
                type="text"
                maxLength={11}
                {...register('mobile', {
                  onChange: (e) => {
                    e.target.value = e.target.value.replace(/\D/g, '');
                  }
                })}
                className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-black uppercase tracking-tight focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none" 
                placeholder={t("mobileNumberPh")}
              />
              {errors.mobile && <p className="text-xs text-red-500">{errors.mobile.message}</p>}
            </div>

            {isFieldVisible('email') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">Email</label>
                <input
                  type="email"
                  inputMode="email"
                  {...register('email')}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-black uppercase tracking-tight italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none"
                  placeholder="name@example.com"
                />
                {errors.email && <p className="text-xs text-red-500">{errors.email.message as string}</p>}
              </div>
            )}

            {isFieldVisible('source') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">{t("source")}{fieldConfigMap.source?.isMandatory !== false && ' *'}</label>
                <Controller
                  control={control}
                  name="source"
                  render={({ field }) => (
                    <CreatableSelect
                      value={field.value || ''}
                      onChange={field.onChange}
                      options={options.Source || []}
                      placeholder={t("selectSource")}
                      onCreateOption={raw => handleAddOption('Source', raw)}
                      selectClassName="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer"
                    />
                  )}
                />
                {errors.source && <p className="text-xs text-red-500">{errors.source.message as string}</p>}
              </div>
            )}

            {isFieldVisible('priority') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">Priority{fieldConfigMap.priority?.isMandatory && ' *'}</label>
                <Controller
                  control={control}
                  name="priority"
                  render={({ field }) => (
                    <CreatableSelect
                      value={field.value || ''}
                      onChange={field.onChange}
                      options={options.Priority || []}
                      placeholder="Select Priority"
                      onCreateOption={raw => handleAddOption('Priority', raw)}
                      selectClassName="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer"
                    />
                  )}
                />
                {errors.priority && <p className="text-xs text-red-500">{errors.priority.message as string}</p>}
              </div>
            )}

            {/* Assign to: the caller's downline (plus "Myself"). A
                caller with no subordinates sees no dropdown at all —
                the lead goes to them, and a one-option dropdown
                would be a dead control. Hidden in edit mode:
                assignment changes go through Reassign, never this
                form, and the edit submit never sends assignedTo. */}
            {!isEditMode && assignOptions.length > 0 && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">Assign to</label>
                <select
                  {...register('assignedTo')}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer"
                >
                  <option value="">Myself</option>
                  {assignOptions.map(person => (
                    <option key={person.employeeId} value={person.employeeId}>
                      {person.name} ({person.employeeId})
                    </option>
                  ))}
                </select>
                {errors.assignedTo && <p className="text-xs text-red-500">{errors.assignedTo.message as string}</p>}
              </div>
            )}

            <div className="md:col-span-2">
              <button
                type="button"
                className="ep-btn"
                onClick={() => setShowMoreDetails(v => !v)}
                aria-expanded={showMoreDetails}
              >
                {showMoreDetails ? 'Hide details' : 'More details'}
              </button>
            </div>

            {showMoreDetails && (
              <>
            {isFieldVisible('profession') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">{t("profession")}{fieldConfigMap.profession?.isMandatory !== false && ' *'}</label>
                <Controller
                  control={control}
                  name="profession"
                  render={({ field }) => (
                    <CreatableSelect
                      value={field.value || ''}
                      onChange={field.onChange}
                      options={options.Profession || []}
                      placeholder={t("selectProfession")}
                      onCreateOption={raw => handleAddOption('Profession', raw)}
                      selectClassName="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer"
                    />
                  )}
                />
                {errors.profession && <p className="text-xs text-red-500">{errors.profession.message as string}</p>}
              </div>
            )}

            {isFieldVisible('occupation') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">{t("subProfession")}{fieldConfigMap.occupation?.isMandatory && ' *'}</label>
                <Controller
                  control={control}
                  name="occupation"
                  render={({ field }) => (
                    <CreatableSelect
                      value={field.value || ''}
                      onChange={field.onChange}
                      options={options.Occupation || []}
                      placeholder={`${t("selectSubProfession")} (Select Occupation)`}
                      onCreateOption={raw => handleAddOption('Occupation', raw)}
                      selectClassName="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer"
                    />
                  )}
                />
                {errors.occupation && <p className="text-xs text-red-500">{errors.occupation.message as string}</p>}
              </div>
            )}

            {isFieldVisible('maritalStatus') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">{t("maritalStatus")}{fieldConfigMap.maritalStatus?.isMandatory !== false && ' *'}</label>
                <Controller
                  control={control}
                  name="maritalStatus"
                  render={({ field }) => (
                    <CreatableSelect
                      value={field.value || ''}
                      onChange={field.onChange}
                      options={options.MaritalStatus || []}
                      placeholder={t("selectMaritalStatus")}
                      onCreateOption={raw => handleAddOption('MaritalStatus', raw)}
                      selectClassName="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer"
                    />
                  )}
                />
                {errors.maritalStatus && <p className="text-xs text-red-500">{errors.maritalStatus.message as string}</p>}
              </div>
            )}

            {['Married', 'Divorced', 'Widowed', 'Widow'].includes(maritalStatus) && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">{t("numberOfChildren")}{fieldConfigMap.noOfChildren?.isMandatory && ' *'}</label>
                <input 
                  type="number"
                  min="0"
                  {...register('noOfChildren')}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-black uppercase tracking-tight italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none" 
                  placeholder="Enter number of children"
                />
                {errors.noOfChildren && <p className="text-xs text-red-500">{errors.noOfChildren.message}</p>}
              </div>
            )}

            {isFieldVisible('familyMember') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">{t("familyMembersPh")} (Family Members){fieldConfigMap.familyMember?.isMandatory && ' *'}</label>
                <input 
                  {...register('familyMember')}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-black uppercase tracking-tight italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none" 
                  placeholder={t("familyMembersPh")}
                />
                {errors.familyMember && <p className="text-xs text-red-500">{errors.familyMember.message as string}</p>}
              </div>
            )}
            {isFieldVisible('division') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">{t("division")}{fieldConfigMap.division?.isMandatory !== false && ' *'}</label>
                <select 
                  {...register('division')}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer"
                >
                  <option value="">{t("selectDivision")}</option>
                  {divisions.map((d: string) => <option key={d} value={d}>{d.toUpperCase()}</option>)}
                </select>
                {errors.division && <p className="text-xs text-red-500">{errors.division.message as string}</p>}
              </div>
            )}

            {isFieldVisible('district') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">{t("district")}{fieldConfigMap.district?.isMandatory !== false && ' *'}</label>
                <select 
                  {...register('district')}
                  disabled={!selectedDivision}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <option value="">{t("selectDistrict")}</option>
                  {districts.map((d: string) => <option key={d} value={d}>{d.toUpperCase()}</option>)}
                </select>
                {errors.district && <p className="text-xs text-red-500">{errors.district.message as string}</p>}
              </div>
            )}

            {isFieldVisible('thana') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">{t("thana")}{fieldConfigMap.thana?.isMandatory !== false && ' *'}</label>
                <select 
                  {...register('thana')}
                  disabled={!selectedDistrict}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <option value="">{t("selectThana")}</option>
                  {thanas.map((t: string) => <option key={t} value={t}>{t.toUpperCase()}</option>)}
                </select>
                {errors.thana && <p className="text-xs text-red-500">{errors.thana.message as string}</p>}
              </div>
            )}

            {isFieldVisible('residenceAddress') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">{t("residenceAddress")}{fieldConfigMap.residenceAddress?.isMandatory && ' *'}</label>
                <input 
                  {...register('residenceAddress')}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-black uppercase tracking-tight italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none" 
                  placeholder={t("residenceAddressPh")}
                />
                {errors.residenceAddress && <p className="text-xs text-red-500">{errors.residenceAddress.message as string}</p>}
              </div>
            )}

            {isFieldVisible('officeAddress') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">{t("officeAddress")}{fieldConfigMap.officeAddress?.isMandatory && ' *'}</label>
                <input 
                  {...register('officeAddress')}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-black uppercase tracking-tight italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none" 
                  placeholder={t("officeAddressPh")}
                />
                {errors.officeAddress && <p className="text-xs text-red-500">{errors.officeAddress.message as string}</p>}
              </div>
            )}

            {isFieldVisible('productName') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">{t("product")}{fieldConfigMap.productName?.isMandatory !== false && ' *'}</label>
                <Controller
                  control={control}
                  name="productName"
                  render={({ field }) => (
                    <CreatableSelect
                      value={field.value || ''}
                      onChange={field.onChange}
                      options={options.Product || []}
                      placeholder={t("selectProduct")}
                      onCreateOption={raw => handleAddOption('Product', raw)}
                      selectClassName="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer"
                    />
                  )}
                />
                {errors.productName && <p className="text-xs text-red-500">{errors.productName.message as string}</p>}
              </div>
            )}

            {isFieldVisible('campaignName') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">{t("campaign")}{fieldConfigMap.campaignName?.isMandatory !== false && ' *'}</label>
                <Controller
                  control={control}
                  name="campaignName"
                  render={({ field }) => (
                    <CreatableSelect
                      value={field.value || ''}
                      onChange={field.onChange}
                      options={options.Campaign || []}
                      placeholder={t("selectCampaign")}
                      onCreateOption={raw => handleAddOption('Campaign', raw)}
                      selectClassName="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer"
                    />
                  )}
                />
                {errors.campaignName && <p className="text-xs text-red-500">{errors.campaignName.message as string}</p>}
              </div>
            )}

            {/* Admin-added custom fields (Form Builder) — extra
                details too, so they live behind the toggle. */}
            {customFieldDefs.map(field => (
              <div key={field.id} className={cn("space-y-3", field.fieldType === 'textarea' && "md:col-span-2")}>
                <label className="text-sm font-medium text-slate-700">
                  {field.label}{field.isMandatory && ' *'}
                </label>
                {field.fieldType === 'dropdown' ? (
                  <Controller
                    control={control}
                    name={`customFields.${field.fieldKey}` as any}
                    render={({ field: rhfField }) => (
                      <CreatableSelect
                        value={rhfField.value || ''}
                        onChange={rhfField.onChange}
                        options={options[field.metadataTypeKey || ''] || []}
                        placeholder="Select"
                        onCreateOption={raw => handleAddOption(field.metadataTypeKey || '', raw)}
                        selectClassName="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer"
                      />
                    )}
                  />
                ) : field.fieldType === 'textarea' ? (
                  <textarea
                    {...register(`customFields.${field.fieldKey}` as any)}
                    rows={3}
                    placeholder={field.placeholder}
                    className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-bold focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none"
                  />
                ) : field.fieldType === 'checkbox' ? (
                  <select
                    {...register(`customFields.${field.fieldKey}` as any)}
                    className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer"
                  >
                    <option value="">-</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                ) : (
                  <input
                    type={field.fieldType === 'number' ? 'number' : field.fieldType === 'date' ? 'date' : 'text'}
                    {...register(`customFields.${field.fieldKey}` as any)}
                    placeholder={field.placeholder}
                    className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-black uppercase tracking-tight italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none"
                  />
                )}
              </div>
            ))}
              </>
            )}

            {isFieldVisible('otherInfo') && (
              <div className="space-y-3 md:col-span-2">
                <label className="text-sm font-medium text-slate-700">{t("otherInfo")}{fieldConfigMap.otherInfo?.isMandatory && ' *'}</label>
                <textarea 
                  {...register('otherInfo')}
                  rows={3}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-bold focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none" 
                  placeholder={t("otherInfoPh")}
                />
                {errors.otherInfo && <p className="text-xs text-red-500">{errors.otherInfo.message as string}</p>}
              </div>
            )}
          </div>
        </motion.section>

        <div className="flex items-center justify-end gap-6 mt-6">
          <div className="flex items-center gap-2 mr-auto opacity-60">
             <ShieldCheck className="w-4 h-4 text-emerald-500" />
             <span className="text-xs font-medium text-stone-500">Your data is securely saved</span>
          </div>
          {isEditMode && (
            <button
              type="button"
              onClick={() => navigate(`/leads/${encodeURIComponent(editLeadId!)}`)}
              className="ep-btn"
            >
              Cancel
            </button>
          )}
          <button
            type="submit"
            disabled={isSubmitting}
            className="ep-btn ep-btn-primary disabled:opacity-50"
          >
            {isSubmitting ? t('loading') : (isEditMode ? 'Save changes' : 'Save lead')}
          </button>
        </div>
      </form>
    </div>
  );
}
