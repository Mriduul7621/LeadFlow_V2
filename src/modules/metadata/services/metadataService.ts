import { DropdownOption, MetadataType } from '../../shared/types';
import { localDb } from '../../../services/localDb';
import { apiRequest, jsonBody, ApiError } from '../../shared/api/http';

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
 * Writes are DB-first: every add/update/delete/reorder is a confirmed
 * API (PostgreSQL) commit; failures throw and never update local state.
 * Reads use an in-memory cache, with a localStorage read-cache only
 * when the server is unreachable or failing (never on 4xx errors).
 */

let typesCache: MetadataType[] | null = null;
let valuesCache: Record<string, DropdownOption[]> = {};

function isOfflineError(err: unknown): boolean {
  // status 0 = network failure; >=500 = server/database unavailable.
  if (err instanceof ApiError) {
    return err.status === 0 || err.status >= 500;
  }
  return true;
}

export const metadataService = {
  /** Full registry of metadata types (for the admin "Metadata Manager" screen). */
  async getTypes(forceRefresh = false): Promise<MetadataType[]> {
    if (typesCache && !forceRefresh) return typesCache;
    try {
      typesCache = await apiRequest<MetadataType[]>('/api/metadata-types');
      return typesCache;
    } catch (err) {
      if (!isOfflineError(err)) throw err;
      return typesCache || [];
    }
  },

  async createType(key: string, label: string, description?: string): Promise<MetadataType> {
    const saved = await apiRequest<MetadataType>('/api/metadata-types', jsonBody({ key, label, description }));
    typesCache = null;
    return saved;
  },

  async deleteType(key: string): Promise<void> {
    await apiRequest(`/api/metadata-types/${encodeURIComponent(key)}`, { method: 'DELETE' });
    typesCache = null;
    delete valuesCache[key];
  },

  /** All values (active + inactive) for a type, sorted by sortOrder. Used by the admin UI. */
  async getAllValues(type: string, forceRefresh = false): Promise<DropdownOption[]> {
    const cacheKey = `__all__${type}`;
    if (valuesCache[cacheKey] && !forceRefresh) return valuesCache[cacheKey];
    try {
      const all = await apiRequest<DropdownOption[]>('/api/options');
      const forType = all
        .filter(o => o.type === type)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
      valuesCache[cacheKey] = forType;
      return forType;
    } catch (err) {
      if (!isOfflineError(err)) throw err;
      return localDb.getOptionsByType(type).map(v => ({ type, value: v, label: v, status: 'Active' as const }));
    }
  },

  /** Active values only, as plain strings - drop-in for the old settingsService.getOptionsByType(). */
  async getActiveValues(type: string): Promise<string[]> {
    const all = await this.getAllValues(type);
    return all.filter(o => o.status === 'Active').map(o => o.label || o.value);
  },

  async addValue(type: string, value: string, meta?: Record<string, any>, label?: string): Promise<DropdownOption> {
    const saved = await apiRequest<DropdownOption>(
      '/api/options',
      jsonBody({ type, value, label: label || value, status: 'Active', meta })
    );
    delete valuesCache[`__all__${type}`];
    return saved;
  },

  async updateValue(option: DropdownOption): Promise<DropdownOption> {
    const saved = await apiRequest<DropdownOption>('/api/options', jsonBody(option));
    delete valuesCache[`__all__${option.type}`];
    return saved;
  },

  async toggleActive(option: DropdownOption): Promise<DropdownOption> {
    return this.updateValue({ ...option, status: option.status === 'Active' ? 'Inactive' : 'Active' });
  },

  async deleteValue(type: string, value: string): Promise<void> {
    await apiRequest(`/api/options/${encodeURIComponent(type)}/${encodeURIComponent(value)}`, { method: 'DELETE' });
    delete valuesCache[`__all__${type}`];
  },

  async reorder(type: string, orderedIds: string[]): Promise<void> {
    await apiRequest('/api/options/reorder', jsonBody({ orderedIds }));
    delete valuesCache[`__all__${type}`];
  },

  clearCache() {
    typesCache = null;
    valuesCache = {};
  },
};
