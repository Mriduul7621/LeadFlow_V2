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
  ShieldCheck,
  AlertTriangle,
  ListChecks
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import {
  parseSpreadsheetBytes,
  gridToKeyedRows,
  gridWithDefval,
  downloadWorkbook,
  LEGACY_XLS_MESSAGE,
} from '../../shared/utils/excel';
import { leadService, type BulkImportResult } from '../services/leadService';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { useCallerTeam } from '../../team/hooks/useCallerTeam';
import { callerHasTeam } from '../../team/services/teamOverviewService';
import { EnterprisePageHeader } from '../../workspace/components/EnterprisePrimitives';
import { REAL_SHEET_HEADERS, mapRowForPreview, formatSheetCellForDisplay, isDateColumn, type PreviewRow } from '../utils/leadUploadMapping';

/** Display formatting for preview cells (never mutates the submitted data). */
/**
 * F17 — display one raw sheet cell.
 *
 * The column matters: only a real date column may interpret a number as an
 * Excel serial. The previous version date-formatted every cell, which turned
 * an "Interested amount of investment" of 50000 into 2036-11-21 in the
 * preview even though the server received, and stored, 50000.
 */
function displayCell(cell: any, header: unknown = ''): string {
  return formatSheetCellForDisplay(cell, header);
}

