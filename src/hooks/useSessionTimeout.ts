import { useEffect, useCallback, useRef } from 'react';
import { useAuthStore } from '../store/authStore';
import { toast } from 'sonner';

const TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes in milliseconds
const CHECK_INTERVAL_MS = 10000; // Check every 10 seconds
const THROTTLE_MS = 5000; // Throttle activity saves to every 5 seconds for performance

/**
 * Custom Hook that monitors user activity (clicks, scrolls, typing) 
 * and automatically logs out the user after 15 minutes of idle state.
 */
export function useSessionTimeout() {
  const { isAuthenticated, logout } = useAuthStore();
  const lastWriteRef = useRef<number>(0);

  const updateActivity = useCallback(() => {
    if (!isAuthenticated) return;
    const now = Date.now();
    if (now - lastWriteRef.current > THROTTLE_MS) {
      localStorage.setItem('leadflow_last_activity', now.toString());
      lastWriteRef.current = now;
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return;

    // Initialize or refresh last activity timestamp on mount
    if (!localStorage.getItem('leadflow_last_activity')) {
      localStorage.setItem('leadflow_last_activity', Date.now().toString());
    }

    const events = ['mousedown', 'keydown', 'scroll', 'click', 'touchstart'];
    
    const handleActivity = () => {
      updateActivity();
    };

    // Attach passive listeners to avoid blocking layout/scrolling threads
    events.forEach(event => {
      window.addEventListener(event, handleActivity, { passive: true });
    });

    const checkTimeout = () => {
      if (!isAuthenticated) return;
      
      const lastActivityStr = localStorage.getItem('leadflow_last_activity');
      if (lastActivityStr) {
        const lastActivity = parseInt(lastActivityStr, 10);
        if (isNaN(lastActivity)) return;
        
        const elapsed = Date.now() - lastActivity;
        if (elapsed >= TIMEOUT_MS) {
          logout();
          toast.warning('Session Expired', {
            description: 'You have been automatically logged out due to 15 minutes of inactivity.',
            duration: 10000,
          });
        }
      }
    };

    // Reactive check immediately when checking back into the page tab
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        checkTimeout();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    const intervalId = setInterval(checkTimeout, CHECK_INTERVAL_MS);

    // Run a clean check immediately on startup
    checkTimeout();

    return () => {
      events.forEach(event => {
        window.removeEventListener(event, handleActivity);
      });
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      clearInterval(intervalId);
    };
  }, [isAuthenticated, logout, updateActivity]);
}
