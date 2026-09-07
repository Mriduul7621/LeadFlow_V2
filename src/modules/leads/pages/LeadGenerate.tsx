import React, { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { 
  User as UserIcon, 
  Briefcase, 
  ArrowRight,
  ShieldCheck,
  Zap,
  Check,
  AlertCircle
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../../../lib/utils';
import { motion } from 'framer-motion';
import { leadService } from '../services/leadService';
import { metadataService } from '../../metadata/services/metadataService';
import { formBuilderService } from '../../forms/services/formBuilderService';
import { FormField } from '../../shared/types';
import { useAuthStore } from '../../auth/store/authStore';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { BANGLADESH_GEOGRAPHY } from '../../shared/utils/bangladeshGeography';

// System fields whose presence/format is essential to a lead record -
// these stay in the form regardless of admin visibility settings, so
// the Form Builder can't be used to accidentally break lead creation.
const ALWAYS_VISIBLE_FIELDS = new Set(['prospectName', 'mobile']);

/**
 * Builds the Zod validation schema dynamically from the admin's Form
 * Builder configuration - a field's "Required" toggle in Settings >
 * Form Builder directly controls whether Zod enforces it here.
 */
function buildLeadSchema(fieldConfigMap: Record<string, FormField>) {
  const isMandatory = (key: string, fallback: boolean) =>
    fieldConfigMap[key] ? fieldConfigMap[key].isMandatory : fallback;

  const req = (key: string, fallback: boolean, message = 'Required') =>
    isMandatory(key, fallback) ? z.string().min(1, message) : z.string().optional().default('');

  return z.object({
    prospectName: z.string().min(3, 'Required'),
    mobile: z.string()
      .length(11, 'Mobile number must be exactly 11 digits')
      .refine(val => /^\d+$/.test(val), 'Mobile number must contain only numbers')
      .refine(val => val.startsWith('01'), 'Mobile number must start with 01'),
    profession: req('profession', true),
    occupation: req('occupation', false),
    priority: req('priority', false),
    maritalStatus: req('maritalStatus', true),
    noOfChildren: z.string().optional(),
    familyMember: req('familyMember', false),
    division: req('division', true),
    district: req('district', true),
    thana: req('thana', true),
    residenceAddress: req('residenceAddress', false),
    officeAddress: req('officeAddress', false),
    source: req('source', true),
    productName: req('productName', true),
    campaignName: req('campaignName', true),
    otherInfo: req('otherInfo', false),
    customFields: z.record(z.string(), z.string()).optional(),
  }).superRefine((data, ctx) => {
    const needsChild = ['Married', 'Divorced', 'Widowed', 'Widow'].includes(data.maritalStatus);
    if (needsChild) {
      if (!data.noOfChildren || data.noOfChildren.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Number of children is required',
          path: ['noOfChildren'],
        });
      }
    }
  });
}

