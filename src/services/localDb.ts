  import { Lead, User, DropdownOption, UserRole, LeadStatus, SystemNotification } from '../types';
  import { MOCK_USERS, MOCK_DROPDOWNS } from '../mock/data';

  const KEYS = {
    LEADS: 'lf_local_leads',
    USERS: 'lf_local_users',
    OPTIONS: 'lf_local_options',
    NOTIFICATIONS: 'lf_local_notifications',
  };

  // Seed initial leads for beautiful visualization
  const SEED_LEADS: Lead[] = [];

  export const localDb = {
    // --- LEADS ---
    getLeads(): Lead[] {
      try {
        const data = localStorage.getItem(KEYS.LEADS);
        if (!data) {
          localStorage.setItem(KEYS.LEADS, JSON.stringify(SEED_LEADS));
          return SEED_LEADS;
        }
        let leads = JSON.parse(data);
        if (!Array.isArray(leads)) {
          throw new Error('Parsed leads data is not an array');
        }
        // Dynamic clean-up of original mock records from current local storage sessions
        const mockIds = ['lead_local_1', 'lead_local_2', 'lead_local_3', 'lead_local_4', 'lead_local_5'];
        if (leads.some(l => mockIds.includes(l.id))) {
          leads = leads.filter(l => !mockIds.includes(l.id));
          localStorage.setItem(KEYS.LEADS, JSON.stringify(leads));
        }
        return leads;
      } catch (e) {
        console.warn('Error reading or parsing leads from local storage, resetting to empty seed:', e);
        localStorage.setItem(KEYS.LEADS, JSON.stringify(SEED_LEADS));
        return SEED_LEADS;
      }
    },

    saveLeads(leads: Lead[]) {
      localStorage.setItem(KEYS.LEADS, JSON.stringify(leads));
    },

    getLead(id: string): Lead | null {
      return this.getLeads().find(l => l.id === id) || null;
    },

    createLead(leadData: Omit<Lead, 'id'> & { id?: string }): Lead {
      const leads = this.getLeads();
      const newLead: Lead = {
        ...leadData,
        id: leadData.id || `lead_local_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        timestamp: leadData.timestamp || new Date().toISOString()
      };
      leads.unshift(newLead);
      this.saveLeads(leads);
      try {
        const deleted = JSON.parse(localStorage.getItem('shanta_deleted_lead_ids') || '[]');
        const filtered = deleted.filter((id: string) => id !== newLead.id);
        localStorage.setItem('shanta_deleted_lead_ids', JSON.stringify(filtered));
      } catch (e) {}
      return newLead;
    },

    updateLead(leadId: string, data: Partial<Lead>): Lead | null {
      const leads = this.getLeads();
      const idx = leads.findIndex(l => l.id === leadId);
      if (idx === -1) return null;
      leads[idx] = { 
        ...leads[idx], 
        ...data,
        timestamp: new Date().toISOString()
      };
      this.saveLeads(leads);
      return leads[idx];
    },

    updateLeadStatus(
      leadId: string, 
      status: LeadStatus, 
      ncp?: number, 
      remarks?: string, 
      nextFollowUpDate?: string, 
      updatedBy?: string,
      nextCallDate?: string,
      meetingDate?: string,
      sumAssured?: number,
      productName?: string,
      projectedNCP?: number,
      lossReason?: string,
      meetingType?: string
    ): boolean {
      const lead = this.getLead(leadId);
      if (!lead) return false;

      const statusHistory = lead.statusHistory || [];
      const newEntry = {
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

      const updateData: Partial<Lead> = {
        currentStatus: status,
        lastFollowUpDate: new Date().toISOString(),
        statusHistory: [...statusHistory, newEntry]
      };
      if (ncp !== undefined) {
        updateData.collectedNCP = ncp;
      }
      if (nextFollowUpDate !== undefined) {
        updateData.nextFollowUpDate = nextFollowUpDate;
      }
      if (nextCallDate !== undefined) {
        updateData.nextCallDate = nextCallDate;
      }
      if (meetingDate !== undefined) {
        updateData.meetingDate = meetingDate;
      }
      if (sumAssured !== undefined) {
        updateData.sumAssured = sumAssured;
      }
      if (productName !== undefined) {
        updateData.productName = productName;
      }
      if (projectedNCP !== undefined) {
        updateData.projectedNCP = projectedNCP;
      }
      if (lossReason !== undefined) {
        updateData.lossReason = lossReason;
      }
      if (meetingType !== undefined) {
        updateData.meetingType = meetingType;
      }
      this.updateLead(leadId, updateData);
      return true;
    },

    bulkUploadLeads(leadList: Omit<Lead, 'id'>[]): Lead[] {
      const created: Lead[] = [];
      leadList.forEach(item => {
        created.push(this.createLead(item));
      });
      return created;
    },

    clearAllLeads() {
      this.saveLeads([]);
    },

    deleteLead(id: string): boolean {
      const leads = this.getLeads();
      const filtered = leads.filter(l => l.id !== id);
      if (filtered.length === leads.length) return false;
      this.saveLeads(filtered);
      try {
        const deleted = JSON.parse(localStorage.getItem('shanta_deleted_lead_ids') || '[]');
        if (!deleted.includes(id)) {
          deleted.push(id);
          localStorage.setItem('shanta_deleted_lead_ids', JSON.stringify(deleted));
        }
      } catch (e) {}
      return true;
    },

    deleteLeadsByCampaign(campaignName: string): number {
      const leads = this.getLeads();
      const keep = leads.filter(l => l.campaignName.toLowerCase().trim() !== campaignName.toLowerCase().trim());
      const deleted = leads.filter(l => l.campaignName.toLowerCase().trim() === campaignName.toLowerCase().trim());
      const deletedCount = leads.length - keep.length;
      this.saveLeads(keep);
      try {
        const deletedIds = JSON.parse(localStorage.getItem('shanta_deleted_lead_ids') || '[]');
        deleted.forEach(l => {
          if (!deletedIds.includes(l.id)) {
            deletedIds.push(l.id);
          }
        });
        localStorage.setItem('shanta_deleted_lead_ids', JSON.stringify(deletedIds));
      } catch (e) {}
      return deletedCount;
    },

    // --- USERS ---
    getUsers(): User[] {
      try {
        const data = localStorage.getItem(KEYS.USERS);
        if (!data) {
          const initialized = MOCK_USERS.map(u => ({ ...u }));
          localStorage.setItem(KEYS.USERS, JSON.stringify(initialized));
          return initialized;
        }
        let users = JSON.parse(data);
        if (!Array.isArray(users)) {
          throw new Error('Parsed users data is not an array');
        }
        let changed = false;

        // De-duplicate users by unique user ID to prevent key clashes (e.g. u1)
        const uniqueUsers: User[] = [];
        const seenIds = new Set<string>();
        for (const u of users) {
          if (u && u.id && !seenIds.has(u.id)) {
            seenIds.add(u.id);
            uniqueUsers.push(u);
          }
        }
        if (uniqueUsers.length !== users.length) {
          users = uniqueUsers;
          changed = true;
        }

        // Dynamic clean-up of original mock users from current local storage sessions
        const originalMockUserIds = ['u_bm1', 'u2', 'u_rm2', 'u3', 'u_ro2', 'u_ro3', 'u_ro4'];
        if (users.some(u => originalMockUserIds.includes(u.id))) {
          users = users.filter(u => !originalMockUserIds.includes(u.id));
          changed = true;
        }
        // Auto-restore any missing mock users from the template configuration to prevent cross-browser login failure
        for (const mock of MOCK_USERS) {
          if (!users.some(u => u.employeeId === mock.employeeId)) {
            users.push({ ...mock });
            changed = true;
          }
        }
        // NOTE: previously this forcibly assigned a hardcoded fallback
        // password ('shanta123') to any user missing one, which meant a
        // fixed, guessable password worked for every account. Real
        // authentication is verified server-side against a bcrypt hash
        // (see POST /api/auth/login) - the client no longer needs, and
        // must not fabricate, password values.
        if (changed) {
          localStorage.setItem(KEYS.USERS, JSON.stringify(users));
        }
        return users;
      } catch (e) {
        console.warn('Error reading or parsing users from local storage, resetting to default:', e);
        const initialized = MOCK_USERS.map(u => ({ ...u }));
        localStorage.setItem(KEYS.USERS, JSON.stringify(initialized));
        return initialized;
      }
    },

    saveUsers(users: User[]) {
      localStorage.setItem(KEYS.USERS, JSON.stringify(users));
    },

    getUser(id: string): User | null {
      return this.getUsers().find(u => u.id === id || u.employeeId === id) || null;
    },

    getUserByEmail(email: string): User | null {
      return this.getUsers().find(u => u.email.toLowerCase() === email.toLowerCase()) || null;
    },

    createUser(user: User): User {
      const users = this.getUsers();
      const existingIdx = users.findIndex(u => u.id === user.id || (u.employeeId && u.employeeId.toUpperCase() === user.employeeId?.toUpperCase()));
      if (existingIdx > -1) {
        users[existingIdx] = user;
      } else {
        users.push(user);
      }
      this.saveUsers(users);
      try {
        const deleted = JSON.parse(localStorage.getItem('shanta_deleted_user_ids') || '[]');
        const filtered = deleted.filter((id: string) => id !== user.id);
        localStorage.setItem('shanta_deleted_user_ids', JSON.stringify(filtered));
      } catch (e) {}
      return user;
    },

    updateUser(id: string, data: Partial<User>): User | null {
      const users = this.getUsers();
      const idx = users.findIndex(u => u.id === id);
      if (idx === -1) return null;
      users[idx] = { ...users[idx], ...data };
      this.saveUsers(users);
      return users[idx];
    },

    deleteUser(id: string) {
      const users = this.getUsers().filter(u => u.id !== id);
      this.saveUsers(users);
      try {
        const deleted = JSON.parse(localStorage.getItem('shanta_deleted_user_ids') || '[]');
        if (!deleted.includes(id)) {
          deleted.push(id);
          localStorage.setItem('shanta_deleted_user_ids', JSON.stringify(deleted));
        }
      } catch (e) {}
    },

    // --- OPTIONS ---
    getOptions(): DropdownOption[] {
      const makeDefaultOpts = () => {
        const generated: DropdownOption[] = [];
        Object.entries(MOCK_DROPDOWNS).forEach(([type, values]) => {
          values.forEach(value => {
            generated.push({
              type: type as any,
              value,
              status: 'Active'
            });
          });
        });
        localStorage.setItem(KEYS.OPTIONS, JSON.stringify(generated));
        return generated;
      };
      try {
        const data = localStorage.getItem(KEYS.OPTIONS);
        if (!data) {
          return makeDefaultOpts();
        }
        const parsed = JSON.parse(data);
        if (!Array.isArray(parsed)) {
          throw new Error('Parsed options data is not an array');
        }
        return parsed;
      } catch (e) {
        console.warn('Error reading or parsing options from local storage, resetting to default:', e);
        return makeDefaultOpts();
      }
    },

    saveOptions(opts: DropdownOption[]) {
      localStorage.setItem(KEYS.OPTIONS, JSON.stringify(opts));
    },

    getOptionsByType(type: string): string[] {
      return this.getOptions()
        .filter(o => o.type === type && o.status === 'Active')
        .map(o => o.value);
    },

    addOption(type: string, value: string) {
      const opts = this.getOptions();
      if (!opts.some(o => o.type === type && o.value === value)) {
        opts.push({
          type: type as any,
          value,
          status: 'Active'
        });
        this.saveOptions(opts);
        const id = `${type}_${value.trim().replace(/\s+/g, '_')}`;
        try {
          const deleted = JSON.parse(localStorage.getItem('shanta_deleted_option_ids') || '[]');
          const filtered = deleted.filter((item: string) => item !== id);
          localStorage.setItem('shanta_deleted_option_ids', JSON.stringify(filtered));
        } catch (e) {}
      }
    },

    deleteOption(type: string, value: string) {
      const opts = this.getOptions().filter(o => !(o.type === type && o.value === value));
      this.saveOptions(opts);
      const id = `${type}_${value.trim().replace(/\s+/g, '_')}`;
      try {
        const deleted = JSON.parse(localStorage.getItem('shanta_deleted_option_ids') || '[]');
        if (!deleted.includes(id)) {
          deleted.push(id);
          localStorage.setItem('shanta_deleted_option_ids', JSON.stringify(deleted));
        }
      } catch (e) {}
    },

    // --- NOTIFICATIONS ---
    getNotifications(userId: string): SystemNotification[] {
      try {
        const data = localStorage.getItem(KEYS.NOTIFICATIONS);
        if (!data) return [];
        const parsed = JSON.parse(data);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(n => n.userId === userId);
      } catch (e) {
        console.warn('Error reading or parsing notifications from local storage:', e);
        return [];
      }
    },

    createNotification(userId: string, title: string, message: string, leadId: string): SystemNotification {
      let list: SystemNotification[] = [];
      try {
        const data = localStorage.getItem(KEYS.NOTIFICATIONS);
        const parsed = data ? JSON.parse(data) : [];
        if (Array.isArray(parsed)) {
          list = parsed;
        }
      } catch (e) {
        console.warn('Error reading or parsing notifications from local storage inside createNotification:', e);
      }
      const newNotif: SystemNotification = {
        id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        userId,
        title,
        message,
        leadId,
        read: false,
        date: new Date().toISOString()
      };
      list.unshift(newNotif);
      try {
        localStorage.setItem(KEYS.NOTIFICATIONS, JSON.stringify(list));
      } catch (e) {
        console.warn('Failed to save notification:', e);
      }
      return newNotif;
    },

    markNotificationAsRead(id: string): boolean {
      try {
        const data = localStorage.getItem(KEYS.NOTIFICATIONS);
        if (!data) return false;
        const list = JSON.parse(data);
        if (!Array.isArray(list)) return false;
        const idx = list.findIndex(n => n.id === id);
        if (idx === -1) return false;
        list[idx].read = true;
        localStorage.setItem(KEYS.NOTIFICATIONS, JSON.stringify(list));
        return true;
      } catch (e) {
        console.warn('Error marking notification as read in local storage:', e);
        return false;
      }
    },

    markAllNotificationsAsRead(userId: string): boolean {
      try {
        const data = localStorage.getItem(KEYS.NOTIFICATIONS);
        if (!data) return false;
        let list = JSON.parse(data);
        if (!Array.isArray(list)) return false;
        list = list.map(n => n.userId === userId ? { ...n, read: true } : n);
        localStorage.setItem(KEYS.NOTIFICATIONS, JSON.stringify(list));
        return true;
      } catch (e) {
        console.warn('Error marking all notifications as read in local storage:', e);
        return false;
      }
    },

    deleteAllNotifications(userId: string): boolean {
      try {
        const data = localStorage.getItem(KEYS.NOTIFICATIONS);
        if (!data) return false;
        let list = JSON.parse(data);
        if (!Array.isArray(list)) return false;
        list = list.filter(n => n.userId !== userId);
        localStorage.setItem(KEYS.NOTIFICATIONS, JSON.stringify(list));
        return true;
      } catch (e) {
        console.warn('Error deleting all notifications in local storage:', e);
        return false;
      }
    }
  };
