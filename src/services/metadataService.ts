import { DropdownOption, MetadataType } from '../types';
import { localDb } from './localDb';

/**
 * metadataService.ts
 * ------------------------------------------------------------------
 * Client for the Metadata Engine (Phase 1). Every admin-configurable
 * list in the app (Profession, Occupation, Lead Source, Campaign,
 * Product, Lead Status, Meeting Type, Loss Reason, Follow-up Type,
 * Priority - and any custom type an admin adds later) is driven
 * through this single service, backed by:
 *   - metadata_types table -> the registry of *types*
 *   - options table        -> the *values* for each type (with label,
 *                              sortOrder, and a free-form `meta` JSON
 *                              blob for per-type extras, e.g. a lead
 *                              status's color / isWon / isLost flags)
 *
 * settingsService.ts (legacy) is kept for backward compatibility but
 * now delegates to this service under the hood.
 */

let typesCache: MetadataType[] | null = null;
let valuesCache: Record<string, DropdownOption[]> = {};

export const metadataService = {
  /** Full registry of metadata types (for the admin "Metadata Manager" screen). */
  async getTypes(forceRefresh = false): Promise<MetadataType[]> {
    if (typesCache && !forceRefresh) return typesCache;
    try {
      const res = await fetch('/api/metadata-types');
      if (res.ok) {
        typesCache = await res.json();
        return typesCache!;
      }
    } catch (err) {
      console.warn('Failed to fetch metadata types, using empty registry:', err);
    }
    return typesCache || [];
  },

  async createType(key: string, label: string, description?: string): Promise<MetadataType> {
    const res = await fetch('/api/metadata-types', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, label, description }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to create metadata type');
    }
    typesCache = null;
    return res.json();
  },

  async deleteType(key: string): Promise<void> {
    const res = await fetch(`/api/metadata-types/${encodeURIComponent(key)}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to delete metadata type');
    }
    typesCache = null;
    delete valuesCache[key];
  },

  /** All values (active + inactive) for a type, sorted by sortOrder. Used by the admin UI. */
  async getAllValues(type: string, forceRefresh = false): Promise<DropdownOption[]> {
    const cacheKey = `__all__${type}`;
    if (valuesCache[cacheKey] && !forceRefresh) return valuesCache[cacheKey];
    try {
      const res = await fetch('/api/options');
      if (res.ok) {
        const all: DropdownOption[] = await res.json();
        const forType = all
          .filter(o => o.type === type)
          .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
        valuesCache[cacheKey] = forType;
        return forType;
      }
    } catch (err) {
      console.warn(`Failed to fetch metadata values for "${type}", falling back to local cache:`, err);
    }
    return localDb.getOptionsByType(type).map(v => ({ type, value: v, label: v, status: 'Active' as const }));
  },

  /** Active values only, as plain strings - drop-in for the old settingsService.getOptionsByType(). */
  async getActiveValues(type: string): Promise<string[]> {
    const all = await this.getAllValues(type);
    return all.filter(o => o.status === 'Active').map(o => o.label || o.value);
  },

  async addValue(type: string, value: string, meta?: Record<string, any>, label?: string): Promise<DropdownOption> {
    const res = await fetch('/api/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, value, label: label || value, status: 'Active', meta }),
    });
    if (!res.ok) throw new Error('Failed to add metadata value');
    const saved = await res.json();
    delete valuesCache[`__all__${type}`];
    return saved;
  },

  async updateValue(option: DropdownOption): Promise<DropdownOption> {
    const res = await fetch('/api/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(option),
    });
    if (!res.ok) throw new Error('Failed to update metadata value');
    const saved = await res.json();
    delete valuesCache[`__all__${option.type}`];
    return saved;
  },

  async toggleActive(option: DropdownOption): Promise<DropdownOption> {
    return this.updateValue({ ...option, status: option.status === 'Active' ? 'Inactive' : 'Active' });
  },

  async deleteValue(type: string, value: string): Promise<void> {
    await fetch(`/api/options/${encodeURIComponent(type)}/${encodeURIComponent(value)}`, { method: 'DELETE' });
    delete valuesCache[`__all__${type}`];
  },

  async reorder(type: string, orderedIds: string[]): Promise<void> {
    const res = await fetch('/api/options/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds }),
    });
    if (!res.ok) throw new Error('Failed to reorder metadata values');
    delete valuesCache[`__all__${type}`];
  },

  clearCache() {
    typesCache = null;
    valuesCache = {};
  },
};
