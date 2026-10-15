import React, { useState, useEffect } from 'react';
import { 
  LayoutDashboard, 
  ClipboardList, 
  ChevronRight,
  LogOut,
  Calendar,
  Clock,
  X,
  Bell,
  Target,
  Lock,
  AlertCircle,
  WifiOff,
  Plus,
  MoreHorizontal,
  Menu,
} from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../modules/auth/store/authStore';
import { SystemNotification, RolePermission } from '../modules/shared/types';
import { cn } from '../lib/utils';
import { motion } from 'framer-motion';
import { notificationService } from '../modules/notifications/services/notificationService';
import { adminService } from '../modules/admin/services/adminService';
import { userService } from '../modules/users/services/userService';
import { toast } from 'sonner';
import {
  readSessionCache,
  writeSessionCache,
} from '../modules/shared/api/sessionCache';
import { markShellStartupSettled, waitForShellStartup } from '../modules/shared/api/startupPriority';
import { ANY_ROLE, resolveMenuVisibility } from './menuVisibility';
import { resolveFeatureRouteAccess } from './featureRouteAccess';
import { buildSidebarGroups } from './sidebarNav';
import { usePermissions } from '../modules/shared/hooks/usePermissions';

interface MenuItem {
  label: string;
  icon: any;
  path: string;
  roles: string[];
}

/**
 * The five primary destinations are organization-wide: `ANY_ROLE` ('*')
 * mirrors the route registry (featureRouteAccess.ts) so the menu and the
 * page gate can never disagree, and the role codes that live in the
 * database (EMPLOYEE, TEAM_LEAD, MANAGER, SBE, SM, CEO, custom codes) are
 * not silently locked out by a stale enum list. A configured
 * `menuAccess[path]` still wins over this default.
 */
const PRIMARY_NAV_ITEMS: MenuItem[] = [
  { label: 'Home', icon: LayoutDashboard, path: '/', roles: [ANY_ROLE] },
  { label: 'My Work', icon: Target, path: '/workbench', roles: [ANY_ROLE] },
  { label: 'Add Lead', icon: Plus, path: '/leads/new', roles: [ANY_ROLE] },
  { label: 'Leads', icon: ClipboardList, path: '/leads', roles: [ANY_ROLE] },
  { label: 'More', icon: MoreHorizontal, path: '/more', roles: [ANY_ROLE] },
];
const MORE_NAV_PATHS = [
  '/more', '/notifications', '/help', '/about', '/administration',
  '/settings', '/settings/system', '/settings/performance-diagnostics',
  '/users', '/leads/upload', '/leads/all', '/activities', '/task-calendar',
  '/follow-up', '/team', '/execution-intelligence', '/ncp-progress',
  '/trend-charts', '/campaign-breakdown', '/sales-pipeline',
];

