import { FormField } from '../../shared/types';

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
 */

let cache: FormField[] | null = null;

export const formBuilderService = {
  async getFields(forceRefresh = false): Promise<FormField[]> {
    if (cache && !forceRefresh) return cache;
    try {
      const res = await fetch('/api/form-fields');
      if (res.ok) {
        cache = await res.json();
        return cache!;
      }
    } catch (err) {
      console.warn('Failed to fetch form field config, using defaults (all visible):', err);
    }
    return cache || [];
  },

  async saveField(field: Partial<FormField>): Promise<FormField> {
    const res = await fetch('/api/form-fields', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(field),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to save field');
    }
    cache = null;
    return res.json();
  },

  async deleteField(id: string): Promise<void> {
    const res = await fetch(`/api/form-fields/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to delete field');
    }
    cache = null;
  },

  async reorder(orderedIds: string[]): Promise<void> {
    const res = await fetch('/api/form-fields/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds }),
    });
    if (!res.ok) throw new Error('Failed to reorder fields');
    cache = null;
  },

  clearCache() {
    cache = null;
  },
};
