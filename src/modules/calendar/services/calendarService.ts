import { apiRequest, jsonBody } from '../../shared/api/http';

/**
 * calendarService.ts
 * ------------------------------------------------------------------
 * Client for Calendar Settings (calendar upgrade PR C): the
 * workspace weekend days + the government holiday list served by
 * GET /calendar/config, plus the settings.manage-gated mutations
 * (weekend replace, holiday CRUD) used by Settings → Calendar.
 *
 * Weekend days are JS weekday numbers (Sun=0 … Sat=6); the
 * Bangladesh default is [5, 6] (Friday + Saturday).
 */

export interface CalendarHoliday {
  id: string;
  date: string; // YYYY-MM-DD
  name: string;
  category: 'general' | 'executive';
  moonDependent: boolean;
  regional: boolean;
  note?: string | null;
}

export interface CalendarConfig {
  weekendDays: number[];
  holidays: CalendarHoliday[];
}

export interface HolidayInput {
  date: string;
  name: string;
  category: 'general' | 'executive';
  moonDependent: boolean;
  regional: boolean;
  note?: string | null;
}

export const DEFAULT_WEEKEND_DAYS: number[] = [5, 6];

export const calendarService = {
  async getConfig(from?: string, to?: string): Promise<CalendarConfig> {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const qs = params.toString();
    const config = await apiRequest<CalendarConfig>(`/api/calendar/config${qs ? `?${qs}` : ''}`);
    return {
      weekendDays: Array.isArray(config?.weekendDays) ? config.weekendDays : [...DEFAULT_WEEKEND_DAYS],
      holidays: Array.isArray(config?.holidays) ? config.holidays : [],
    };
  },

  async saveWeekendDays(weekendDays: number[]): Promise<number[]> {
    const saved = await apiRequest<{ weekendDays: number[] }>('/api/calendar/weekend', {
      method: 'PUT',
      ...jsonBody({ weekendDays }),
    });
    return saved.weekendDays;
  },

  async createHoliday(input: HolidayInput): Promise<CalendarHoliday> {
    return apiRequest<CalendarHoliday>('/api/calendar/holidays', {
      method: 'POST',
      ...jsonBody(input),
    });
  },

  async updateHoliday(id: string, input: HolidayInput): Promise<CalendarHoliday> {
    return apiRequest<CalendarHoliday>(`/api/calendar/holidays/${encodeURIComponent(id)}`, {
      method: 'PUT',
      ...jsonBody(input),
    });
  },

  async deleteHoliday(id: string): Promise<void> {
    await apiRequest(`/api/calendar/holidays/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};
