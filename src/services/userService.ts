import { User } from '../types';
import { localDb } from './localDb';

export const userService = {
  async createUser(user: User) {
    // Always write to localDb first for immediate local consistency
    localDb.createUser(user);

    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(user)
      });
      if (res.ok) {
        const saved = await res.json();
        return saved as User;
      }
    } catch (error) {
      console.warn('PostgreSQL write fallback to local db:', error);
    }
    return user;
  },

  async updateUser(userId: string, data: Partial<User>) {
    // Always write to localDb first for immediate local consistency
    localDb.updateUser(userId, data);

    const existing = localDb.getUser(userId);
    if (!existing) return true;

    try {
      await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(existing)
      });
    } catch (error) {
      console.warn('PostgreSQL write fallback to local db:', error);
    }
    return true;
  },

  async getUser(userId: string): Promise<User | null> {
    try {
      const res = await fetch('/api/users');
      if (res.ok) {
        const cloudUsers: User[] = await res.json();
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
      const res = await fetch('/api/users');
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
    // Always delete from localDb first to prevent sync resurrection
    localDb.deleteUser(userId);

    try {
      await fetch(`/api/users/${userId}`, {
        method: 'DELETE'
      });
    } catch (error) {
      console.warn('PostgreSQL delete user fallback to local db:', error);
    }
  },

  async checkAdminExists(): Promise<boolean> {
    try {
      const res = await fetch('/api/users/check-admin');
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
