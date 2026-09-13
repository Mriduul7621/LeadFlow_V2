import {
  Lead,
  LeadStatus,
  StatusHistoryEntry,
  SystemNotification,
  User,
} from '../modules/shared/types';

/**
 * localDb.ts
 * ------------------------------------------------------------------
 * Browser-side READ CACHE for the API-backed services. It is NEVER an
 * authority: every business mutation goes to the API first and only a
 * server-confirmed commit touches these caches.
 *
 * CROSS-USER ISOLATION (security hardening):
 *   Business-data caches (leads, users directory, notifications) are
 *   keyed PER AUTHENTICATED USER: `<base>:<userId>`. Consequences:
 *     - after User A logs out and User B logs in on the same browser,
 *       B can never fall back to leads/notifications A previously
 *       viewed — B's scope starts empty until B's own API reads land;
 *     - an offline read (network/5xx fallback) can only ever surface
 *       data the CURRENT user was previously authorized to see;
 *     - the signing-out user's caches are deleted on logout (see
 *       authStore.logout -> clearUserCaches), so nothing user-scoped
 *       survives the session at all.
 *   When no authenticated user is resolvable, reads return the empty
 *   fallback and writes are no-ops: business data is never persisted
 *   (or read) in an unscoped, shared form.
 *
 *   `shanta_options` is deliberately NOT user-scoped: option lists are
 *   org-wide reference data returned identically to every authenticated
 *   user (no per-user secrets), so scoping would only duplicate bytes.
 *
 * Pre-hardening builds wrote business data under the unscoped global
 * keys (`shanta_leads`, `shanta_users`, `shanta_notifications`).
 * `clearLegacyGlobalCaches()` removes those on logout so a multi-user
 * browser can never read another user's previously cached business
 * data.
 */

const keys = {
  users: 'shanta_users',
  leads: 'shanta_leads',
  options: 'shanta_options',
  notifications: 'shanta_notifications',
};

/**
 * Resolves the currently authenticated user id (null when logged out).
 * Registered by the auth store (one-way dependency: authStore ->
 * localDb, so this module never imports the store — no cycles).
 */
let resolveCurrentUserId: () => string | null = () => null;

export function setLocalDbUserIdProvider(fn: () => string | null): void {
  resolveCurrentUserId = fn;
}

function sanitizeId(value: string): string {
  return String(value).replace(/[^A-Za-z0-9_-]/g, '');
}

/** Per-user key, or null when no authenticated user can be resolved. */
function scopedKey(base: string): string | null {
  const uid = resolveCurrentUserId();
  if (!uid) return null;
  return `${base}:${sanitizeId(uid)}`;
}

/** User-scoped read: unscoped (logged-out) state always gets the fallback. */
function read<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function readScoped<T>(base: string, fallback: T): T {
  const key = scopedKey(base);
  if (!key) return fallback;
  return read<T>(key, fallback);
}

/** User-scoped write: never persists business data unscoped. */
function write(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

function writeScoped(base: string, value: unknown): void {
  const key = scopedKey(base);
  if (!key) return;
  write(key, value);
}

/** Delete the signing-out user's business-data caches (logout hook). */
export function clearUserCaches(userId: string | null | undefined): void {
  if (!userId) return;
  const safe = sanitizeId(String(userId));
  if (!safe) return;
  for (const base of [keys.users, keys.leads, keys.notifications]) {
    try {
      localStorage.removeItem(`${base}:${safe}`);
    } catch {
      // storage may be unavailable; nothing to clear
    }
  }
}

/**
 * Delete the pre-hardening UNSCOPEd global business keys. Called on
 * logout so data cached by older builds can never cross into a new
 * user's offline fallback.
 */
export function clearLegacyGlobalCaches(): void {
  for (const base of [keys.users, keys.leads, keys.notifications]) {
    try {
      localStorage.removeItem(base);
    } catch {
      // ignore
    }
  }
}

export const localDb = {
  getUsers(): User[] { return readScoped<User[]>(keys.users, []); },
  saveUsers(users: User[]): void { writeScoped(keys.users, users); },
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

  getLeads(): Lead[] { return readScoped<Lead[]>(keys.leads, []); },
  saveLeads(leads: Lead[]): void { writeScoped(keys.leads, leads); },
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

  // Org-wide reference data: NOT user-scoped (see module header).
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
    // User-scoped cache: entries always belong to the current user;
    // the userId filter is kept as defense in depth.
    return readScoped<SystemNotification[]>(keys.notifications, []).filter(notification => notification.userId === userId);
  },
  /** Persist the current user's full cached notification slice. */
  saveNotifications(notifications: SystemNotification[]): void {
    writeScoped(keys.notifications, notifications);
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
    this.saveNotifications([...readScoped<SystemNotification[]>(keys.notifications, []), notification]);
    return notification;
  },
  markNotificationAsRead(id: string): boolean {
    const notifications = readScoped<SystemNotification[]>(keys.notifications, []);
    const notification = notifications.find(item => item.id === id);
    if (!notification) return false;
    notification.read = true;
    this.saveNotifications(notifications);
    return true;
  },
  markAllNotificationsAsRead(userId: string): boolean {
    const notifications = readScoped<SystemNotification[]>(keys.notifications, []);
    notifications.forEach(notification => {
      if (notification.userId === userId) notification.read = true;
    });
    this.saveNotifications(notifications);
    return true;
  },
  deleteAllNotifications(userId: string): boolean {
    this.saveNotifications(
      readScoped<SystemNotification[]>(keys.notifications, []).filter(notification => notification.userId !== userId)
    );
    return true;
  },
};
