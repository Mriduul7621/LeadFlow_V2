import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User } from '../types';

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isInitialized: boolean;
  isOfflineMode: boolean;
  login: (user: User, token?: string, isOffline?: boolean) => void;
  logout: () => void;
  setInitialized: (val: boolean) => void;
  setOfflineMode: (val: boolean) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      isInitialized: false,
      isOfflineMode: false,
      login: (user, token, isOffline = false) => {
        localStorage.setItem('leadflow_last_activity', Date.now().toString());
        set({ user, token: token || null, isAuthenticated: true, isOfflineMode: isOffline });
      },
      logout: () => {
        localStorage.removeItem('leadflow-auth');
        localStorage.removeItem('leadflow_last_activity');
        set({ user: null, token: null, isAuthenticated: false, isOfflineMode: false });
      },
      setInitialized: (val) => set({ isInitialized: val }),
      setOfflineMode: (val) => set({ isOfflineMode: val }),
    }),
    {
      name: 'leadflow-auth',
      partialize: (state) => ({
        user: state.user,
        token: state.token,
        isAuthenticated: state.isAuthenticated,
        isOfflineMode: state.isOfflineMode,
      }),
    }
  )
);

