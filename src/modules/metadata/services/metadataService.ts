import { DropdownOption, MetadataType } from '../../shared/types';
import { localDb } from '../../../services/localDb';
import { apiRequest, jsonBody, ApiError } from '../../shared/api/http';
import { useAuthStore } from '../../auth/store/authStore';
import { coalesceGet } from '../../shared/api/coalesce';
import {
  readSessionCache,
  writeSessionCache,
  invalidateSessionCache,
  registerSessionCacheClearHandler,
} from '../../shared/api/sessionCache';
import { shouldFallBackToCache } from '../../shared/api/offlinePolicy';

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

/** Short-lived session TTL for the options reference list (same window as roles). */
const OPTIONS_REFERENCE_TTL_MS = 5 * 60 * 1000;

function optionsSessionKey(): string | null {
  const id = useAuthStore.getState().user?.id;
  return id ? `options:${id}` : null;
}

function invalidateOptionsReferenceCache(): void {
  const key = optionsSessionKey();
  if (key) invalidateSessionCache(key);
}

async function loadAllOptions(forceRefresh = false): Promise<DropdownOption[]> {
  const sessionKey = optionsSessionKey();
  if (sessionKey && !forceRefresh) {
    const cached = readSessionCache<DropdownOption[]>(sessionKey);
    if (cached && Date.now() - cached.fetchedAt <= OPTIONS_REFERENCE_TTL_MS) {
      return cached.value;
    }
  }
  const all = await coalesceGet('/api/options', () => apiRequest<DropdownOption[]>('/api/options'));
  if (sessionKey) writeSessionCache(sessionKey, all);
  return all;
}

function clearMetadataSessionCaches(): void {
  typesCache = null;
  valuesCache = {};
}

// Per-type in-memory index dies with the session (no cross-user reuse).
// Named function so HMR re-register is a Set no-op.
registerSessionCacheClearHandler(clearMetadataSessionCaches);

function isOfflineError(err: unknown): boolean {
  // status 0 = network failure; >=500 = server/database unavailable.
  if (err instanceof ApiError) {
    return shouldFallBackToCache(err.status);
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
    invalidateOptionsReferenceCache();
  },

  /** All values (active + inactive) for a type, sorted by sortOrder. Used by the admin UI. */
  async getAllValues(type: string, forceRefresh = false): Promise<DropdownOption[]> {
    const cacheKey = `__all__${type}`;
    if (valuesCache[cacheKey] && !forceRefresh) return valuesCache[cacheKey];
    try {
      // GET read only: one coalesced /api/options round-trip per session
      // window, then per-type filter. Never used for dashboard KPI /
      // follow-up / scheduled-activity data.
      const all = await loadAllOptions(forceRefresh);
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
  async getActiveValues(type: string, forceRefresh = false): Promise<string[]> {
    const all = await this.getAllValues(type, forceRefresh);
    return all.filter(o => o.status === 'Active').map(o => o.label || o.value);
  },

  async addValue(type: string, value: string, meta?: Record<string, any>, label?: string): Promise<DropdownOption> {
    const saved = await apiRequest<DropdownOption>(
      '/api/options',
      jsonBody({ type, value, label: label || value, status: 'Active', meta })
    );
    delete valuesCache[`__all__${type}`];
    invalidateOptionsReferenceCache();
    return saved;
  },

  /**
   * Add Lead form "+" — append ONE option to a lead-form dropdown list.
   * Deliberately narrower than addValue(): the server gates it on
   * `leads.create` (not settings.manage), allowlists the extendable
   * lists, and dedupes case-insensitively. Resolves with the canonical
   * stored option; `existing: true` means the value was already on the
   * list (select it, store nothing new). Throws ApiError on refusal
   * (not allowlisted, blank/overlong, or an inactive namesake).
   */
  async quickAddOption(type: string, value: string): Promise<DropdownOption & { existing: boolean }> {
    // Retry NETWORK failures only (ApiError status 0 = fetch never got a
    // response: a dropped connection / momentary hiccup, exactly what a
    // field agent on mobile data hits). HTTP responses are real answers
    // from the server (400 not-allowlisted, 403 no permission, ...) and
    // are NEVER retried. Retrying is safe here because the endpoint
    // dedupes case-insensitively: if the first attempt actually landed
    // before the connection dropped, the retry resolves with the stored
    // option and `existing: true` instead of creating a duplicate.
    const RETRY_BACKOFF_MS = [600, 1500];
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
      try {
        const saved = await apiRequest<DropdownOption & { existing: boolean }>(
          '/api/options/quick-add',
          jsonBody({ type, value })
        );
        delete valuesCache[`__all__${type}`];
        invalidateOptionsReferenceCache();
        return saved;
      } catch (err) {
        lastError = err;
        const isNetworkFailure = err instanceof ApiError && err.status === 0;
        if (!isNetworkFailure || attempt === RETRY_BACKOFF_MS.length) throw err;
        await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS[attempt]));
      }
    }
    // Unreachable (the loop always returns or throws), but keeps the
    // type checker honest about the fall-through path.
    throw lastError;
  },

  async updateValue(option: DropdownOption): Promise<DropdownOption> {
    const saved = await apiRequest<DropdownOption>('/api/options', jsonBody(option));
    delete valuesCache[`__all__${option.type}`];
    invalidateOptionsReferenceCache();
    return saved;
  },

  async toggleActive(option: DropdownOption): Promise<DropdownOption> {
    return this.updateValue({ ...option, status: option.status === 'Active' ? 'Inactive' : 'Active' });
  },

  async deleteValue(type: string, value: string): Promise<void> {
    await apiRequest(`/api/options/${encodeURIComponent(type)}/${encodeURIComponent(value)}`, { method: 'DELETE' });
    delete valuesCache[`__all__${type}`];
    invalidateOptionsReferenceCache();
  },

  async reorder(type: string, orderedIds: string[]): Promise<void> {
    await apiRequest('/api/options/reorder', jsonBody({ orderedIds }));
    delete valuesCache[`__all__${type}`];
    invalidateOptionsReferenceCache();
  },

  clearCache() {
    typesCache = null;
    valuesCache = {};
  },
};
