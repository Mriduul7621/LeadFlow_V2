import { SystemNotification } from '../../shared/types';
import { localDb } from '../../../services/localDb';

export const notificationService = {
  async getNotifications(user_Id: string): Promise<SystemNotification[]> {
    try {
      const res = await fetch(`/api/notifications/users/${user_Id}`);
      if (res.ok) {
        const cloudNotifs: SystemNotification[] = await res.json();
        
        // Sync local caches
        cloudNotifs.forEach(cn => {
          const lNotifs = localDb.getNotifications(user_Id);
          if (!lNotifs.some(ln => ln.id === cn.id)) {
            // Write to local cache
            localStorage.setItem('shanta_notifications', JSON.stringify([...lNotifs, cn]));
          }
        });

        return cloudNotifs.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      }
    } catch (e) {
      console.warn("Failed PostgreSQL notifications query, falling back to local storage cache", e);
    }
    return localDb.getNotifications(user_Id);
  },

  async getNotificationsForLead(leadId: string): Promise<SystemNotification[]> {
    try {
      const res = await fetch(`/api/notifications/leads/${leadId}`);
      if (res.ok) {
        const notifs: SystemNotification[] = await res.json();
        return notifs.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      }
    } catch (e) {
      console.warn('Failed to fetch notification history for lead:', e);
    }
    return [];
  },

  async createNotification(user_Id: string, title: string, message: string, leadId: string): Promise<SystemNotification> {
    const localNotif = localDb.createNotification(user_Id, title, message, leadId);
    const id = `notif_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    
    const payload: SystemNotification = {
      id,
      userId: user_Id,
      title,
      message,
      leadId,
      read: false,
      date: new Date().toISOString()
    };

    try {
      await fetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      return payload;
    } catch (e) {
      console.error("Failed to write notification to PostgreSQL", e);
      return localNotif;
    }
  },

  async markNotificationAsRead(id: string): Promise<boolean> {
    const localOk = localDb.markNotificationAsRead(id);
    try {
      await fetch(`/api/notifications/${id}/read`, {
        method: 'POST'
      });
      return true;
    } catch (e) {
      console.error("Failed to mark read in PostgreSQL database:", e);
      return localOk;
    }
  },

  async markAllNotificationsAsRead(user_Id: string): Promise<boolean> {
    const localOk = localDb.markAllNotificationsAsRead(user_Id);
    try {
      await fetch(`/api/notifications/users/${user_Id}/read-all`, {
        method: 'POST'
      });
      return true;
    } catch (e) {
      console.warn("Failed to mark all notifications read on PostgreSQL database:", e);
      return localOk;
    }
  },

  async deleteAllNotifications(user_Id: string): Promise<boolean> {
    const localOk = localDb.deleteAllNotifications(user_Id);
    try {
      await fetch(`/api/notifications/users/${user_Id}`, {
        method: 'DELETE'
      });
      return true;
    } catch (e) {
      console.warn("Failed to delete all notifications on PostgreSQL database:", e);
      return localOk;
    }
  }
};
