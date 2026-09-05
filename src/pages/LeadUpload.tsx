import React, { useState } from 'react';
import { 
  Upload, 
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
  ShieldCheck
} from 'lucide-react';
import { cn } from '../lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import * as XLSX from 'xlsx';
import { toast } from 'sonner';
import { leadService } from '../services/leadService';
import { settingsService } from '../services/settingsService';
import { userService } from '../services/userService';
import { usePermissions } from '../hooks/usePermissions';

function parseExcelDate(val: any): string {
  if (val === undefined || val === null || val === '') {
    return '';
  }
  
  if (val instanceof Date) {
    if (!isNaN(val.getTime())) {
      return val.toISOString();
    }
  }

  const num = Number(val);
  if (!isNaN(num) && num > 10000 && num < 100000) {
    const date = new Date(Math.round((num - 25569) * 86400 * 1000));
    if (!isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  const parsed = new Date(val);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return '';
}

export default function LeadUpload() {
  const { canAccess, userRole } = usePermissions();

  if (!canAccess('lead_upl_gen', 'upload_raw_csv_xlsx')) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center p-8 bg-white border border-slate-100 rounded-sm shadow-xs max-w-xl mx-auto space-y-6 animate-in fade-in duration-300 mt-12">
        <div className="w-16 h-16 rounded-full bg-amber-50 border border-amber-100 flex items-center justify-center text-[#978C21] shrink-0 transform hover:rotate-12 transition-transform">
          <AlertCircle className="w-8 h-8" />
        </div>
        <div className="space-y-2">
          <span className="text-[9px] font-black tracking-[0.25em] text-[#978C21] uppercase italic">Clearance Protocol Warning</span>
          <h2 className="text-xl font-black text-slate-900 uppercase tracking-tight italic">Access Denied</h2>
          <p className="text-[11px] text-slate-400 font-bold uppercase tracking-wider leading-relaxed">
            Your current clearance level <span className="text-red-550 font-black">"{userRole || 'RESTRICTED'}"</span> does not possess active credentials to upload raw lead sheets or configure campaign lists.
          </p>
        </div>
        <div className="pt-2 border-t border-slate-100 w-full text-[9px] font-mono text-slate-400 uppercase tracking-widest leading-none">
          Strict Security Level: Feature lead_upl_gen.upload_raw_csv_xlsx Required
        </div>
      </div>
    );
  }

  const [dragActive, setDragActive] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewData, setPreviewData] = useState<any[]>([]);
  const [fullData, setFullData] = useState<any[]>([]);
  const [processing, setProcessing] = useState(false);

  const downloadTemplate = () => {
    // Generate sample data exactly matching requested format
    const templateData = [
      {
        "Assigned Date": "",
        "Lead Date": "2026-05-20",
        "Name": "Mridul Hassan",
        "Phone": "01711001122",
        "E-mail": "mr.mriduul@gmail.com",
        "Area": "Gulshan",
        "Source": "Website",
        "Product": "Life Secure+",
        "Other Info": "Interested in premium policy options",
        "Campaign Name": "Corporate Wellness Drive"
      },
      {
        "Assigned Date": "",
        "Lead Date": "2026-05-20",
        "Name": "Faria Rahman",
        "Phone": "01822334455",
        "E-mail": "faria@shanta.com",
        "Area": "Dhanmondi",
        "Source": "Facebook",
        "Product": "Child Education Plan",
        "Other Info": "Wants follow up next Monday",
        "Campaign Name": "Summer Promo Offer"
      }
    ];

    try {
      const worksheet = XLSX.utils.json_to_sheet(templateData);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Leads Template");
      
      // Auto-adjust column width for readability
      const maxColWidths = [
        { wch: 15 }, // Assigned Date
        { wch: 15 }, // Lead Date
        { wch: 20 }, // Name
        { wch: 15 }, // Phone
        { wch: 25 }, // E-mail
        { wch: 12 }, // Area
        { wch: 12 }, // Source
        { wch: 20 }, // Product
        { wch: 30 }, // Other Info
        { wch: 25 }  // Campaign Name
      ];
      worksheet['!cols'] = maxColWidths;

      XLSX.writeFile(workbook, "Shanta_Life_Leads_Upload_Template.xlsx");
      toast.success("Correct format template downloaded! Fill and upload this sheet.");
    } catch (err) {
      toast.error("Failed to generate download spreadsheet template.");
    }
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
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
          const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
          const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
          setFullData(rows);
          setPreviewData(data.slice(0, 7)); // Preview header + 6 rows
          toast.success("Intelligence data parsed successfully");
        } catch (err) {
          toast.error("Failed to parse file. Check integrity.");
        } finally {
          setProcessing(false);
        }
      };
      reader.readAsBinaryString(file);
    } else {
      toast.error("Invalid protocol. Please inject Excel or CSV format.");
    }
  };

  const handleUpload = async () => {
    if (fullData.length === 0) return;
    
    setProcessing(true);
    try {
      // 1. Gather all unique campaigns in uploaded dataset
      const uniqueCampaigns = Array.from(
        new Set(
          fullData
            .map((row: any) => {
              const val = row['Campaign Name'] || row.Campaign || row.campaignName;
              return val ? String(val).trim() : '';
            })
            .filter(Boolean)
        )
      ) as string[];

      // 2. Fetch existing registered campaigns to compare against
      const existingCampaignsList = await settingsService.getOptionsByType('Campaign');
      const existingSetLower = new Set(existingCampaignsList.map(c => c.toLowerCase().trim()));

      let newlyAddedCampaignsCount = 0;
      for (const camp of uniqueCampaigns) {
        if (!existingSetLower.has(camp.toLowerCase())) {
          await settingsService.addOption('Campaign', camp);
          newlyAddedCampaignsCount++;
        }
      }

      if (newlyAddedCampaignsCount > 0) {
        toast.info(`Auto-registered ${newlyAddedCampaignsCount} new campaign(s) in the options database.`);
      }

      // 3. Load all system users to match assignment person accurately
      const allUsers = await userService.getAllUsers();

      // 4. Transform rows using exact columns
      const leadsToUpload = fullData.map((row: any) => {
        const rawName = row.Name || row['Customer Name'] || row.prospectName || 'Unknown';
        const rawMobile = String(row.Phone || row['Mobile Number'] || row.Mobile || row.mobile || '').trim();
        const rawCampaign = row['Campaign Name'] || row.Campaign || row.campaignName || 'Default';
        const rawAssignPerson = String(row['Assign Person'] || row.Operator || row.assignedTo || '').trim();
        const rawEmail = row['E-mail'] || row.Email || row.email || '';
        const rawArea = row.Area || row.area || 'Gulshan';
        const rawSource = row.Source || row.source || 'Bulk Upload';
        const rawProduct = row.Product || row['Product Name'] || row.productName || 'Default';
        const rawOtherInfo = row['Other Info'] || row.otherInfo || '';

        // "lead date is uploaded date" -> Let's check 'Lead Date' column. If present, parse or use, fallback to now.
        const leadDateValue = row['Lead Date'] || row.creationDate;
        let creationDate = parseExcelDate(leadDateValue);
        if (!creationDate) {
          creationDate = new Date().toISOString();
        }

        // "assign date will be select by after upload admin when assign"
        // Let's parse 'Assigned Date' if optionally filled in sheet, else it starts as empty and can be assigned by Admin.
        const assignedDateValue = row['Assigned Date'] || row.assignedDate;
        const assignedDate = parseExcelDate(assignedDateValue);

        // High Intelligence Match for Assigned Person (if provided as fallback)
        let assignedTo = '';
        if (rawAssignPerson && rawAssignPerson !== 'undefined' && rawAssignPerson !== 'null') {
          const matchedUser = allUsers.find(
            u => 
              u.employeeId.toLowerCase() === rawAssignPerson.toLowerCase() ||
              u.name.toLowerCase() === rawAssignPerson.toLowerCase() ||
              u.email.toLowerCase() === rawAssignPerson.toLowerCase()
          );
          if (matchedUser) {
            assignedTo = matchedUser.employeeId;
          } else {
            // Keep the exact designated assignee identifier
            assignedTo = rawAssignPerson;
          }
        }

        return {
          prospectName: rawName,
          mobile: rawMobile,
          mobileNumber: rawMobile, // Support both references
          email: rawEmail,
          profession: row.Profession || row.profession || 'Service',
          area: rawArea,
          source: rawSource,
          productName: rawProduct,
          campaignName: rawCampaign,
          assignedTo: assignedTo,
          assignedBy: assignedTo ? 'ADMIN' : '',
          assignedDate: assignedTo && !assignedDate ? new Date().toISOString() : assignedDate,
          currentStatus: 'Untouched' as any,
          projectedNCP: 0,
          collectedNCP: 0,
          creationDate: creationDate,
          timestamp: creationDate,
          otherInfo: rawOtherInfo || '',
          familyMember: row['Family Member'] || row.familyMember || '0',
          maritalStatus: row['Marital Status'] || row.maritalStatus || 'Single',
          hasChild: row['Has Child'] === 'Yes' || row.HasChild === 'Yes'
        };
      });

      await leadService.bulkUploadLeads(leadsToUpload);
      toast.success(`Successfully uploaded ${leadsToUpload.length} leads matching corresponding campaign assigned users!`);
      setFile(null);
      setPreviewData([]);
      setFullData([]);
    } catch (err) {
      toast.error('Synchronization failure during extraction');
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-12 pb-24">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-8 border-b border-slate-100 pb-10">
        <div className="flex items-center gap-6">
          <div className="w-16 h-16 bg-[#F9F9F4] rounded-sm flex items-center justify-center text-[#978C21] shadow-sm border border-slate-100">
            <Database className="w-8 h-8" />
          </div>
          <div>
            <h1 className="text-4xl font-black tracking-tighter text-brand-text italic uppercase serif leading-none">Bulk Data Injection</h1>
            <p className="text-slate-400 font-bold text-[10px] uppercase tracking-[0.3em] mt-3 italic">Autonomous Lead Acquisition Protocol</p>
          </div>
        </div>
        <button 
          onClick={downloadTemplate}
          className="flex items-center gap-3 px-6 py-3 bg-[#978C21]/10 hover:bg-[#978C21]/20 border border-[#978C21]/30 text-[#978C21] text-[10px] font-black uppercase tracking-widest transition-all rounded-sm shadow-sm active:scale-95 group animate-bounce-slow"
        >
          <Download className="w-4 h-4 text-[#978C21] transition-transform group-hover:translate-y-0.5" />
          Download Sample Format
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
                  <FileSpreadsheet className={cn("w-10 h-10 text-[#978C21]", processing && "animate-pulse")} />
               </div>
               
               <AnimatePresence mode="wait">
                  {file ? (
                     <motion.div 
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="space-y-4"
                     >
                        <p className="text-2xl font-black text-brand-text italic tracking-tight uppercase">{file.name}</p>
                        <div className="flex items-center justify-center gap-4">
                           <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{(file.size / 1024).toFixed(2)} KB</span>
                           <div className="w-1 h-1 rounded-full bg-slate-300" />
                           <span className="text-[10px] font-black text-emerald-500 uppercase tracking-widest italic">Ready for Extraction</span>
                        </div>
                        <button 
                           onClick={(e) => { e.stopPropagation(); setFile(null); setPreviewData([]); }} 
                           className="text-red-500 text-[10px] font-black uppercase tracking-widest flex items-center gap-2 mx-auto hover:bg-red-50 px-4 py-2 rounded-sm mt-8 z-20 transition-all border border-transparent hover:border-red-100"
                        >
                        <X className="w-4 h-4" /> Remove Entity
                        </button>
                     </motion.div>
                  ) : (
                     <div className="space-y-4">
                        <p className="text-3xl font-black text-brand-text tracking-tighter italic serif uppercase">Drop Logic File Here</p>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.4em] italic leading-relaxed">System awaiting bulk intelligence payload</p>
                        <div className="pt-10">
                           <div className="inline-flex items-center gap-3 px-6 py-3 bg-white border border-slate-100 shadow-sm rounded-sm">
                              <Plus className="w-4 h-4 text-[#978C21]" />
                              <span className="text-[10px] font-black uppercase tracking-widest text-slate-600">Select Local Source</span>
                           </div>
                        </div>
                     </div>
                  )}
               </AnimatePresence>
            </div>

            {previewData.length > 0 && (
               <motion.div 
                  initial={{ opacity: 0, y: 30 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="bg-white rounded-sm border border-slate-100 p-10 shadow-sm space-y-10"
               >
                  <div className="flex items-center justify-between border-b border-slate-50 pb-8">
                    <div className="flex items-center gap-4">
                      <ShieldCheck className="w-8 h-8 text-emerald-500" />
                      <div>
                        <h3 className="font-black text-[18px] uppercase tracking-tight text-brand-text italic serif">Data Integrity Assessment</h3>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1 italic">Validation Level 0.998 SECURE</p>
                      </div>
                    </div>
                    <div className="px-4 py-2 bg-slate-50 rounded-sm">
                       <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest italic">Encryption Active</p>
                    </div>
                  </div>

                  <div className="overflow-x-auto border border-slate-50 rounded-sm shadow-inner bg-[#FBFAF8]">
                    <table className="w-full text-left">
                      <tbody className="italic">
                        {previewData.map((row: any, i) => (
                          <tr key={i} className={cn(
                             "text-[11px] group transition-all", 
                             i === 0 ? "bg-[#3C3C3C] font-black text-white uppercase tracking-[0.1em]" : "text-slate-500 font-bold hover:bg-white"
                          )}>
                            {row.map((cell: any, j: number) => {
                              let displayVal = cell;
                              if (cell instanceof Date) {
                                displayVal = cell.toLocaleDateString('en-CA');
                              } else if (cell === null || cell === undefined) {
                                displayVal = '';
                              } else if (i > 0 && (j === 0 || j === 1)) {
                                // Format Excel number dates in Lead Date or Assigned Date column
                                const num = Number(cell);
                                if (!isNaN(num) && num > 10000 && num < 100000) {
                                  const date = new Date(Math.round((num - 25569) * 86400 * 1000));
                                  if (!isNaN(date.getTime())) {
                                    displayVal = date.toLocaleDateString('en-CA');
                                  }
                                }
                              }
                              return (
                                <td key={j} className="px-6 py-4 whitespace-nowrap border-r border-slate-100/10">
                                  {String(displayVal)}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex items-center gap-6 bg-[#978C21]/5 p-6 rounded-sm border border-[#978C21]/10">
                    <Info className="w-6 h-6 text-[#978C21] shrink-0" />
                    <p className="text-[11px] font-black text-brand-text leading-relaxed italic uppercase tracking-tight">
                      <strong>Operational Directive:</strong> System mapping will sync "Mobile" entities to Intelligence Hub. Ensure unique keys prefix 880 or 01.
                    </p>
                  </div>

                  <button 
                    onClick={handleUpload}
                    className="w-full py-6 bg-slate-900 hover:bg-black text-white text-[12px] font-black uppercase tracking-[0.4em] transition-all rounded-sm shadow-xl flex items-center justify-center gap-4 group italic"
                  >
                    Execute Extraction Protocol
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
                  <h4 className="font-black text-[13px] uppercase tracking-widest text-brand-text italic serif">Injection Constraints</h4>
               </div>
                <ul className="space-y-6">
                  {[
                     { label: 'Protocols', val: 'XLSX, XLS, CSV' },
                     { label: 'Max Payload', val: '5,000 Entities' },
                     { label: 'Mandatory', val: 'Name, Phone, Source' }
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
                     <h4 className="font-black text-[13px] uppercase tracking-widest text-white italic serif">Assignment Logic</h4>
                  </div>
                  <p className="text-[11px] font-black text-slate-400 leading-relaxed italic uppercase tracking-tighter">
                     Lead date corresponds to bulk upload date. Assigned Date will be set automatically when the Admin assigns the lead.
                  </p>
               </div>
               <BarChart3 className="absolute -bottom-6 -right-6 w-32 h-32 text-white/5 rotate-12" />
            </div>

            <div className="bg-white rounded-sm border border-slate-100 p-8 shadow-sm">
               <div className="flex items-center justify-between mb-6">
                  <span className="text-[10px] font-black text-slate-300 uppercase tracking-widest italic">Global Upload Volume</span>
                  <div className="w-2 h-2 rounded-full bg-[#10B981] animate-pulse" />
               </div>
               <div className="h-2 w-full bg-slate-50 rounded-full overflow-hidden">
                  <div className="h-full bg-[#978C21] w-[64%]" />
               </div>
               <div className="flex justify-between items-center mt-3">
                  <span className="text-[11px] font-black text-brand-text italic uppercase">6,432 / 10,000</span>
                  <span className="text-[10px] font-medium text-slate-400 uppercase tracking-widest">Monthly Limit</span>
               </div>
            </div>
         </div>
      </div>
    </div>
  );
}
