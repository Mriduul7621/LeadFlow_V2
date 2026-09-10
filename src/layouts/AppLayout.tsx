import React, { useState, useEffect } from 'react';
import { 
  LayoutDashboard, 
  UserPlus, 
  Upload, 
  ClipboardList, 
  Users, 
  History, 
  Settings, 
  ChevronRight,
  LogOut,
  RefreshCw,
  Calendar,
  Clock,
  Menu,
  X,
  Bell,
  Database,
  TrendingUp,
  PieChart as PieIcon,
  Target,
  Lock
} from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../modules/auth/store/authStore';
import { UserRole, SystemNotification, RolePermission } from '../modules/shared/types';
import { cn } from '../lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { notificationService } from '../modules/notifications/services/notificationService';
import { databaseStatusService } from '../services/syncService';
import { adminService } from '../modules/admin/services/adminService';
import { userService } from '../modules/users/services/userService';
import { toast } from 'sonner';
import { useTranslation } from '../modules/shared/utils/translations';
import {
  readSessionCache,
  writeSessionCache,
} from '../modules/shared/api/sessionCache';
import { resolveMenuVisibility } from './menuVisibility';

const labelToTranslationKey: Record<string, string> = {
  'Dashboard': 'navDashboard',
  'Add New Lead': 'navLeadGenerate',
  'Bulk Upload': 'navLeadUpload',
  'All Leads': 'navAllLeads',
  'Lead Tracking': 'navLeadTracking',
  'Performance': 'navExecutionIntell',
  'NCP Progress': 'navNcpProgress',
  'Trends': 'navTrendCharts',
  'Campaigns': 'navCampaignBreakdown',
  'Follow-up Queue': 'navFollowUpQueue',
  'Task Calendar': 'navTaskCalendar',
  'Activities': 'navActivities',
  'Team': 'navTeamProgress',
  'Users': 'navUserManagement',
  'Settings': 'navSettings',
};

interface MenuItem {
  label: string;
  icon: any;
  path: string;
  roles: UserRole[];
}

interface MenuSection {
  key: string;
  labelKey: string;
  items: MenuItem[];
}

const ALL_ROLES = Object.values(UserRole);
const INSIGHT_ROLES = [UserRole.ADMIN, UserRole.RO, UserRole.RM];
const TEAM_ROLES = [
  UserRole.ADMIN,
  UserRole.RM,
  UserRole.ASM,
  UserRole.BDM,
  UserRole.BUSINESS_EXECUTIVE,
  UserRole.BUSINESS_HEAD,
];

/**
 * Grouped sidebar navigation (Step 5B). Each item keeps the SAME path and
 * role/`menuAccess` semantics as the previous flat menu — grouping is purely
 * visual and never changes what a role is allowed to see.
 *
 * Every path below maps to a real, existing route registered in App.tsx.
 * No dead links and no invented routes (e.g. there is deliberately no
 * dedicated "Pipeline" route yet).
 */
const menuSections: MenuSection[] = [
  {
    key: 'overview',
    labelKey: 'navSectionOverview',
    items: [
      { label: 'Dashboard', icon: LayoutDashboard, path: '/', roles: ALL_ROLES },
    ],
  },
  {
    key: 'mywork',
    labelKey: 'navSectionMyWork',
    items: [
      { label: 'Activities', icon: Clock, path: '/activities', roles: ALL_ROLES },
      { label: 'Task Calendar', icon: Calendar, path: '/task-calendar', roles: ALL_ROLES },
      { label: 'Follow-up Queue', icon: History, path: '/follow-up', roles: ALL_ROLES },
    ],
  },
  {
    key: 'leads',
    labelKey: 'navSectionLeads',
    items: [
      { label: 'Lead Tracking', icon: ClipboardList, path: '/leads', roles: ALL_ROLES },
      { label: 'Add New Lead', icon: UserPlus, path: '/leads/new', roles: ALL_ROLES },
      { label: 'Bulk Upload', icon: Upload, path: '/leads/upload', roles: [UserRole.ADMIN] },
      { label: 'All Leads', icon: Database, path: '/leads/all', roles: [UserRole.ADMIN] },
    ],
  },
  {
    key: 'insights',
    labelKey: 'navSectionInsights',
    items: [
      { label: 'Performance', icon: LayoutDashboard, path: '/execution-intelligence', roles: INSIGHT_ROLES },
      { label: 'NCP Progress', icon: TrendingUp, path: '/ncp-progress', roles: INSIGHT_ROLES },
      { label: 'Trends', icon: Target, path: '/trend-charts', roles: INSIGHT_ROLES },
      { label: 'Campaigns', icon: PieIcon, path: '/campaign-breakdown', roles: INSIGHT_ROLES },
    ],
  },
  {
    key: 'management',
    labelKey: 'navSectionManagement',
    items: [
      { label: 'Team', icon: Users, path: '/team', roles: TEAM_ROLES },
      { label: 'Users', icon: Users, path: '/users', roles: [UserRole.ADMIN] },
    ],
  },
  {
    key: 'system',
    labelKey: 'navSectionSystem',
    items: [
      { label: 'Settings', icon: Settings, path: '/settings', roles: ALL_ROLES },
    ],
  },
];

