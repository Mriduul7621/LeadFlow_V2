import {
  Lead,
  LeadStatus,
  StatusHistoryEntry,
  SystemNotification,
  User,
} from '../modules/shared/types';

const keys = {
  users: 'shanta_users',
  leads: 'shanta_leads',
  options: 'shanta_options',
  notifications: 'shanta_notifications',
};

function read<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

function write<T>(key: string, value: T): void {
  localStorage.setItem(key, JSON.stringify(value));
}

export const localDb = {
  getUsers(): User[] { return read<User[]>(keys.users, []); },
  saveUsers(users: User[]): void { write(keys.users, users); },
  getUser(id: string): User | null {
    return this.getUsers().find(user => user.id === id || user.employeeId === id) || null;
  },
  getUserByEmail(email: string): User | null {
    return this.getUsers().find(user => user.email.toLowerCase() === email.toLowerCase()) || null;
  },
  createUser(user: User): User {
    const users = this.getUsers().filter(existing => existing.id !== user.id);
    users.push(user);
    this.saveUsers(users);
    return user;
  },
  updateUser(id: string, data: Partial<User>): boolean {
    const users = this.getUsers();
    const index = users.findIndex(user => user.id === id || user.employeeId === id);
    if (index < 0) return false;
    users[index] = { ...users[index], ...data };
    this.saveUsers(users);
    return true;
  },
  deleteUser(id: string): boolean {
    const users = this.getUsers();
    const next = users.filter(user => user.id !== id && user.employeeId !== id);
    this.saveUsers(next);
    return next.length !== users.length;
  },

  getLeads(): Lead[] { return read<Lead[]>(keys.leads, []); },
  saveLeads(leads: Lead[]): void { write(keys.leads, leads); },
  getLead(id: string): Lead | null { return this.getLeads().find(lead => lead.id === id) || null; },
  createLead(lead: Lead): Lead {
    this.saveLeads([...this.getLeads().filter(existing => existing.id !== lead.id), lead]);
    return lead;
  },
  bulkUploadLeads(leads: Lead[]): void { this.saveLeads([...this.getLeads(), ...leads]); },
  clearAllLeads(): void { this.saveLeads([]); },
  updateLead(id: string, fields: Partial<Lead>): boolean {
    const leads = this.getLeads();
    const index = leads.findIndex(lead => lead.id === id);
    if (index < 0) return false;
    leads[index] = { ...leads[index], ...fields, timestamp: new Date().toISOString() };
    this.saveLeads(leads);
    return true;
  },
  updateLeadStatus(
    id: string,
    status: LeadStatus,
    collectedNCP?: number,
    remarks?: string,
    nextFollowUpDate?: string,
    updatedBy?: string,
    nextCallDate?: string,
    meetingDate?: string,
    sumAssured?: number,
    productName?: string,
    projectedNCP?: number,
    lossReason?: string,
    meetingType?: string,
  ): boolean {
    const lead = this.getLead(id);
    if (!lead) return false;
    const history: StatusHistoryEntry = {
      status,
      date: new Date().toISOString(),
      remarks: remarks || '',
      nextFollowUpDate,
      nextCallDate,
      meetingDate,
      sumAssured,
      productName,
      updatedBy,
      lossReason,
      meetingType,
    };
    return this.updateLead(id, {
      currentStatus: status,
      collectedNCP,
      nextFollowUpDate,
      nextCallDate,
      meetingDate,
      sumAssured,
      productName,
      projectedNCP,
      lossReason,
      meetingType,
      statusHistory: [...(lead.statusHistory || []), history],
    });
  },
  deleteLead(id: string): boolean {
    const leads = this.getLeads();
    this.saveLeads(leads.filter(lead => lead.id !== id));
    return leads.length !== this.getLeads().length;
  },
  deleteLeadsByCampaign(campaignName: string): void {
    this.saveLeads(this.getLeads().filter(lead => lead.campaignName !== campaignName));
  },

  getOptionsByType(type: string): string[] {
    return read<Record<string, string[]>>(keys.options, {})[type] || [];
  },
  addOption(type: string, value: string): void {
    const options = read<Record<string, string[]>>(keys.options, {});
    options[type] = Array.from(new Set([...(options[type] || []), value]));
    write(keys.options, options);
  },
  deleteOption(type: string, value: string): void {
    const options = read<Record<string, string[]>>(keys.options, {});
    options[type] = (options[type] || []).filter(option => option !== value);
    write(keys.options, options);
  },

  getNotifications(userId: string): SystemNotification[] {
    return read<SystemNotification[]>(keys.notifications, []).filter(notification => notification.userId === userId);
  },
  createNotification(userId: string, title: string, message: string, leadId: string): SystemNotification {
    const notification: SystemNotification = {
      id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      userId,
      title,
      message,
      leadId,
      read: false,
      date: new Date().toISOString(),
    };
    write(keys.notifications, [...read<SystemNotification[]>(keys.notifications, []), notification]);
    return notification;
  },
  markNotificationAsRead(id: string): boolean {
    const notifications = read<SystemNotification[]>(keys.notifications, []);
    const notification = notifications.find(item => item.id === id);
    if (!notification) return false;
    notification.read = true;
    write(keys.notifications, notifications);
    return true;
  },
  markAllNotificationsAsRead(userId: string): boolean {
    const notifications = read<SystemNotification[]>(keys.notifications, []);
    notifications.forEach(notification => {
      if (notification.userId === userId) notification.read = true;
    });
    write(keys.notifications, notifications);
    return true;
  },
  deleteAllNotifications(userId: string): boolean {
    const notifications = read<SystemNotification[]>(keys.notifications, []);
    write(keys.notifications, notifications.filter(notification => notification.userId !== userId));
    return true;
  },
};
