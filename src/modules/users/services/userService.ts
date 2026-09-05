import { User } from '../../shared/types';
import { localDb } from '../../../services/localDb';
import { useAuthStore } from '../../auth/store/authStore';

function authHeaders(): HeadersInit {
  const token = useAuthStore.getState().token;
  return token
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    : { 'Content-Type': 'application/json' };
}

async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json();
  return (body?.data ?? body) as T;
}

export const userService = {
  async createUser(user: User) {
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(user)
      });
      if (res.ok) {
        const saved = await readResponse<User>(res);
        localDb.createUser({ ...saved, password: undefined });
        return saved as User;
      }
    } catch (error) {
      console.warn('PostgreSQL write fallback to local db:', error);
    }
    localDb.createUser(user);
    return user;
  },

  async updateUser(userId: string, data: Partial<User>) {
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(userId)}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(data)
      });
      if (res.ok) {
        const saved = await readResponse<User>(res);
        localDb.updateUser(userId, { ...saved, password: undefined });
        return saved;
      }
    } catch (error) {
      console.warn('PostgreSQL write fallback to local db:', error);
    }
    localDb.updateUser(userId, data);
    return localDb.getUser(userId);
  },

  async getUser(userId: string): Promise<User | null> {
    try {
      const res = await fetch('/api/users', { headers: authHeaders() });
      if (res.ok) {
        const cloudUsers = await readResponse<User[]>(res);
        const found = cloudUsers.find(u => u.id === userId || u.employeeId === userId);
        if (found) {
          localDb.updateUser(found.id, found);
          return found;
        }
      }
    } catch (error) {
      console.warn('PostgreSQL get fallback to local db:', error);
    }
    return localDb.getUser(userId);
  },

  async getAllUsers(): Promise<User[]> {
    try {
      const res = await fetch('/api/users', { headers: authHeaders() });
      if (res.ok) {
        const cloudUsers: User[] = await res.json();
        const localUsers = localDb.getUsers();
        let changed = false;
        const mergedUsers = [...localUsers];

        for (const cu of cloudUsers) {
          const idx = mergedUsers.findIndex(u => u.id === cu.id);
          if (idx === -1) {
            mergedUsers.push(cu);
            changed = true;
          } else {
            const localUser = mergedUsers[idx];
            const lTime = new Date(localUser.createdDate || 0).getTime();
            const cTime = new Date(cu.createdDate || 0).getTime();
            const needsUpdate = cu.role !== localUser.role || 
                                cu.name !== localUser.name ||
                                cu.status !== localUser.status ||
                                (!isNaN(cTime) && !isNaN(lTime) && cTime > lTime);
            if (needsUpdate) {
              mergedUsers[idx] = cu;
              changed = true;
            }
          }
        }

        if (changed) {
          localDb.saveUsers(mergedUsers);
        }
        return mergedUsers;
      }
    } catch (error) {
      console.warn('PostgreSQL list users fallback to local db:', error);
    }
    return localDb.getUsers();
  },

  async getUserByEmail(email: string): Promise<User | null> {
    try {
      const users = await this.getAllUsers();
      return users.find(u => u.email.toLowerCase() === email.toLowerCase()) || null;
    } catch (error) {
      console.warn('PostgreSQL getUserByEmail fallback to local db:', error);
    }
    return localDb.getUserByEmail(email);
  },

  async deleteUser(userId: string) {
    try {
      await fetch(`/api/users/${userId}`, {
        method: 'DELETE',
        headers: authHeaders()
      });
    } catch (error) {
      console.warn('PostgreSQL delete user fallback to local db:', error);
    }
    localDb.deleteUser(userId);
  },

  async resetPassword(userId: string, password: string) {
    const res = await fetch(`/api/users/${encodeURIComponent(userId)}/reset-password`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ password })
    });
    if (!res.ok) throw new Error('Password reset failed.');
    return readResponse<{ success: boolean }>(res);
  },

  async checkAdminExists(): Promise<boolean> {
    try {
      const res = await fetch('/api/users/check-admin', { headers: authHeaders() });
      if (res.ok) {
        const body = await res.json();
        return !!body.exists;
      }
    } catch (error) {
      console.warn('PostgreSQL checkAdminExists failed:', error);
    }
    // Only fallback if there was an actual connection issue
    const localUsers = localDb.getUsers();
    return localUsers.some(u => u.role === 'ADMIN');
  }
};