export default function LeadUpload() {
  const { canAccess, userRole, serverPermissionsSettled } = usePermissions();
  // Team Lead lead upload (2026-11-19): the route gate already
  // admits admins and team leads; this page gate mirrors the
  // server's bulk-import rule exactly — an explicit leads.import
  // grant, or leads.create plus ≥1 subordinate. The
  // has-subordinate arm is what opens the page for a team lead: no
  // default grant set carries leads.import, so the import check
  // alone would deny every TL (and adding it to the TEAM_LEAD
  // defaults would not change production's stored rows anyway).
  const callerTeam = useCallerTeam();
  const hasSubordinates = callerHasTeam(callerTeam.overview?.people);
  const canUpload = canAccess('lead_upl_gen', 'upload_raw_csv_xlsx')
    || (hasSubordinates && canAccess('lead_generate', 'capture_new_leads'));

  const [dragActive, setDragActive] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewData, setPreviewData] = useState<any[]>([]);
  const [fullData, setFullData] = useState<any[]>([]);
  const [mappedRows, setMappedRows] = useState<PreviewRow[]>([]);
  const [serverPreview, setServerPreview] = useState<BulkImportResult | null>(null);
  const [importResult, setImportResult] = useState<BulkImportResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [processing, setProcessing] = useState(false);
  /** Column headers of the loaded sheet — they tell each preview cell
   *  whether it is a date column (F17: only a date column may read a bare
   *  number as an Excel serial; an amount must stay 50000, not 2036-11-21). */
  const headerRow: any[] = Array.isArray(previewData[0]) ? previewData[0] : [];

  // Wait for the permission sheet before deciding: it loads in an
  // effect after the first paint, and a first-paint "Access Denied"
  // for a team lead would be wrong. FeatureGate already waited for
  // the team overview on a cold load, so the team arm is settled by
  // the time this page mounts — this wait is only the sheet's.
  if (!serverPermissionsSettled) {
    return (
      <div className="ep-page" style={{ maxWidth: 640 }}>
        <div className="ep-card" style={{ marginTop: 48 }} role="status" aria-label="Checking access">
          <div className="h-9 w-60 bg-stone-100 rounded-[10px] animate-pulse" />
          <div className="h-44 bg-stone-100 rounded-[12px] animate-pulse" style={{ marginTop: 16 }} />
        </div>
      </div>
    );
  }

  if (!canUpload) {
    return (
      <div className="ep-page" style={{ maxWidth: 640 }}>
        <div className="ep-card" style={{ textAlign: 'center', marginTop: 48 }}>
          <div className="w-16 h-16 rounded-full bg-amber-50 border border-amber-100 flex items-center justify-center text-[#978C21] shrink-0 mx-auto">
            <AlertCircle className="w-8 h-8" />
          </div>
          <div className="space-y-2" style={{ marginTop: 16 }}>
            <span className="text-sm font-medium text-[#978C21]">Access Restricted</span>
            <h2 className="text-xl font-bold text-slate-900">Access Denied</h2>
            <p className="ep-muted">
              Your role <span className="font-bold text-red-600">"{userRole || 'RESTRICTED'}"</span> does not have permission to upload lead sheets.
            </p>
          </div>
          <div className="pt-2 border-t border-slate-100 w-full text-[9px] font-mono text-slate-400 uppercase tracking-widest leading-none" style={{ marginTop: 16 }}>
            Strict Security Level: Lead import required (admin, or team lead with lead creation)
          </div>
        </div>
      </div>
    );
  }

  const downloadTemplate = async () => {
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
        // Corporate Group Leads (065): a corporate client CODE in
        // this column (e.g. from the MIS Corporate Clients sheet)
        // uploads the row as a corporate lead — source auto-set,
        // client linked. The example stays a normal source so a
        // first-time user still sees the plain shape.
        'Source': 'Social media',
        'Product': 'SCEP',
        'Other Info': '',
        'Campaign Name': "Child Education April`26",
        // Blank on purpose: the app's own sample must import as-is, and an
        // employee id that does not exist in THIS workspace would make the
        // first row fail (F9). The hint below the table says how to fill it.
        'Assigned To': '',
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
      await downloadWorkbook('Shanta_Life_Leads_Upload_Template.xlsx', [{
        name: 'Leads Template',
        rows: templateData,
        headers: [...REAL_SHEET_HEADERS],
        columnWidths: REAL_SHEET_HEADERS.map(() => 18),
      }]);
      toast.success('Correct format template downloaded! Fill and upload this sheet.');
    } catch (err) {
      toast.error('Failed to generate download spreadsheet template.');
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
      toast.error(err?.message || 'Preview validation failed. Check your connection and permissions.');
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
    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith('.xls') && !lowerName.endsWith('.xlsx')) {
      // Legacy binary .xls can no longer be parsed (Phase 4: the old
      // SheetJS reader was replaced for security). Ask for a re-save.
      toast.error(LEGACY_XLS_MESSAGE);
      return;
    }
    if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.csv')) {
      setFile(file);
      setProcessing(true);

      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const bytes = new Uint8Array(e.target?.result as ArrayBuffer);
          const parsed = await parseSpreadsheetBytes(bytes, lowerName.endsWith('.csv') ? 'csv' : 'xlsx');
          const sheet = parsed.sheets[0];
          if (!sheet) throw new Error('No sheet found in file');
          const data = gridWithDefval(sheet.grid);
          // Rows keyed by the FIRST ROW's headers - raw rows are submitted
          // unchanged and the server maps the exact headers authoritatively.
          const rows = gridToKeyedRows(sheet.grid);
          setFullData(rows);
          setPreviewData(data.slice(0, 7)); // Preview header + 6 rows
          setImportResult(null);
          setMappedRows(rows.map((row: any, i: number) => mapRowForPreview(row, i)).filter(r => r.hasAnyValue));
          // F8: parsing a file is not an import. Saying "imported successfully"
          // here promised a write that had not happened (and, with rejected
          // rows, never would). Report the load, then let the server preview
          // and the import report speak about data.
          if (rows.length > 0) {
            toast.info(`${rows.length} row(s) loaded — validating against the server…`);
            void runServerValidation(rows);
          } else {
            toast.error('No data rows found in the file (only the header row).');
            setServerPreview(null);
          }
        } catch (err: any) {
          toast.error(err?.message === LEGACY_XLS_MESSAGE ? LEGACY_XLS_MESSAGE : 'Failed to parse file. Check integrity.');
        } finally {
          setProcessing(false);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      toast.error('Invalid protocol. Please inject Excel or CSV format.');
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
        toast.warning(`${result.inserted} inserted, ${result.updated} updated, ${result.failed} failed of ${result.total} row(s). See the report below.`);
      } else {
        toast.success(`Successfully imported ${result.inserted} new and ${result.updated} updated lead(s).`);
        resetFileState();
      }
    } catch (err: any) {
      toast.error(err?.message || 'Import failed. Nothing was saved.');
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
    <div className="ep-page">
      <EnterprisePageHeader
        path="/leads/upload"
        actions={(
          <button
            type="button"
            onClick={downloadTemplate}
            className="ep-btn"
          >
            <Download className="w-4 h-4" />
            Download sample format
          </button>
        )}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
         <div className="lg:col-span-2 space-y-8">
            <div
               onDragEnter={handleDrag}
               onDragOver={handleDrag}
               onDragLeave={handleDrag}
               onDrop={handleDrop}
               className={cn(
                  "relative h-96 flex flex-col items-center justify-center text-center transition-all cursor-pointer overflow-hidden rounded-[14px] border-2 border-dashed",
                  dragActive ? "border-[#858515] bg-[#858515]/5 scale-[1.01]" : "border-slate-200 hover:border-[#858515]/50 bg-[#FBFAF8]"
               )}
            >
               <input
                  type="file"
                  className="absolute inset-0 opacity-0 cursor-pointer z-10"
                  onChange={handleChange}
                  accept=".xlsx, .csv"
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
                        <X className="w-4 h-4" /> Remove file
                        </button>
                     </motion.div>
                  ) : (
                     <div className="space-y-4">
                        <p className="text-3xl font-black text-brand-text tracking-tighter italic serif uppercase">Drop your file here</p>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.4em] italic leading-relaxed">XLSX or CSV &middot; up to 5,000 rows</p>
                        <div className="pt-10">
                           <div className="inline-flex items-center gap-3 px-6 py-3 bg-white border border-slate-100 shadow-sm rounded-sm">
                              <Plus className="w-4 h-4 text-[#978C21]" />
                              <span className="text-[10px] font-black uppercase tracking-widest text-slate-600">Select a file</span>
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
                  className="ep-card space-y-10"
               >
                  <div className="ep-cardhead">
                    <div className="flex items-center gap-4">
                      <ShieldCheck className={cn('w-8 h-8', attentionRows.length > 0 ? 'text-amber-500' : 'text-emerald-500')} />
                      <div>
                        <h3>Data integrity assessment</h3>
                        <div className="ep-muted">
                          {validating ? 'Validating against database…' : 'Pre-commit validation (read-only)'}
                        </div>
                      </div>
                    </div>
                    <span className="ep-pill">{mappedRows.length} data row(s)</span>
                  </div>

                  {/* Validation summary */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                     {[
                        { label: 'Total Rows', val: mappedRows.length, tone: 'text-slate-700' },
                        { label: 'Local Issues', val: localIssueRows.length, tone: localIssueRows.length ? 'text-red-500' : 'text-emerald-600' },
                        { label: 'Would Insert', val: serverPreview ? serverPreview.inserted : '—', tone: 'text-emerald-600' },
                        { label: 'Would Update', val: serverPreview ? serverPreview.updated : '—', tone: 'text-blue-600' },
                     ].map((item, i) => (
                        <div key={i} className="ep-card" style={{ padding: 12 }}>
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

                  {/* Rows needing attention */}
                  {attentionRows.length > 0 && (
                     <div className="space-y-4">
                        <div className="flex items-center gap-3">
                           <ListChecks className="w-5 h-5 text-amber-500" />
                           <h4 className="text-[11px] font-black uppercase tracking-widest text-slate-500">Rows needing attention</h4>
                        </div>
                        <div className="ep-tablewrap" style={{ maxHeight: 256, overflowY: 'auto' }}>
                           <table>
                              <thead>
                                 <tr>
                                    <th>Sheet Row</th>
                                    <th>Name</th>
                                    <th>Phone</th>
                                    <th>Assigned To</th>
                                    <th>Issues</th>
                                 </tr>
                              </thead>
                              <tbody>
                                 {attentionRows.slice(0, 50).map((row, i) => (
                                    <tr key={i}>
                                       <td><strong>{row.rowNumber + 1}</strong></td>
                                       <td>{row.name || '—'}</td>
                                       <td>{row.phone || '—'}</td>
                                       <td>{row.assignedTo || '—'}</td>
                                       <td style={{ color: '#c84d43' }}><strong>{row.issues.join(' · ')}</strong></td>
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
                  <div className="ep-tablewrap">
                    <table>
                      <thead>
                        <tr>
                          {(previewData[0] || []).map((cell: any, j: number) => (
                            <th key={j} className="whitespace-nowrap">{displayCell(cell, headerRow[j])}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {previewData.slice(1).map((row: any, i) => (
                          <tr key={i}>
                            {row.map((cell: any, j: number) => (
                              <td
                                key={j}
                                className={cn(
                                  'whitespace-nowrap',
                                  isDateColumn(headerRow[j]) && 'tabular-nums'
                                )}
                              >
                                {displayCell(cell, headerRow[j])}
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
                      <strong>Assignment Logic:</strong> "Assigned To" must match an ACTIVE employee ID of this workspace (see Administration → Users) — otherwise the row is rejected. Blank leaves the lead unassigned, which is what the sample file does. Statuses must match your configured Lead Status options, and historical dates are preserved exactly. <strong>Corporate leads:</strong> put the company's MIS code in the Source column — the row uploads as a Corporate Client Group Insurance lead linked to that company; a code that matches no client is a dry-run error naming the row.
                    </p>
                  </div>

                  {/* Import result report */}
                  {importResult && (
                     <div className={cn('border p-6 rounded-sm space-y-4', importResult.failed > 0 ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50')}>
                        <div className="flex items-center gap-3">
                           {importResult.failed > 0 ? <AlertTriangle className="w-5 h-5 text-amber-600" /> : <CheckCircle2 className="w-5 h-5 text-emerald-600" />}
                           <h4 className="text-[12px] font-black uppercase tracking-widest text-slate-700">Import report</h4>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                           {[
                              { label: 'Inserted', val: importResult.inserted },
                              { label: 'Updated', val: importResult.updated },
                              { label: 'Skipped Duplicates', val: importResult.skipped },
                              { label: 'Failed', val: importResult.failed },
                              { label: 'Total', val: importResult.total },
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
                    className="ep-btn ep-btn-primary"
                    style={{ width: '100%', justifyContent: 'center', padding: '14px' }}
                  >
                    {processing ? 'Importing…' : validating ? 'Validating…' : `Import ${fullData.length} row(s)`}
                    <ArrowRight className="w-5 h-5" />
                  </button>
               </motion.div>
            )}
         </div>

         <div className="space-y-6">
            <div className="ep-card group">
               <div className="flex items-center gap-4 mb-8">
                  <div className="w-10 h-10 rounded-sm bg-slate-50 flex items-center justify-center text-slate-400 group-hover:text-amber-500 transition-colors">
                     <AlertCircle className="w-6 h-6" />
                  </div>
                  <h4 className="font-black text-[13px] uppercase tracking-widest text-brand-text italic serif">Upload rules</h4>
               </div>
                <ul className="space-y-6">
                  {[
                     { label: 'Protocols', val: 'XLSX, CSV' },
                     { label: 'Max Payload', val: '5,000 Entities' },
                     { label: 'Mandatory', val: 'Name, Phone' },
                     { label: 'Assigned To', val: 'Active Employee ID' },
                     { label: 'Statuses', val: 'Configured Options' }
                  ].map((item, i) => (
                     <li key={i} className="flex justify-between items-end border-b border-slate-50 pb-2">
                        <span className="text-[10px] font-black text-slate-300 uppercase tracking-widest italic">{item.label}</span>
                        <span className="text-[11px] font-black text-brand-text italic">{item.val}</span>
                     </li>
                  ))}
               </ul>
            </div>

            <div className="ep-card">
               <div className="flex items-center gap-4 mb-8">
                  <ShieldCheck className="w-6 h-6 text-[#978C21]" />
                  <h4 className="font-black text-[13px] uppercase tracking-widest text-brand-text italic serif">How import works</h4>
               </div>
               <p className="text-[11px] font-black text-slate-500 leading-relaxed italic uppercase tracking-tighter">
                  Each row is imported as the lead's CURRENT STATE. Initial/Follow-up statuses, remarks, TAT and dates are preserved. Existing leads are updated safely — blank cells never erase data, and duplicates are reported.
               </p>
            </div>

            <div className="ep-card">
               <div className="flex items-center justify-between mb-6">
                  <span className="text-[10px] font-black text-slate-300 uppercase tracking-widest italic">Database Sync</span>
                  <div className="w-2 h-2 rounded-full bg-[#10B981] animate-pulse" />
               </div>
               <p className="text-[11px] font-black text-slate-500 leading-relaxed italic uppercase tracking-tight">
                  Rows commit directly to PostgreSQL in a single transaction. Nothing is reported as saved unless the database confirmed it.
               </p>
            </div>
         </div>
      </div>
    </div>
  );
}