/**
 * Session-scoped freshness for shared session data (per user, in-memory):
 * the layout remounts on every route change, so these values are reused
 * across navigations instead of being re-requested on every click.
 */
const ROLE_MENU_TTL_MS = 5 * 60 * 1000;
const NOTIFICATION_REFRESH_MS = 60_000;

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { t, language, setLanguage } = useTranslation();
  const { user, logout } = useAuthStore();
  const location = useLocation();
  const navigate = useNavigate();
  const [isSidebarOpen, setIsSidebarOpen] = React.useState(true);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = React.useState(false);
  const [notifications, setNotifications] = useState<SystemNotification[]>([]);
  const [isNotifOpen, setIsNotifOpen] = useState(false);
  const [rolesPermissions, setRolesPermissions] = useState<RolePermission[]>([]);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwResetLoading, setPwResetLoading] = useState(false);
  /** Latest notification refresher (panel-open refresh, no stale closure). */
  const refreshNotifsRef = React.useRef<() => void>(() => undefined);

  /**
   * Role / menu permissions — session-scoped, NO 6-second polling.
   * - Served instantly from the in-memory session cache when fresh, so a
   *   navigation (which remounts this layout) performs zero requests.
   * - Fetched once per session when absent or stale.
   * - Invalidated by the explicit role/permission save flows
   *   (adminService) — the saved change then takes effect immediately.
   * - A conservative tick re-checks at most every 5 minutes and only
   *   while the tab is visible (not seconds-level polling).
   */
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

  // 30-Minute Inactivity Session Timeout with Multi-Tab Synchronization
  useEffect(() => {
    if (!user) return;

    // Ensure initial timestamp is established
    if (!localStorage.getItem('leadflow_last_activity')) {
      localStorage.setItem('leadflow_last_activity', Date.now().toString());
    }

    // Set up a periodic background check (every 2 seconds)
    const checkTimeoutInterval = setInterval(() => {
      const lastActivityStr = localStorage.getItem('leadflow_last_activity');
      if (!lastActivityStr) return;
      
      const lastActivity = parseInt(lastActivityStr, 10);
      const now = Date.now();
      
      if (now - lastActivity > 1800000) { // 30 minutes = 1,800,000ms
        clearInterval(checkTimeoutInterval);
        toast.error("Session expired due to 30 minutes of inactivity.", {
          duration: 7000,
          id: "session-timeout-toast"
        });
        logout();
        navigate('/login');
      }
    }, 2000);

    // Track user active gestures in this tab with a 1-second write throttle
    let lastWriteTime = 0;
    const handleGesture = () => {
      const now = Date.now();
      if (now - lastWriteTime > 1000) {
        localStorage.setItem('leadflow_last_activity', now.toString());
        lastWriteTime = now;
      }
    };

    const activityEvents = [
      'mousedown',
      'mousemove',
      'keydown',
      'scroll',
      'touchstart',
      'click'
    ];

    activityEvents.forEach((ev) => {
      window.addEventListener(ev, handleGesture, { passive: true });
    });

    return () => {
      clearInterval(checkTimeoutInterval);
      activityEvents.forEach((ev) => {
        window.removeEventListener(ev, handleGesture);
      });
    };
  }, [user, logout, navigate]);

  /**
   * Notifications — NO 8-second polling.
   * - Initial fetch once per session (session cache makes the layout
   *   remount-on-navigation free).
   * - Refreshed when the panel is opened (explicit user action), and the
   *   mutation handlers below sync DB-backed state after the server
   *   confirms each change.
   * - A low-frequency (60s) background refresh keeps the unread badge
   *   reasonably current; it is paused while the tab is hidden.
   * - localStorage remains a read-only offline cache — the DB/API stays
   *   authoritative.
   */
  useEffect(() => {
    if (!user) return;
    const cacheKey = `notifications:${user.employeeId || user.id}`;
    const cached = readSessionCache<SystemNotification[]>(cacheKey);
    if (cached) setNotifications(cached.value);

    let stopped = false;
    let inFlight: Promise<void> | null = null;
    const fetchNotifs = (): Promise<void> => {
      // In-flight de-duplication: opening the panel while the session
      // fetch is still running must not double the request.
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

    if (!cached) void fetchNotifs();

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

  // Opening the panel is an explicit user action: fetch fresh.
  useEffect(() => {
    if (isNotifOpen) void refreshNotifsRef.current();
  }, [isNotifOpen]);

  /** Apply a server-confirmed notification mutation to state AND cache. */
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

  const [dhakaTime, setDhakaTime] = useState<{ dateStr: string; dayStr: string; timeStr: string }>({
    dateStr: '',
    dayStr: '',
    timeStr: ''
  });

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      try {
        const dateStr = now.toLocaleDateString('en-US', {
          timeZone: 'Asia/Dhaka',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });

        const dayStr = now.toLocaleDateString('en-US', {
          timeZone: 'Asia/Dhaka',
          weekday: 'long'
        });

        const timeStr = now.toLocaleTimeString('en-US', {
          timeZone: 'Asia/Dhaka',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: true
        });

        setDhakaTime({ dateStr, dayStr, timeStr });
      } catch (e) {
        // Fallback if timezone not supported (though universally is)
        setDhakaTime({
          dateStr: now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
          dayStr: now.toLocaleDateString('en-US', { weekday: 'long' }),
          timeStr: now.toLocaleTimeString('en-US')
        });
      }
    };

    updateTime();
    const intervalId = setInterval(updateTime, 1000);
    return () => clearInterval(intervalId);
  }, []);

  const [isSyncing, setIsSyncing] = useState(false);

  const handleSync = async () => {
    setIsSyncing(true);
    toast.loading("Checking database connection...", { id: "sync-toast" });
    try {
      const result = await databaseStatusService.checkDatabaseStatus();
      if (result && result.connected) {
        toast.success("Connected to the cloud database. All data is stored in PostgreSQL.", { id: "sync-toast" });
      } else {
        toast.error(result?.message || "Database connection failed. Changes cannot be persisted right now.", { id: "sync-toast" });
      }
    } catch (err) {
      toast.error("Could not verify the database connection.", { id: "sync-toast" });
    } finally {
      setIsSyncing(false);
    }
  };

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
        await userService.updateUser(user.id, {
          password: trimmed,
          mustChangePassword: false
        });
        useAuthStore.getState().login({
          ...user,
          mustChangePassword: false,
          password: undefined
        }, useAuthStore.getState().token || undefined, useAuthStore.getState().isOfflineMode);
        toast.success("Password successfully rotated! Welcome to Shanta Lead Flow Client System.");
      } catch (err: any) {
        toast.error(err.message || "Failed to update password. Try again.");
      } finally {
        setPwResetLoading(false);
      }
    };

    return (
      <div id="forced_reset_container" className="fixed inset-0 bg-[#F9F9F4] z-50 flex items-center justify-center p-6">
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-md w-full bg-white border border-slate-200 p-8 rounded-sm shadow-2xl space-y-6"
        >
          <div className="space-y-2 text-center">
            <div className="mx-auto w-12 h-12 bg-[#978C21]/10 rounded-full flex items-center justify-center text-[#978C21] mb-2">
              <Lock className="w-6 h-6 animate-pulse" />
            </div>
            <h2 className="text-sm font-black uppercase tracking-[0.2em] text-[#978C21] italic">Rotate Password</h2>
            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider leading-relaxed">
              For security compliance, you must rotate your temporary password upon onboarding.
            </p>
          </div>

          <form onSubmit={handleForcedPasswordReset} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-600">New Password</label>
              <input
                type="password"
                required
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="MINIMUM 6 CHARACTERS"
                className="w-full px-4 py-3 bg-[#FBFAF8] border border-slate-200 focus:border-[#978C21] outline-none text-xs rounded-none transition-all uppercase tracking-widest font-mono"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-600">Confirm Password</label>
              <input
                type="password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="RE-ENTER NEW PASSWORD"
                className="w-full px-4 py-3 bg-[#FBFAF8] border border-slate-200 focus:border-[#978C21] outline-none text-xs rounded-none transition-all uppercase tracking-widest font-mono"
              />
            </div>

            <button
              id="submit_forced_reset"
              type="submit"
              disabled={pwResetLoading}
              className="w-full py-4 bg-[#978C21] hover:bg-[#83781C] text-white font-black text-xs uppercase tracking-widest italic transition-colors shadow-lg shadow-[#978C21]/20 flex items-center justify-center gap-2 cursor-pointer"
            >
              {pwResetLoading ? 'Rotating credentials...' : 'Rotate and Log In'}
            </button>
          </form>
        </motion.div>
      </div>
    );
  }

  const userRoleName = user.role || '';
  const userRoleNormalized = userRoleName.toUpperCase();
  // ADMIN bypass is preserved (see resolveMenuVisibility in
  // menuVisibility.ts): the admin always sees every menu item.
  const isAdminUser = userRoleNormalized === 'ADMIN';
  const matchedPermission = rolesPermissions.find(rp => rp.roleId === userRoleName || rp.roleId === userRoleNormalized);

  /**
   * Single, authoritative visibility check used by BOTH the grouped sidebar
   * and the mobile drawer. Semantics are unchanged from the previous flat
   * menu: ADMIN always sees everything, then the dynamic role `menuAccess`
   * override wins when configured, otherwise the static role fallback
   * applies (the `item.roles` check, i.e. roles.includes on the raw role).
   *
   * The exact precedence lives in menuVisibility.ts (resolveMenuVisibility)
   * so it is unit-testable without rendering the layout.
   */
  const isItemVisible = (item: MenuItem): boolean => {
    void isAdminUser; // document the bypass; enforced inside resolveMenuVisibility
    return resolveMenuVisibility(userRoleName, matchedPermission, item);
  };

  // Sections are only rendered when at least one of their items is visible,
  // so grouping can never surface a route that the permission model hides.
  const visibleSections = menuSections
    .map(section => ({ ...section, items: section.items.filter(isItemVisible) }))
    .filter(section => section.items.length > 0);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-white flex text-slate-900 font-sans">
      {/* Sidebar - Desktop */}
      <motion.aside 
        initial={false}
        animate={{ width: isSidebarOpen ? 280 : 80 }}
        className="hidden lg:flex flex-col bg-[#F9F9F4] border-r border-slate-100 sticky top-0 h-screen z-40 transition-all duration-300 shadow-sm"
      >
        <div className={cn("p-8 mb-4", !isSidebarOpen && "flex justify-center")}>
          {isSidebarOpen ? (
            <div className="flex items-center">
               <img 
                 src="https://lh3.googleusercontent.com/d/1Mv6Wn1SLKO9c-fCyEj2G36dzxpSRNOFO"
                 alt="Shanta Life Logo"
                 className="h-12 w-auto object-contain"
                 referrerPolicy="no-referrer"
               />
            </div>
          ) : (
             <div className="flex items-center justify-center">
                <img 
                  src="https://lh3.googleusercontent.com/d/1Mv6Wn1SLKO9c-fCyEj2G36dzxpSRNOFO"
                  alt="Shanta Life Logo"
                  className="h-7 w-auto object-contain animate-pulse-slow"
                  referrerPolicy="no-referrer"
                />
             </div>
          )}
        </div>

        <nav className="flex-1 px-4 space-y-1.5 overflow-y-auto">
          {visibleSections.map((section, sectionIndex) => (
            <React.Fragment key={section.key}>
              {isSidebarOpen ? (
                <div className={cn("pt-3 pb-1 px-4 first:pt-0", sectionIndex > 0 && "mt-2")}>
                  <p className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-300 select-none">
                    {t(section.labelKey as any)}
                  </p>
                </div>
              ) : (
                sectionIndex > 0 && <div className="my-2 border-t border-slate-100" aria-hidden="true" />
              )}
              {section.items.map((item) => {
                const isActive = location.pathname === item.path;
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    title={item.label}
                    className={cn(
                      "flex items-center gap-3 px-4 py-2.5 rounded-lg transition-all duration-200 group relative text-sm font-medium",
                      isActive 
                        ? "bg-[#978C21] text-white shadow-lg shadow-[#978C21]/20" 
                        : "text-slate-400 hover:text-brand-text hover:bg-white"
                    )}
                  >
                    <item.icon className={cn("w-4 h-4 shrink-0", isActive ? "text-white" : "group-hover:text-[#978C21]")} />
                    {isSidebarOpen && <span className="whitespace-nowrap">{t(labelToTranslationKey[item.label] as any) || item.label}</span>}
                  </Link>
                );
              })}
            </React.Fragment>
          ))}
        </nav>

        <div className="p-4 border-t border-slate-100">
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="w-full h-8 flex items-center justify-center rounded-sm hover:bg-slate-100 text-slate-400 transition-colors"
          >
            <ChevronRight className={cn("w-4 h-4 transition-transform duration-300", isSidebarOpen && "rotate-180")} />
          </button>
        </div>
      </motion.aside>

      {/* Mobile Menu */}
      <AnimatePresence>
        {isMobileMenuOpen && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsMobileMenuOpen(false)}
              className="fixed inset-0 bg-slate-900/40 z-50 lg:hidden backdrop-blur-sm"
            />
            <motion.aside
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              className="fixed left-0 top-0 bottom-0 w-72 bg-white z-50 lg:hidden h-full"
            >
              <div className="p-6 flex items-center justify-between border-b border-slate-100">
                <div className="flex items-center">
                   <img 
                     src="https://lh3.googleusercontent.com/d/1Mv6Wn1SLKO9c-fCyEj2G36dzxpSRNOFO"
                     alt="Shanta Life Logo"
                     className="h-10 w-auto object-contain"
                     referrerPolicy="no-referrer"
                   />
                </div>
                <button onClick={() => setIsMobileMenuOpen(false)} className="p-2 hover:bg-slate-50 rounded-full">
                  <X className="w-5 h-5 text-slate-400" />
                </button>
              </div>
              <nav className="p-4 space-y-1 overflow-y-auto h-[calc(100%-5rem)]">
                {visibleSections.map((section, sectionIndex) => (
                  <React.Fragment key={section.key}>
                    <div className={cn("pt-3 pb-1 px-3 first:pt-0", sectionIndex > 0 && "mt-1")}>
                      <p className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-300 select-none">
                        {t(section.labelKey as any)}
                      </p>
                    </div>
                    {section.items.map((item) => {
                      const isActive = location.pathname === item.path;
                      return (
                        <Link
                          key={item.path}
                          to={item.path}
                          onClick={() => setIsMobileMenuOpen(false)}
                          className={cn(
                            "flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors",
                            isActive ? "bg-slate-50 text-[#978C21]" : "text-slate-400 hover:bg-slate-50"
                          )}
                        >
                          <item.icon className="w-4 h-4" />
                          <span>{t(labelToTranslationKey[item.label] as any) || item.label}</span>
                        </Link>
                      );
                    })}
                  </React.Fragment>
                ))}
              </nav>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <div className="flex-1 flex flex-col min-w-0 bg-white">
        {/* Top Header */}
        <header className="h-20 bg-white border-b border-slate-100 px-8 flex items-center justify-between sticky top-0 z-30 flex-shrink-0">
          <div className="flex items-center gap-4 lg:hidden">
             <button onClick={() => setIsMobileMenuOpen(true)} className="p-2 -ml-2">
                <Menu className="w-6 h-6 text-slate-400" />
             </button>
          </div>

          <div className="hidden lg:flex items-center select-none">
             <img 
               src="https://lh3.googleusercontent.com/d/1Mv6Wn1SLKO9c-fCyEj2G36dzxpSRNOFO"
               alt="Shanta Life Logo"
               className="h-12 w-auto object-contain"
               referrerPolicy="no-referrer"
             />
          </div>

          <div className="flex items-center gap-6">
             <div className="hidden md:flex items-center">
                <span className="text-[11px] font-black text-[#978C21] capitalize tracking-wider italic mr-6">Dhaka Standard Time</span>
                <div className="flex items-center border border-slate-100 rounded-sm divide-x divide-slate-50 px-2 py-1 shadow-sm bg-[#FBFAF8]">
                   <div className="px-4 py-1.5 flex items-center gap-3">
                      <Calendar className="w-3.5 h-3.5 text-[#978C21]" />
                      <span className="text-[10px] font-black text-slate-600 italic tracking-wider leading-none">
                        {dhakaTime.dayStr ? `${dhakaTime.dayStr.substring(0, 3)}, ${dhakaTime.dateStr}` : 'Loading Date...'}
                      </span>
                   </div>
                   <div className="px-4 py-1.5 flex items-center gap-3 bg-white shadow-inner rounded-sm">
                      <Clock className="w-3.5 h-3.5 text-[#978C21]" />
                      <span className="text-[10px] font-mono font-black text-slate-800 tracking-widest leading-none">
                        {dhakaTime.timeStr || '--:--:-- --'}
                      </span>
                   </div>
                </div>
             </div>
             
             <div className="h-6 w-px bg-slate-100 mx-2" />

             {/* Premium Language Switcher inside App Layout Header */}
             <div className="flex items-center gap-1 bg-slate-100 border border-slate-200/50 p-1 rounded-full shadow-inner" id="layout-language-switcher">
               <button
                 type="button"
                 onClick={() => setLanguage('en')}
                 className={cn(
                   "px-2.5 py-1 text-[8px] font-black uppercase tracking-wider rounded-full transition-all cursor-pointer",
                   language === 'en'
                     ? "bg-[#978C21] text-white shadow-sm"
                     : "text-slate-400 hover:text-slate-600"
                 )}
               >
                 EN
               </button>
               <button
                 type="button"
                 onClick={() => setLanguage('bn')}
                 className={cn(
                   "px-2.5 py-1 text-[8px] font-black uppercase tracking-wider rounded-full transition-all cursor-pointer",
                   language === 'bn'
                     ? "bg-[#978C21] text-white shadow-sm"
                     : "text-slate-400 hover:text-slate-600"
                 )}
               >
                 BN
               </button>
             </div>

             <div className="h-6 w-px bg-slate-100 mx-2" />

             <div className="flex items-center gap-4">
                <button 
                  onClick={handleSync}
                  disabled={isSyncing}
                  title={isSyncing ? "Syncing..." : "Sync data with cloud"}
                  className={cn(
                    "p-2.5 border border-slate-100 rounded-sm hover:text-[#978C21] hover:bg-slate-50 transition-all shadow-sm flex items-center justify-center gap-2",
                    isSyncing ? "text-slate-400 bg-slate-50 border-slate-200 cursor-not-allowed" : "text-[#978C21]"
                  )}
                >
                   <RefreshCw className={cn("w-4 h-4", isSyncing && "animate-spin")} />
                   <span className="hidden md:inline text-sm font-medium text-[#978C21]">
                     {isSyncing ? "Syncing..." : "Sync"}
                   </span>
                </button>

                {/* Real-time Notification Bell container */}
                <div className="relative">
                   <button 
                     onClick={() => setIsNotifOpen(!isNotifOpen)}
                     className="relative p-2.5 border border-slate-100 rounded-sm text-slate-400 hover:text-[#978C21] hover:bg-slate-50 transition-all shadow-sm"
                   >
                     <Bell className="w-4 h-4" />
                     {unreadCount > 0 && (
                       <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[8px] font-bold h-4 w-4 rounded-full flex items-center justify-center animate-pulse">
                         {unreadCount}
                       </span>
                     )}
                   </button>

                   {isNotifOpen && (
                     <>
                       <div 
                         className="fixed inset-0 z-40" 
                         onClick={() => setIsNotifOpen(false)}
                       />
                       <div className="absolute right-0 mt-2 w-[330px] bg-white border border-slate-100 rounded-sm shadow-2xl py-3 z-50 text-left max-h-96 overflow-y-auto">
                         <div className="px-4 py-2 border-b border-slate-50 flex justify-between items-center">
                           <span className="text-sm font-semibold text-slate-800">🔔 Notifications ({unreadCount} new)</span>
                          </div>
                          {notifications.length > 0 && (
                            <div className="px-4 py-1.5 border-b border-slate-50 flex items-center justify-between bg-[#FDFDFB]">
                              <button 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleMarkAllRead();
                                }}
                                className="text-xs font-medium text-[#978C21] hover:underline cursor-pointer"
                              >
                                Mark All Read
                              </button>
                              <button 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteAll();
                                }}
                                className="text-xs font-medium text-red-500 hover:underline cursor-pointer"
                              >
                                Delete All
                              </button>
                            </div>
                          )}

                         <div className="divide-y divide-slate-50">
                           {notifications.length === 0 ? (
                             <div className="px-4 py-8 text-center text-sm text-slate-400">
                               No notifications yet
                             </div>
                           ) : (
                             notifications.map((notif) => (
                               <div 
                                 key={notif.id} 
                                 onClick={() => {
                                   handleMarkAsRead(notif.id); if (notif.leadId) navigate(`/leads?leadId=${notif.leadId}`);
                                   setIsNotifOpen(false);
                                 }}
                                 className={cn(
                                   "p-4 hover:bg-slate-50 transition-colors cursor-pointer text-left",
                                   !notif.read ? "bg-[#978C21]/5 border-l-2 border-[#978C21]" : ""
                                 )}
                               >
                                 <div className="flex justify-between items-start gap-2">
                                    <h5 className="text-sm font-medium text-slate-800">{notif.title}</h5>
                                    {!notif.read && <span className="bg-[#978C21] h-1.5 w-1.5 rounded-full" />}
                                 </div>
                                 <p className="text-sm text-slate-500 mt-1 leading-relaxed">{notif.message}</p>
                                 <span className="text-xs text-slate-400 mt-2 block">
                                   {new Date(notif.date).toLocaleTimeString()}
                                 </span>
                               </div>
                             ))
                           )}
                         </div>
                       </div>
                     </>
                   )}
                </div>
                
                <div className="relative group cursor-pointer">
                  <div className="flex items-center gap-3 pl-2">
                    <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center border-2 border-slate-200 shadow-sm overflow-hidden">
                      {user.avatarUrl ? (
                        <img src={user.avatarUrl} alt={user.name} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                      ) : (
                        <span className="text-white font-semibold text-base">
                          {user.name.charAt(0).toUpperCase()}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* Profile Popup */}
                  <div className="absolute right-0 top-[120%] w-64 bg-white rounded-sm shadow-2xl border border-slate-100 py-3 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-300 transform origin-top-right scale-95 group-hover:scale-100 z-50">
                    <div className="px-6 py-4 border-b border-slate-50 mb-2">
                      <p className="text-xs text-slate-400 mb-2">Logged in as</p>
                      <p className="text-base text-slate-800 font-semibold truncate">{user.name}</p>
                      <p className="text-sm text-slate-400 mt-1">{user.email}</p>
                    </div>
                    <button 
                      onClick={handleLogout}
                      className="w-full px-6 py-4 flex items-center gap-4 text-red-500 hover:bg-red-50 text-sm font-medium transition-colors"
                    >
                      <LogOut className="w-4 h-4" />
                      Logout
                    </button>
                  </div>
                </div>
             </div>
          </div>
        </header>

        {/* Main Content Area */}
        <main className="flex-1 p-10 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
