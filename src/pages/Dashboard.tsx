import React, { useEffect, useState } from 'react';
import { 
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip, LineChart, Line, XAxis, YAxis, CartesianGrid, AreaChart, Area
} from 'recharts';
import { 
  TrendingUp, Zap, History, ChevronRight, Users, MessageSquare, Phone, Target, PieChart as PieIcon, Filter, Download, Info, Calendar as CalendarIcon, RefreshCw, LayoutDashboard, Database, CheckCircle, XCircle, AlertTriangle
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../lib/utils';
import { useAuthStore } from '../store/authStore';
import { usePermissions } from '../hooks/usePermissions';
import { UserRole, LeadStatus } from '../types';
import { leadService } from '../services/leadService';
import { userService } from '../services/userService';
import { settingsService } from '../services/settingsService';
import { metadataService } from '../services/metadataService';
import { workflowService } from '../services/workflowService';
import { toast } from 'sonner';
import * as XLSX from 'xlsx';
import TaskCalendar from './TaskCalendar';

const CAMPAIGN_TREND_DATA = [
  { date: '01 May', value: 40 },
  { date: '05 May', value: 65 },
  { date: '10 May', value: 45 },
  { date: '15 May', value: 90 },
  { date: '20 May', value: 70 },
  { date: '25 May', value: 85 },
  { date: '31 May', value: 110 },
];

import { getLeadStatusColorClasses } from '../utils/leadStatusMeta';

const getStatusColor = (status: string) => getLeadStatusColorClasses(status);

export default function Dashboard() {
  const { user } = useAuthStore();
  const { canAccess } = usePermissions();
  const getTomorrowString = () => {
     const tomorrow = new Date();
     tomorrow.setDate(tomorrow.getDate() + 1);
     return tomorrow.toISOString().substring(0, 10);
  };
  const [period, setPeriod] = useState('TODAY');
  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().substring(0, 10));
  const [customDates, setCustomDates] = useState({ 
    start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0]
  });
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    newLeads: 0,
    responses: 0,
    pipeline: 0,
    alerts: 0,
    contacted: 0,
    meetings: 0,
    followUps: 0,
    projected: 0,
    collected: 0,
    activeLeads: 0,
    conversionRate: '0.0%',
    avgResponseTAT: '24.0h'
  });
  const [agentStats, setAgentStats] = useState<any[]>([]);
  const [teamStats, setTeamStats] = useState<any[]>([]);
  const [campaignStats, setCampaignStats] = useState<any[]>([]);
  const [leads, setLeads] = useState<any[]>([]);
  const [activePopup, setActivePopup] = useState<string | null>(null);
  const [alertDate, setAlertDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [popupSearch, setPopupSearch] = useState<string>('');
  const [trendData, setTrendData] = useState<{ date: string; value: number }[]>(CAMPAIGN_TREND_DATA);

  // Status updating state fields
  const [selectedLead, setSelectedLead] = useState<any | null>(null);
  const [formStatus, setFormStatus] = useState<string>('');
  const [formRemarks, setFormRemarks] = useState('');
  const [formNextFollowUpDate, setFormNextFollowUpDate] = useState('');
  const [formCollectedNCP, setFormCollectedNCP] = useState<number>(0);
  const [formNextCallDate, setFormNextCallDate] = useState('');
  const [formMeetingDate, setFormMeetingDate] = useState('');
  const [formSubStatus, setFormSubStatus] = useState<string>('');
  const [formSumAssured, setFormSumAssured] = useState<number>(0);
  const [formProductName, setFormProductName] = useState('');
  const [formProjectedNCP, setFormProjectedNCP] = useState<number>(0);
  const [formLossReason, setFormLossReason] = useState('');
  const [formMeetingType, setFormMeetingType] = useState('');
  const [workflowRules, setWorkflowRules] = useState<any[]>([]);
  const [lossReasonOptions, setLossReasonOptions] = useState<string[]>([]);
  const [meetingTypeOptions, setMeetingTypeOptions] = useState<string[]>([]);

  const [statusOptions, setStatusOptions] = useState<string[]>([]);
  const [productOptions, setProductOptions] = useState<string[]>([]);
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [selectedRO, setSelectedRO] = useState<string>('');

  const getReportingUserIds = (managerId: string, usersList: any[]): string[] => {
    const result: string[] = [];
    const queue: string[] = [managerId];
    const visited = new Set<string>([managerId]);
    while (queue.length > 0) {
      const currId = queue.shift()!;
      const reports = usersList.filter(u => u.managerId === currId);
      for (const r of reports) {
        if (!visited.has(r.employeeId)) {
          visited.add(r.employeeId);
          result.push(r.employeeId);
          queue.push(r.employeeId);
        }
      }
    }
    return result;
  };

  const isScheduleInRange = (dateStr: string | undefined | null) => {
    if (!dateStr) return false;
    const now = new Date();
    let startDate = new Date(0);
    let endDate = new Date();

    if (period === 'TODAY') {
      const todayStart = new Date(selectedDate + 'T00:00:00');
      const todayEnd = new Date(selectedDate + 'T23:59:59.999');
      return { startDate: todayStart, endDate: todayEnd };
    } else if (period === 'THIS MONTH') {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    } else if (period === 'LAST MONTH') {
      startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    } else if (period === 'CUSTOM') {
      startDate = new Date(customDates.start);
      endDate = new Date(customDates.end);
      endDate.setHours(23, 59, 59, 999);
    }

    const d = new Date(dateStr);
    return d >= startDate && d <= endDate;
  };

  const getDateFilteredLeads = () => {
    let startDate = new Date(0);
    let endDate = new Date();
    const now = new Date();

    if (period === 'TODAY') {
      const todayStart = new Date(selectedDate + 'T00:00:00');
      const todayEnd = new Date(selectedDate + 'T23:59:59.999');
      startDate = todayStart;
      endDate = todayEnd;
    } else if (period === 'THIS MONTH') {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    } else if (period === 'LAST MONTH') {
      startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    } else if (period === 'CUSTOM') {
      startDate = new Date(customDates.start);
      endDate = new Date(customDates.end);
      endDate.setHours(23, 59, 59, 999);
    }

    let filtered = leads.filter(l => {
      const leadDate = new Date(l.timestamp);
      return leadDate >= startDate && leadDate <= endDate;
    });

    if (user?.role === UserRole.RO) {
      filtered = filtered.filter(l => l.assignedTo === user.employeeId);
    }

    return filtered;
  };

  const getModalLeads = () => {
     let baseUsersLeads = leads;
     if (user?.role === UserRole.RO) {
        baseUsersLeads = leads.filter(l => l.assignedTo === user.employeeId);
     }

     if (activePopup === 'call') {
        if (period === 'TODAY') {
           return baseUsersLeads.filter(l => l.currentStatus === 'No Response' && l.nextCallDate && l.nextCallDate.substring(0, 10) === new Date().toISOString().substring(0, 10));
        } else {
           return baseUsersLeads.filter(l => l.currentStatus === 'No Response' && l.nextCallDate && isScheduleInRange(l.nextCallDate));
        }
     } else if (activePopup === 'call_tomorrow') {
        if (period === 'TODAY') {
           return baseUsersLeads.filter(l => l.currentStatus === 'No Response' && l.nextCallDate && l.nextCallDate.substring(0, 10) === getTomorrowString());
        } else {
           return baseUsersLeads.filter(l => l.currentStatus === 'No Response' && l.nextCallDate && isScheduleInRange(l.nextCallDate));
        }
     } else if (activePopup === 'meeting') {
        if (period === 'TODAY') {
           return baseUsersLeads.filter(l => l.meetingDate && l.meetingDate.substring(0, 10) === new Date().toISOString().substring(0, 10));
        } else {
           return baseUsersLeads.filter(l => l.meetingDate && isScheduleInRange(l.meetingDate));
        }
     } else if (activePopup === 'meeting_tomorrow') {
        if (period === 'TODAY') {
           return baseUsersLeads.filter(l => l.meetingDate && l.meetingDate.substring(0, 10) === getTomorrowString());
        } else {
           return baseUsersLeads.filter(l => l.meetingDate && isScheduleInRange(l.meetingDate));
        }
     } else if (activePopup === 'followup') {
        if (period === 'TODAY') {
           return baseUsersLeads.filter(l => ['Follow-up Set', 'Interested', 'Pipeline Locked'].includes(l.currentStatus) && l.nextFollowUpDate && l.nextFollowUpDate.substring(0, 10) === new Date().toISOString().substring(0, 10));
        } else {
           return baseUsersLeads.filter(l => ['Follow-up Set', 'Interested', 'Pipeline Locked'].includes(l.currentStatus) && l.nextFollowUpDate && isScheduleInRange(l.nextFollowUpDate));
        }
     } else if (activePopup === 'followup_tomorrow') {
        if (period === 'TODAY') {
           return baseUsersLeads.filter(l => ['Follow-up Set', 'Interested', 'Pipeline Locked'].includes(l.currentStatus) && l.nextFollowUpDate && l.nextFollowUpDate.substring(0, 10) === getTomorrowString());
        } else {
           return baseUsersLeads.filter(l => ['Follow-up Set', 'Interested', 'Pipeline Locked'].includes(l.currentStatus) && l.nextFollowUpDate && isScheduleInRange(l.nextFollowUpDate));
        }
     }

     const filteredPeriodLeads = getDateFilteredLeads();

     switch (activePopup) {
        case 'new_leads':
           return filteredPeriodLeads.filter(l => l.currentStatus === 'Untouched');
        case 'agent_responses':
           return filteredPeriodLeads.filter(l => l.currentStatus !== 'Untouched');
        case 'pipeline_volume':
           return filteredPeriodLeads.filter(l => l.collectedNCP > 0 || l.projectedNCP > 0);
        case 'immediate_alerts':
           return filteredPeriodLeads.filter(l => l.currentStatus === 'Untouched');
        case 'contacted_calls':
           return filteredPeriodLeads.filter(l => ['Contacted', 'Interested', 'Follow-up Set'].includes(l.currentStatus));
        case 'meetings_completed':
           return filteredPeriodLeads.filter(l => l.currentStatus === 'Meeting Fixed');
        case 'followups_set':
           return filteredPeriodLeads.filter(l => l.currentStatus === 'Follow-up Set');
        case 'projected_ncp':
           return filteredPeriodLeads.filter(l => l.projectedNCP > 0);
        case 'collected_ncp':
           return filteredPeriodLeads.filter(l => l.collectedNCP > 0);
        case 'conversion_rate':
           return filteredPeriodLeads.filter(l => l.currentStatus === 'Converted');
        case 'avg_response_tat':
           return filteredPeriodLeads.filter(l => l.currentStatus !== 'Untouched');
        case 'active_leads':
           return filteredPeriodLeads.filter(l => l.currentStatus !== 'Converted' && l.currentStatus !== 'Not Interested');
        case 'critical_alerts':
           return filteredPeriodLeads.filter(l => l.currentStatus === 'Untouched');
        default:
           return [];
     }
  };

  const getPopupTitle = () => {
     switch (activePopup) {
        case 'call': return period === 'TODAY' ? 'Daily Call Alerts' : 'Call Alerts (Selected Period)';
        case 'call_tomorrow': return period === 'TODAY' ? 'Tomorrow Call Alerts' : 'Call Alerts (Selected Period)';
        case 'meeting': return period === 'TODAY' ? 'Daily Meeting Alerts' : 'Meeting Alerts (Selected Period)';
        case 'meeting_tomorrow': return period === 'TODAY' ? 'Tomorrow Meeting Alerts' : 'Meeting Alerts (Selected Period)';
        case 'followup': return period === 'TODAY' ? 'Daily Follow-up Alerts' : 'Follow-up Alerts (Selected Period)';
        case 'followup_tomorrow': return period === 'TODAY' ? 'Tomorrow Follow-up Alerts' : 'Follow-up Alerts (Selected Period)';
        case 'new_leads': return 'New Leads';
        case 'agent_responses': return 'Agent Responses';
        case 'pipeline_volume': return 'Pipeline Volume';
        case 'immediate_alerts': return 'Immediate Alerts';
        case 'contacted_calls': return 'Contacted Calls';
        case 'meetings_completed': return 'Meetings Completed';
        case 'followups_set': return 'Follow-ups Set';
        case 'projected_ncp': return 'Projected NCP Records';
        case 'collected_ncp': return 'Collected NCP Records';
        case 'conversion_rate': return 'Conversion Rate (Converted Leads)';
        case 'avg_response_tat': return 'Avg Response TAT (Touched Leads)';
        case 'active_leads': return 'Active Leads';
        case 'critical_alerts': return 'Critical Alerts (Untouched)';
        default: return 'Leads List';
     }
  };

  const handleExportExcel = (leadsList: any[], categoryTitle: string) => {
    if (!canAccess('dashboard', 'export_summary_pdf')) {
      toast.error("Access Denied: Your Clearance Level cannot export summary reports.");
      return;
    }
    try {
      if (leadsList.length === 0) {
        toast.warning("No records to export.");
        return;
      }
      
      const excelRows = leadsList.map((lead, idx) => ({
        "Serial No": idx + 1,
        "Lead Date": lead.timestamp ? new Date(lead.timestamp).toLocaleDateString('en-GB') : '',
        "Lead Name": lead.name || '',
        "Phone Contact": lead.phone || '',
        "Region/Area": lead.area || 'No Region Configured',
        "Assigned Handler": lead.assignedTo || 'Unassigned',
        "Current Status": lead.currentStatus || 'Untouched',
        "Product": lead.productName || lead.product || 'N/A',
        "Campaign": lead.campaignName || lead.campaign || 'N/A',
        "Collected NCP": lead.collectedNCP || 0,
        "Projected NCP": lead.projectedNCP || 0,
        "Meeting Date": lead.meetingDate || 'N/A',
        "Next Follow-up": lead.nextFollowUpDate || 'N/A',
        "Next Call Date": lead.nextCallDate || 'N/A'
      }));

      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(excelRows);
      
      XLSX.utils.book_append_sheet(workbook, worksheet, "Leads Extract");

      worksheet['!cols'] = [
        { wch: 10 },
        { wch: 12 },
        { wch: 22 },
        { wch: 15 },
        { wch: 18 },
        { wch: 18 },
        { wch: 15 },
        { wch: 15 },
        { wch: 20 },
        { wch: 15 },
        { wch: 15 },
        { wch: 15 },
        { wch: 15 },
        { wch: 15 }
      ];

      const cleanFilename = `${categoryTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_export.xlsx`;
      XLSX.writeFile(workbook, cleanFilename);
      toast.success(`Successfully exported ${leadsList.length} leads as Excel!`);
    } catch (err) {
      console.error(err);
      toast.error("Failed to generate Excel file.");
    }
  };
  
  useEffect(() => {
    loadDashboardData();
  }, [user, period, customDates, selectedDate]);

  // Sync form states with selected lead
  useEffect(() => {
    if (selectedLead) {
      setFormStatus(selectedLead.currentStatus);
      setFormRemarks('');
      setFormNextFollowUpDate(selectedLead.nextFollowUpDate || '');
      setFormCollectedNCP(selectedLead.collectedNCP || 0);
      setFormNextCallDate(selectedLead.nextCallDate || '');
      setFormMeetingDate(selectedLead.meetingDate || '');
      setFormSubStatus('');
      setFormSumAssured(selectedLead.sumAssured || 0);
      setFormProductName(selectedLead.productName || '');
      setFormProjectedNCP(selectedLead.projectedNCP || 0);
      setSelectedRO(selectedLead.assignedTo || '');
    } else {
      setFormStatus('');
      setFormRemarks('');
      setFormNextFollowUpDate('');
      setFormCollectedNCP(0);
      setFormNextCallDate('');
      setFormMeetingDate('');
      setFormSubStatus('');
      setFormSumAssured(0);
      setFormProductName('');
      setFormProjectedNCP(0);
      setSelectedRO('');
    }
  }, [selectedLead]);

  const DEFAULT_STATUS_LIST = [
    'Untouched',
    'Contacted',
    'No Response',
    'Busy',
    'Interested',
    'Follow-up Set',
    'Meeting Fixed',
    'Meeting Completed',
    'Pipeline Locked',
    'Converted',
    'Not Interested'
  ];

  useEffect(() => {
    const fetchOptions = async () => {
      try {
        const res = await settingsService.getOptionsByType('FollowUpStatus');
        setStatusOptions(res && res.length > 0 ? res : DEFAULT_STATUS_LIST);
        
        const prodRes = await settingsService.getOptionsByType('Product');
        setProductOptions(prodRes || []);

        const rules = await workflowService.getRules();
        setWorkflowRules(rules);
        setLossReasonOptions(await metadataService.getActiveValues('LossReason'));
        setMeetingTypeOptions(await metadataService.getActiveValues('MeetingType'));

        const usersList = await userService.getAllUsers();
        setAllUsers(usersList);
      } catch (err) {
        console.error(err);
        setStatusOptions(DEFAULT_STATUS_LIST);
      }
    };
    fetchOptions();
  }, []);

  const handleSaveLeadUpdate = async () => {
    if (!selectedLead) return;
    if (!formStatus) {
      toast.error('Please select a target status');
      return;
    }
    if (!formRemarks.trim()) {
      toast.error('Remarks are mandatory to fill when editing status!');
      return;
    }

    if (formStatus === 'No Response' && !formNextCallDate) {
      toast.error('Next Call Date is mandatory for No Response status!');
      return;
    }
    if (formStatus === 'Meeting Fixed' && !formMeetingDate) {
      toast.error('Meeting Date is mandatory for Meeting Fixed status!');
      return;
    }
    if ((formStatus === 'Follow-up Set' || formStatus === 'Interested' || formStatus === 'Busy') && !formNextFollowUpDate) {
      toast.error(`Next Follow-up Date is mandatory for ${formStatus} status!`);
      return;
    }

    // Workflow Engine: admin-configured requirements for entering this status
    const targetRule = workflowRules.find((r: any) => r.status === formStatus);
    if (targetRule?.requiresLossReason && !formLossReason) {
      toast.error(`Loss Reason is mandatory for ${formStatus} status!`);
      return;
    }
    if (targetRule?.requiresMeetingType && !formMeetingType) {
      toast.error(`Meeting Type is mandatory for ${formStatus} status!`);
      return;
    }
    if (formStatus === 'Meeting Completed' && !formSubStatus) {
      toast.error('Please select a sub-status (Pipeline Locked or Not Interested) for Meeting Completed!');
      return;
    }

    const isPipelineLocked = formStatus === 'Pipeline Locked' || (formStatus === 'Meeting Completed' && formSubStatus === 'Pipeline Locked');
    const isConverted = formStatus === 'Converted';

    if (isPipelineLocked) {
      if (!formProductName) {
        toast.error('Product Name is mandatory for Pipeline Locked status!');
        return;
      }
      if (!formSumAssured || formSumAssured <= 0) {
        toast.error('Sum Assured is mandatory and must be greater than zero for Pipeline Locked!');
        return;
      }
      if (!formProjectedNCP || formProjectedNCP <= 0) {
        toast.error('Projected NCP is mandatory and must be greater than zero for Pipeline Locked!');
        return;
      }
    }

    if (isConverted) {
      if (!formProductName) {
        toast.error('Product Name is mandatory for Converted status!');
        return;
      }
      if (!formSumAssured || formSumAssured <= 0) {
        toast.error('Sum Assured is mandatory and must be greater than zero for Converted!');
        return;
      }
      if (!formCollectedNCP || formCollectedNCP <= 0) {
        toast.error('Collected NCP is mandatory and must be greater than zero for Converted!');
        return;
      }
    }

    try {
      const updaterName = user ? `${user.name} (${user.employeeId})` : 'System';
      const finalStatus = formStatus === 'Meeting Completed' ? formSubStatus : formStatus;

      await leadService.updateLeadStatus(
        selectedLead.id, 
        finalStatus as any, 
        isConverted ? formCollectedNCP : undefined, 
        formRemarks, 
        (finalStatus === 'Follow-up Set' || finalStatus === 'Interested' || finalStatus === 'Busy') ? formNextFollowUpDate : undefined,
        updaterName,
        formStatus === 'No Response' ? formNextCallDate : undefined,
        formStatus === 'Meeting Fixed' ? formMeetingDate : undefined,
        (isPipelineLocked || isConverted) ? formSumAssured : undefined,
        (isPipelineLocked || isConverted) ? formProductName : undefined,
        isPipelineLocked ? formProjectedNCP : undefined,
        formLossReason || undefined,
        formMeetingType || undefined
      );
      toast.success('Lead status and remarks logged successfully!');
      
      // Update local leads list
      setSelectedLead(null);
      await loadDashboardData();
    } catch (err) {
      toast.error('Failed to update lead status from dashboard context.');
    }
  };

  const loadDashboardData = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const allLeads = await leadService.getLeads({ 
        employeeId: user.employeeId, 
        role: user.role,
        startDate: period === 'CUSTOM' ? customDates.start : (period === 'TODAY' ? selectedDate + 'T00:00:00' : undefined),
        endDate: period === 'CUSTOM' ? customDates.end : (period === 'TODAY' ? selectedDate + 'T23:59:59.999' : undefined)
      });
      setLeads(allLeads);
      
      let allUsers: any[] = [];
      if (user.role !== UserRole.RO) {
        try {
          allUsers = await userService.getAllUsers();
          setAllUsers(allUsers);
        } catch (e) {
          console.warn("Could not fetch user list - restricted access");
        }
      }
      
      // Determine date range
      let startDate = new Date(0);
      let endDate = new Date();
      const now = new Date();

      if (period === 'TODAY') {
        startDate = new Date(selectedDate + 'T00:00:00');
        endDate = new Date(selectedDate + 'T23:59:59.999');
      } else if (period === 'THIS MONTH') {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      } else if (period === 'LAST MONTH') {
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        endDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      } else if (period === 'CUSTOM') {
        startDate = new Date(customDates.start);
        endDate = new Date(customDates.end);
        endDate.setHours(23, 59, 59, 999);
      }

      // Filter leads based on role AND time
      let filteredLeads = allLeads.filter(l => {
        const leadDate = new Date(l.timestamp);
        return leadDate >= startDate && leadDate <= endDate;
      });

      if (user.role === UserRole.RO) {
        filteredLeads = filteredLeads.filter(l => l.assignedTo === user.employeeId);
      }

      // Calculate Snapshots
      const newLeadsCount = filteredLeads.filter(l => l.currentStatus === 'Untouched').length;
      const responsesCount = filteredLeads.filter(l => l.currentStatus !== 'Untouched').length;
      const pipelineCount = filteredLeads.filter(l => l.collectedNCP > 0 || l.projectedNCP > 0).length;
      const alertsCount = filteredLeads.filter(l => l.currentStatus === 'Untouched').length;

      const collectedTotal = filteredLeads.reduce((acc, curr) => acc + (curr.collectedNCP || 0), 0);
      const projectedTotal = filteredLeads.reduce((acc, curr) => acc + (curr.projectedNCP || 0), 0);

      // Calculate Turnaround Time (TAT)
      let totalTatMs = 0;
      let targetTatLeads = 0;
      filteredLeads.forEach(l => {
        if (l.currentStatus !== 'Untouched') {
          const birthTime = new Date(l.timestamp || l.creationDate).getTime();
          let reactionTime = 0;
          if (l.statusHistory && l.statusHistory.length > 0) {
            const validTimes = l.statusHistory
              .map(h => new Date(h.date).getTime())
              .filter(t => !isNaN(t));
            if (validTimes.length > 0) {
              reactionTime = Math.min(...validTimes);
            }
          }
          if (reactionTime > birthTime) {
            totalTatMs += (reactionTime - birthTime);
            targetTatLeads++;
          }
        }
      });
      const tatVal = targetTatLeads > 0 
        ? (totalTatMs / (1000 * 60 * 60 * targetTatLeads)).toFixed(1) + 'h' 
        : '24.0h';

      const activeLeadsCount = filteredLeads.filter(l => l.currentStatus !== 'Converted' && l.currentStatus !== 'Not Interested').length;
      const convertedCount = filteredLeads.filter(l => l.currentStatus === 'Converted').length;
      const conversionRateVal = filteredLeads.length > 0
        ? ((convertedCount / filteredLeads.length) * 100).toFixed(1) + '%'
        : '0.0%';

      setStats({
        newLeads: newLeadsCount,
        responses: responsesCount,
        pipeline: pipelineCount,
        alerts: alertsCount,
        contacted: filteredLeads.filter(l => ['Contacted', 'Interested', 'Follow-up Set'].includes(l.currentStatus)).length,
        meetings: filteredLeads.filter(l => l.currentStatus === 'Meeting Fixed').length,
        followUps: filteredLeads.filter(l => l.currentStatus === 'Follow-up Set').length,
        projected: projectedTotal,
        collected: collectedTotal,
        activeLeads: activeLeadsCount,
        conversionRate: conversionRateVal,
        avgResponseTAT: tatVal
      });

      // Calculate Agent Stats
      const agents = allUsers.filter(u => u.role === UserRole.RO);
      const calculatedAgentStats = agents.map(agent => {
        const agentLeads = filteredLeads.filter(l => l.assignedTo === agent.employeeId);
        const agentCollected = agentLeads.reduce((acc, curr) => acc + (curr.collectedNCP || 0), 0);
        const agentProjected = agentLeads.reduce((acc, curr) => acc + (curr.projectedNCP || 0), 0);
        
        return {
          name: agent.name,
          assigned: agentLeads.length,
          total: agentLeads.length,
          noCall: agentLeads.filter(l => l.currentStatus === 'Untouched').length,
          nextCall: agentLeads.filter(l => l.currentStatus === 'Untouched').length,
          followUp: agentLeads.filter(l => l.currentStatus === 'Follow-up Set').length,
          followUpAlert: agentLeads.filter(l => l.currentStatus === 'Follow-up Set').length,
          converted: agentLeads.filter(l => l.currentStatus === 'Converted').length,
          collected: `৳ ${agentCollected.toLocaleString()}`,
          projected: `৳ ${agentProjected.toLocaleString()}`,
          conversion: agentLeads.length > 0 ? `${((agentLeads.filter(l => l.currentStatus === 'Converted').length / agentLeads.length) * 100).toFixed(1)}%` : '0.0%'
        };
      });
      setAgentStats(calculatedAgentStats);

      // Campaign stats breakdown
      const statuses = [
        'Untouched', 'Interested', 'Follow-up Set', 'No Response', 'Not Interested', 
        'Meeting Fixed', 'Meeting Completed', 'Converted', 'Pipeline Locked'
      ];
      const colors = ['#e2e8f0', '#0F172A', '#334155', '#64748B', '#94A3B8', '#1E293B', '#CBD5E1', '#978C21', '#475569'];
      
      const breakdown = statuses.map((status, i) => ({
        name: status,
        value: filteredLeads.filter(l => l.currentStatus === status).length,
        color: colors[i]
      }));
      setCampaignStats(breakdown);

      // Team stats
      const teams = ['Gulshan', 'Banani', 'Dhanmondi', 'Uttara', 'Mirpur'];
      const teamBreakdown = teams.map(team => {
        const teamLeads = filteredLeads.filter(l => (l.area || '').includes(team));
        return {
          team,
          assigned: teamLeads.length,
          noCall: teamLeads.filter(l => l.currentStatus === 'Untouched').length,
          contacted: teamLeads.filter(l => l.currentStatus === 'Contacted').length,
          meetings: teamLeads.filter(l => l.currentStatus === 'Meeting Fixed').length,
          followUps: teamLeads.filter(l => l.currentStatus === 'Follow-up Set').length,
          pipeline: teamLeads.filter(l => l.projectedNCP > 0).length,
          collected: `৳ ${teamLeads.reduce((acc, curr) => acc + (curr.collectedNCP || 0), 0).toLocaleString()}`,
          projected: `৳ ${teamLeads.reduce((acc, curr) => acc + (curr.projectedNCP || 0), 0).toLocaleString()}`
        };
      });
      setTeamStats(teamBreakdown.filter(t => t.assigned > 0));

      // Calculate dynamic Campaign Performance Trend (Daily Lead Generation Volume)
      let calculatedTrend: { date: string; value: number }[] = [];
      const diffTime = Math.abs(endDate.getTime() - startDate.getTime());
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (period === 'TODAY' || diffDays <= 1) {
        // Hourly breakdown for 1 day
        const hours = [
          { label: '09:00', start: 0, end: 9 },
          { label: '12:00', start: 9, end: 12 },
          { label: '15:00', start: 12, end: 15 },
          { label: '18:00', start: 15, end: 18 },
          { label: '21:00', start: 18, end: 21 },
          { label: '24:00', start: 21, end: 24 }
        ];
        calculatedTrend = hours.map(h => {
          const count = filteredLeads.filter(l => {
            const hr = new Date(l.timestamp).getHours();
            return hr >= h.start && hr < h.end;
          }).length;
          return { date: h.label, value: count };
        });
      } else {
        // Multi-day breakdown (max 7-8 intervals to look beautiful)
        const pointCount = Math.min(diffDays, 7);
        const intervalMs = diffTime / pointCount;

        for (let i = 0; i < pointCount; i++) {
          const pointStart = new Date(startDate.getTime() + i * intervalMs);
          const pointEnd = new Date(startDate.getTime() + (i + 1) * intervalMs);
          
          const label = pointEnd.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
          const count = filteredLeads.filter(l => {
            const leadDate = new Date(l.timestamp);
            return leadDate >= pointStart && leadDate <= pointEnd;
          }).length;

          calculatedTrend.push({ date: label, value: count });
        }
      }
      setTrendData(calculatedTrend);

    } catch (err) {
      toast.error('Dashboard synchronization failure');
    } finally {
      setLoading(false);
    }
  };

  const formattedDateRange = () => {
    const now = new Date();
    if (period === 'TODAY') return new Date(selectedDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    if (period === 'THIS MONTH') return `1 ${now.toLocaleDateString('en-GB', { month: 'short' })} - ${now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    if (period === 'LAST MONTH') {
       const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
       const lastDay = new Date(now.getFullYear(), now.getMonth(), 0);
       return `${lastMonth.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} - ${lastDay.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    }
    if (period === 'CUSTOM') {
       return `${new Date(customDates.start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} - ${new Date(customDates.end).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    }
    return '';
  };

  const ncpTrackingData = [
    { name: 'Week 1', Collected: Math.round(stats.collected * 0.25), Projected: Math.round(stats.projected * 0.25) },
    { name: 'Week 2', Collected: Math.round(stats.collected * 0.55), Projected: Math.round(stats.projected * 0.50) },
    { name: 'Week 3', Collected: Math.round(stats.collected * 0.80), Projected: Math.round(stats.projected * 0.80) },
    { name: 'Week 4', Collected: stats.collected, Projected: stats.projected },
  ];

  return (
    <div className="space-y-6 pb-12 bg-white font-sans">
      {/* Dynamic Date Selection Controls */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 bg-[#F9F9F4] p-6 rounded-sm border border-slate-100 shadow-sm mx-1">
         <div>
            <h1 className="text-3xl font-black italic uppercase text-brand-text tracking-tighter serif leading-none">Dashboard Summary</h1>
            <p className="text-[10px] uppercase tracking-[0.22em] font-black text-slate-400 mt-2 italic">Corporate Performance Ledger Control</p>
         </div>

         <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1 bg-slate-100/80 p-1 rounded-sm border border-slate-200">
               {['TODAY', 'THIS MONTH', 'LAST MONTH', 'CUSTOM'].map(p => (
                 <button 
                  key={p}
                  type="button"
                  onClick={() => setPeriod(p)}
                  className={cn(
                    "px-4 py-1.5 text-[9px] font-black uppercase tracking-widest rounded-sm transition-all",
                    period === p ? "bg-[#978C21] text-white shadow-sm" : "text-slate-500 hover:text-slate-800"
                  )}
                 >
                   {p}
                 </button>
               ))}
            </div>

            {period === 'TODAY' && (
              <div className="flex items-center gap-2 bg-white p-1 rounded-sm border border-slate-200 shadow-sm">
                <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest pl-1.5">Date:</span>
                <input 
                  type="date" 
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="bg-white border-0 text-slate-700 rounded-sm px-2 py-1 text-[10px] font-black uppercase outline-none focus:ring-0 cursor-pointer"
                />
              </div>
            )}

            {period === 'CUSTOM' && (
              <div className="flex items-center gap-3 bg-white p-1 rounded-sm border border-slate-200 shadow-sm">
                <div className="flex items-center gap-1.5">
                   <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest pl-1.5">Start:</span>
                   <input 
                     type="date" 
                     value={customDates.start}
                     onChange={(e) => setCustomDates({ ...customDates, start: e.target.value })}
                     className="bg-white border-0 text-slate-700 rounded-sm px-2 py-1 text-[10px] font-black uppercase outline-none focus:ring-0 cursor-pointer"
                   />
                </div>
                <div className="flex items-center gap-1.5 border-l border-slate-100 pl-3">
                   <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">End:</span>
                   <input 
                     type="date" 
                     value={customDates.end}
                     onChange={(e) => setCustomDates({ ...customDates, end: e.target.value })}
                     className="bg-white border-0 text-slate-700 rounded-sm px-2 py-1 text-[10px] font-black uppercase outline-none focus:ring-0 cursor-pointer"
                   />
                </div>
              </div>
            )}

            <div className="flex items-center gap-2 px-3 py-1.5 bg-[#978C21]/5 border border-[#978C21]/10 rounded-sm">
               <CalendarIcon className="w-3.5 h-3.5 text-[#978C21]" />
               <span className="text-[10px] font-black text-[#978C21] uppercase tracking-widest italic">{formattedDateRange()}</span>
            </div>
         </div>
      </div>

      {/* Snapshot Header */}
      <div className="flex items-center gap-2 px-1">
         <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-300 italic">Today's Snapshot / {new Date(selectedDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
      </div>

      {/* Snapshot Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 px-1">
        {[
          { label: 'NEW LEADS', value: stats.newLeads, icon: Users, color: 'text-slate-400' },
          { label: 'AGENT RESPONSES', value: stats.responses, sub: `${(stats.newLeads + stats.responses) > 0 ? ((stats.responses / (stats.responses + stats.newLeads)) * 100).toFixed(1) : 0}% Initial Response`, icon: History, color: 'text-brand-blue' },
          { label: 'PIPELINE VOLUME', value: stats.pipeline, icon: TrendingUp, color: 'text-slate-400' },
          { label: 'IMMEDIATE ALERTS', value: stats.alerts, icon: Zap, color: 'text-red-500', isCritical: true },
        ].map((stat, i) => (
          <motion.button 
            key={i}
            onClick={() => {
              const types = ['new_leads', 'agent_responses', 'pipeline_volume', 'immediate_alerts'];
              setActivePopup(types[i]);
              setPopupSearch('');
            }}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.1 }}
            className={cn(
              "bg-white p-6 rounded-sm border border-slate-100 flex flex-col justify-between h-32 transition-all hover:border-[#978C21] cursor-pointer text-left select-none shadow-sm focus:outline-none w-full",
              stat.isCritical && "bg-red-50/10 border-red-100 hover:border-red-500"
            )}
          >
            <div className="w-full">
               <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest leading-none mb-4">{stat.label}</p>
               <h3 className={cn("text-4xl font-black text-brand-text tracking-tighter italic", stat.isCritical && "text-red-500")}>{stat.value}</h3>
            </div>
            {stat.sub && (
              <p className="text-[9px] font-bold text-slate-400 mt-1 italic leading-none">{stat.sub}</p>
            )}
          </motion.button>
        ))}
      </div>

      {/* Quick Action Alerts block */}
      <div className="bg-[#FBFAF8] p-6 rounded-sm border border-slate-100 mx-1">
         <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] italic mb-3">Quick Actions & Alerts</p>
         <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            
            {/* Action 1: Daily Call Alerts */}
            <button
               onClick={() => {
                  setActivePopup('call');
                  setAlertDate(new Date().toISOString().substring(0, 10));
                  setPopupSearch('');
               }}
               className="flex items-center gap-4 bg-white p-5 rounded-sm border border-slate-150 hover:border-[#978C21] transition-all text-left group shadow-sm cursor-pointer"
            >
               <div className="w-12 h-12 rounded bg-amber-50 border border-amber-100 flex items-center justify-center text-[#978C21] group-hover:bg-[#978C21] group-hover:text-white transition-all">
                  <Phone className="w-5 h-5" />
               </div>
               <div>
                  <h4 className="text-[12px] font-black uppercase text-slate-800 tracking-wider">Daily Call Alerts</h4>
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mt-1">
                     {getDateFilteredLeads().filter(l => l.currentStatus === 'No Response' && l.nextCallDate && l.nextCallDate.substring(0, 10) === new Date().toISOString().substring(0, 10)).length} Calls Scheduled Today
                  </p>
               </div>
            </button>

            {/* Action 1B: Tomorrow Call Alerts */}
            <button
               onClick={() => {
                  setActivePopup('call_tomorrow');
                  setAlertDate(getTomorrowString());
                  setPopupSearch('');
               }}
               className="flex items-center gap-4 bg-white p-5 rounded-sm border border-slate-150 hover:border-[#978C21]/60 transition-all text-left group shadow-sm cursor-pointer"
            >
               <div className="w-12 h-12 rounded bg-amber-50/50 border border-amber-100/50 flex items-center justify-center text-[#978C21]/80 group-hover:bg-[#978C21] group-hover:text-white transition-all">
                  <Phone className="w-5 h-5" />
               </div>
               <div>
                  <h4 className="text-[12px] font-black uppercase text-slate-800 tracking-wider">Tomorrow Call Alerts</h4>
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mt-1">
                     {getDateFilteredLeads().filter(l => l.currentStatus === 'No Response' && l.nextCallDate && l.nextCallDate.substring(0, 10) === getTomorrowString()).length} Calls Tomorrow
                  </p>
               </div>
            </button>

            {/* Action 2: Daily Meeting Alerts */}
            <button
               onClick={() => {
                  setActivePopup('meeting');
                  setAlertDate(new Date().toISOString().substring(0, 10));
                  setPopupSearch('');
               }}
               className="flex items-center gap-4 bg-white p-5 rounded-sm border border-slate-150 hover:border-blue-500 transition-all text-left group shadow-sm cursor-pointer"
            >
               <div className="w-12 h-12 rounded bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-600 group-hover:bg-blue-600 group-hover:text-white transition-all">
                  <CalendarIcon className="w-5 h-5" />
               </div>
               <div>
                  <h4 className="text-[12px] font-black uppercase text-slate-800 tracking-wider">Daily Meeting Alerts</h4>
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mt-1">
                     {getDateFilteredLeads().filter(l => l.meetingDate && l.meetingDate.substring(0, 10) === new Date().toISOString().substring(0, 10)).length} Meetings Today
                  </p>
               </div>
            </button>

            {/* Action 2B: Tomorrow Meeting Alerts */}
            <button
               onClick={() => {
                  setActivePopup('meeting_tomorrow');
                  setAlertDate(getTomorrowString());
                  setPopupSearch('');
               }}
               className="flex items-center gap-4 bg-white p-5 rounded-sm border border-slate-150 hover:border-blue-400 transition-all text-left group shadow-sm cursor-pointer"
            >
               <div className="w-12 h-12 rounded bg-blue-50/50 border border-blue-100/50 flex items-center justify-center text-blue-500 group-hover:bg-blue-500 group-hover:text-white transition-all">
                  <CalendarIcon className="w-5 h-5" />
               </div>
               <div>
                  <h4 className="text-[12px] font-black uppercase text-slate-800 tracking-wider">Tomorrow Meeting Alerts</h4>
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mt-1">
                     {getDateFilteredLeads().filter(l => l.meetingDate && l.meetingDate.substring(0, 10) === getTomorrowString()).length} Meetings Tomorrow
                  </p>
               </div>
            </button>

            {/* Action 3: Daily Follow-up Alerts */}
            <button
               onClick={() => {
                  setActivePopup('followup');
                  setAlertDate(new Date().toISOString().substring(0, 10));
                  setPopupSearch('');
               }}
               className="flex items-center gap-4 bg-white p-5 rounded-sm border border-slate-150 hover:border-emerald-500 transition-all text-left group shadow-sm cursor-pointer"
            >
               <div className="w-12 h-12 rounded bg-emerald-50 border border-emerald-100 flex items-center justify-center text-emerald-600 group-hover:bg-emerald-600 group-hover:text-white transition-all">
                  <RefreshCw className="w-5 h-5" />
               </div>
               <div>
                  <h4 className="text-[12px] font-black uppercase text-slate-800 tracking-wider">Daily Follow-up Alerts</h4>
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mt-1">
                     {getDateFilteredLeads().filter(l => ['Follow-up Set', 'Interested', 'Pipeline Locked'].includes(l.currentStatus) && l.nextFollowUpDate && l.nextFollowUpDate.substring(0, 10) === new Date().toISOString().substring(0, 10)).length} Follow-ups Today
                  </p>
               </div>
            </button>

            {/* Action 3B: Tomorrow Follow-up Alerts */}
            <button
               onClick={() => {
                  setActivePopup('followup_tomorrow');
                  setAlertDate(getTomorrowString());
                  setPopupSearch('');
               }}
               className="flex items-center gap-4 bg-white p-5 rounded-sm border border-slate-150 hover:border-emerald-400 transition-all text-left group shadow-sm cursor-pointer"
            >
               <div className="w-12 h-12 rounded bg-emerald-50/50 border border-emerald-100/50 flex items-center justify-center text-emerald-500 group-hover:bg-emerald-500 group-hover:text-white transition-all">
                  <RefreshCw className="w-5 h-5" />
               </div>
               <div>
                  <h4 className="text-[12px] font-black uppercase text-slate-800 tracking-wider">Tomorrow Follow-up Alerts</h4>
                  <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest mt-1">
                     {getDateFilteredLeads().filter(l => ['Follow-up Set', 'Interested', 'Pipeline Locked'].includes(l.currentStatus) && l.nextFollowUpDate && l.nextFollowUpDate.substring(0, 10) === getTomorrowString()).length} Follow-ups Tomorrow
                  </p>
               </div>
            </button>

         </div>
      </div>

      {/* Alert popup details list modal */}
      {activePopup && (
         <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
            <motion.div 
               initial={{ opacity: 0, scale: 0.95 }}
               animate={{ opacity: 1, scale: 1 }}
               className="bg-white rounded-sm border border-slate-200 shadow-2xl w-full max-w-5xl max-h-[85vh] flex flex-col overflow-hidden"
            >
               <div className="bg-[#3C3C3C] p-6 text-white flex items-center justify-between">
                  <div className="flex items-center gap-3">
                     {activePopup === 'call' && <Phone className="w-5 h-5 text-[#978C21]" />}
                     {activePopup === 'meeting' && <CalendarIcon className="w-5 h-5 text-blue-400" />}
                     {activePopup === 'followup' && <RefreshCw className="w-5 h-5 text-emerald-400" />}
                     {!['call', 'meeting', 'followup'].includes(activePopup) && <Users className="w-5 h-5 text-[#978C21]" />}
                     <div>
                        <h4 className="font-black text-[12px] uppercase tracking-[0.2em] italic">
                           {getPopupTitle()} List Extraction
                        </h4>
                        <p className="text-[8px] text-slate-400 uppercase tracking-widest mt-1 font-bold">Workspace KPI Extraction Panel</p>
                     </div>
                  </div>
                  <button 
                     onClick={() => setActivePopup(null)}
                     className="text-slate-400 hover:text-white text-[10px] uppercase tracking-widest font-black"
                  >
                     [ CLOSE PANEL ]
                  </button>
               </div>

               <div className="p-6 bg-slate-50 border-b border-slate-100 flex flex-col md:flex-row gap-4 items-center justify-between">
                  <div className="flex items-center gap-4 flex-wrap">
                     {['call', 'meeting', 'followup'].includes(activePopup) ? (
                        <div className="flex items-center gap-2">
                           <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest italic">Filter Target Date:</span>
                           <input 
                              type="date"
                              value={alertDate}
                              onChange={(e) => setAlertDate(e.target.value)}
                              className="bg-white border border-slate-200 rounded-sm px-3 py-1.5 text-[11px] font-black uppercase outline-none focus:border-[#978C21]"
                           />
                           <button 
                              onClick={() => setAlertDate(new Date().toISOString().split('T')[0])}
                              className="text-[9px] font-black uppercase text-[#978C21] hover:underline cursor-pointer"
                           >
                              Today
                           </button>
                        </div>
                     ) : (
                        <div className="flex items-center gap-2">
                           <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest italic bg-slate-200/50 px-2.5 py-1 rounded-sm">
                              {period === 'CUSTOM' ? `Custom Period: ${customDates.start} ~ ${customDates.end}` : `Period: ${period}`}
                           </span>
                        </div>
                     )}
                     
                     {/* Dynamic leads counter */}
                     <span className="text-[10px] font-bold text-slate-400 bg-slate-100 px-3 py-1.5 rounded-sm uppercase">
                        {(() => {
                           let f = getModalLeads();
                           if (popupSearch.trim()) {
                              const s = popupSearch.toLowerCase();
                              f = f.filter(l => 
                                 (l.name || '').toLowerCase().includes(s) || 
                                 (l.phone || '').toLowerCase().includes(s) || 
                                 (l.area || '').toLowerCase().includes(s)
                              );
                           }
                           return f.length;
                        })()} Records Found
                     </span>
                  </div>
                  
                  <div className="flex items-center gap-3 w-full md:w-auto">
                     <div className="w-full md:w-60">
                        <input 
                           type="text"
                           placeholder="Search Name or Phone..."
                           value={popupSearch}
                           onChange={(e) => setPopupSearch(e.target.value)}
                           className="w-full bg-white border border-slate-200 rounded-sm px-4 py-2 text-[11px] font-medium outline-none focus:border-[#978C21] placeholder:opacity-50"
                        />
                     </div>
                     <button
                        onClick={() => {
                           // Get final filtered list
                           let rawLeads = getModalLeads();
                           if (popupSearch.trim()) {
                              const s = popupSearch.toLowerCase();
                              rawLeads = rawLeads.filter(l => 
                                 (l.name || '').toLowerCase().includes(s) || 
                                 (l.phone || '').toLowerCase().includes(s) || 
                                 (l.area || '').toLowerCase().includes(s)
                              );
                           }
                           handleExportExcel(rawLeads, getPopupTitle());
                        }}
                        className="flex items-center gap-2 bg-[#10B981] hover:bg-[#059669] text-white px-4 py-2 text-[11px] uppercase font-black tracking-widest rounded-sm transition-all shadow-md focus:outline-none shrink-0"
                     >
                        <Download className="w-3.5 h-3.5" />
                        Export XL
                     </button>
                  </div>
               </div>

               <div className="flex-1 overflow-y-auto p-6 bg-white min-h-[300px]">
                  {(() => {
                     let filtered = getModalLeads();

                     if (popupSearch.trim()) {
                        const s = popupSearch.toLowerCase();
                        filtered = filtered.filter(l => 
                           (l.name || '').toLowerCase().includes(s) || 
                           (l.phone || '').toLowerCase().includes(s) || 
                           (l.area || '').toLowerCase().includes(s)
                        );
                     }

                     if (filtered.length === 0) {
                        return (
                           <div className="py-12 bg-[#FBFAF8] rounded border border-slate-100 flex flex-col items-center justify-center text-center">
                              <p className="text-[10px] text-[#978C21] uppercase tracking-widest italic font-black">No Records Match This Criteria</p>
                              <p className="text-[8px] text-slate-300 uppercase mt-2 font-bold tracking-wider">Select different target date or change query</p>
                           </div>
                        );
                     }

                     return (
                        <div className="overflow-x-auto rounded border border-slate-100">
                           <table className="w-full text-left">
                              <thead className="bg-[#FBFAF8] text-[9px] font-black text-slate-500 uppercase tracking-widest border-b border-slate-100">
                                 <tr>
                                    <th className="px-5 py-4">Lead Name / Region</th>
                                    <th className="px-5 py-4">Phone Contact</th>
                                    <th className="px-5 py-4 text-center">Product / Campaign</th>
                                    <th className="px-5 py-4 text-center">Configured Date / Flag</th>
                                    <th className="px-5 py-4">Assigned Handler</th>
                                    <th className="px-5 py-4 text-center">Lead status</th>
                                    <th className="px-5 py-4 text-right">Actions</th>
                                 </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-50 italic">
                                 {filtered.map((l, i) => (
                                    <tr 
                                       key={i} 
                                       className="hover:bg-slate-50 transition-colors cursor-pointer"
                                       onClick={() => setSelectedLead(l)}
                                    >
                                       <td className="px-5 py-4 text-[12px] font-black uppercase text-slate-700">
                                          <div>{l.name}</div>
                                          <div className="text-[9px] font-bold text-slate-400">{l.area || 'No Region Configured'}</div>
                                       </td>
                                       <td className="px-5 py-4 text-[11px] font-bold text-slate-500 font-mono">
                                          {l.phone}
                                       </td>
                                       <td className="px-5 py-4 text-[11px] text-center font-bold text-slate-600">
                                          <div>{l.productName || l.product || 'N/A'}</div>
                                          <div className="text-[9px] text-slate-400">{l.campaignName || l.campaign || 'N/A'}</div>
                                       </td>
                                       <td className="px-5 py-4 text-[11px] text-center font-black text-[#978C21] tracking-wider font-mono">
                                          {['call', 'call_tomorrow'].includes(activePopup || '') && l.nextCallDate}
                                          {['meeting', 'meeting_tomorrow'].includes(activePopup || '') && l.meetingDate}
                                          {['followup', 'followup_tomorrow'].includes(activePopup || '') && l.nextFollowUpDate}
                                          {!['call', 'call_tomorrow', 'meeting', 'meeting_tomorrow', 'followup', 'followup_tomorrow'].includes(activePopup || '') && (
                                             l.currentStatus === 'Meeting Fixed' && l.meetingDate ? l.meetingDate : (l.nextCallDate ? l.nextCallDate : (l.nextFollowUpDate ? l.nextFollowUpDate : new Date(l.timestamp).toLocaleDateString('en-GB')))
                                          )}
                                       </td>
                                       <td className="px-5 py-4 text-[11px] font-black text-slate-500 uppercase">
                                          {l.assignedTo || 'Unassigned'}
                                       </td>
                                       <td className="px-5 py-4 text-center">
                                          <span className="px-2.5 py-1 rounded text-[9px] uppercase tracking-wider font-black bg-[#978C21]/10 text-[#978C21]">
                                             {l.currentStatus}
                                          </span>
                                       </td>
                                       <td className="px-5 py-4 text-right" onClick={(e) => e.stopPropagation()}>
                                          <button 
                                             onClick={() => setSelectedLead(l)}
                                             className="border border-[#978C21] text-[#978C21] hover:bg-[#978C21] hover:text-white px-2.5 py-1 text-[9px] uppercase tracking-wider font-black rounded-sm transition-all focus:outline-none cursor-pointer"
                                          >
                                             Update
                                          </button>
                                       </td>
                                    </tr>
                                 ))}
                              </tbody>
                           </table>
                        </div>
                     );
                  })()}
               </div>
            </motion.div>
         </div>
      )}

      {/* Drawer Overlay for Lead Status Update */}
      <AnimatePresence>
         {selectedLead && (
            <div className="fixed inset-0 z-[100] flex justify-end bg-black/50 backdrop-blur-sm">
               {/* Click outside to close */}
               <div className="absolute inset-0" onClick={() => setSelectedLead(null)} />
               
               <motion.div 
                  initial={{ x: '100%' }}
                  animate={{ x: 0 }}
                  exit={{ x: '100%' }}
                  transition={{ type: 'tween', duration: 0.3 }}
                  className="relative w-full max-w-xl bg-white h-full shadow-2xl flex flex-col z-10 border-l border-slate-100"
               >
                  {/* Header */}
                  <div className="bg-[#3C3C3C] p-6 text-white flex items-center justify-between">
                     <div>
                        <p className="text-[9px] font-black text-[#978C21] uppercase tracking-[0.2em] italic">Engagement Portal</p>
                        <h3 className="text-lg font-black tracking-tight uppercase mt-1">{selectedLead.name}</h3>
                        <p className="text-[10px] font-bold text-slate-300 mt-1 uppercase tracking-wider">
                           Phone: {selectedLead.phone} | Region: {selectedLead.area || 'No Region'}
                        </p>
                     </div>
                     <button 
                        onClick={() => setSelectedLead(null)}
                        className="text-slate-400 hover:text-white transition-colors cursor-pointer"
                     >
                        <XCircle className="w-6 h-6" />
                     </button>
                  </div>

                  {/* Body - Scrollable */}
                  <div className="flex-1 overflow-y-auto p-6 space-y-6">
                     {/* Historic Records */}
                     <div>
                        <p className="text-[10px] font-black text-[#978C21] uppercase tracking-[0.2em] italic mb-3">Historic Engagement History</p>
                        {selectedLead.history && selectedLead.history.length > 0 ? (
                           <div className="space-y-3">
                              {selectedLead.history.map((h: any, idx: number) => (
                                 <div key={idx} className="bg-slate-50 rounded border border-slate-100 p-4 space-y-2">
                                    <div className="flex justify-between items-center text-[10px] font-black uppercase text-slate-700">
                                       <span>Status: <span className="text-[#978C21]">{h.status}</span></span>
                                       <span className="text-[8px] font-bold text-slate-400">{new Date(h.date).toLocaleString()}</span>
                                    </div>
                                    <div className="text-[11px] font-medium text-slate-600 font-sans italic leading-relaxed">
                                       "{h.remarks || 'No remarks logged'}"
                                    </div>
                                    <div className="text-[8px] text-slate-400 font-bold border-t border-slate-100/50 pt-1">
                                       Log Creator: {h.updatedBy || 'N/A'}
                                    </div>
                                 </div>
                              ))}
                           </div>
                        ) : (
                           <div className="p-4 bg-slate-50 border border-slate-200/50 rounded text-[11px] text-slate-400 italic">
                              No previous operational history has been logged yet.
                           </div>
                        )}
                     </div>

                     {/* Edit Form */}
                     <div className="border-t border-slate-100 pt-6 space-y-4">
                        <p className="text-[10px] font-black text-[#978C21] uppercase tracking-[0.2em] italic mb-2">Update Engagement Lead Status</p>
                        
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                           <div className="space-y-1">
                              <p className="text-[9px] font-black text-slate-400 uppercase italic">Target Status <span className="text-red-500">*</span></p>
                              <select 
                                 value={formStatus}
                                 onChange={(e) => {
                                    const newStatus = e.target.value;
                                    setFormStatus(newStatus);
                                    if (newStatus !== 'No Response') setFormNextCallDate('');
                                    if (newStatus !== 'Meeting Fixed') setFormMeetingDate('');
                                    if (newStatus !== 'Follow-up Set' && newStatus !== 'Interested' && newStatus !== 'Busy') setFormNextFollowUpDate('');
                                    if (newStatus !== 'Meeting Completed') setFormSubStatus('');
                                    setFormLossReason('');
                                    setFormMeetingType('');
                                 }}
                                 className="w-full bg-[#FBFAF8] border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest focus:ring-1 focus:ring-[#978C21] outline-none"
                              >
                                 <option value="">-- SELECT STATUS --</option>
                                 {workflowService.getAllowedNextStatuses(selectedLead?.currentStatus || '', statusOptions, workflowRules).map(opt => (
                                    <option key={opt} value={opt}>{opt}</option>
                                 ))}
                              </select>
                           </div>

                           {/* Workflow Engine: Loss Reason (admin-configurable requirement) */}
                           {workflowRules.find((r: any) => r.status === formStatus)?.requiresLossReason && (
                              <div className="space-y-1">
                                 <p className="text-[9px] font-black text-slate-400 uppercase italic">Loss Reason <span className="text-red-500">*</span></p>
                                 <select 
                                    value={formLossReason}
                                    onChange={(e) => setFormLossReason(e.target.value)}
                                    className="w-full bg-[#FBFAF8] border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest focus:ring-1 focus:ring-[#978C21] outline-none"
                                 >
                                    <option value="">-- SELECT REASON --</option>
                                    {lossReasonOptions.map(r => <option key={r} value={r}>{r}</option>)}
                                 </select>
                              </div>
                           )}

                           {/* Workflow Engine: Meeting Type (admin-configurable requirement) */}
                           {workflowRules.find((r: any) => r.status === formStatus)?.requiresMeetingType && (
                              <div className="space-y-1">
                                 <p className="text-[9px] font-black text-slate-400 uppercase italic">Meeting Type <span className="text-red-500">*</span></p>
                                 <select 
                                    value={formMeetingType}
                                    onChange={(e) => setFormMeetingType(e.target.value)}
                                    className="w-full bg-[#FBFAF8] border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest focus:ring-1 focus:ring-[#978C21] outline-none"
                                 >
                                    <option value="">-- SELECT TYPE --</option>
                                    {meetingTypeOptions.map(m => <option key={m} value={m}>{m}</option>)}
                                 </select>
                              </div>
                           )}

                           {/* Conditional Field: No Response -> Next Call Date */}
                           {formStatus === 'No Response' && (
                              <div className="space-y-1">
                                 <p className="text-[9px] font-black text-slate-400 uppercase italic">Next Call Date <span className="text-red-500">*</span></p>
                                 <input 
                                    type="date"
                                    value={formNextCallDate ? formNextCallDate.substring(0, 10) : ''}
                                    onChange={(e) => setFormNextCallDate(e.target.value)}
                                    className="w-full bg-[#FBFAF8] border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase focus:ring-1 focus:ring-[#978C21] outline-none"
                                 />
                              </div>
                           )}

                           {/* Conditional Field: Meeting Fixed -> Meeting Date */}
                           {formStatus === 'Meeting Fixed' && (
                              <div className="space-y-1">
                                 <p className="text-[9px] font-black text-slate-400 uppercase italic">Meeting Date <span className="text-red-500">*</span></p>
                                 <input 
                                    type="date"
                                    value={formMeetingDate ? formMeetingDate.substring(0, 10) : ''}
                                    onChange={(e) => setFormMeetingDate(e.target.value)}
                                    className="w-full bg-[#FBFAF8] border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase focus:ring-1 focus:ring-[#978C21] outline-none"
                                 />
                              </div>
                           )}

                           {/* Conditional Field: Follow-up Set, Interested or Busy -> Next Follow-up Date */}
                           {(formStatus === 'Follow-up Set' || formStatus === 'Interested' || formStatus === 'Busy') && (
                              <div className="space-y-1">
                                 <p className="text-[9px] font-black text-slate-400 uppercase italic">Target Follow-Up Date <span className="text-red-500">*</span></p>
                                 <input 
                                    type="date"
                                    value={formNextFollowUpDate ? formNextFollowUpDate.substring(0, 10) : ''}
                                    onChange={(e) => setFormNextFollowUpDate(e.target.value)}
                                    className="w-full bg-[#FBFAF8] border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase focus:ring-1 focus:ring-[#978C21] outline-none"
                                 />
                              </div>
                           )}

                           {/* Conditional Field: Meeting Completed -> sub-status dropdown */}
                           {formStatus === 'Meeting Completed' && (
                              <div className="space-y-1">
                                 <p className="text-[9px] font-black text-slate-400 uppercase italic">Meeting Result (Sub-Status) <span className="text-red-500">*</span></p>
                                 <select 
                                    value={formSubStatus}
                                    onChange={(e) => setFormSubStatus(e.target.value)}
                                    className="w-full bg-[#FBFAF8] border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-wider focus:ring-1 focus:ring-[#978C21] outline-none"
                                 >
                                    <option value="">-- SELECT RESULT --</option>
                                    <option value="Pipeline Locked">Pipeline Locked</option>
                                    <option value="Not Interested border-red-500">Not Interested</option>
                                 </select>
                              </div>
                           )}

                           {/* Conditional Fields block: Pipeline Locked */}
                           {(formStatus === 'Pipeline Locked' || (formStatus === 'Meeting Completed' && formSubStatus === 'Pipeline Locked')) && (
                              <div className="col-span-2 grid grid-cols-1 md:grid-cols-3 gap-4 border-l-2 border-[#978C21] pl-3 py-1 bg-slate-50/50 rounded-r-md">
                                 <div className="space-y-1">
                                    <p className="text-[9px] font-black text-slate-400 uppercase italic">Product Name <span className="text-red-500">*</span></p>
                                    <select 
                                       value={formProductName}
                                       onChange={(e) => setFormProductName(e.target.value)}
                                       className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest focus:ring-1 focus:ring-[#978C21] outline-none"
                                    >
                                       <option value="">-- SELECT PRODUCT --</option>
                                       {productOptions.map(p => (
                                          <option key={p} value={p}>{p}</option>
                                       ))}
                                    </select>
                                 </div>
                                 <div className="space-y-1">
                                    <p className="text-[9px] font-black text-slate-400 uppercase italic">Sum Assured (৳) <span className="text-red-500">*</span></p>
                                    <input 
                                       type="number"
                                       placeholder="Sum Assured..."
                                       value={formSumAssured || ''}
                                       onChange={(e) => setFormSumAssured(parseFloat(e.target.value) || 0)}
                                       className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black focus:ring-1 focus:ring-[#978C21] outline-none"
                                    />
                                 </div>
                                 <div className="space-y-1">
                                    <p className="text-[9px] font-black text-slate-400 uppercase italic">Projected NCP (৳) <span className="text-red-500">*</span></p>
                                    <input 
                                       type="number"
                                       placeholder="Projected NCP..."
                                       value={formProjectedNCP || ''}
                                       onChange={(e) => setFormProjectedNCP(parseFloat(e.target.value) || 0)}
                                       className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black focus:ring-1 focus:ring-[#978C21] outline-none"
                                    />
                                 </div>
                              </div>
                           )}

                           {/* Conditional Fields block: Converted */}
                           {formStatus === 'Converted' && (
                              <div className="col-span-2 grid grid-cols-1 md:grid-cols-3 gap-4 border-l-2 border-emerald-500 pl-3 py-1 bg-slate-50/50 rounded-r-md">
                                 <div className="space-y-1">
                                    <p className="text-[9px] font-black text-slate-400 uppercase italic">Product Name <span className="text-red-500">*</span></p>
                                    <select 
                                       value={formProductName}
                                       onChange={(e) => setFormProductName(e.target.value)}
                                       className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black uppercase tracking-widest focus:ring-1 focus:ring-[#978C21] outline-none"
                                    >
                                       <option value="">-- SELECT PRODUCT --</option>
                                       {productOptions.map(p => (
                                          <option key={p} value={p}>{p}</option>
                                       ))}
                                    </select>
                                 </div>
                                 <div className="space-y-1">
                                    <p className="text-[9px] font-black text-slate-400 uppercase italic">Sum Assured (৳) <span className="text-red-500">*</span></p>
                                    <input 
                                       type="number"
                                       placeholder="Sum Assured..."
                                       value={formSumAssured || ''}
                                       onChange={(e) => setFormSumAssured(parseFloat(e.target.value) || 0)}
                                       className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black focus:ring-1 focus:ring-[#978C21] outline-none"
                                    />
                                 </div>
                                 <div className="space-y-1">
                                    <p className="text-[9px] font-black text-slate-400 uppercase italic">Collected NCP (৳) <span className="text-red-500">*</span></p>
                                    <input 
                                       type="number"
                                       placeholder="Collected NCP..."
                                       value={formCollectedNCP || ''}
                                       onChange={(e) => setFormCollectedNCP(parseFloat(e.target.value) || 0)}
                                       className="w-full bg-white border border-slate-200 rounded-sm px-4 py-3 text-[11px] font-black focus:ring-1 focus:ring-[#978C21] outline-none"
                                    />
                                 </div>
                              </div>
                           )}
                        </div>

                        {/* Operational Remarks */}
                        <div className="space-y-1">
                           <p className="text-[9px] font-black text-slate-400 uppercase italic">Operational Remarks <span className="text-red-500">*</span></p>
                           <textarea
                              placeholder="Describe client response, expectations, or next steps in detail (Mandatory)..."
                              value={formRemarks}
                              onChange={(e) => setFormRemarks(e.target.value)}
                              rows={3}
                              className="w-full bg-[#FBFAF8] border border-slate-200 rounded-sm p-3 text-[11px] font-medium focus:ring-1 focus:ring-[#978C21] outline-none"
                           />
                        </div>
                     </div>

                     {/* Delegation Action Matrix */}
                     {user?.role !== UserRole.RO && (
                        <div className="p-4 bg-[#978C21]/5 border border-[#978C21]/15 rounded-sm space-y-3">
                           <p className="text-[10px] font-black text-slate-800 uppercase tracking-widest leading-none">📋 Assign & Delegate Lead</p>
                           <div className="flex gap-3">
                              <select
                                 value={selectedRO}
                                 onChange={(e) => setSelectedRO(e.target.value)}
                                 className="flex-1 bg-white border border-slate-200 rounded-sm px-3 py-2 text-[11px] font-black uppercase tracking-wider outline-none focus:ring-1 focus:ring-[#978C21]"
                              >
                                 <option value="">-- CHOOSE RECIPIENT AGENT --</option>
                                 {allUsers.filter(u => {
                                    if (u.employeeId === user?.employeeId) return false;
                                    if (user?.role === UserRole.ADMIN) return true;
                                    const reportUserIds = getReportingUserIds(user?.employeeId || '', allUsers);
                                    return reportUserIds.includes(u.employeeId);
                                 }).map(u => (
                                    <option key={u.employeeId} value={u.employeeId}>
                                       {u.name} ({u.role} - {u.employeeId})
                                    </option>
                                 ))}
                              </select>
                              <button
                                 onClick={async () => {
                                    if (!selectedRO) {
                                       toast.error('Select a valid agent/officer first!');
                                       return;
                                    }
                                    try {
                                       await leadService.updateLead(selectedLead.id, { 
                                          assignedTo: selectedRO,
                                          currentStatus: 'Untouched'
                                       });
                                       const targetAgent = allUsers.find(u => u.employeeId === selectedRO);
                                       toast.success(`Lead successfully assigned to ${targetAgent?.name || selectedRO}!`);
                                       setSelectedLead(null);
                                       await loadDashboardData();
                                    } catch (err) {
                                       toast.error('Failed to assign lead.');
                                    }
                                 }}
                                 className="bg-[#978C21] text-white px-5 py-2 text-[11px] uppercase font-black tracking-widest rounded-sm hover:opacity-95 cursor-pointer"
                              >
                                 Assign
                              </button>
                           </div>
                        </div>
                     )}
                  </div>

                  {/* Footer actions */}
                  <div className="border-t border-slate-100 p-6 bg-slate-50 flex items-center justify-end gap-3 shrink-0">
                     <button 
                        onClick={() => setSelectedLead(null)}
                        className="bg-white border border-slate-200 hover:border-slate-300 px-6 py-3 text-[11px] uppercase font-black tracking-widest rounded-sm transition-all shadow-sm cursor-pointer"
                     >
                        Cancel
                     </button>
                     <button 
                        onClick={handleSaveLeadUpdate}
                        className="bg-[#978C21] hover:opacity-95 text-white px-6 py-3 text-[11px] uppercase font-black tracking-widest rounded-sm transition-all shadow-md flex items-center gap-2 cursor-pointer"
                     >
                        <CheckCircle className="w-3.5 h-3.5" />
                        Save Changes
                     </button>
                  </div>
               </motion.div>
            </div>
         )}
      </AnimatePresence>

      {!(user?.role === UserRole.RO || user?.role === UserRole.RM) && (
        <>
          {/* Execution Intelligence Section */}
          <div className="bg-white rounded-sm border border-slate-100 overflow-hidden shadow-sm mt-6">
         <div className="bg-[#3C3C3C] px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
               <div className="w-8 h-8 rounded bg-white/5 flex items-center justify-center text-primary">
                  <LayoutDashboard className="w-4 h-4 text-[#978C21]" />
               </div>
               <div>
                  <h4 className="text-white text-[12px] font-black uppercase tracking-[0.2em] italic">Execution Intelligence</h4>
                  <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">Daily Status Report</p>
               </div>
            </div>
            <div className="flex items-center flex-wrap gap-1 bg-white/5 p-1 rounded-sm">
               {['TODAY', 'THIS MONTH', 'LAST MONTH', 'CUSTOM'].map(p => (
                 <button 
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={cn(
                    "px-4 py-1.5 text-[9px] font-black uppercase tracking-widest rounded-sm transition-all",
                    period === p ? "bg-white text-brand-text" : "text-slate-400 hover:text-white"
                  )}
                 >
                   {p}
                 </button>
               ))}
               <div className="hidden md:block h-6 w-px bg-white/10 mx-2" />
               <div className="flex items-center gap-2 px-2">
                  <CalendarIcon className="w-3 h-3 text-slate-400" />
                  <span className="text-[9px] font-black text-slate-400 uppercase">{formattedDateRange()}</span>
               </div>
            </div>
         </div>
         
         {period === 'CUSTOM' && (
           <div className="bg-slate-50 px-6 py-3 border-b border-slate-100 flex items-center gap-4">
              <div className="flex items-center gap-2">
                 <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Start:</span>
                 <input 
                   type="date" 
                   value={customDates.start}
                   onChange={(e) => setCustomDates({ ...customDates, start: e.target.value })}
                   className="bg-white border border-slate-200 rounded-sm px-2 py-1 text-[10px] font-black uppercase outline-none focus:border-[#978C21]"
                 />
              </div>
              <div className="flex items-center gap-2">
                 <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">End:</span>
                 <input 
                   type="date" 
                   value={customDates.end}
                   onChange={(e) => setCustomDates({ ...customDates, end: e.target.value })}
                   className="bg-white border border-slate-200 rounded-sm px-2 py-1 text-[10px] font-black uppercase outline-none focus:border-[#978C21]"
                 />
              </div>
           </div>
         )}
         <div className="grid grid-cols-2 md:grid-cols-3 gap-0 divide-x divide-slate-100 border-b border-slate-100">
            {[
              { label: 'CONTACTED CALLS', value: stats.contacted },
              { label: 'MEETINGS COMPLETED', value: stats.meetings },
              { label: 'FOLLOW-UPS SET', value: stats.followUps },
              { label: 'PIPELINE LOCKED', value: stats.pipeline, prefix: '৳' },
              { label: 'PROJECTED NCP', value: stats.projected.toLocaleString(), prefix: '৳' },
              { label: 'COLLECTED NCP', value: stats.collected.toLocaleString(), prefix: '৳', isGreen: true },
            ].map((stat, i) => (
               <button
                  key={i}
                  onClick={() => {
                     const types = ['contacted_calls', 'meetings_completed', 'followups_set', 'pipeline_volume', 'projected_ncp', 'collected_ncp'];
                     setActivePopup(types[i]);
                     setPopupSearch('');
                  }}
                  className="p-8 text-left group hover:bg-slate-50/50 transition-colors cursor-pointer select-none border-0 outline-none w-full"
               >
                  <div className="flex items-center gap-2 mb-4">
                     {i === 0 && <Phone className="w-3.5 h-3.5 text-brand-blue" />}
                     {i === 1 && <Users className="w-3.5 h-3.5 text-slate-900" />}
                     {i === 2 && <RefreshCw className="w-3.5 h-3.5 text-slate-500" />}
                     {i === 3 && <Target className="w-3.5 h-3.5 text-slate-900" />}
                     {i === 4 && <div className="w-3.5 h-3.5 rounded-full border-2 border-brand-blue" />}
                     {i === 5 && <CheckCircle className="w-3.5 h-3.5 text-[#10B981]" />}
                     <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">{stat.label}</p>
                  </div>
                  <div className="flex items-baseline gap-1">
                    {stat.prefix && <span className="text-xl font-black text-brand-text leading-none italic">{stat.prefix}</span>}
                    <h5 className={cn("text-4xl font-black text-brand-text tracking-tighter italic", stat.isGreen && "text-[#10B981]")}>{stat.value}</h5>
                  </div>
               </button>
            ))}
         </div>

         {canAccess('dashboard', 'view_division_table') && (
         <div className="overflow-x-auto">
            <table className="w-full text-left">
               <thead className="bg-[#FBFAF8] text-[9px] font-black text-slate-500 uppercase tracking-widest border-b border-slate-100">
                  <tr>
                     <th className="px-8 py-6">Team / Agency</th>
                     <th className="px-6 py-6 text-center">Total Assigned</th>
                     <th className="px-6 py-6 text-center text-brand-blue">No Call Yet</th>
                     <th className="px-6 py-6 text-center">Contacted</th>
                     <th className="px-6 py-6 text-center">Meetings</th>
                     <th className="px-6 py-6 text-center">Follow-ups</th>
                     <th className="px-6 py-6 text-center">Pipeline Locked</th>
                     <th className="px-6 py-6 text-center text-[#10B981]">Collected NCP</th>
                     <th className="px-6 py-6 text-center">Projected NCP</th>
                     <th className="px-6 py-6 text-right pr-8">
                        <Download className="w-4 h-4 text-slate-300 ml-auto cursor-pointer hover:text-primary transition-colors" />
                     </th>
                  </tr>
               </thead>
               <tbody className="divide-y divide-slate-50 italic">
                  {!canAccess('dashboard', 'filter_by_divisions') ? (
                     <tr>
                        <td colSpan={10} className="px-8 py-10 text-center text-slate-400 font-bold uppercase tracking-widest text-[10px]">
                           <div className="flex flex-col items-center justify-center gap-2">
                              <AlertTriangle className="w-5 h-5 text-[#978C21] mb-1 animate-pulse" />
                              <span>Clearance Level Restricted - Regional Division Filtering Disabled</span>
                           </div>
                        </td>
                     </tr>
                  ) : teamStats.map((row, i) => (
                     <tr key={i} className="hover:bg-slate-50 transition-colors group">
                        <td className="px-8 py-5 text-[12px] font-black uppercase text-slate-600">{row.team}</td>
                        <td className="px-6 py-5 text-[12px] text-center font-bold text-slate-400">{row.assigned}</td>
                        <td className="px-6 py-5 text-[12px] text-center font-black text-brand-blue">{row.noCall}</td>
                        <td className="px-6 py-5 text-[12px] text-center font-bold text-slate-400">{row.contacted}</td>
                        <td className="px-6 py-5 text-[12px] text-center font-bold text-slate-400">{row.meetings}</td>
                        <td className="px-6 py-5 text-[12px] text-center font-bold text-slate-400">{row.followUps}</td>
                        <td className="px-6 py-5 text-[12px] text-center font-black text-[#978C21] italic">{row.pipeline}</td>
                        <td className="px-6 py-5 text-[12px] text-center font-black text-[#10B981] italic">{row.collected}</td>
                        <td className="px-6 py-5 text-[12px] text-center font-black text-slate-500 italic">{row.projected}</td>
                        <td className="px-6 py-5"></td>
                     </tr>
                  ))}
               </tbody>
            </table>
         </div>
         )}
      </div>

      {/* Financial Section */}
      {canAccess('dashboard', 'view_ncp_chart') && (
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 mt-8 px-1">
         <div className="lg:col-span-3 bg-white rounded-2xl border border-slate-100 p-8 md:p-10 shadow-sm relative overflow-hidden">
            <div className="flex flex-col md:flex-row md:items-start justify-between gap-8 mb-8">
               <div>
                  <h4 className="text-[22px] md:text-[26px] font-black text-brand-text tracking-tighter italic leading-tight uppercase">Financial Extraction & Target Tracking</h4>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-2 ml-0.5">Collected vs. Projected NCP</p>
               </div>
               <div 
                  onClick={() => {
                     setActivePopup('collected_ncp');
                     setPopupSearch('');
                  }}
                  className="text-right border-l-0 md:border-l md:pl-6 border-slate-100 flex flex-row md:flex-col gap-4 md:gap-2 justify-between items-end cursor-pointer hover:bg-slate-50 p-2 rounded transition-all select-none"
               >
                  <div>
                     <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1 italic">Collected NCP</p>
                     <h3 className="text-2xl md:text-3xl font-black text-[#978C21] italic tracking-tighter leading-none">৳{stats.collected.toLocaleString()}</h3>
                  </div>
                  <div>
                     <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mb-1 italic">Projected NCP</p>
                     <h4 className="text-lg md:text-xl font-black text-slate-500 italic tracking-tighter leading-none">৳{stats.projected.toLocaleString()}</h4>
                  </div>
                  <p className="text-[11px] font-black text-[#978C21] mt-1 italic flex items-center gap-1">
                     <TrendingUp className="w-3.5 h-3.5" /> 
                     {stats.projected > 0 ? ((stats.collected / stats.projected) * 100).toFixed(1) : 0}% of Target
                  </p>
               </div>
            </div>

            {/* Dynamic visual AreaChart graphing Collected/Projected weekly progressions */}
            <div className="h-44 w-full border-t border-b border-slate-50 py-4 my-6" id="tracking-matrix-chart">
               {!canAccess('dashboard', 'view_analytics') ? (
                  <div className="h-full w-full flex flex-col items-center justify-center bg-[#FBFAF8] border border-dashed border-slate-100 rounded-sm p-4 text-center">
                     <AlertTriangle className="w-5 h-5 text-[#978C21] mb-1 animate-pulse" />
                     <p className="text-[10px] font-black text-slate-900 uppercase">Clearance Unauthorized</p>
                     <p className="text-[9px] text-slate-400 font-bold uppercase mt-0.5">Role credentials lack permissions to view visual analytical indexes.</p>
                  </div>
               ) : (
                  <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={ncpTrackingData}>
                     <defs>
                       <linearGradient id="colorCollected" x1="0" y1="0" x2="0" y2="1">
                         <stop offset="5%" stopColor="#10B981" stopOpacity={0.15}/>
                         <stop offset="95%" stopColor="#10B981" stopOpacity={0}/>
                       </linearGradient>
                       <linearGradient id="colorProjected" x1="0" y1="0" x2="0" y2="1">
                         <stop offset="5%" stopColor="#978C21" stopOpacity={0.15}/>
                         <stop offset="95%" stopColor="#978C21" stopOpacity={0}/>
                       </linearGradient>
                     </defs>
                     <CartesianGrid strokeDasharray="3 3" stroke="#f8fafc" vertical={false} />
                     <XAxis 
                       dataKey="name" 
                       axisLine={false} 
                       tickLine={false} 
                       tick={{ fontSize: 9, fill: '#64748b', fontWeight: 800, fontStyle: 'italic' }} 
                     />
                     <YAxis 
                       axisLine={false} 
                       tickLine={false} 
                       tick={{ fontSize: 9, fill: '#cbd5e1', fontWeight: 700 }}
                       tickFormatter={(v) => `৳${(v / 1000).toFixed(0)}k`}
                     />
                     <Tooltip 
                       formatter={(value: any) => [`৳${value.toLocaleString()}`, '']}
                       contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.1)', fontSize: '11px', fontWeight: '800' }}
                     />
                     <Area type="monotone" dataKey="Collected" stroke="#10B981" strokeWidth={3} fillOpacity={1} fill="url(#colorCollected)" name="Collected" />
                     <Area type="monotone" dataKey="Projected" stroke="#978C21" strokeWidth={2} strokeDasharray="4 4" fillOpacity={1} fill="url(#colorProjected)" name="Projected" />
                  </AreaChart>
               </ResponsiveContainer>
               )}
            </div>

            <div className="grid grid-cols-3 gap-4 md:gap-12 mt-6">
               <button 
                  onClick={() => {
                     setActivePopup('conversion_rate');
                     setPopupSearch('');
                  }}
                  className="text-left cursor-pointer hover:bg-slate-50 p-2 rounded transition-all select-none border-0 outline-none w-full"
               >
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest italic leading-none mb-3">Conversion Rate</p>
                  <h4 className="text-2xl md:text-3xl font-black text-brand-blue italic tracking-tighter leading-none">{stats.conversionRate}</h4>
               </button>
               <button 
                  onClick={() => {
                     setActivePopup('avg_response_tat');
                     setPopupSearch('');
                  }}
                  className="text-left cursor-pointer hover:bg-slate-50 p-2 rounded transition-all select-none border-0 outline-none w-full"
               >
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest italic leading-none mb-3">Avg Response TAT</p>
                  <h4 className="text-2xl md:text-3xl font-black text-brand-text italic tracking-tighter leading-none">{stats.avgResponseTAT}</h4>
               </button>
               <button 
                  onClick={() => {
                     setActivePopup('active_leads');
                     setPopupSearch('');
                  }}
                  className="text-left cursor-pointer hover:bg-slate-50 p-2 rounded transition-all select-none border-0 outline-none w-full"
               >
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest italic leading-none mb-3">Active Leads</p>
                  <h4 className="text-2xl md:text-3xl font-black text-[#978C21] italic tracking-tighter leading-none">{stats.activeLeads}</h4>
               </button>
            </div>
         </div>

         {/* Right-sidebar view cards - strictly sized down to prevent horizontal leaking */}
         <div className="flex flex-col gap-6 justify-between">
            <div className="flex-1 bg-[#2C2C2C] rounded-2xl border border-slate-800 p-6 flex flex-col justify-between shadow-xl min-h-[145px] overflow-hidden">
                <div>
                   <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest italic leading-none mb-3">Collected NCP (Final)</p>
                   <h3 className="text-2xl sm:text-3xl lg:text-xl xl:text-3xl font-black text-[#978C21] italic tracking-tight break-all leading-tight">
                      ৳{stats.collected.toLocaleString()}
                   </h3>
                </div>
                <div className="flex justify-end opacity-15">
                   <Users className="w-12 h-12 text-white" />
                </div>
            </div>
            <div className="flex-1 bg-white rounded-2xl border border-slate-100 p-6 flex flex-col justify-between shadow-sm min-h-[145px] overflow-hidden">
                <div>
                   <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest italic leading-none mb-3">Projected NCP (Potential)</p>
                   <h3 className="text-2xl sm:text-3xl lg:text-xl xl:text-3xl font-black text-brand-text italic tracking-tight break-all leading-tight">
                      ৳{stats.projected.toLocaleString()}
                   </h3>
                </div>
                <div className="flex justify-end opacity-45">
                   <TrendingUp className="w-12 h-12 text-[#978C21]" />
                </div>
            </div>
         </div>
      </div>
      )}

      {/* Campaign Trend Chart */}
      {canAccess('dashboard', 'view_trend_chart') && (
      <div className="bg-white rounded-sm border border-slate-100 p-10 shadow-sm mt-8 mx-1">
         <p className="text-[11px] font-black text-slate-400 uppercase tracking-widest text-center italic mb-8">Campaign Performance Trend</p>
         <div className="h-72 w-full">
            {!canAccess('dashboard', 'view_analytics') ? (
               <div className="h-full w-full flex flex-col items-center justify-center bg-[#FBFAF8] border border-dashed border-slate-100 rounded-sm p-4 text-center">
                  <AlertTriangle className="w-5 h-5 text-[#978C21] mb-1 animate-pulse" />
                  <p className="text-[10px] font-black text-slate-900 uppercase">Clearance Unauthorized</p>
                  <p className="text-[9px] text-slate-400 font-bold uppercase mt-0.5">Role credentials lack permissions to view visual analytical indexes.</p>
               </div>
            ) : (
               <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={trendData}>
                     <defs>
                       <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                         <stop offset="5%" stopColor="#978C21" stopOpacity={0.15}/>
                         <stop offset="95%" stopColor="#978C21" stopOpacity={0}/>
                       </linearGradient>
                     </defs>
                     <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f8fafc" />
                     <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#cbd5e1', fontWeight: 800, fontStyle: 'italic' }} dy={15} />
                     <YAxis hide />
                     <Tooltip 
                       contentStyle={{ borderRadius: '4px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)', fontSize: '10px', fontWeight: '900' }}
                     />
                     <Area type="monotone" dataKey="value" stroke="#978C21" strokeWidth={4} fillOpacity={1} fill="url(#colorValue)" dot={{ fill: '#978C21', strokeWidth: 3, r: 6, stroke: '#fff' }} />
                  </AreaChart>
               </ResponsiveContainer>
            )}
         </div>
         <p className="text-[10px] font-black text-slate-300 uppercase tracking-widest text-center italic mt-10">Daily Lead Generation Volume</p>
      </div>
      )}

      {/* Campaign Performance Breakdown */}
      {canAccess('dashboard', 'view_campaign_pie') && (
      <div className="bg-white rounded-sm border border-slate-100 shadow-sm mt-8 mx-1">
         <div className="px-8 py-6 flex items-center justify-between border-b border-slate-50">
            <div className="flex items-center gap-3">
               <div className="w-10 h-10 rounded bg-[#978C21]/5 flex items-center justify-center text-[#978C21]">
                  <Database className="w-5 h-5" />
               </div>
               <h4 className="text-brand-text text-[13px] font-black uppercase tracking-[0.2em] italic">Campaign Performance Intelligence</h4>
            </div>
            <div className="flex items-center gap-4">
               <div className="flex items-center gap-3 border border-slate-100 px-4 py-2 rounded bg-white cursor-pointer hover:bg-slate-50 transition-all shadow-sm">
                  <Filter className="w-4 h-4 text-slate-400" />
                  <span className="text-[10px] font-black text-brand-text uppercase tracking-widest">All Campaigns</span>
                  <ChevronRight className="w-4 h-4 text-slate-200" />
               </div>
            </div>
         </div>

         <div className="p-10 pb-16">
            <div className="flex flex-col lg:flex-row gap-20">
               <div className="flex-1">
                  <div>
                    <h2 className="text-6xl font-black text-brand-text tracking-tighter italic leading-none serif">All Campaigns</h2>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-4 italic">Period: May 1 - May 31, 2026</p>
                  </div>

                  <div className="mt-20 flex flex-col xl:flex-row items-center gap-16">
                     <div className="h-72 w-72 relative flex-shrink-0">
                        {!canAccess('dashboard', 'view_analytics') ? (
                           <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#FBFAF8] border border-dashed border-slate-100/80 rounded-sm p-4 text-center">
                              <AlertTriangle className="w-5 h-5 text-[#978C21] mb-1.5 animate-pulse" />
                              <p className="text-[10px] font-black text-slate-800 uppercase leading-none tracking-tight">Clearance Restricted</p>
                           </div>
                        ) : (
                           <>
                           <ResponsiveContainer width="100%" height="100%">
                           <PieChart>
                              <Pie
                                 data={campaignStats}
                                 cx="50%"
                                 cy="50%"
                                 innerRadius={95}
                                 outerRadius={125}
                                 paddingAngle={3}
                                 dataKey="value"
                              >
                                 {campaignStats.map((entry, index) => (
                                    <Cell key={`cell-${index}`} fill={entry.color} />
                                 ))}
                              </Pie>
                              <Tooltip />
                           </PieChart>
                        </ResponsiveContainer>
                        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                           <span className="text-5xl font-black italic tracking-tighter text-brand-text leading-none">{(stats.newLeads + stats.responses)}</span>
                           <span className="text-[10px] text-slate-400 uppercase font-black tracking-widest mt-2">TOTAL LEADS</span>
                        </div>
                        </>
                        )}
                     </div>

                     <div className="w-full max-w-xl">
                        <div className="flex justify-between border-b border-slate-100 pb-3 mb-6">
                           <p className="text-[11px] font-black text-slate-400 uppercase italic">Call Status</p>
                           <p className="text-[11px] font-black text-slate-400 uppercase italic">Total</p>
                        </div>
                        <div className="space-y-1.5 ">
                           {campaignStats.map((item, i) => (
                              <div key={i} className="flex items-center justify-between group cursor-pointer hover:bg-slate-50 px-3 py-1.5 rounded transition-all">
                                 <p className="text-[11px] font-bold text-slate-600 uppercase tracking-tight italic group-hover:text-primary">{item.name}</p>
                                 <p className="text-[13px] font-black text-brand-text italic">{item.value}</p>
                              </div>
                           ))}
                           <div className="flex items-center justify-between border-t border-slate-100 pt-6 mt-6">
                              <p className="text-[12px] font-black text-brand-text uppercase tracking-widest italic opacity-40">Grand Total</p>
                              <h5 className="text-[18px] font-black text-brand-text italic leading-none">{(stats.newLeads + stats.responses)}</h5>
                           </div>
                        </div>
                     </div>
                  </div>
               </div>
            </div>
         </div>
      </div>
      )}
        </>
      )}

      {/* Executive Performance Table */}
      {canAccess('dashboard', 'view_agent_table') && (
      <div className="bg-white rounded-sm border border-slate-100 shadow-sm mt-8 mx-1 overflow-hidden">
         <div className="bg-white px-10 py-10 border-b border-slate-50 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
            <div>
               <h4 className="text-[32px] font-black text-brand-text tracking-tighter italic leading-none serif">Executive Performance</h4>
               <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-3 ml-0.5">Agent Ranking & Efficiency Tracking</p>
            </div>
            <div className="flex items-center gap-4">
               <div 
                  onClick={() => {
                     setActivePopup('critical_alerts');
                     setPopupSearch('');
                  }}
                  className="px-6 py-2.5 border border-red-100 bg-red-50/30 rounded-sm flex items-center gap-3 shadow-sm hover:bg-red-50 cursor-pointer select-none"
               >
                  <Zap className="w-4 h-4 text-red-500 fill-red-500" />
                  <span className="text-[11px] font-black uppercase tracking-widest text-red-600 italic">{stats.alerts} Critical Alerts</span>
               </div>
            </div>
         </div>

         <div className="overflow-x-auto">
            <table className="w-full text-left">
               <thead className="bg-[#FBFAF8] text-[9px] font-black text-slate-500 uppercase tracking-widest border-b border-slate-100">
                  <tr>
                     <th className="px-10 py-8">Agent Name</th>
                     <th className="px-6 py-8 text-center">Assigned</th>
                     <th className="px-6 py-8 text-center">Total Assigned</th>
                     <th className="px-6 py-8 text-center text-brand-blue">No Call Yet</th>
                     <th className="px-6 py-8 text-center text-[#978C21]">Next Call Alert</th>
                     <th className="px-6 py-8 text-center">Total Follow Up</th>
                     <th className="px-6 py-8 text-center text-red-500">Follow-up Alert</th>
                     <th className="px-6 py-8 text-center">Converted</th>
                     <th className="px-6 py-8 text-center text-[#10B981]">Collected NCP</th>
                     <th className="px-6 py-8 text-center">Proj. NCP</th>
                     <th className="px-6 py-8 text-center">Conversion %</th>
                  </tr>
               </thead>
               <tbody className="divide-y divide-slate-50 italic">
                  {agentStats.map((row, i) => (
                     <tr key={i} className="hover:bg-slate-50 transition-colors group cursor-pointer">
                        <td className="px-10 py-6">
                          <div className="flex items-center gap-5">
                             <div className="w-10 h-10 rounded bg-[#978C21]/5 border border-[#978C21]/10 flex items-center justify-center text-[13px] font-black text-[#978C21] italic shadow-sm group-hover:bg-[#978C21] group-hover:text-white transition-all">
                                {String(row.name || 'U').charAt(0)}
                             </div>
                             <span className="text-[14px] font-black text-slate-600 uppercase tracking-tight italic group-hover:text-[#978C21] transition-colors">{row.name || 'Unknown Agent'}</span>
                          </div>
                        </td>
                        <td className="px-6 py-6 text-center text-[14px] font-black text-brand-text italic leading-none">{row.assigned}</td>
                        <td className="px-6 py-6 text-center text-[14px] font-black text-slate-500 italic leading-none">{row.total}</td>
                        <td className="px-6 py-6 text-center text-[14px] font-black text-brand-blue italic leading-none">{row.noCall}</td>
                        <td className="px-6 py-6 text-center text-[14px] font-black text-[#978C21] italic leading-none">{row.nextCall}</td>
                        <td className="px-6 py-6 text-center text-[14px] font-black text-slate-400 italic leading-none">{row.followUp}</td>
                        <td className="px-6 py-6 text-center text-[14px] font-black text-red-500 italic leading-none">{row.followUpAlert}</td>
                        <td className="px-6 py-6 text-center text-[14px] font-black text-slate-400 italic leading-none">{row.converted}</td>
                        <td className="px-6 py-6 text-center text-[14px] font-black text-[#10B981] italic leading-none">{row.collected}</td>
                        <td className="px-6 py-6 text-center text-[14px] font-black text-slate-500 italic leading-none">{row.projected}</td>
                        <td className="px-6 py-6 text-center text-[14px] font-black text-slate-400 italic leading-none">{row.conversion}</td>
                     </tr>
                  ))}
               </tbody>
            </table>
         </div>
         <div className="px-10 py-10 border-t border-slate-50 flex flex-col md:flex-row md:items-center justify-between gap-4">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] italic leading-none">Shanta Life Lead Console v2.0</p>
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest italic leading-none">Brand Compliance Secured • 13:18:00 GMT</p>
         </div>
      
        </div>
       )}

      {/* Dynamic Task Calendar embedded at Dashboard bottom if role permission is selected */}
      {canAccess('dashboard', 'view_task_calendar') && (
         <div className="bg-white rounded-sm border border-slate-100 shadow-sm mt-8 mx-1 p-8 overflow-hidden animate-in fade-in duration-300">
            <TaskCalendar embedded={true} />
         </div>
      )}
    </div>
  );
}