const ROLE_MENU_TTL_MS = 5 * 60 * 1000;
const NOTIFICATION_REFRESH_MS = 60_000;

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuthStore();
  const { canAccess } = usePermissions();
  const location = useLocation();
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<SystemNotification[]>([]);
  const [isNotifOpen, setIsNotifOpen] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [rolesPermissions, setRolesPermissions] = useState<RolePermission[]>([]);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwResetLoading, setPwResetLoading] = useState(false);
  const refreshNotifsRef = React.useRef<() => void>(() => undefined);
  const [isOffline, setIsOffline] = useState<boolean>(() => typeof navigator !== 'undefined' ? !navigator.onLine : false);

  useEffect(() => {
    if (!user) return;
    const cacheKey = `roles:${user.id}`;
    const cached = readSessionCache<RolePermission[]>(cacheKey);
    if (cached) setRolesPermissions(cached.value);

    const fetchPerms = async () => {
      try {
        const rp = await adminService.getRoles();
        writeSessionCache(cacheKey, rp);
        setRolesPermissions(rp);
      } catch (err) {
        console.error(err);
      }
    };

    const isFresh = Boolean(cached) && Date.now() - cached!.fetchedAt <= ROLE_MENU_TTL_MS;
    if (!isFresh) void fetchPerms();

    const tick = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const entry = readSessionCache<RolePermission[]>(cacheKey);
      if (!entry || Date.now() - entry.fetchedAt > ROLE_MENU_TTL_MS) void fetchPerms();
    }, 60_000);

    return () => clearInterval(tick);
  }, [user]);

  useEffect(() => {
    if (!user) return;
    if (!localStorage.getItem('leadflow_last_activity')) {
      localStorage.setItem('leadflow_last_activity', Date.now().toString());
    }
    const checkTimeoutInterval = setInterval(() => {
      const lastActivityStr = localStorage.getItem('leadflow_last_activity');
      if (!lastActivityStr) return;
      const lastActivity = parseInt(lastActivityStr, 10);
      const now = Date.now();
      if (now - lastActivity > 1800000) {
        clearInterval(checkTimeoutInterval);
        toast.error("Session expired due to 30 minutes of inactivity.", {
          duration: 7000,
          id: "session-timeout-toast"
        });
        logout();
        navigate('/login');
      }
    }, 2000);
    let lastWriteTime = 0;
    const handleGesture = () => {
      const now = Date.now();
      if (now - lastWriteTime > 1000) {
        localStorage.setItem('leadflow_last_activity', now.toString());
        lastWriteTime = now;
      }
    };
    const activityEvents = ['mousedown','mousemove','keydown','scroll','touchstart','click'];
    activityEvents.forEach((ev) => window.addEventListener(ev, handleGesture, { passive: true }));
    return () => {
      clearInterval(checkTimeoutInterval);
      activityEvents.forEach((ev) => window.removeEventListener(ev, handleGesture));
    };
  }, [user, logout, navigate]);

  useEffect(() => {
    if (!user) return;
    const cacheKey = `notifications:${user.employeeId || user.id}`;
    const cached = readSessionCache<SystemNotification[]>(cacheKey);
    if (cached) setNotifications(cached.value);
    let stopped = false;
    let inFlight: Promise<void> | null = null;
    const fetchNotifs = (): Promise<void> => {
      if (!inFlight) {
        inFlight = (async () => {
          try {
            const list = await notificationService.getNotifications(user.employeeId);
            if (stopped) return;
            writeSessionCache(cacheKey, list);
            setNotifications(list);
          } catch (err) {
            console.error(err);
          } finally {
            inFlight = null;
          }
        })();
      }
      return inFlight;
    };
    refreshNotifsRef.current = fetchNotifs;
    // Tier 3: do not compete with GET /api/dashboard on first login.
    // Wait on the SHELL gate (not first-dashboard-critical): a first
    // visit to /workbench /users /leads must still fetch the bell, but
    // must not pretend the later first Dashboard KPI already ran.
    // Panel-open and the 60 s refresh still call fetchNotifs directly.
    if (!cached) {
      void waitForShellStartup().then(() => {
        if (stopped) return;
        void fetchNotifs();
      });
    }
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void fetchNotifs();
    }, NOTIFICATION_REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      refreshNotifsRef.current = () => undefined;
    };
  }, [user]);

  useEffect(() => {
    if (isNotifOpen) void refreshNotifsRef.current();
  }, [isNotifOpen]);

  useEffect(() => {
    // Non-dashboard routes have no KPI request. Release SHELL waiters
    // (notifications / options) so they cannot hang — but do NOT mark
    // first-dashboard-critical. The later first Dashboard load of this
    // session must still sequence GET /api/dashboard ahead of today/
    // upcoming / scheduled.
    if (location.pathname !== '/') markShellStartupSettled();
  }, [location.pathname]);

  /**
   * Left drawer (hamburger) lifecycle: it never survives a navigation, it
   * closes on Escape, and while open the page behind it must not scroll.
   *
   * Closing is the BACK BUTTON's job: opening the drawer pushes one history
   * entry (same URL, marker state) so the device/browser back gesture pops
   * that entry and closes the drawer instead of leaving the page. There is
   * deliberately no in-drawer close/exit control. When the user taps a menu
   * item the marker entry stays behind, so back from the destination page
   * lands on the page they opened the drawer from.
   */
  useEffect(() => {
    setIsSidebarOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const onPopState = () => setIsSidebarOpen(false);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const openSidebar = () => {
    setIsSidebarOpen(true);
    window.history.pushState({ ...(window.history.state || {}), lfSidebar: true }, '');
  };

  const closeSidebar = () => {
    // Pop our own marker entry when it is the current one; popstate then
    // performs the actual close so history stays truthful.
    if (window.history.state?.lfSidebar) {
      window.history.back();
      return;
    }
    setIsSidebarOpen(false);
  };

  useEffect(() => {
    if (!isSidebarOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSidebar();
    };
    window.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSidebarOpen]);

  const syncNotifications = (next: SystemNotification[]) => {
    if (!user) return;
    writeSessionCache(`notifications:${user.employeeId || user.id}`, next);
    setNotifications(next);
  };

  const handleMarkAsRead = async (id: string) => {
    await notificationService.markNotificationAsRead(id);
    syncNotifications(notifications.map(n => n.id === id ? { ...n, read: true } : n));
  };

  const handleMarkAllRead = async () => {
    if (!user) return;
    try {
      await notificationService.markAllNotificationsAsRead(user.employeeId);
      syncNotifications(notifications.map(n => ({ ...n, read: true })));
      toast.success("All notifications marked as read");
    } catch (err) {
      console.error(err);
      toast.error("Failed to mark notifications as read");
    }
  };

  const handleDeleteAll = async () => {
    if (!user) return;
    try {
      await notificationService.deleteAllNotifications(user.employeeId);
      syncNotifications([]);
      toast.success("All notifications deleted successfully");
    } catch (err) {
      console.error(err);
      toast.error("Failed to delete notifications");
    }
  };

  const unreadCount = notifications.filter(n => !n.read).length;

  const [dhakaTime, setDhakaTime] = useState<{ dateStr: string; timeStr: string }>({
    dateStr: '',
    timeStr: ''
  });

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      try {
        const dateStr = now.toLocaleDateString('en-GB', {
          timeZone: 'Asia/Dhaka',
          day: 'numeric',
          month: 'short',
          year: 'numeric'
        });
        const timeStr = now.toLocaleTimeString('en-GB', {
          timeZone: 'Asia/Dhaka',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
        });
        setDhakaTime({ dateStr, timeStr });
      } catch {
        setDhakaTime({
          dateStr: now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
          timeStr: now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true })
        });
      }
    };
    updateTime();
    const intervalId = setInterval(updateTime, 60000);
    return () => clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const onOnline = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  if (!user) return <>{children}</>;

  if (user && user.mustChangePassword) {
    const handleForcedPasswordReset = async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = newPassword.trim();
      if (trimmed.length < 6) {
        toast.error("Security policy requires password to be at least 6 characters.");
        return;
      }
      if (trimmed !== confirmPassword.trim()) {
        toast.error("Confirm password does not match new password.");
        return;
      }
      setPwResetLoading(true);
      try {
        // Dedicated forced first-login flow (POST /api/auth/change-required-password):
        // self-only, no users.edit / admin / Settings capability required. The
        // server returns the authoritative profile with mustChangePassword=false.
        const updatedUser = await userService.changeRequiredPassword(trimmed);
        useAuthStore.getState().setUser(updatedUser);
        setNewPassword('');
        setConfirmPassword('');
        toast.success("Password updated successfully. Welcome to LeadFlow.");
      } catch (err: any) {
        // Server update failed: keep the modal open and the forced state intact.
        toast.error(err.message || "Failed to update password. Try again.");
      } finally {
        setPwResetLoading(false);
      }
    };

    return (
      <div id="forced_reset_container" className="fixed inset-0 bg-[#FDFBF7] z-50 flex items-center justify-center p-6">
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-md w-full bg-white border border-stone-200 p-8 rounded-[12px] shadow-xl space-y-6"
        >
          <div className="space-y-2 text-center">
            <div className="mx-auto w-12 h-12 bg-[#978C21]/10 rounded-full flex items-center justify-center text-[#978C21] mb-2">
              <Lock className="w-6 h-6 animate-pulse" />
            </div>
            <h2 className="text-sm font-black uppercase tracking-[0.18em] text-[#978C21]">Set New Password</h2>
            <p className="text-[11px] text-stone-400 font-medium leading-relaxed">
              For security, create a new password before continuing.
            </p>
          </div>

          <form onSubmit={handleForcedPasswordReset} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-600">New Password</label>
              <input
                type="password"
                required
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Minimum 6 characters"
                className="w-full px-4 py-3 bg-[#FFFCF8] border border-stone-200 focus:border-[#978C21] outline-none text-sm rounded-[10px] transition-all"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-stone-600">Confirm Password</label>
              <input
                type="password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter new password"
                className="w-full px-4 py-3 bg-[#FFFCF8] border border-stone-200 focus:border-[#978C21] outline-none text-sm rounded-[10px] transition-all"
              />
            </div>

            <button
              id="submit_forced_reset"
              type="submit"
              disabled={pwResetLoading}
              className="w-full py-4 bg-[#978C21] hover:bg-[#83781C] text-white font-black text-xs uppercase tracking-widest transition-colors shadow-md flex items-center justify-center gap-2 cursor-pointer rounded-[10px]"
            >
              {pwResetLoading ? 'Updating password...' : 'Update Password & Continue'}
            </button>
          </form>

          {/* Logout stays usable even while the forced-change flag is set. */}
          <button
            type="button"
            onClick={() => { logout(); navigate('/login'); }}
            className="w-full text-center text-xs font-medium text-stone-400 hover:text-red-600 transition-colors cursor-pointer"
          >
            Log out
          </button>
        </motion.div>
      </div>
    );
  }

  const userRoleName = user.role || '';
  const userRoleNormalized = userRoleName.toUpperCase();
  const matchedPermission = rolesPermissions.find(rp => rp.roleId === userRoleName || rp.roleId === userRoleNormalized);
  const isItemVisible = (item: MenuItem): boolean =>
    resolveMenuVisibility(userRoleName, matchedPermission, item);
  const visiblePrimaryItems = PRIMARY_NAV_ITEMS.filter(isItemVisible);
  const isPrimaryItemActive = (path: string) => {
    if (path === '/') return location.pathname === '/';
    if (path === '/workbench') return location.pathname === '/workbench';
    if (path === '/leads') {
      return location.pathname === '/leads'
        || (location.pathname.startsWith('/leads/') && !['/leads/new', '/leads/upload', '/leads/all'].includes(location.pathname));
    }
    if (path === '/leads/new') return location.pathname === '/leads/new';
    return MORE_NAV_PATHS.some(morePath =>
      location.pathname === morePath || location.pathname.startsWith(`${morePath}/`)
    );
  };

  /**
   * Left sidebar contents. Same visibility rule as the router and the
   * retired More → Reports directory: an entry appears only when BOTH the
   * route module (Feature Access) and its functional `view` permission allow
   * the destination — so the drawer can never surface a page the user would
   * be bounced out of.
   */
  const sidebarGroups = buildSidebarGroups({
    canOpen: (route: string) => resolveFeatureRouteAccess(route, userRoleName, matchedPermission),
    canAccess,
  });
  const isSidebarItemActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(`${path}/`);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-[#FDFBF7] flex text-brand-text font-sans">
      <div className="flex-1 flex flex-col min-w-0 bg-[#FDFBF7]">
        <header className="h-[64px] bg-white/90 backdrop-blur-md border-b border-stone-100 px-4 md:px-6 flex items-center justify-between sticky top-0 z-30 flex-shrink-0">
          <button
            type="button"
            id="leadflow-sidebar-toggle"
            className={cn('lf-sidebar-toggle', isSidebarOpen && 'is-active')}
            aria-label="Menu"
            aria-haspopup="dialog"
            aria-expanded={isSidebarOpen}
            aria-controls="leadflow-sidebar"
            onClick={() => (isSidebarOpen ? closeSidebar() : openSidebar())}
          >
            <Menu className="h-[18px] w-[18px]" />
          </button>

          <div className="flex items-center gap-2 lg:hidden">
             <img src="https://lh3.googleusercontent.com/d/1Mv6Wn1SLKO9c-fCyEj2G36dzxpSRNOFO" alt="Shanta Life" className="h-7 w-auto max-w-[112px] object-contain" referrerPolicy="no-referrer" />
          </div>

          <div className="hidden lg:flex items-center gap-3">
             <img 
               src="https://lh3.googleusercontent.com/d/1Mv6Wn1SLKO9c-fCyEj2G36dzxpSRNOFO"
               alt="Shanta Life"
               className="h-8 w-auto object-contain"
               referrerPolicy="no-referrer"
             />
             <div className="hidden md:flex items-center gap-2 ml-4 pl-4 border-l border-stone-100">
                <div className="flex items-center gap-2 bg-[#FFFCF8] border border-stone-100 rounded-full px-3 py-1.5">
                  <Calendar className="w-3.5 h-3.5 text-[#978C21]" />
                  <span className="text-xs font-semibold text-stone-600 tracking-tight" aria-label="Current date">
                    {dhakaTime.dateStr || '—'}
                  </span>
                  <span className="text-stone-300">·</span>
                  <Clock className="w-3.5 h-3.5 text-[#978C21]" />
                  <span className="text-xs font-mono font-bold text-stone-700 tracking-tight" aria-label="Current time">
                    {dhakaTime.timeStr || '--:--'}
                  </span>
                </div>
                {isOffline && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-50 border border-red-200 text-[11px] font-bold text-red-700" role="status" aria-live="polite">
                    <WifiOff className="w-3.5 h-3.5" />
                    Connection degraded
                  </span>
                )}
             </div>
          </div>

          <nav className="leadflow-desktop-nav" aria-label="Primary navigation">
            {visiblePrimaryItems.map(item => {
              const active = isPrimaryItemActive(item.path);
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  aria-current={active ? 'page' : undefined}
                  className={cn('leadflow-desktop-nav-item', active && 'is-active', item.path === '/leads/new' && 'is-primary')}
                >
                  <item.icon className="h-4 w-4" strokeWidth={active ? 2.4 : 1.8} />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="flex md:hidden items-center gap-2">
            <span className="text-xs font-mono font-semibold text-stone-600">{dhakaTime.timeStr || '--:--'}</span>
            {isOffline && <AlertCircle className="w-4 h-4 text-red-500" aria-label="Offline" />}
          </div>

          <div className="flex items-center gap-2 md:gap-3">
             <div className="flex items-center gap-1 md:gap-2">
                <div className="relative">
                   <button 
                     onClick={() => setIsNotifOpen(!isNotifOpen)}
                     className="relative p-2.5 border border-stone-100 rounded-[10px] text-stone-500 hover:text-[#978C21] hover:bg-stone-50 transition-all duration-150 hover:border-stone-200 bg-white shadow-sm"
                     aria-label="Notifications"
                     aria-haspopup="dialog"
                     aria-expanded={isNotifOpen}
                   >
                     <Bell className="w-[18px] h-[18px]" />
                     {unreadCount > 0 && (
                       <span className="absolute -top-1 -right-1 bg-[#F3702B] text-white text-[10px] font-bold h-5 w-5 rounded-full flex items-center justify-center shadow-sm border-2 border-white">
                         {unreadCount > 9 ? '9+' : unreadCount}
                       </span>
                     )}
                   </button>

                   {isNotifOpen && (
                     <>
                       <div 
                         className="fixed inset-0 z-40" 
                         onClick={() => setIsNotifOpen(false)}
                         aria-hidden="true"
                       />
                       <div className="absolute right-0 mt-2 w-[340px] max-w-[92vw] bg-white border border-stone-100 rounded-[12px] shadow-xl py-3 z-50 text-left max-h-[420px] overflow-hidden flex flex-col" role="dialog" aria-label="Notifications">
                         <div className="px-4 py-2.5 border-b border-stone-100 flex justify-between items-center">
                           <span className="text-sm font-bold text-stone-800">Notifications {unreadCount > 0 && `(${unreadCount})`}</span>
                           <button onClick={() => setIsNotifOpen(false)} className="p-1 rounded-full hover:bg-stone-50" aria-label="Close"><X className="w-4 h-4 text-stone-400" /></button>
                          </div>
                          {notifications.length > 0 && (
                            <div className="px-3 py-2 border-b border-stone-50 flex items-center justify-between bg-[#FFFCF8]">
                              <button 
                                onClick={(e) => { e.stopPropagation(); handleMarkAllRead(); }}
                                className="text-xs font-semibold text-[#978C21] hover:underline cursor-pointer px-2 py-1 rounded"
                              >
                                Mark All Read
                              </button>
                              <button 
                                onClick={(e) => { e.stopPropagation(); handleDeleteAll(); }}
                                className="text-xs font-semibold text-red-600 hover:underline cursor-pointer px-2 py-1 rounded"
                              >
                                Delete All
                              </button>
                            </div>
                          )}

                         <div className="divide-y divide-stone-50 overflow-y-auto flex-1">
                           {notifications.length === 0 ? (
                             <div className="px-4 py-10 text-center">
                               <div className="w-10 h-10 rounded-full bg-stone-50 border border-stone-100 flex items-center justify-center mx-auto mb-3"><Bell className="w-5 h-5 text-stone-300" /></div>
                               <p className="text-sm font-medium text-stone-500">No notifications yet</p>
                             </div>
                           ) : (
                             notifications.map((notif) => (
                               <div 
                                 key={notif.id} 
                                 onClick={() => { handleMarkAsRead(notif.id); if (notif.leadId) navigate(`/leads?leadId=${notif.leadId}`); setIsNotifOpen(false); }}
                                 className={cn(
                                   "p-4 hover:bg-stone-50 transition-colors cursor-pointer text-left",
                                   !notif.read ? "bg-[#978C21]/[0.06] border-l-[3px] border-l-[#978C21]" : ""
                                 )}
                                 role="button"
                                 tabIndex={0}
                                 onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleMarkAsRead(notif.id); if (notif.leadId) navigate(`/leads?leadId=${notif.leadId}`); setIsNotifOpen(false); }}}
                               >
                                 <div className="flex justify-between items-start gap-2">
                                    <h5 className="text-sm font-semibold text-stone-800 leading-tight">{notif.title}</h5>
                                    {!notif.read && <span className="w-2 h-2 rounded-full bg-[#978C21] mt-1.5 shrink-0" aria-label="Unread" />}
                                 </div>
                                 <p className="text-[13px] text-stone-500 mt-1.5 leading-relaxed line-clamp-2">{notif.message}</p>
                                 <span className="text-xs text-stone-400 mt-2 block font-mono">
                                   {new Date(notif.date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                                 </span>
                               </div>
                             ))
                           )}
                         </div>
                       </div>
                     </>
                   )}
                </div>
                
                <div className="relative group">
                  <button
                    onClick={() => setIsUserMenuOpen((open) => !open)}
                    className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-full hover:bg-stone-50 transition-colors border border-transparent hover:border-stone-100"
                    aria-haspopup="menu"
                    aria-expanded={isUserMenuOpen}
                    aria-label="User menu"
                  >
                    <div className="w-9 h-9 rounded-full bg-stone-800 flex items-center justify-center border-2 border-white shadow-sm overflow-hidden">
                      {user.avatarUrl ? (
                        <img src={user.avatarUrl} alt={user.name} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                      ) : (
                        <span className="text-white font-bold text-sm">
                          {user.name.charAt(0).toUpperCase()}
                        </span>
                      )}
                    </div>
                    <ChevronRight className="w-3.5 h-3.5 text-stone-400 hidden md:block rotate-90 group-hover:text-stone-600 transition-colors" />
                  </button>
                  {isUserMenuOpen && (
                    <button
                      type="button"
                      className="fixed inset-0 z-40 cursor-default"
                      aria-label="Close user menu"
                      onClick={() => setIsUserMenuOpen(false)}
                    />
                  )}
                  <div className={cn(
                    "absolute right-0 top-[110%] w-64 bg-white rounded-[12px] shadow-xl border border-stone-100 py-2 transition-all duration-150 transform origin-top-right z-50 overflow-hidden",
                    isUserMenuOpen
                      ? "opacity-100 visible"
                      : "opacity-0 invisible group-hover:opacity-100 group-hover:visible group-focus-within:opacity-100 group-focus-within:visible",
                  )} role="menu" aria-label="User menu">
                    <div className="px-5 py-4 border-b border-stone-50">
                      <p className="text-xs text-stone-400 font-medium">Logged in as</p>
                      <p className="text-sm text-stone-800 font-bold truncate mt-1">{user.name}</p>
                      <p className="text-xs text-stone-500 mt-1 truncate">{user.email}</p>
                      <span className="inline-flex mt-2 px-2 py-0.5 bg-[#978C21]/10 text-[#978C21] rounded-full text-[11px] font-bold border border-[#978C21]/20">{user.role}</span>
                    </div>
                    <button 
                      onClick={handleLogout}
                      className="w-full px-5 py-3 flex items-center gap-3 text-red-600 hover:bg-red-50 text-sm font-semibold transition-colors text-left"
                      role="menuitem"
                    >
                      <LogOut className="w-4 h-4" />
                      Logout
                    </button>
                  </div>
                </div>
             </div>
          </div>
        </header>

        <main className="leadflow-main flex-1 p-4 md:p-6 lg:p-8 overflow-y-auto">
          {children}
        </main>
      </div>
      {/* ----------------------------------------------------------------
          Left sidebar (drawer). It replaces More → Reports: the analytics
          pages, the workspace pages, Roadshow Follow-up and the Sales
          Pipeline live here, permission-filtered, one tap from anywhere.
          Nothing listed here is duplicated in More.
          ---------------------------------------------------------------- */}
      {isSidebarOpen && (
        <>
          <div
            className="lf-sidebar-scrim is-open"
            onClick={closeSidebar}
            aria-hidden="true"
          />
          <aside
            id="leadflow-sidebar"
            className="lf-sidebar is-open"
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
          >
            <div className="lf-sidebar-head">
              <span className="lf-sidebar-title">Menu</span>
            </div>
            <nav className="lf-sidebar-body" aria-label="Sidebar navigation">
              {sidebarGroups.map(group => (
                <div key={group.title} className="lf-sidebar-group">
                  <p className="lf-sidebar-group-title">{group.title}</p>
                  {group.items.map(item => {
                    const active = isSidebarItemActive(item.path);
                    return (
                      <Link
                        key={item.path}
                        to={item.path}
                        className={cn('lf-sidebar-item', active && 'is-active')}
                        aria-current={active ? 'page' : undefined}
                        onClick={() => setIsSidebarOpen(false)}
                      >
                        <span className="lf-sidebar-item-icon">
                          <item.icon className="h-[18px] w-[18px]" strokeWidth={1.9} />
                        </span>
                        <span className="lf-sidebar-item-copy">
                          <strong>{item.label}</strong>
                          <small>{item.description}</small>
                        </span>
                        <ChevronRight className="lf-sidebar-item-arrow" />
                      </Link>
                    );
                  })}
                </div>
              ))}
              {sidebarGroups.length === 0 && (
                <p className="lf-sidebar-empty">No additional pages are enabled for your role.</p>
              )}
            </nav>
          </aside>
        </>
      )}

      <nav className="leadflow-mobile-nav" aria-label="Primary mobile navigation">
        {visiblePrimaryItems.map(item => {
          const active = isPrimaryItemActive(item.path);
          return <Link key={item.path} to={item.path} aria-current={active ? "page" : undefined} className={cn("leadflow-mobile-nav-item", item.path === "/leads/new" && "leadflow-mobile-nav-item--primary", active && "is-active")}><item.icon className="h-[19px] w-[19px]" strokeWidth={active ? 2.4 : 1.8} /><span>{item.label}</span></Link>;
        })}
      </nav>
    </div>
  );
}
