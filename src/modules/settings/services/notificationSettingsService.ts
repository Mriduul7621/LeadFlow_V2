import { apiRequest, jsonBody } from '../../shared/api/http';

/**
 * notificationSettingsService.ts
 * ------------------------------------------------------------------
 * Client for the real notification toggles (Admin Control programme,
 * DZ-1 "Honest Settings"): GET/PUT /api/notifications/settings,
 * served by NotificationSettingsService. The Settings → Push
 * Intelligence card reads these values and its switches write them —
 * nothing on that card is display-only any more.
 */

export interface NotificationSettings {
  assignmentAlerts: boolean;
  dailyPushSummary: boolean;
}

export const notificationSettingsService = {
  async getSettings(): Promise<NotificationSettings> {
    const settings = await apiRequest<NotificationSettings>('/api/notifications/settings');
    return {
      assignmentAlerts: settings?.assignmentAlerts !== false,
      dailyPushSummary: settings?.dailyPushSummary !== false,
    };
  },

  async saveSettings(patch: Partial<NotificationSettings>): Promise<NotificationSettings> {
    const saved = await apiRequest<NotificationSettings>('/api/notifications/settings', {
      method: 'PUT',
      ...jsonBody(patch),
    });
    return {
      assignmentAlerts: saved?.assignmentAlerts !== false,
      dailyPushSummary: saved?.dailyPushSummary !== false,
    };
  },
};
