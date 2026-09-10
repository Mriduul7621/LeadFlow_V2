export type RoleName = 'ADMIN' | 'BH' | 'BDM' | 'RM' | 'RO' | 'ASM' | string;

export interface FallbackUser {
  id: string;
  employeeId: string;
  fullName: string;
  name: string;
  email: string;
  phone?: string;
  role: RoleName;
  roleCode?: string;
  roleName?: string;
  status: 'Active' | 'Inactive';
  accountStatus?: string;
  isActive?: boolean;
  designation?: string;
  departmentId?: string;
  teamId?: string;
  managerId?: string;
  reportingManagerId?: string;
  avatarUrl?: string;
  createdDate?: string;
  updatedAt?: string;
  password?: string;
  mustChangePassword?: boolean;
  reportingChain?: string[];
  subordinates?: string[];
}

export interface FallbackLead {
  id: string;
  creationDate?: string;
  prospectName: string;
  mobile: string;
  email?: string;
  profession: string;
  area: string;
  division?: string;
  district?: string;
  thana?: string;
  source: string;
  productName?: string;
  campaignName?: string;
  familyMember?: string;
  maritalStatus?: string;
  assignedTo: string;
  assignedBy?: string;
  currentStatus: string;
  projectedNCP: number;
  collectedNCP: number;
  lastFollowUpDate?: string;
  nextFollowUpDate?: string;
  nextCallDate?: string;
  meetingDate?: string;
  sumAssured?: number;
  timestamp: string;
  statusHistory?: Array<Record<string, any>>;
  assignmentHistory?: Array<Record<string, any>>;
  documents?: Array<Record<string, any>>;
  [key: string]: any;
}

export interface FallbackNotification {
  id: string;
  userId: string;
  title: string;
  message: string;
  leadId?: string;
  read: boolean;
  date: string;
}

export interface FallbackMetadataType {
  key: string;
  label: string;
  description?: string;
  isSystem: boolean;
  sortOrder: number;
}

export interface FallbackOption {
  id?: string;
  type: string;
  value: string;
  label?: string;
  status: 'Active' | 'Inactive';
  sortOrder?: number;
  meta?: Record<string, any>;
  createdDate?: string;
}

export interface FallbackWorkflowRule {
  id: string;
  status: string;
  allowedNextStatuses: string[] | null;
  requiresLossReason: boolean;
  requiresMeetingType: boolean;
  requiresFollowUpType: boolean;
  requiresNote: boolean;
  isSystem: boolean;
  createdDate?: string;
}


export interface FallbackLeadActivity {
  id: string;
  leadId: string;
  lead_id?: string;
  activityType: string;
  activity_type?: string;
  status?: string;
  remarks?: string;
  nextFollowUpAt?: string | null;
  next_follow_up_at?: string | null;
  nextCallAt?: string | null;
  next_call_at?: string | null;
  meetingAt?: string | null;
  meeting_at?: string | null;
  meetingType?: string | null;
  meeting_type?: string | null;
  collectedNcp?: number | null;
  collected_ncp?: number | null;
  projectedNcp?: number | null;
  projected_ncp?: number | null;
  sumAssured?: number | null;
  sum_assured?: number | null;
  productName?: string | null;
  product_name?: string | null;
  lossReason?: string | null;
  loss_reason?: string | null;
  createdBy?: string | null;
  created_by?: string | null;
  createdAt: string;
  created_at?: string;
}

export interface FallbackScheduledActivity {
  id: string;
  leadId: string;
  lead_id?: string;
  activityType: string;
  activity_type?: string;
  title?: string | null;
  scheduledAt: string;
  scheduled_at?: string;
  durationMinutes?: number | null;
  duration_minutes?: number | null;
  remarks?: string | null;
  status: string;
  priority?: string | null;
  meetingType?: string | null;
  meeting_type?: string | null;
  location?: string | null;
  createdBy?: string | null;
  created_by?: string | null;
  assignedTo?: string | null;
  assigned_to?: string | null;
  updatedBy?: string | null;
  updated_by?: string | null;
  createdAt: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
  completedAt?: string | null;
  completed_at?: string | null;
  completedBy?: string | null;
  completed_by?: string | null;
  completedActivityId?: string | null;
  completed_activity_id?: string | null;
}

export const fallbackStore = {
  users: [] as FallbackUser[],
  leads: [] as FallbackLead[],
  notifications: [] as FallbackNotification[],
  metadataTypes: [
    { key: 'lead_status', label: 'Lead Status', description: 'Standard lifecycle states', isSystem: true, sortOrder: 1 },
    { key: 'occupation', label: 'Occupation', description: 'Customer occupation list', isSystem: true, sortOrder: 2 },
    { key: 'source', label: 'Lead Source', description: 'Lead capture channels', isSystem: true, sortOrder: 3 },
    { key: 'product', label: 'Product', description: 'Insurance product catalog', isSystem: true, sortOrder: 4 },
    { key: 'campaign', label: 'Campaign', description: 'Campaign list', isSystem: true, sortOrder: 5 },
    { key: 'meeting_type', label: 'Meeting Type', description: 'Meeting modes and categories', isSystem: true, sortOrder: 6 },
    { key: 'loss_reason', label: 'Loss Reason', description: 'Lead loss categories', isSystem: true, sortOrder: 7 },
    { key: 'follow_up_type', label: 'Follow-up Type', description: 'Follow-up categories', isSystem: true, sortOrder: 8 },
  ] as FallbackMetadataType[],
  options: [
    { id: 'status_untouched', type: 'lead_status', value: 'Untouched', label: 'Untouched', status: 'Active', sortOrder: 1 },
    { id: 'status_contacted', type: 'lead_status', value: 'Contacted', label: 'Contacted', status: 'Active', sortOrder: 2 },
    { id: 'status_no_response', type: 'lead_status', value: 'No Response', label: 'No Response', status: 'Active', sortOrder: 3 },
    { id: 'status_busy', type: 'lead_status', value: 'Busy', label: 'Busy', status: 'Active', sortOrder: 4 },
    { id: 'status_interested', type: 'lead_status', value: 'Interested', label: 'Interested', status: 'Active', sortOrder: 5 },
    { id: 'status_follow_up_set', type: 'lead_status', value: 'Follow-up Set', label: 'Follow-up Set', status: 'Active', sortOrder: 6 },
    { id: 'status_meeting_fixed', type: 'lead_status', value: 'Meeting Fixed', label: 'Meeting Fixed', status: 'Active', sortOrder: 7 },
    { id: 'status_meeting_completed', type: 'lead_status', value: 'Meeting Completed', label: 'Meeting Completed', status: 'Active', sortOrder: 8 },
    { id: 'status_pipeline_locked', type: 'lead_status', value: 'Pipeline Locked', label: 'Pipeline Locked', status: 'Active', sortOrder: 9 },
    { id: 'status_converted', type: 'lead_status', value: 'Converted', label: 'Converted', status: 'Active', sortOrder: 10 },
    { id: 'status_not_interested', type: 'lead_status', value: 'Not Interested', label: 'Not Interested', status: 'Active', sortOrder: 11 },
  ] as FallbackOption[],
  workflowRules: [] as FallbackWorkflowRule[],
  leadActivities: [] as FallbackLeadActivity[],
  scheduledActivities: [] as FallbackScheduledActivity[],
};

export function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
