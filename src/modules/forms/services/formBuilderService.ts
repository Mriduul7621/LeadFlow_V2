import { FormField } from '../../shared/types';
import { apiRequest, jsonBody, ApiError } from '../../shared/api/http';

/**
 * formBuilderService.ts
 * ------------------------------------------------------------------
 * Client for the Dynamic Form Builder (Phase 2). Field definitions
 * (mandatory / visible / order / dropdown source) live in the
 * `form_fields` table and are managed by the admin through
 * Settings > Form Builder. LeadGenerate.tsx reads this config to:
 *   - hide/show each field
 *   - enforce which fields are required
 *   - render any admin-added custom field generically
 *
 * The original "system" fields (prospectName, mobile, profession, ...)
 * keep their specialized rendering/validation in LeadGenerate.tsx
 * (e.g. the Division/District/Thana cascading selects), but still
 * respect isVisible/isMandatory from this config. Any NEW field an
 * admin adds through the Form Builder is rendered generically in an
 * "Additional Information" section and stored in Lead.customFields.
 *
 * Writes are DB-first - saveField/deleteField/reorder throw unless the
 * API (and therefore PostgreSQL) confirmed the change. Reads default
 * to "all fields visible" only when the server is unreachable/failing;
 * 4xx responses surface as errors.
 */

let cache: FormField[] | null = null;

function isOfflineError(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 0 || err.status >= 500;
  return true;
}

export const formBuilderService = {
  async getFields(forceRefresh = false): Promise<FormField[]> {
    if (cache && !forceRefresh) return cache;
    try {
      cache = await apiRequest<FormField[]>('/api/form-fields');
      return cache;
    } catch (err) {
      if (!isOfflineError(err)) throw err;
      return cache || [];
    }
  },

  async saveField(field: Partial<FormField>): Promise<FormField> {
    const saved = await apiRequest<FormField>('/api/form-fields', jsonBody(field));
    cache = null;
    return saved;
  },

  async deleteField(id: string): Promise<void> {
    await apiRequest(`/api/form-fields/${encodeURIComponent(id)}`, { method: 'DELETE' });
    cache = null;
  },

  async reorder(orderedIds: string[]): Promise<void> {
    await apiRequest('/api/form-fields/reorder', jsonBody({ orderedIds }));
    cache = null;
  },

  clearCache() {
    cache = null;
  },
};
