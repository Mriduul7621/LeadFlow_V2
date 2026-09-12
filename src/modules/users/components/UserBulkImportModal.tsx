import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Upload, Download, AlertTriangle, CheckCircle2, XCircle, FileSpreadsheet, Copy, ShieldCheck, Info } from 'lucide-react';
import * as XLSX from 'xlsx';
import { parseUserImportFile, downloadUserImportTemplate, mapToServerRows, type ParsedUserBulkRow, USER_BULK_MAX_ROWS } from '../utils/userBulkImport';
import { userService } from '../services/userService';
import { orgService } from '../../hierarchy/services/orgService';
import { adminService } from '../../admin/services/adminService';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onClose: () => void;
  onCompleted: () => void;
}

type Step = 'upload' | 'preview' | 'result';

interface ServerPreview {
  totalRows: number;
  validRows: number;
  rowsToCreate: number;
  rowsToUpdate: number;
  errorRows: number;
  warningRows: number;
  rows: Array<{
    rowNumber: number;
    employeeId: string;
    fullName: string;
    email: string;
    roleInput: string;
    roleResolved?: string;
    departmentInput: string;
    departmentResolved?: string;
    teamInput: string;
    teamResolved?: string;
    managerInput: string;
    managerResolved?: string;
    managerIsSameBatch: boolean;
    action: 'Create' | 'Update' | 'Skip' | 'Error';
    isValid: boolean;
    errors: string[];
    warnings: string[];
  }>;
  fileName?: string;
  mode: 'createOnly' | 'createAndUpdate';
}

interface CommitResult {
  totalRows: number;
  created: number;
  updated: number;
  failed: number;
  skipped: number;
  errors: Array<{ rowNumber: number; employeeId: string; message: string }>;
  credentials: Array<{ employeeId: string; fullName: string; temporaryPassword: string; mustChangePassword: boolean }>;
  fileName?: string;
  mode: string;
}

