import { SystemNotification } from '../../shared/types';
import { localDb } from '../../../services/localDb';
import { apiRequest, ApiError } from '../../shared/api/http';
import { coalesceGet } from '../../shared/api/coalesce';

/**
 * notificationService.ts
 * ------------------------------------------------------------------
 * Notifications are database-backed. Every create/mark-read/delete goes
 * through the API first; localStorage is a read cache refreshed only
 * after the server confirms persistence.
 */

function syncCacheForUser(userId: string, cloud: SystemNotification[]): void {
  try {
    const all = localDb.getNotifications(userId);
    const others = all.filter(n => n.userId !== userId);
    const merged = [...others, ...cloud];
    localStorage.setItem('shanta_notifications', JSON.stringify(merged));
  } catch (e) {
    console.error('Failed to update notification cache:', e);
  }
}

export const notificationService = {
  async getNotifications(user_Id: string): Promise<SystemNotification[]> {
    try {
      const path = `/api/notifications/users/${encodeURIComponent(user_Id)}`;
      // GET read: AppLayout may double-fire this (StrictMode / remount race
      // before the session cache is written) — share one round-trip.
      const cloudNotifs = await coalesceGet(path, () => apiRequest<SystemNotification[]>(path));
      syncCacheForUser(user_Id, cloudNotifs);
      return cloudNotifs.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    } catch (err) {
      if (err instanceof ApiError && err.status !== 0 && err.status < 500) throw err;
      return localDb.getNotifications(user_Id);
    }
  },

  async getNotificationsForLead(leadId: string): Promise<SystemNotification[]> {
    const notifs = await apiRequest<SystemNotification[]>(`/api/notifications/leads/${encodeURIComponent(leadId)}`);
    return notifs.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  },

  async createNotification(user_Id: string, title: string, message: string, leadId: string): Promise<SystemNotification> {
    const payload: SystemNotification = {
      id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      userId: user_Id,
      title,
      message,
      leadId: leadId || '',
      read: false,
      date: new Date().toISOString(),
    };
    const saved = await apiRequest<SystemNotification>('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    // Cache after DB success.
    try {
      const cached = localDb.getNotifications(user_Id);
      if (!cached.some(n => n.id === saved.id)) {
        localStorage.setItem('shanta_notifications', JSON.stringify([...cached, saved]));
      }
    } catch (e) {
      console.error('Failed to update notification cache:', e);
    }
    return saved;
  },

  async markNotificationAsRead(id: string): Promise<boolean> {
    const saved = await apiRequest<SystemNotification>(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
    if (saved) localDb.markNotificationAsRead(id);
    return true;
  },

  async markAllNotificationsAsRead(user_Id: string): Promise<boolean> {
    await apiRequest(`/api/notifications/users/${encodeURIComponent(user_Id)}/read-all`, { method: 'POST' });
    localDb.markAllNotificationsAsRead(user_Id);
    return true;
  },

  async deleteAllNotifications(user_Id: string): Promise<boolean> {
    await apiRequest(`/api/notifications/users/${encodeURIComponent(user_Id)}`, { method: 'DELETE' });
    localDb.deleteAllNotifications(user_Id);
    return true;
  },
};