export default function LeadGenerate() {
  const { user } = useAuthStore();
  const { canAccess, userRole } = usePermissions();

  if (!canAccess('lead_generate', 'create')) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center p-8 bg-white border border-slate-200 rounded-sm max-w-xl mx-auto space-y-6 animate-in fade-in duration-300 mt-12">
        <div className="w-16 h-16 rounded-full bg-amber-50 border border-amber-100 flex items-center justify-center text-[#978C21] shrink-0 transform hover:rotate-12 transition-transform">
          <AlertCircle className="w-8 h-8" />
        </div>
        <div className="space-y-2">
          <span className="text-sm font-medium text-[#978C21]">প্রবেশাধিকার সংরক্ষিত (Access Restricted)</span>
          <h2 className="text-xl font-bold text-slate-900">Access Denied</h2>
          <p className="text-xs text-slate-500 leading-relaxed font-sans">
            আপনার বর্তমান পদবি <span className="text-red-650 font-black">"{userRole || 'RESTRICTED'}"</span> অনুযায়ী আপনার লিড তৈরি করার অনুমতি নেই। (Your role does not have permission to create leads).
          </p>
        </div>
        <div className="pt-2 border-t border-slate-100 w-full text-[9px] font-mono text-slate-400 uppercase tracking-widest leading-none">
          Strict Security Level: Feature lead_generate.create Required
        </div>
      </div>
    );
  }
  const [options, setOptions] = useState<any>({});
  const [fieldConfigs, setFieldConfigs] = useState<FormField[]>([]);
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

  const { register, handleSubmit, watch, reset, setValue, formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(leadSchema),
    defaultValues: {
      prospectName: '',
      mobile: '',
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
      const types = ['Profession', 'Occupation', 'MaritalStatus', 'Area', 'Source', 'Product', 'Campaign', 'Priority'];
      const results = await Promise.all(types.map(t => metadataService.getActiveValues(t)));
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
    };
    loadOptions();
  }, []);

  const maritalStatus = watch('maritalStatus');
  const selectedDivision = watch('division');
  const selectedDistrict = watch('district');

  useEffect(() => {
    setValue('district', '');
    setValue('thana', '');
  }, [selectedDivision, setValue]);

  useEffect(() => {
    setValue('thana', '');
  }, [selectedDistrict, setValue]);

  const divisions = Object.keys(BANGLADESH_GEOGRAPHY);
  const districts = selectedDivision ? Object.keys(BANGLADESH_GEOGRAPHY[selectedDivision] || {}) : [];
  const thanas = (selectedDivision && selectedDistrict) ? (BANGLADESH_GEOGRAPHY[selectedDivision]?.[selectedDistrict] || []) : [];

  const onSubmit = async (data: any) => {
    if (!user) return;
    
    const combinedArea = `${data.thana}, ${data.district}, ${data.division}`;
    const childPresence = ['Married', 'Divorced', 'Widowed', 'Widow'].includes(data.maritalStatus);
    
    try {
      await leadService.createLead({
        ...data,
        area: combinedArea,
        hasChild: childPresence && Number(data.noOfChildren) > 0,
        noOfChildren: childPresence ? data.noOfChildren : '0',
        assignedTo: user.employeeId,
        assignedBy: user.employeeId,
        currentStatus: 'Untouched',
        projectedNCP: 0,
        collectedNCP: 0,
        creationDate: new Date().toISOString(),
        timestamp: new Date().toISOString()
      });
      toast.success('নতুন লিড সফলভাবে তৈরি হয়েছে! (Lead generated successfully)');
      reset();
    } catch (err) {
      toast.error('লিড তৈরি করতে সমস্যা হয়েছে, অনুগ্রহ করে আবার চেষ্টা করুন।');
    }
  };

  return (
    <div className="max-w-5xl mx-auto pb-24 space-y-12">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-8 border-b border-slate-100 pb-10">
        <div className="flex items-center gap-6">
          <div className="w-16 h-16 bg-slate-900 rounded-sm flex items-center justify-center text-[#978C21] shadow-xl">
            <Zap className="w-8 h-8 fill-[#978C21]" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-800 leading-none">Add New Lead</h1>
            <p className="text-slate-400 font-bold text-[10px] uppercase tracking-widest mt-3 italic">নতুন কাস্টমারের তথ্য যুক্ত করার ফরম (Add New Customer Info)</p>
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-10">
        {/* Section 1: Identity */}
        <motion.section 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-sm border border-slate-100 p-10 shadow-sm"
        >
          <div className="flex items-center gap-4 mb-12 border-b border-slate-50 pb-6">
            <UserIcon className="w-6 h-6 text-[#978C21]" />
            <h2 className="font-semibold text-base text-slate-800">কাস্টমারের তথ্য (Customer Info)</h2>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-700">কাস্টমারের নাম (Customer Name) *</label>
              <input 
                {...register('prospectName')}
                className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-black uppercase tracking-tight italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none" 
                placeholder="কাস্টমারের পূর্ণ নাম লিখুন"
              />
              {errors.prospectName && <p className="text-xs text-red-500">{errors.prospectName.message}</p>}
            </div>

            <div className="space-y-3">
              <label className="text-sm font-medium text-slate-700 flex items-center justify-between">
                <span>মোবাইল নম্বর (Mobile Number) *</span>
                <span className="text-[8px] text-[#978C21] font-black normal-case">(যেমন: ০১৭১২৩৪৫৬৭৮)</span>
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
                placeholder="মোবাইল নম্বর লিখুন"
              />
              {errors.mobile && <p className="text-xs text-red-500">{errors.mobile.message}</p>}
            </div>

            {isFieldVisible('profession') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">পেশা (Occupation){fieldConfigMap.profession?.isMandatory !== false && ' *'}</label>
                <select 
                  {...register('profession')}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer"
                >
                  <option value="">পেশা নির্বাচন করুন (Select Profession)</option>
                  {options.Profession?.map((p: string) => <option key={p} value={p}>{p}</option>)}
                </select>
                {errors.profession && <p className="text-xs text-red-500">{errors.profession.message as string}</p>}
              </div>
            )}

            {isFieldVisible('occupation') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">উপ-পেশা (Occupation){fieldConfigMap.occupation?.isMandatory && ' *'}</label>
                <select 
                  {...register('occupation')}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer"
                >
                  <option value="">উপ-পেশা নির্বাচন করুন (Select Occupation)</option>
                  {options.Occupation?.map((p: string) => <option key={p} value={p}>{p}</option>)}
                </select>
                {errors.occupation && <p className="text-xs text-red-500">{errors.occupation.message as string}</p>}
              </div>
            )}

            {isFieldVisible('priority') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">অগ্রাধিকার (Priority){fieldConfigMap.priority?.isMandatory && ' *'}</label>
                <select 
                  {...register('priority')}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer"
                >
                  <option value="">অগ্রাধিকার নির্বাচন করুন (Select Priority)</option>
                  {options.Priority?.map((p: string) => <option key={p} value={p}>{p}</option>)}
                </select>
                {errors.priority && <p className="text-xs text-red-500">{errors.priority.message as string}</p>}
              </div>
            )}

            {isFieldVisible('maritalStatus') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">বৈবাহিক অবস্থা (Marital Status){fieldConfigMap.maritalStatus?.isMandatory !== false && ' *'}</label>
                <select 
                  {...register('maritalStatus')}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer"
                >
                  <option value="">বৈবাহিক অবস্থা নির্বাচন করুন</option>
                  {options.MaritalStatus?.map((m: string) => <option key={m} value={m}>{m}</option>)}
                </select>
                {errors.maritalStatus && <p className="text-xs text-red-500">{errors.maritalStatus.message as string}</p>}
              </div>
            )}

            {['Married', 'Divorced', 'Widowed', 'Widow'].includes(maritalStatus) && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">সন্তানের সংখ্যা (Number of Children) *</label>
                <input 
                  type="number"
                  min="0"
                  {...register('noOfChildren')}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-black uppercase tracking-tight italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none" 
                  placeholder="সন্তানের সংখ্যা লিখুন"
                />
                {errors.noOfChildren && <p className="text-xs text-red-500">{errors.noOfChildren.message}</p>}
              </div>
            )}

            {isFieldVisible('familyMember') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">পরিবারের সদস্য সংখ্যা (Family Members){fieldConfigMap.familyMember?.isMandatory && ' *'}</label>
                <input 
                  {...register('familyMember')}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-black uppercase tracking-tight italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none" 
                  placeholder="পরিবারের সদস্য সংখ্যা"
                />
                {errors.familyMember && <p className="text-xs text-red-500">{errors.familyMember.message as string}</p>}
              </div>
            )}
          </div>
        </motion.section>

        {/* Section 2: Strategy */}
        <motion.section 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="bg-white rounded-sm border border-slate-100 p-10 shadow-sm"
        >
          <div className="flex items-center gap-4 mb-12 border-b border-slate-50 pb-6">
            <Briefcase className="w-6 h-6 text-[#978C21]" />
            <h2 className="font-semibold text-base text-slate-800">ঠিকানা ও ক্যাম্পেইন (Address & Campaign)</h2>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
            {isFieldVisible('division') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">বিভাগ (Division){fieldConfigMap.division?.isMandatory !== false && ' *'}</label>
                <select 
                  {...register('division')}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer"
                >
                  <option value="">বিভাগ নির্বাচন করুন</option>
                  {divisions.map((d: string) => <option key={d} value={d}>{d.toUpperCase()}</option>)}
                </select>
                {errors.division && <p className="text-xs text-red-500">{errors.division.message as string}</p>}
              </div>
            )}

            {isFieldVisible('district') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">জেলা (District){fieldConfigMap.district?.isMandatory !== false && ' *'}</label>
                <select 
                  {...register('district')}
                  disabled={!selectedDivision}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <option value="">জেলা নির্বাচন করুন</option>
                  {districts.map((d: string) => <option key={d} value={d}>{d.toUpperCase()}</option>)}
                </select>
                {errors.district && <p className="text-xs text-red-500">{errors.district.message as string}</p>}
              </div>
            )}

            {isFieldVisible('thana') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">থানা / উপজেলা (Thana){fieldConfigMap.thana?.isMandatory !== false && ' *'}</label>
                <select 
                  {...register('thana')}
                  disabled={!selectedDistrict}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <option value="">থানা নির্বাচন করুন</option>
                  {thanas.map((t: string) => <option key={t} value={t}>{t.toUpperCase()}</option>)}
                </select>
                {errors.thana && <p className="text-xs text-red-500">{errors.thana.message as string}</p>}
              </div>
            )}

            {isFieldVisible('residenceAddress') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">বাসার ঠিকানা (Residence Address){fieldConfigMap.residenceAddress?.isMandatory && ' *'}</label>
                <input 
                  {...register('residenceAddress')}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-black uppercase tracking-tight italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none" 
                  placeholder="বাসার ঠিকানা লিখুন"
                />
                {errors.residenceAddress && <p className="text-xs text-red-500">{errors.residenceAddress.message as string}</p>}
              </div>
            )}

            {isFieldVisible('officeAddress') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">অফিসের ঠিকানা (Office Address){fieldConfigMap.officeAddress?.isMandatory && ' *'}</label>
                <input 
                  {...register('officeAddress')}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-black uppercase tracking-tight italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none" 
                  placeholder="অফিসের ঠিকানা লিখুন"
                />
                {errors.officeAddress && <p className="text-xs text-red-500">{errors.officeAddress.message as string}</p>}
              </div>
            )}

            {isFieldVisible('productName') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">পরিকল্পিত প্রোডাক্ট (Product){fieldConfigMap.productName?.isMandatory !== false && ' *'}</label>
                <select 
                  {...register('productName')}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer"
                >
                  <option value="">প্রোডাক্ট নির্বাচন করুন</option>
                  {options.Product?.map((p: string) => <option key={p} value={p}>{p}</option>)}
                </select>
                {errors.productName && <p className="text-xs text-red-500">{errors.productName.message as string}</p>}
              </div>
            )}

            {isFieldVisible('source') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">উৎস (Lead Source){fieldConfigMap.source?.isMandatory !== false && ' *'}</label>
                <select 
                  {...register('source')}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer"
                >
                  <option value="">উৎস নির্বাচন করুন</option>
                  {options.Source?.map((s: string) => <option key={s} value={s}>{s}</option>)}
                </select>
                {errors.source && <p className="text-xs text-red-500">{errors.source.message as string}</p>}
              </div>
            )}

            {isFieldVisible('campaignName') && (
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">ক্যাম্পেইন (Campaign){fieldConfigMap.campaignName?.isMandatory !== false && ' *'}</label>
                <select 
                  {...register('campaignName')}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer"
                >
                  <option value="">ক্যাম্পেইন নির্বাচন করুন</option>
                  {options.Campaign?.map((c: string) => <option key={c} value={c}>{c}</option>)}
                </select>
                {errors.campaignName && <p className="text-xs text-red-500">{errors.campaignName.message as string}</p>}
              </div>
            )}

            {isFieldVisible('otherInfo') && (
              <div className="space-y-3 md:col-span-2">
                <label className="text-sm font-medium text-slate-700">অন্যান্য তথ্য (Other Information){fieldConfigMap.otherInfo?.isMandatory && ' *'}</label>
                <textarea 
                  {...register('otherInfo')}
                  rows={3}
                  className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-sm font-bold focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none" 
                  placeholder="অতিরিক্ত কোনো তথ্য থাকলে লিখুন"
                />
                {errors.otherInfo && <p className="text-xs text-red-500">{errors.otherInfo.message as string}</p>}
              </div>
            )}
          </div>
        </motion.section>

        {/* Section 3: Additional (admin-added custom fields via Form Builder) */}
        {customFieldDefs.length > 0 && (
          <motion.section 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="bg-white rounded-sm border border-slate-100 p-10 shadow-sm"
          >
            <div className="flex items-center gap-4 mb-12 border-b border-slate-50 pb-6">
              <Briefcase className="w-6 h-6 text-[#978C21]" />
              <h2 className="font-semibold text-base text-slate-800">অতিরিক্ত তথ্য (Additional Information)</h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
              {customFieldDefs.map(field => (
                <div key={field.id} className={cn("space-y-3", field.fieldType === 'textarea' && "md:col-span-2")}>
                  <label className="text-sm font-medium text-slate-700">
                    {field.label}{field.isMandatory && ' *'}
                  </label>
                  {field.fieldType === 'dropdown' ? (
                    <select
                      {...register(`customFields.${field.fieldKey}` as any)}
                      className="w-full px-5 py-4 bg-[#FBFAF8] border border-slate-100 rounded-sm text-xs font-black uppercase tracking-widest italic focus:ring-2 focus:ring-primary/5 focus:border-[#978C21] transition-all outline-none cursor-pointer"
                    >
                      <option value="">নির্বাচন করুন</option>
                      {(options[field.metadataTypeKey || ''] || []).map((v: string) => <option key={v} value={v}>{v}</option>)}
                    </select>
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
                      <option value="true">হ্যাঁ (Yes)</option>
                      <option value="false">না (No)</option>
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
            </div>
          </motion.section>
        )}

        <div className="flex items-center justify-end gap-6 mt-16 group">
          <div className="flex items-center gap-2 mr-auto italic opacity-40">
             <ShieldCheck className="w-4 h-4 text-emerald-500" />
             <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">তথ্য নিরাপদভাবে সংরক্ষিত হচ্ছে</span>
          </div>
          <button 
            type="submit" 
            disabled={isSubmitting}
            className="w-64 py-5 bg-slate-900 hover:bg-black text-white text-[12px] font-black uppercase tracking-widest transition-all rounded-sm shadow-2xl flex items-center justify-center gap-4 group italic disabled:opacity-50"
          >
            {isSubmitting ? 'সংরক্ষণ করা হচ্ছে...' : (
              <>
                লিড তৈরি করুন (Generate Lead)
                <ArrowRight className="w-5 h-5 text-[#978C21] group-hover:translate-x-2 transition-transform" />
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
