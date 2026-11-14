import { apiRequest, jsonBody } from '../../shared/api/http';

/**
 * notificationSettingsService.ts
 * ------------------------------------------------------------------
 * Client for the real notification toggles (Admin Control programme,
 * DZ-1 "Honest Settings", DZ-2 split): GET/PUT /api/notifications/settings,
 * served by NotificationSettingsService. The Settings → Push
 * Intelligence card reads these values and its switches write them —
 * nothing on that card is display-only any more.
 *
 * DZ-2: the DZ-1 combined `assignmentAlerts` toggle is split into
 * `assigneeAlerts` and `uplineAlerts`, and `meetingNotifications`
 * joins them. `assignmentAlerts` is kept in the response as the
 * derived value (assignee && upline) for compatibility; the UI never
 * writes it directly.
 */

export interface NotificationSettings {
  assigneeAlerts: boolean;
  uplineAlerts: boolean;
  /** Derived (assigneeAlerts && uplineAlerts). Never written by the UI. */
  assignmentAlerts: boolean;
  dailyPushSummary: boolean;
  meetingNotifications: boolean;
}

function normalize(settings: any): NotificationSettings {
  const assigneeAlerts = settings?.assigneeAlerts !== false;
  const uplineAlerts = settings?.uplineAlerts !== false;
  return {
    assigneeAlerts,
    uplineAlerts,
    assignmentAlerts: settings?.assignmentAlerts !== undefined
      ? settings.assignmentAlerts !== false
      : (assigneeAlerts && uplineAlerts),
    dailyPushSummary: settings?.dailyPushSummary !== false,
    meetingNotifications: settings?.meetingNotifications !== false,
  };
}

export const notificationSettingsService = {
  async getSettings(): Promise<NotificationSettings> {
    const settings = await apiRequest<NotificationSettings>('/api/notifications/settings');
    return normalize(settings);
  },

  async saveSettings(patch: Partial<NotificationSettings>): Promise<NotificationSettings> {
    const saved = await apiRequest<NotificationSettings>('/api/notifications/settings', {
      method: 'PUT',
      ...jsonBody(patch),
    });
    return normalize(saved);
  },
};
