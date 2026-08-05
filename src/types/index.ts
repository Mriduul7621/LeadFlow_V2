export enum UserRole {
  RO = 'RO',
  RM = 'RM',
  ASM = 'ASM',
  BDM = 'BDM',
  BUSINESS_EXECUTIVE = 'BE',
  BUSINESS_HEAD = 'BH',
  ADMIN = 'ADMIN',
}

// LeadStatus used to be a hardcoded fixed union - it is now admin
// configurable via the Metadata Engine (type key: 'lead_status'), so the
// type is loosened to `string`. DEFAULT_LEAD_STATUSES below is only the
// seed list used the very first time a database is initialized (see
// server/db.ts) - the actual source of truth at runtime is the
// `options` table (type='lead_status'), fetched through metadataService.
export type LeadStatus = string;

export const DEFAULT_LEAD_STATUSES = [
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
  'Not Interested',
] as const;

export interface User {
  // Identity
  id: string;
  employeeId: string;

  // Legacy fields (Keep for existing code)
  name: string;
  contact?: string;
  role: UserRole | string;
  status: 'Active' | 'Inactive';
  createdDate: string;
  departmentId?: string;
  managerId?: string;
  teamId?: string;
  reportingChain?: string[];
  subordinates?: string[];

  // Enterprise fields
  fullName?: string;
  email: string;
  phone?: string;

  designation?: string;

  employmentStatus?: 'Active' | 'Inactive';
  joiningDate?: string;

  primaryDepartmentId?: string;
  departmentIds?: string[];

  primaryRoleId?: string;
  roleIds?: string[];

  reportingManagerId?: string;

  password?: string;
  mustChangePassword?: boolean;
  avatarUrl?: string;

  createdAt?: string;
  updatedAt?: string;
}

/**
 * RolePermission - defines the full access-control profile attached to a role
 * (e.g. ADMIN, BH, BDM, RO...). This drives both menu visibility and the
 * data-visibility scope ("Own" | "DownTeam" | "FullTeam" | "Organization")
 * used to restrict which employees'/leads' data a user can see.
 */
export type DataVisibilityScope = 'Own' | 'DownTeam' | 'FullTeam' | 'Organization';

export interface RolePermission {
  roleId: string;
  roleName: string;
  isCustom?: boolean;
  // Route -> allowed
  menuAccess?: Record<string, boolean>;
  // Coarse-grained scope of data (leads/users/reports) this role may see
  dataVisibility?: DataVisibilityScope;
  // Coarse-grained CRUD actions allowed globally
  actions?: {
    view?: boolean;
    create?: boolean;
    edit?: boolean;
    delete?: boolean;
    approve?: boolean;
    upload?: boolean;
  };
  // Fine-grained per-feature permission matrix, e.g.
  // { dashboard: { view: true, ... }, user_management: { user_create: true, ... } }
  featurePermissions?: Record<string, Record<string, boolean>>;
}

export interface Permissions {
  id: string; // coincided with roleId
  roleId: string;
  roleName: string;
  modules: Record<string, {
    view: boolean;
    create: boolean;
    edit: boolean;
    delete: boolean;
    upload: boolean;
  }>;
}

export interface Team {
  id: string;
  name: string;
  leaderId: string; // Employee ID of manager/leader
  memberIds: string[]; // List of Employee IDs assigned
  createdDate: string;
}

export interface StatusHistoryEntry {
  status: LeadStatus;
  date: string;
  remarks: string;
  nextFollowUpDate?: string;
  nextCallDate?: string;
  meetingDate?: string;
  sumAssured?: number;
  productName?: string;
  updatedBy?: string;
  lossReason?: string;
  meetingType?: string;
}

export interface AssignmentHistoryEntry {
  id: string;
  fromEmployeeId?: string;
  toEmployeeId: string;
  changedBy?: string;
  date: string;
  note?: string;
}

export interface LeadDocument {
  id: string;
  name: string;
  note?: string;
  uploadedBy?: string;
  date: string;
}

export interface Lead {
  id: string;
  creationDate: string;
  assignedDate?: string;
  prospectName: string;
  mobile: string;
  mobileNumber?: string;
  email?: string;
  profession: string;
  residenceAddress?: string;
  officeAddress?: string;
  familyMember: string;
  maritalStatus: string;
  hasChild: boolean;
  noOfChildren?: string;
  area: string;
  division?: string;
  district?: string;
  thana?: string;
  source: string;
  productName: string;
  campaignName: string;
  otherInfo?: string;
  assignedTo: string; // Employee ID
  assignedBy?: string; // Employee ID
  currentStatus: LeadStatus;
  projectedNCP: number;
  collectedNCP: number;
  lastFollowUpDate?: string;
  nextFollowUpDate?: string;
  nextCallDate?: string;
  meetingDate?: string;
  sumAssured?: number;
  timestamp: string;
  statusHistory?: StatusHistoryEntry[];
  // New Metadata Engine fields (Phase 1) - all admin-configurable via
  // the Settings > Metadata Manager screen (type keys: Occupation,
  // Priority, MeetingType, LossReason, FollowUpType).
  occupation?: string;
  priority?: string;
  meetingType?: string;
  lossReason?: string;
  followUpType?: string;
  // Values for any admin-added custom field (Dynamic Form Builder - Phase 2),
  // keyed by the field's fieldKey.
  customFields?: Record<string, string>;
  // Lead Timeline (Phase 4)
  assignmentHistory?: AssignmentHistoryEntry[];
  documents?: LeadDocument[];
}

export interface FollowUp {
  id: string;
  leadId: string;
  count: number;
  status: LeadStatus;
  remarks: string;
  firstCallDate?: string;
  nextFollowUpDate?: string;
  finalRemarks?: string;
  projectedNCP: number;
  collectedNCP: number;
  updatedBy: string;
  updatedDate: string;
}

export interface Campaign {
  id: string;
  name: string;
  status: 'Active' | 'Inactive';
}

export interface DropdownOption {
  id?: string;
  type: string;
  value: string;
  label?: string;
  status: 'Active' | 'Inactive';
  sortOrder?: number;
  meta?: Record<string, any>;
  createdDate?: string;
}

export interface MetadataType {
  key: string;
  label: string;
  description?: string;
  isSystem: boolean;
  sortOrder: number;
}

export type FormFieldType = 'text' | 'number' | 'dropdown' | 'date' | 'textarea' | 'checkbox';

export interface FormField {
  id: string;
  fieldKey: string;
  label: string;
  fieldType: FormFieldType;
  section: string;
  isMandatory: boolean;
  isVisible: boolean;
  sortOrder: number;
  metadataTypeKey?: string | null;
  placeholder?: string;
  isSystem: boolean;
  createdDate?: string;
}

export interface WorkflowRule {
  id: string;
  status: string;
  allowedNextStatuses: string[] | null; // null = any status allowed (unrestricted)
  requiresLossReason: boolean;
  requiresMeetingType: boolean;
  requiresFollowUpType: boolean;
  requiresNote: boolean;
  isSystem: boolean;
  createdDate?: string;
}

export interface SystemNotification {
  id: string;
  userId: string; // Employee ID
  title: string;
  message: string;
  leadId: string;
  read: boolean;
  date: string;
}

