import { User } from '../../shared/types';
import { localDb } from '../../../services/localDb';
import { apiRequest, ApiError } from '../../shared/api/http';
import { extractLoginPayload } from '../../auth/services/loginContract';
import { useAuthStore } from '../../auth/store/authStore';
import { coalesceGet } from '../../shared/api/coalesce';
import {
  readSessionCache,
  writeSessionCache,
  invalidateSessionCache,
} from '../../shared/api/sessionCache';

/** Short-lived session TTL for the users reference list (same window as roles). */
const USERS_REFERENCE_TTL_MS = 5 * 60 * 1000;

function usersSessionKey(): string | null {
  const id = useAuthStore.getState().user?.id;
  return id ? `users:${id}` : null;
}

/** Drop the session-scoped users list after a confirmed user/admin mutation. */
function invalidateUsersReferenceCache(): void {
  const key = usersSessionKey();
  if (key) invalidateSessionCache(key);
}

/**
 * userService.ts
 * ------------------------------------------------------------------
 * Persistence policy (matches the rest of the app):
 *   CREATE/UPDATE/DELETE -> API first -> only after the server confirms
 *   the PostgreSQL commit is the local cache touched.
 *   READS -> API first; localDb is a pure cache fallback for offline
 *   viewing, never an authoritative store.
 * A failed database write THROWS - the UI must never show a success
 * toast when the database did not persist the change.
 */

function cacheUser(user: User): void {
  const safe = { ...user, password: undefined };
  const existing = localDb.getUser(user.id);
  if (existing) {
    localDb.updateUser(user.id, safe);
  } else {
    localDb.createUser(safe as User);
  }
}

function cacheUsers(users: User[]): void {
  localDb.saveUsers(users.map(u => ({ ...u, password: undefined })));
}

async function extractErrorMessage(err: unknown, fallback: string): Promise<string> {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : fallback;
}

export const userService = {
  /** POST /api/auth/bootstrap-admin - secure first-admin creation (server guards it). */
  async bootstrapAdmin(payload: {
    fullName: string;
    employeeId: string;
    email: string;
    password: string;
  }): Promise<{ token: string; user: User }> {
    // apiRequest unwraps `{ success, data }`; extractLoginPayload validates +
    // normalizes the session and guarantees no credential field survives.
    const body = await apiRequest<unknown>('/api/auth/bootstrap-admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const session = extractLoginPayload(body);
    cacheUser(session.user);
    return session;
  },

  async createUser(user: User): Promise<User> {
    const saved = await apiRequest<User>('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(user),
    });
    cacheUser(saved);
    invalidateUsersReferenceCache();
    return saved;
  },

  async updateUser(userId: string, data: Partial<User>): Promise<User | null> {
    const saved = await apiRequest<User>(`/api/users/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (saved) {
      localDb.updateUser(userId, { ...saved, password: undefined });
      invalidateUsersReferenceCache();
      return saved;
    }
    return null;
  },

  async getUser(userId: string): Promise<User | null> {
    try {
      const cloudUsers = await this.getAllUsers();
      const found = cloudUsers.find(u => u.id === userId || u.employeeId === userId);
      if (found) {
        localDb.updateUser(found.id, { ...found, password: undefined });
        return found;
      }
      // Cloud is authoritative: if the user is not there anymore, drop the
      // stale cache entry and report null (do not resurrect deleted users).
      const cached = localDb.getUser(userId);
      if (cached && String(cached.status).toLowerCase() === 'inactive') {
        localDb.deleteUser(userId);
      }
      return null;
    } catch (err) {
      // Network/server unavailable: return the cache (read-only fallback).
      const cached = localDb.getUser(userId);
      if (cached) return cached;
      throw err;
    }
  },

  async getAllUsers(): Promise<User[]> {
    // GET read only: session-scoped reuse + in-flight coalescing. Never
    // used for dashboard KPI / follow-up / scheduled-activity data.
    const sessionKey = usersSessionKey();
    if (sessionKey) {
      const cached = readSessionCache<User[]>(sessionKey);
      if (cached && Date.now() - cached.fetchedAt <= USERS_REFERENCE_TTL_MS) {
        return cached.value;
      }
    }
    try {
      const cloudUsers = await coalesceGet('/api/users', () => apiRequest<User[]>('/api/users'));
      cacheUsers(cloudUsers);
      if (sessionKey) writeSessionCache(sessionKey, cloudUsers);
      return cloudUsers;
    } catch (err) {
      // Offline / server-down fallback: return the read-only cache. Auth
      // failures (401/403) are never swallowed here.
      if (err instanceof ApiError && err.status !== 0 && err.status < 500) throw err;
      const cached = localDb.getUsers();
      return cached;
    }
  },

  async getUserByEmail(email: string): Promise<User | null> {
    const users = await this.getAllUsers();
    return users.find(u => (u.email || '').toLowerCase() === email.toLowerCase()) || null;
  },

  async deleteUser(userId: string): Promise<void> {
    await apiRequest(`/api/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
    localDb.deleteUser(userId);
    invalidateUsersReferenceCache();
  },

  /**
   * POST /api/auth/change-required-password — forced first-login password
   * change. Self-only: the server derives the caller from the session, so
   * this never requires `users.edit`, an admin role, or Settings Feature
   * Access — and can never target another user. Returns the authoritative
   * updated profile (with `mustChangePassword: false`) for the store.
   */
  async changeRequiredPassword(newPassword: string): Promise<User> {
    const saved = await apiRequest<User>('/api/auth/change-required-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword }),
    });
    cacheUser(saved);
    return saved;
  },

  async resetPassword(userId: string, password: string): Promise<{ success: boolean }> {
    const result = await apiRequest<{ success: boolean }>(
      `/api/users/${encodeURIComponent(userId)}/reset-password`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      }
    );
    invalidateUsersReferenceCache();
    return result;
  },

  /**
   * Whether the app still needs its first ADMIN created. Uses the public
   * bootstrap-status endpoint - no local fallback, because deciding this
   * from the browser's cache could mislead the user about the real
   * database state.
   */
  async checkAdminExists(): Promise<boolean> {
    const body = await apiRequest<{ required: boolean; exists?: boolean }>('/api/auth/bootstrap-status');
    return body.exists === true || body.required === false;
  },

  async validateBulkUsers(rows: any[], mode: 'createOnly' | 'createAndUpdate', fileName?: string): Promise<any> {
    const body = await apiRequest<{ success: boolean; data: any }>('/api/users/bulk/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows, mode, fileName }),
    });
    return (body as any).data || body;
  },

  async commitBulkUsers(rows: any[], mode: 'createOnly' | 'createAndUpdate', fileName?: string): Promise<any> {
    const body = await apiRequest<{ success: boolean; data: any }>('/api/users/bulk/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows, mode, fileName }),
    });
    const data = (body as any).data || body;
    invalidateUsersReferenceCache();
    // After commit, refresh local cache lazily via getAllUsers on next call
    return data;
  },

  async checkBootstrapRequired(): Promise<boolean> {
    const body = await apiRequest<{ required: boolean; exists?: boolean }>('/api/auth/bootstrap-status');
    return body.required !== false;
  },

  /** Shared by UI catch blocks - keeps messages consistent. */
  async errorMessage(err: unknown, fallback: string): Promise<string> {
    return extractErrorMessage(err, fallback);
  },
};