export const UserBulkImportModal: React.FC<Props> = ({ open, onClose, onCompleted }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>('upload');
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState<string>('');
  const [parsedRows, setParsedRows] = useState<ParsedUserBulkRow[]>([]);
  const [localIssues, setLocalIssues] = useState<number>(0);
  const [serverPreview, setServerPreview] = useState<ServerPreview | null>(null);
  const [serverValidating, setServerValidating] = useState(false);
  const [mode, setMode] = useState<'createOnly' | 'createAndUpdate'>('createOnly');
  const [commitLoading, setCommitLoading] = useState(false);
  const [commitResult, setCommitResult] = useState<CommitResult | null>(null);

  const resetState = useCallback(() => {
    setStep('upload');
    setFileName('');
    setParsedRows([]);
    setLocalIssues(0);
    setServerPreview(null);
    setServerValidating(false);
    setCommitLoading(false);
    setCommitResult(null);
  }, []);

  const handleClose = useCallback(() => {
    resetState();
    onClose();
  }, [resetState, onClose]);

  const runServerValidation = useCallback(async (rows: ParsedUserBulkRow[], currentMode: 'createOnly' | 'createAndUpdate', currentFileName: string) => {
    setServerValidating(true);
    try {
      const serverRows = mapToServerRows(rows);
      const preview = await userService.validateBulkUsers(serverRows, currentMode, currentFileName);
      setServerPreview(preview);
      setStep('preview');
    } catch (e: any) {
      toast.error(e?.message || 'Server validation failed');
    } finally {
      setServerValidating(false);
    }
  }, []);

  const handleFile = useCallback(async (file: File) => {
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!['xlsx', 'xls', 'csv'].includes(ext || '')) {
      toast.error('Please upload an XLSX or CSV file');
      return;
    }
    setFileName(file.name);
    try {
      const { rows } = await parseUserImportFile(file);
      if (rows.length === 0) {
        toast.error('No data rows found in file');
        return;
      }
      if (rows.length > USER_BULK_MAX_ROWS) {
        toast.error(`File exceeds maximum ${USER_BULK_MAX_ROWS} rows`);
        return;
      }
      const issues = rows.filter(r => r.issues.length > 0).length;
      setParsedRows(rows);
      setLocalIssues(issues);
      await runServerValidation(rows, mode, file.name);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to parse file');
    }
  }, [mode, runServerValidation]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  }, [handleFile]);

  const onFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [handleFile]);

  const handleDownloadTemplate = useCallback(async () => {
    try {
      const [roles, departments, teams] = await Promise.all([
        adminService.getRoles(),
        orgService.getDepartments(),
        adminService.getTeams().catch(() => [] as any),
      ]);
      downloadUserImportTemplate({ roles, departments, teams } as any);
      toast.success('Template downloaded');
    } catch {
      toast.warning('Failed to build template, downloading blank');
      downloadUserImportTemplate({ roles: [], departments: [], teams: [] } as any);
    }
  }, []);

  const handleModeChange = useCallback(async (newMode: 'createOnly' | 'createAndUpdate') => {
    setMode(newMode);
    if (parsedRows.length > 0) {
      await runServerValidation(parsedRows, newMode, fileName);
    }
  }, [parsedRows, fileName, runServerValidation]);

  const handleCommit = useCallback(async () => {
    if (!serverPreview) return;
    if (serverPreview.validRows === 0) {
      toast.error('No valid rows to import');
      return;
    }
    setCommitLoading(true);
    try {
      const serverRows = mapToServerRows(parsedRows);
      const result = await userService.commitBulkUsers(serverRows, mode, fileName);
      setCommitResult(result);
      setStep('result');
      toast.success(`Imported: ${result.created} created, ${result.updated} updated`);
      onCompleted();
    } catch (e: any) {
      toast.error(e?.message || 'Bulk import commit failed');
    } finally {
      setCommitLoading(false);
    }
  }, [serverPreview, parsedRows, mode, fileName, onCompleted]);

  const attentionRows = useMemo(() => {
    if (!serverPreview) return [];
    return serverPreview.rows.filter(r => !r.isValid || r.warnings.length > 0);
  }, [serverPreview]);

  const handleCopyCredentials = useCallback(async () => {
    if (!commitResult?.credentials?.length) return;
    const text = commitResult.credentials.map(c => `${c.employeeId}\t${c.fullName}\t${c.temporaryPassword}\t${c.mustChangePassword ? 'Yes' : 'No'}`).join('\n');
    const header = 'Employee ID\tFull Name\tTemporary Password\tMust Change Password\n';
    try {
      await navigator.clipboard.writeText(header + text);
      toast.success('Credentials copied to clipboard');
    } catch {
      toast.error('Copy failed — please use download');
    }
  }, [commitResult]);

  const handleDownloadCredentials = useCallback(() => {
    if (!commitResult?.credentials?.length) return;
    const ws = XLSX.utils.json_to_sheet(commitResult.credentials.map(c => ({
      'Employee ID': c.employeeId,
      'Full Name': c.fullName,
      'Temporary Password': c.temporaryPassword,
      'Must Change Password': c.mustChangePassword ? 'Yes' : 'No',
    })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Credentials');
    XLSX.writeFile(wb, `User_Credentials_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }, [commitResult]);

  const handleDownloadErrors = useCallback(() => {
    if (!serverPreview) return;
    const errorRows = serverPreview.rows.filter(r => !r.isValid);
    const ws = XLSX.utils.json_to_sheet(errorRows.map(r => ({
      'Row Number': r.rowNumber,
      'Employee ID': r.employeeId,
      'Full Name': r.fullName,
      'Role': r.roleInput,
      'Department': r.departmentInput,
      'Manager': r.managerInput,
      'Action': r.action,
      'Errors': r.errors.join('; '),
      'Warnings': r.warnings.join('; '),
    })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Errors');
    XLSX.writeFile(wb, `User_Import_Errors_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }, [serverPreview]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center">
              <FileSpreadsheet className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Bulk Import Users</h2>
              <p className="text-xs text-gray-500">XLSX primary, CSV optional — validated partial success, secure provisioning</p>
            </div>
          </div>
          <button onClick={handleClose} className="p-2 rounded-xl hover:bg-gray-100">
            <XCircle className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <div className="px-6 py-3 bg-gray-50 border-b flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">Import Mode:</label>
            <select value={mode} onChange={e => handleModeChange(e.target.value as any)} className="text-sm border rounded-lg px-3 py-1.5">
              <option value="createOnly">CREATE ONLY (default)</option>
              <option value="createAndUpdate">CREATE + UPDATE EXISTING</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleDownloadTemplate} className="inline-flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg border bg-white hover:bg-gray-50">
              <Download className="w-4 h-4" /> Download Template
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {step === 'upload' && (
            <>
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                className={`border-2 border-dashed rounded-2xl p-8 text-center transition ${dragOver ? 'border-blue-500 bg-blue-50' : 'border-gray-300 bg-gray-50'}`}
              >
                <Upload className="w-8 h-8 mx-auto text-gray-400 mb-3" />
                <p className="text-sm font-medium text-gray-700">Drag & drop your XLSX file here</p>
                <p className="text-xs text-gray-500 mt-1">or click to browse — max {USER_BULK_MAX_ROWS} rows</p>
                <button onClick={() => fileInputRef.current?.click()} className="mt-4 px-4 py-2 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700">
                  Browse File
                </button>
                <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onFileInputChange} />
                {fileName && <p className="mt-3 text-xs text-gray-600">Selected: {fileName}</p>}
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex gap-3">
                <Info className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                <div className="text-xs text-amber-900 leading-relaxed">
                  <p className="font-semibold">How it works</p>
                  <ul className="list-disc ml-4 mt-1 space-y-1">
                    <li>Template has 3 sheets: Users (import), Reference Values (valid roles/departments/teams), Instructions (rules).</li>
                    <li>Employee ID is primary — duplicates in file are errors. Email must be unique.</li>
                    <li>Role/Department/Team must exactly match database (case-insensitive). Unknown values are row errors.</li>
                    <li>Reporting Manager resolved by Employee ID, supports same-batch managers, order irrelevant. Validates one-level-up same-dept.</li>
                    <li>Passwords: blank → server generates securely and returns once. Supplied passwords min 6 chars, hashed server-side.</li>
                    <li>Existing user passwords NEVER changed via bulk — use admin reset.</li>
                  </ul>
                </div>
              </div>

              {serverValidating && (
                <div className="text-center py-6 text-sm text-gray-600">Validating with server…</div>
              )}
            </>
          )}

          {step === 'preview' && serverPreview && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <div className="bg-white border rounded-xl p-3">
                  <div className="text-xs text-gray-500">Total Rows</div>
                  <div className="text-xl font-semibold">{serverPreview.totalRows}</div>
                </div>
                <div className="bg-white border rounded-xl p-3">
                  <div className="text-xs text-gray-500">Valid</div>
                  <div className="text-xl font-semibold text-green-600">{serverPreview.validRows}</div>
                </div>
                <div className="bg-white border rounded-xl p-3">
                  <div className="text-xs text-gray-500">To Create</div>
                  <div className="text-xl font-semibold text-blue-600">{serverPreview.rowsToCreate}</div>
                </div>
                <div className="bg-white border rounded-xl p-3">
                  <div className="text-xs text-gray-500">To Update</div>
                  <div className="text-xl font-semibold text-amber-600">{serverPreview.rowsToUpdate}</div>
                </div>
                <div className="bg-white border rounded-xl p-3">
                  <div className="text-xs text-gray-500">Errors</div>
                  <div className="text-xl font-semibold text-red-600">{serverPreview.errorRows}</div>
                </div>
              </div>

              {serverPreview.errorRows > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-3 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm text-red-800">
                    <AlertTriangle className="w-4 h-4" />
                    {serverPreview.errorRows} rows have errors and will be skipped. Valid rows will still be imported.
                  </div>
                  <button onClick={handleDownloadErrors} className="text-xs px-3 py-1 rounded-lg bg-white border hover:bg-gray-50">Download Errors</button>
                </div>
              )}

              {localIssues > 0 && (
                <div className="text-xs text-amber-700">Client detected {localIssues} rows with basic issues before server validation.</div>
              )}

              <div className="border rounded-xl overflow-hidden">
                <div className="px-4 py-2 bg-gray-50 border-b flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Rows needing attention ({attentionRows.length})</h3>
                  <span className="text-xs text-gray-500">Showing invalid + warnings</span>
                </div>
                <div className="max-h-[320px] overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="text-left p-2">Row</th>
                        <th className="text-left p-2">Employee ID</th>
                        <th className="text-left p-2">Full Name</th>
                        <th className="text-left p-2">Role</th>
                        <th className="text-left p-2">Dept</th>
                        <th className="text-left p-2">Manager</th>
                        <th className="text-left p-2">Action</th>
                        <th className="text-left p-2">Messages</th>
                      </tr>
                    </thead>
                    <tbody>
                      {attentionRows.map((r, idx) => (
                        <tr key={idx} className="border-t">
                          <td className="p-2">{r.rowNumber}</td>
                          <td className="p-2 font-medium">{r.employeeId}</td>
                          <td className="p-2">{r.fullName}</td>
                          <td className="p-2">{r.roleResolved || r.roleInput}</td>
                          <td className="p-2">{r.departmentResolved || r.departmentInput}</td>
                          <td className="p-2">{r.managerResolved || r.managerInput} {r.managerIsSameBatch ? '(batch)' : ''}</td>
                          <td className="p-2">
                            <span className={`px-2 py-0.5 rounded-full text-[10px] ${r.action === 'Error' ? 'bg-red-100 text-red-700' : r.action === 'Create' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>
                              {r.action}
                            </span>
                          </td>
                          <td className="p-2">
                            {r.errors.map((e, i) => <div key={i} className="text-red-600">{e}</div>)}
                            {r.warnings.map((w, i) => <div key={i} className="text-amber-600">{w}</div>)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="border rounded-xl overflow-hidden">
                <div className="px-4 py-2 bg-gray-50 border-b">
                  <h3 className="text-sm font-semibold">All rows preview ({serverPreview.rows.length})</h3>
                </div>
                <div className="max-h-[240px] overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="text-left p-2">Row</th>
                        <th className="text-left p-2">Employee ID</th>
                        <th className="text-left p-2">Full Name</th>
                        <th className="text-left p-2">Role</th>
                        <th className="text-left p-2">Dept</th>
                        <th className="text-left p-2">Manager</th>
                        <th className="text-left p-2">Action</th>
                        <th className="text-left p-2">Valid</th>
                      </tr>
                    </thead>
                    <tbody>
                      {serverPreview.rows.map((r, idx) => (
                        <tr key={idx} className="border-t">
                          <td className="p-2">{r.rowNumber}</td>
                          <td className="p-2">{r.employeeId}</td>
                          <td className="p-2">{r.fullName}</td>
                          <td className="p-2">{r.roleResolved || r.roleInput}</td>
                          <td className="p-2">{r.departmentResolved || r.departmentInput}</td>
                          <td className="p-2">{r.managerResolved || r.managerInput}</td>
                          <td className="p-2">{r.action}</td>
                          <td className="p-2">{r.isValid ? <CheckCircle2 className="w-4 h-4 text-green-600" /> : <XCircle className="w-4 h-4 text-red-600" />}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-900">
                <div className="flex items-center gap-2 font-semibold"><ShieldCheck className="w-4 h-4" /> Security & Transaction</div>
                <ul className="list-disc ml-5 mt-1 space-y-0.5">
                  <li>Revalidation on commit — preview never trusted.</li>
                  <li>Row-level savepoints: one bad row does not corrupt batch.</li>
                  <li>Passwords hashed server-side, never logged, returned once only.</li>
                  <li>Reporting chains recomputed once after batch.</li>
                </ul>
              </div>
            </>
          )}

          {step === 'result' && commitResult && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="bg-white border rounded-xl p-3"><div className="text-xs text-gray-500">Created</div><div className="text-xl font-semibold text-green-600">{commitResult.created}</div></div>
                <div className="bg-white border rounded-xl p-3"><div className="text-xs text-gray-500">Updated</div><div className="text-xl font-semibold text-amber-600">{commitResult.updated}</div></div>
                <div className="bg-white border rounded-xl p-3"><div className="text-xs text-gray-500">Failed</div><div className="text-xl font-semibold text-red-600">{commitResult.failed}</div></div>
                <div className="bg-white border rounded-xl p-3"><div className="text-xs text-gray-500">Skipped</div><div className="text-xl font-semibold">{commitResult.skipped}</div></div>
              </div>

              {commitResult.errors.length > 0 && (
                <div className="border rounded-xl overflow-hidden">
                  <div className="px-4 py-2 bg-red-50 border-b text-sm font-semibold text-red-800">Errors ({commitResult.errors.length})</div>
                  <div className="max-h-[160px] overflow-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 sticky top-0"><tr><th className="text-left p-2">Row</th><th className="text-left p-2">Employee ID</th><th className="text-left p-2">Message</th></tr></thead>
                      <tbody>
                        {commitResult.errors.map((e, idx) => (
                          <tr key={idx} className="border-t"><td className="p-2">{e.rowNumber}</td><td className="p-2">{e.employeeId}</td><td className="p-2 text-red-600">{e.message}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {commitResult.credentials.length > 0 && (
                <div className="border rounded-xl overflow-hidden">
                  <div className="px-4 py-2 bg-amber-50 border-b flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-amber-900">One-time credentials — copy/download now, shown only once</h3>
                      <p className="text-[11px] text-amber-800">Passwords are hashed server-side, never stored plaintext, never in logs, not returned again.</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={handleCopyCredentials} className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-white border hover:bg-gray-50"><Copy className="w-3 h-3" /> Copy</button>
                      <button onClick={handleDownloadCredentials} className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-700"><Download className="w-3 h-3" /> Download</button>
                    </div>
                  </div>
                  <div className="max-h-[260px] overflow-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 sticky top-0"><tr><th className="text-left p-2">Employee ID</th><th className="text-left p-2">Full Name</th><th className="text-left p-2">Temp Password</th><th className="text-left p-2">Must Change</th></tr></thead>
                      <tbody>
                        {commitResult.credentials.map((c, idx) => (
                          <tr key={idx} className="border-t"><td className="p-2 font-medium">{c.employeeId}</td><td className="p-2">{c.fullName}</td><td className="p-2 font-mono">{c.temporaryPassword}</td><td className="p-2">{c.mustChangePassword ? 'Yes' : 'No'}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-xs text-green-900">
                Bulk import completed. Users list will refresh. For generated passwords, ensure secure distribution and remind users to change on first login (forced flow).
              </div>
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t bg-gray-50 flex items-center justify-between">
          <button onClick={handleClose} className="px-4 py-2 rounded-xl border bg-white text-sm hover:bg-gray-100">Close</button>
          <div className="flex items-center gap-2">
            {step === 'upload' && parsedRows.length > 0 && (
              <button onClick={() => runServerValidation(parsedRows, mode, fileName)} disabled={serverValidating} className="px-4 py-2 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50">
                {serverValidating ? 'Validating…' : 'Re-validate'}
              </button>
            )}
            {step === 'preview' && serverPreview && (
              <>
                <button onClick={() => { setStep('upload'); setServerPreview(null); }} className="px-4 py-2 rounded-xl border bg-white text-sm hover:bg-gray-100">Back</button>
                <button onClick={handleCommit} disabled={commitLoading || serverPreview.validRows === 0} className="px-5 py-2 rounded-xl bg-green-600 text-white text-sm hover:bg-green-700 disabled:opacity-50">
                  {commitLoading ? 'Importing…' : `Confirm Import (${serverPreview.validRows} rows)`}
                </button>
              </>
            )}
            {step === 'result' && (
              <button onClick={handleClose} className="px-5 py-2 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700">Done</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
