import React, { useState } from 'react';
import {
  FileSpreadsheet,
  AlertCircle,
  CheckCircle2,
  Download,
  Info,
  X,
  Plus,
  ArrowRight,
  Database,
  BarChart3,
  ShieldCheck,
  AlertTriangle,
  ListChecks
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import * as XLSX from 'xlsx';
import { toast } from 'sonner';
import { leadService, type BulkImportResult } from '../services/leadService';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { useTranslation } from '../../shared/utils/translations';
import { REAL_SHEET_HEADERS, mapRowForPreview, formatDateForDisplay, type PreviewRow } from '../utils/leadUploadMapping';

/** Display formatting for preview cells (never mutates the submitted data). */
function displayCell(cell: any): string {
  if (cell === null || cell === undefined) return '';
  // formatDateForDisplay handles Date instances, Excel serials and every
  // supported date-only string WITHOUT timezone shifting (a Date or a
  // "23-Apr-2026" cell must display the same calendar date that is stored).
  return formatDateForDisplay(cell);
}

export default function LeadUpload() {
  const { canAccess, userRole } = usePermissions();
  const { t } = useTranslation();

  const [dragActive, setDragActive] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewData, setPreviewData] = useState<any[]>([]);
  const [fullData, setFullData] = useState<any[]>([]);
  const [mappedRows, setMappedRows] = useState<PreviewRow[]>([]);
  const [serverPreview, setServerPreview] = useState<BulkImportResult | null>(null);
  const [importResult, setImportResult] = useState<BulkImportResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [processing, setProcessing] = useState(false);

  if (!canAccess('lead_upl_gen', 'upload_raw_csv_xlsx')) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center p-8 bg-white border border-slate-100 rounded-sm shadow-xs max-w-xl mx-auto space-y-6 animate-in fade-in duration-300 mt-12">
        <div className="w-16 h-16 rounded-full bg-amber-50 border border-amber-100 flex items-center justify-center text-[#978C21] shrink-0 transform hover:rotate-12 transition-transform">
          <AlertCircle className="w-8 h-8" />
        </div>
        <div className="space-y-2">
          <span className="text-sm font-medium text-[#978C21]">{t('uploadClearanceWarning')}</span>
          <h2 className="text-xl font-bold text-slate-900">{t('accessDeniedTitle')}</h2>
          <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider leading-relaxed">
            {t('uploadAccessDeniedDesc')}
          </p>
        </div>
        <div className="pt-2 border-t border-slate-100 w-full text-[9px] font-mono text-slate-400 uppercase tracking-widest leading-none">
          {t('uploadSecurityLevelRequired')}
        </div>
      </div>
    );
  }

  const downloadTemplate = () => {
    // Exact real spreadsheet headers with the business example row.
    const templateData = [
      {
        'Assigned Date': '23-Apr-2026',
        'Lead Date': '22-Apr-2026',
        'Name': 'Ranjon Tng',
        'Phone': '8801557586634',
        'E-mail': 'ranjanchakama@gmail.com',
        'Area': 'CTG',
        'Interested amount of investment': 500000,
        'Source': 'Social media',
        'Product': 'SCEP',
        'Other Info': '',
        'Campaign Name': "Child Education April`26",
        'Assigned To': 'Monsoor_CTG',
        'Previously Assigned': '',
        'TAT': 1,
        '1st Call date': '23-Apr-2026',
        'Initial Status': 'No response',
        'Initial Remarks': '',
        'Follow up date': '29-Apr-2026',
        'Follow up': 'Interested',
        'Final Remarks': 'The customer is currently busy as he works in a factory. He asked to be called at 8 PM.'
      }
    ];

    try {
      const worksheet = XLSX.utils.json_to_sheet(templateData, { header: [...REAL_SHEET_HEADERS] });
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Leads Template');
      worksheet['!cols'] = REAL_SHEET_HEADERS.map(() => ({ wch: 18 }));
      XLSX.writeFile(workbook, 'Shanta_Life_Leads_Upload_Template.xlsx');
      toast.success(t('templateDownloadSuccess'));
    } catch (err) {
      toast.error(t('templateDownloadFailed'));
    }
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0]);
    }
  };

  /**
   * Ask the server to validate the rows WITHOUT importing (dryRun).
   * This is the authoritative preview: it resolves "Assigned To" against
   * real users, statuses against the configured dictionary, and detects
   * duplicates - without writing anything.
   */
  const runServerValidation = async (rows: any[]) => {
    setValidating(true);
    try {
      const result = await leadService.bulkUploadLeads(rows, { dryRun: true });
      setServerPreview(result);
    } catch (err: any) {
      setServerPreview(null);
      toast.error(err?.message || t('previewValidationFailed'));
    } finally {
      setValidating(false);
    }
  };

  const resetFileState = () => {
    setFile(null);
    setPreviewData([]);
    setFullData([]);
    setMappedRows([]);
    setServerPreview(null);
    setImportResult(null);
  };

  const processFile = (file: File) => {
    if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls') || file.name.endsWith('.csv')) {
      setFile(file);
      setProcessing(true);

      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const bstr = e.target?.result;
          const wb = XLSX.read(bstr, { type: 'binary', cellDates: true });
          const wsname = wb.SheetNames[0];
          const ws = wb.Sheets[wsname];
          const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
          // Rows keyed by the FIRST ROW's headers - raw rows are submitted
          // unchanged and the server maps the exact headers authoritatively.
          const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
          setFullData(rows);
          setPreviewData(data.slice(0, 7)); // Preview header + 6 rows
          setImportResult(null);
          setMappedRows(rows.map((row: any, i: number) => mapRowForPreview(row, i)).filter(r => r.hasAnyValue));
          toast.success(t('dataImportedSuccess'));
          if (rows.length > 0) {
            void runServerValidation(rows);
          } else {
            setServerPreview(null);
          }
        } catch (err) {
          toast.error(t('parseFailed'));
        } finally {
          setProcessing(false);
        }
      };
      reader.readAsBinaryString(file);
    } else {
      toast.error(t('invalidProtocol'));
    }
  };

  const handleUpload = async () => {
    if (fullData.length === 0) return;

    setProcessing(true);
    try {
      // Raw rows are sent as-is: the server maps the exact spreadsheet
      // headers, resolves "Assigned To" against active users, validates
      // statuses and dates, registers new campaigns deterministically and
      // reports per-row results.
      const result = await leadService.bulkUploadLeads(fullData);
      setImportResult(result);
      setServerPreview(null);

      if (result.failed > 0) {
        toast.warning(t('importSummary', { inserted: String(result.inserted), updated: String(result.updated), failed: String(result.failed), total: String(result.total) }));
      } else {
        toast.success(t('importSuccessSummary', { inserted: String(result.inserted), updated: String(result.updated) }));
        resetFileState();
      }
    } catch (err: any) {
      toast.error(err?.message || t('importFailedNothingSaved'));
    } finally {
      setProcessing(false);
    }
  };

  const localIssueRows = mappedRows.filter(r => r.localIssues.length > 0);
  const serverErrors = serverPreview?.errors || [];
  const serverWarnings = serverPreview?.warnings || [];
  const attentionRows: Array<{ rowNumber: number; name: string; phone: string; assignedTo: string; issues: string[] }> = [
    ...localIssueRows.map(r => ({ rowNumber: r.rowNumber, name: r.name, phone: r.phone, assignedTo: r.assignedTo, issues: r.localIssues })),
    ...serverErrors
      .filter(e => !localIssueRows.some(r => r.rowNumber === e.index + 1))
      .map(e => {
        const row = mappedRows.find(r => r.rowNumber === e.index + 1);
        return {
          rowNumber: e.index + 1,
          name: row?.name || '',
          phone: row?.phone || '',
          assignedTo: row?.assignedTo || '',
          issues: [e.message],
        };
      }),
  ];

  return (
    <div className="max-w-5xl mx-auto space-y-12 pb-24">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-8 border-b border-slate-100 pb-10">
        <div className="flex items-center gap-6">
          <div className="w-16 h-16 bg-[#F9F9F4] rounded-sm flex items-center justify-center text-[#978C21] shadow-sm border border-slate-100">
            <Database className="w-8 h-8" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-800 leading-none">{t('bulkUploadTitle')}</h1>
            <p className="text-sm text-slate-500 mt-2">{t('bulkUploadSubtitle')}</p>
          </div>
        </div>
        <button
          onClick={downloadTemplate}
          className="flex items-center gap-3 px-6 py-3 bg-[#978C21]/10 hover:bg-[#978C21]/20 border border-[#978C21]/30 text-[#978C21] text-[10px] font-black uppercase tracking-widest transition-all rounded-sm shadow-sm active:scale-95 group animate-bounce-slow"
        >
          <Download className="w-4 h-4 text-[#978C21] transition-transform group-hover:translate-y-0.5" />
          {t('downloadSampleFormat')}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
         <div className="lg:col-span-2 space-y-8">
            <div
               onDragEnter={handleDrag}
               onDragOver={handleDrag}
               onDragLeave={handleDrag}
               onDrop={handleDrop}
               className={cn(
                  "relative h-96 flex flex-col items-center justify-center text-center transition-all cursor-pointer overflow-hidden rounded-sm border-2 border-dashed",
                  dragActive ? "border-[#978C21] bg-[#978C21]/5 scale-[1.01]" : "border-slate-200 hover:border-[#978C21]/50 bg-[#FBFAF8]"
               )}
            >
               <input
                  type="file"
                  className="absolute inset-0 opacity-0 cursor-pointer z-10"
                  onChange={handleChange}
                  accept=".xlsx, .xls, .csv"
               />

               <div className="w-20 h-20 bg-white rounded-sm shadow-xl flex items-center justify-center mb-8 border border-slate-50">
                  <FileSpreadsheet className={cn('w-10 h-10 text-[#978C21]', processing && 'animate-pulse')} />
               </div>

               <AnimatePresence mode="wait">
                  {file ? (
                     <motion.div
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="space-y-4"
                     >
                        <p className="text-xl font-bold text-slate-800">{file.name}</p>
                        <div className="flex items-center justify-center gap-4">
                           <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{(file.size / 1024).toFixed(2)} KB</span>
                           <div className="w-1 h-1 rounded-full bg-slate-300" />
                           <span className="text-[10px] font-black text-emerald-500 uppercase tracking-widest italic">{fullData.length} row(s) parsed</span>
                        </div>
                        <button
                           onClick={(e) => { e.stopPropagation(); resetFileState(); }}
                           className="text-red-500 text-[10px] font-black uppercase tracking-widest flex items-center gap-2 mx-auto hover:bg-red-50 px-4 py-2 rounded-sm mt-8 z-20 transition-all border border-transparent hover:border-red-100"
                        >
                        <X className="w-4 h-4" /> {t('removeEntity')}
                        </button>
                     </motion.div>
                  ) : (
                     <div className="space-y-4">
                        <p className="text-3xl font-black text-brand-text tracking-tighter italic serif uppercase">{t('dropLogicFile')}</p>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.4em] italic leading-relaxed">{t('dropLogicFileHint')}</p>
                        <div className="pt-10">
                           <div className="inline-flex items-center gap-3 px-6 py-3 bg-white border border-slate-100 shadow-sm rounded-sm">
                              <Plus className="w-4 h-4 text-[#978C21]" />
                              <span className="text-[10px] font-black uppercase tracking-widest text-slate-600">{t('selectLocalSource')}</span>
                           </div>
                        </div>
                     </div>
                  )}
               </AnimatePresence>
            </div>

            {fullData.length > 0 && (
               <motion.div
                  initial={{ opacity: 0, y: 30 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-white rounded-sm border border-slate-100 p-10 shadow-sm space-y-10"
               >
                  <div className="flex items-center justify-between border-b border-slate-50 pb-8">
                    <div className="flex items-center gap-4">
                      <ShieldCheck className={cn('w-8 h-8', attentionRows.length > 0 ? 'text-amber-500' : 'text-emerald-500')} />
                      <div>
                        <h3 className="font-black text-[18px] uppercase tracking-tight text-brand-text italic serif">{t('dataIntegrityAssessment')}</h3>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1 italic">
                          {validating ? 'Validating against database…' : 'Pre-commit validation (read-only)'}
                        </p>
                      </div>
                    </div>
                    <div className="px-4 py-2 bg-slate-50 rounded-sm">
                       <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest italic">{mappedRows.length} data row(s)</p>
                    </div>
                  </div>

                  {/* Validation summary */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                     {[
                        { label: 'totalRows', val: mappedRows.length, tone: 'text-slate-700' },
                        { label: 'localIssues', val: localIssueRows.length, tone: localIssueRows.length ? 'text-red-500' : 'text-emerald-600' },
                        { label: 'wouldInsert', val: serverPreview ? serverPreview.inserted : '—', tone: 'text-emerald-600' },
                        { label: 'wouldUpdate', val: serverPreview ? serverPreview.updated : '—', tone: 'text-blue-600' },
                     ].map((item, i) => (
                        <div key={i} className="border border-slate-100 rounded-sm p-4 bg-[#FBFAF8]">
                           <p className={cn('text-xl font-black', item.tone)}>{item.val}</p>
                           <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mt-1">{item.label}</p>
                        </div>
                     ))}
                  </div>

                  {serverPreview && serverPreview.failed > 0 && (
                     <div className="flex items-start gap-4 bg-red-50 border border-red-100 p-5 rounded-sm">
                        <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                        <p className="text-[11px] font-black text-red-600 leading-relaxed uppercase tracking-tight">
                           {serverPreview.failed} row(s) will be rejected. Fix the issues below (or remove those rows) before importing — valid rows can still be imported.
                        </p>
                     </div>
                  )}

                  {/* {t('rowsNeedingAttention')} */}
                  {attentionRows.length > 0 && (
                     <div className="space-y-4">
                        <div className="flex items-center gap-3">
                           <ListChecks className="w-5 h-5 text-amber-500" />
                           <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-500">{t('rowsNeedingAttention')}</h4>
                        </div>
                        <div className="overflow-x-auto border border-slate-100 rounded-sm max-h-64 overflow-y-auto">
                           <table className="w-full text-left">
                              <thead>
                                 <tr className="bg-[#3C3C3C] text-white text-[9px] font-black uppercase tracking-widest">
                                    <th className="px-4 py-3">{t('sheetRow')}</th>
                                    <th className="px-4 py-3">{t('name')}</th>
                                    <th className="px-4 py-3">{t('phone')}</th>
                                    <th className="px-4 py-3">{t('assignedTo')}</th>
                                    <th className="px-4 py-3">{t('issues')}</th>
                                 </tr>
                              </thead>
                              <tbody>
                                 {attentionRows.slice(0, 50).map((row, i) => (
                                    <tr key={i} className="text-[11px] text-slate-600 border-t border-slate-50 hover:bg-slate-50/60">
                                       <td className="px-4 py-3 font-black">{row.rowNumber + 1}</td>
                                       <td className="px-4 py-3">{row.name || '—'}</td>
                                       <td className="px-4 py-3">{row.phone || '—'}</td>
                                       <td className="px-4 py-3">{row.assignedTo || '—'}</td>
                                       <td className="px-4 py-3 text-red-500 font-bold">{row.issues.join(' · ')}</td>
                                    </tr>
                                 ))}
                              </tbody>
                           </table>
                        </div>
                     </div>
                  )}

                  {serverWarnings.length > 0 && (
                     <div className="bg-amber-50 border border-amber-100 p-5 rounded-sm space-y-2">
                        <p className="text-[10px] font-black text-amber-700 uppercase tracking-widest">Warnings ({serverWarnings.length})</p>
                        <ul className="space-y-1 max-h-32 overflow-y-auto">
                           {serverWarnings.slice(0, 20).map((w, i) => (
                              <li key={i} className="text-[11px] text-amber-700 font-bold">Row {w.index + 2}: {w.message}</li>
                           ))}
                        </ul>
                     </div>
                  )}

                  {/* Raw data preview */}
                  <div className="overflow-x-auto border border-slate-50 rounded-sm shadow-inner bg-[#FBFAF8]">
                    <table className="w-full text-left">
                      <tbody className="italic">
                        {previewData.map((row: any, i) => (
                          <tr key={i} className={cn(
                             'text-[11px] group transition-all',
                             i === 0 ? 'bg-[#3C3C3C] font-black text-white uppercase tracking-[0.1em]' : 'text-slate-500 font-bold hover:bg-white'
                          )}>
                            {row.map((cell: any, j: number) => (
                              <td key={j} className="px-6 py-4 whitespace-nowrap border-r border-slate-100/10">
                                {String(displayCell(cell))}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex items-center gap-6 bg-[#978C21]/5 p-6 rounded-sm border border-[#978C21]/10">
                    <Info className="w-6 h-6 text-[#978C21] shrink-0" />
                    <p className="text-[11px] font-black text-brand-text leading-relaxed italic uppercase tracking-tight">
                      <strong>{t('assignmentLogic')}:</strong> "Assigned To" must match an active employee ID (e.g. Monsoor_CTG) — otherwise the row is rejected. Blank leaves the lead unassigned. Statuses must match your configured Lead Status options, and historical dates are preserved exactly.
                    </p>
                  </div>

                  {/* Import result report */}
                  {importResult && (
                     <div className={cn('border p-6 rounded-sm space-y-4', importResult.failed > 0 ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50')}>
                        <div className="flex items-center gap-3">
                           {importResult.failed > 0 ? <AlertTriangle className="w-5 h-5 text-amber-600" /> : <CheckCircle2 className="w-5 h-5 text-emerald-600" />}
                           <h4 className="text-[12px] font-black uppercase tracking-widest text-slate-700">{t('importReport')}</h4>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                           {[
                              { label: 'inserted', val: importResult.inserted },
                              { label: 'updated', val: importResult.updated },
                              { label: 'skippedDuplicates', val: importResult.skipped },
                              { label: 'failed', val: importResult.failed },
                              { label: 'total', val: importResult.total },
                           ].map((item, i) => (
                              <div key={i} className="bg-white border border-slate-100 rounded-sm p-3">
                                 <p className="text-lg font-black text-slate-800">{item.val}</p>
                                 <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">{item.label}</p>
                              </div>
                           ))}
                        </div>
                        {typeof importResult.campaignsRegistered === 'number' && importResult.campaignsRegistered > 0 && (
                           <p className="text-[11px] font-bold text-slate-600 uppercase tracking-wide">{importResult.campaignsRegistered} new campaign(s) registered.</p>
                        )}
                        {importResult.errors.length > 0 && (
                           <div className="max-h-48 overflow-y-auto bg-white border border-slate-100 rounded-sm divide-y divide-slate-50">
                              {importResult.errors.map((e, i) => (
                                 <p key={i} className="text-[11px] text-red-600 font-bold px-4 py-2">Sheet row {e.index + 2}: {e.message}</p>
                              ))}
                           </div>
                        )}
                     </div>
                  )}

                  <button
                    onClick={handleUpload}
                    disabled={processing || validating || fullData.length === 0}
                    className={cn(
                      'w-full py-6 bg-slate-900 hover:bg-black text-white text-[12px] font-black uppercase tracking-[0.4em] transition-all rounded-sm shadow-xl flex items-center justify-center gap-4 group italic',
                      (processing || validating || fullData.length === 0) && 'opacity-60 cursor-not-allowed'
                    )}
                  >
                    {processing ? 'Importing…' : validating ? 'Validating…' : `Import ${fullData.length} row(s)`}
                    <ArrowRight className="w-5 h-5 text-[#978C21] group-hover:translate-x-2 transition-transform" />
                  </button>
               </motion.div>
            )}
         </div>

         <div className="space-y-6">
            <div className="bg-white rounded-sm border border-slate-100 p-8 shadow-sm group">
               <div className="flex items-center gap-4 mb-8">
                  <div className="w-10 h-10 rounded-sm bg-slate-50 flex items-center justify-center text-slate-400 group-hover:text-amber-500 transition-colors">
                     <AlertCircle className="w-6 h-6" />
                  </div>
                  <h4 className="font-black text-[13px] uppercase tracking-widest text-brand-text italic serif">{t('injectionConstraints')}</h4>
               </div>
                <ul className="space-y-6">
                  {[
                     { label: 'protocols', val: 'XLSX, XLS, CSV' },
                     { label: 'maxPayload', val: '5,000 Entities' },
                     { label: 'mandatory', val: 'Name, Phone' },
                     { label: t('assignedTo'), val: 'Active Employee ID' },
                     { label: 'statuses', val: 'Configured Options' }
                  ].map((item, i) => (
                     <li key={i} className="flex justify-between items-end border-b border-slate-50 pb-2">
                        <span className="text-[10px] font-black text-slate-300 uppercase tracking-widest italic">{item.label}</span>
                        <span className="text-[11px] font-black text-brand-text italic">{item.val}</span>
                     </li>
                  ))}
               </ul>
            </div>

            <div className="bg-[#3C3C3C] rounded-sm p-8 shadow-xl relative overflow-hidden">
               <div className="relative z-10">
                  <div className="flex items-center gap-4 mb-8">
                     <ShieldCheck className="w-6 h-6 text-[#978C21]" />
                     <h4 className="font-black text-[13px] uppercase tracking-widest text-white italic serif">{t('snapshotIntegrity')}</h4>
                  </div>
                  <p className="text-[11px] font-black text-slate-400 leading-relaxed italic uppercase tracking-tighter">
                     {t('snapshotIntegrityDesc')}
                  </p>
               </div>
               <BarChart3 className="absolute -bottom-6 -right-6 w-32 h-32 text-white/5 rotate-12" />
            </div>

            <div className="bg-white rounded-sm border border-slate-100 p-8 shadow-sm">
               <div className="flex items-center justify-between mb-6">
                  <span className="text-[10px] font-black text-slate-300 uppercase tracking-widest italic">{t('databaseSync')}</span>
                  <div className="w-2 h-2 rounded-full bg-[#10B981] animate-pulse" />
               </div>
               <p className="text-[11px] font-black text-slate-500 leading-relaxed italic uppercase tracking-tight">
                  {t('databaseSyncDesc')}
               </p>
            </div>
         </div>
      </div>
    </div>
  );
}
