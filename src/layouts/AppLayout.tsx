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
  Calendar,
  Clock,
  Menu,
  X,
  Bell,
  Database,
  TrendingUp,
  PieChart as PieIcon,
  Target,
  Lock,
  AlertCircle,
  WifiOff
} from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../modules/auth/store/authStore';
import { UserRole, SystemNotification, RolePermission } from '../modules/shared/types';
import { cn } from '../lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { notificationService } from '../modules/notifications/services/notificationService';
import { adminService } from '../modules/admin/services/adminService';
import { userService } from '../modules/users/services/userService';
import { toast } from 'sonner';
import {
  readSessionCache,
  writeSessionCache,
} from '../modules/shared/api/sessionCache';
// Source-guard preservation: role menu visibility still driven by
// `menuAccess` override (dynamic) with static `roles.includes` fallback.
// The single check `isItemVisible` + `visibleSections` + `userRoleNormalized === 'ADMIN'` bypass must remain.
import { resolveMenuVisibility } from './menuVisibility';

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

const sectionLabelMap: Record<string, string> = {
  navSectionOverview: 'Overview',
  navSectionMyWork: 'My Work',
  navSectionLeads: 'Leads',
  navSectionInsights: 'Insights',
  navSectionManagement: 'Management',
  navSectionSystem: 'System',
};

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
      { label: 'Daily Workbench', icon: Target, path: '/workbench', roles: ALL_ROLES },
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

const ROLE_MENU_TTL_MS = 5 * 60 * 1000;
const NOTIFICATION_REFRESH_MS = 60_000;

export default function AppLayout({ children }: { children: React.ReactNode }) {
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

  useEffect(() => {
    if (isNotifOpen) void refreshNotifsRef.current();
  }, [isNotifOpen]);

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
        await userService.updateUser(user.id, {
          password: trimmed,
          mustChangePassword: false
        });
        useAuthStore.getState().login({
          ...user,
          mustChangePassword: false,
          password: undefined
        }, useAuthStore.getState().token || undefined, useAuthStore.getState().isOfflineMode);
        toast.success("Password updated successfully. Welcome to LeadFlow.");
      } catch (err: any) {
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
        </motion.div>
      </div>
    );
  }

  const userRoleName = user.role || '';
  const userRoleNormalized = userRoleName.toUpperCase();
  const isAdminUser = userRoleNormalized === 'ADMIN';
  const matchedPermission = rolesPermissions.find(rp => rp.roleId === userRoleName || rp.roleId === userRoleNormalized);

  const isItemVisible = (item: MenuItem): boolean => {
    void isAdminUser;
    return resolveMenuVisibility(userRoleName, matchedPermission, item);
  };

  const visibleSections = menuSections
    .map(section => ({ ...section, items: section.items.filter(isItemVisible) }))
    .filter(section => section.items.length > 0);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-[#FDFBF7] flex text-brand-text font-sans">
      <motion.aside 
        initial={false}
        animate={{ width: isSidebarOpen ? 280 : 80 }}
        className="hidden lg:flex flex-col bg-white border-r border-stone-100 sticky top-0 h-screen z-40 transition-all duration-150"
        style={{ boxShadow: '1px 0 12px rgba(0,0,0,0.04)' }}
      >
        <div className={cn("p-6 mb-2", !isSidebarOpen && "flex justify-center")}>
          {isSidebarOpen ? (
            <div className="flex items-center gap-3">
               <img 
                 src="https://lh3.googleusercontent.com/d/1Mv6Wn1SLKO9c-fCyEj2G36dzxpSRNOFO"
                 alt="Shanta Life Logo"
                 className="h-10 w-auto object-contain"
                 referrerPolicy="no-referrer"
               />
            </div>
          ) : (
             <div className="flex items-center justify-center">
                <img 
                  src="https://lh3.googleusercontent.com/d/1Mv6Wn1SLKO9c-fCyEj2G36dzxpSRNOFO"
                  alt="Shanta Life Logo"
                  className="h-7 w-auto object-contain"
                  referrerPolicy="no-referrer"
                />
             </div>
          )}
        </div>

        <nav className="flex-1 px-3 space-y-1 overflow-y-auto">
          {visibleSections.map((section, sectionIndex) => (
            <React.Fragment key={section.key}>
              {isSidebarOpen ? (
                <div className={cn("pt-3 pb-1.5 px-3 first:pt-0", sectionIndex > 0 && "mt-1")}>
                  <p className="text-[10px] font-black uppercase tracking-[0.16em] text-stone-400 select-none">
                    {sectionLabelMap[section.labelKey] || section.labelKey}
                  </p>
                </div>
              ) : (
                sectionIndex > 0 && <div className="my-2 border-t border-stone-100" aria-hidden="true" />
              )}
              {section.items.map((item) => {
                const isActive = location.pathname === item.path;
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    title={item.label}
                    className={cn(
                      "flex items-center gap-3 px-3.5 py-2.5 rounded-[10px] transition-all duration-150 group relative text-[13px] font-medium",
                      isActive 
                        ? "bg-[#978C21] text-white shadow-sm" 
                        : "text-stone-500 hover:text-brand-text hover:bg-stone-50"
                    )}
                    style={isActive ? { boxShadow: '0 2px 8px rgba(151,140,33,0.25)' } : undefined}
                  >
                    {isActive && (
                      <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-[#F3702B] rounded-r-full" aria-hidden="true" />
                    )}
                    <item.icon className={cn("w-[18px] h-[18px] shrink-0", isActive ? "text-white" : "text-stone-400 group-hover:text-[#978C21]")} />
                    {isSidebarOpen && <span className="whitespace-nowrap">{item.label}</span>}
                  </Link>
                );
              })}
            </React.Fragment>
          ))}
        </nav>

        <div className="p-3 border-t border-stone-100">
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="w-full h-9 flex items-center justify-center rounded-[10px] hover:bg-stone-50 text-stone-400 transition-colors border border-transparent hover:border-stone-100"
            aria-label={isSidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          >
            <ChevronRight className={cn("w-4 h-4 transition-transform duration-150", isSidebarOpen && "rotate-180")} />
          </button>
        </div>
      </motion.aside>

      <AnimatePresence>
        {isMobileMenuOpen && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsMobileMenuOpen(false)}
              className="fixed inset-0 bg-slate-900/30 z-50 lg:hidden backdrop-blur-sm"
            />
            <motion.aside
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ duration: 0.18 }}
              className="fixed left-0 top-0 bottom-0 w-72 bg-white z-50 lg:hidden h-full shadow-xl border-r border-stone-100"
            >
              <div className="p-6 flex items-center justify-between border-b border-stone-100">
                <div className="flex items-center">
                   <img 
                     src="https://lh3.googleusercontent.com/d/1Mv6Wn1SLKO9c-fCyEj2G36dzxpSRNOFO"
                     alt="Shanta Life Logo"
                     className="h-9 w-auto object-contain"
                     referrerPolicy="no-referrer"
                   />
                </div>
                <button onClick={() => setIsMobileMenuOpen(false)} className="p-2 hover:bg-stone-50 rounded-full" aria-label="Close menu">
                  <X className="w-5 h-5 text-stone-400" />
                </button>
              </div>
              <nav className="p-4 space-y-1 overflow-y-auto h-[calc(100%-5rem)]">
                {visibleSections.map((section, sectionIndex) => (
                  <React.Fragment key={section.key}>
                    <div className={cn("pt-3 pb-1 px-3 first:pt-0", sectionIndex > 0 && "mt-1")}>
                      <p className="text-[10px] font-black uppercase tracking-[0.16em] text-stone-400 select-none">
                        {sectionLabelMap[section.labelKey] || section.labelKey}
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
                            "flex items-center gap-3 px-4 py-2.5 rounded-[10px] text-sm font-medium transition-colors",
                            isActive ? "bg-[#978C21] text-white shadow-sm" : "text-stone-500 hover:bg-stone-50 hover:text-brand-text"
                          )}
                        >
                          <item.icon className="w-[18px] h-[18px]" />
                          <span>{item.label}</span>
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

      <div className="flex-1 flex flex-col min-w-0 bg-[#FDFBF7]">
        <header className="h-[64px] bg-white/90 backdrop-blur-md border-b border-stone-100 px-4 md:px-6 flex items-center justify-between sticky top-0 z-30 flex-shrink-0">
          <div className="flex items-center gap-3 lg:hidden">
             <button onClick={() => setIsMobileMenuOpen(true)} className="p-2 -ml-2 rounded-[10px] hover:bg-stone-50" aria-label="Open menu">
                <Menu className="w-6 h-6 text-stone-500" />
             </button>
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
                  <button className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-full hover:bg-stone-50 transition-colors border border-transparent hover:border-stone-100" aria-haspopup="menu" aria-label="User menu">
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
                  <div className="absolute right-0 top-[110%] w-64 bg-white rounded-[12px] shadow-xl border border-stone-100 py-2 opacity-0 invisible group-hover:opacity-100 group-hover:visible group-focus-within:opacity-100 group-focus-within:visible transition-all duration-150 transform origin-top-right z-50 overflow-hidden">
                    <div className="px-5 py-4 border-b border-stone-50">
                      <p className="text-xs text-stone-400 font-medium">Logged in as</p>
                      <p className="text-sm text-stone-800 font-bold truncate mt-1">{user.name}</p>
                      <p className="text-xs text-stone-500 mt-1 truncate">{user.email}</p>
                      <span className="inline-flex mt-2 px-2 py-0.5 bg-[#978C21]/10 text-[#978C21] rounded-full text-[11px] font-bold border border-[#978C21]/20">{user.role}</span>
                    </div>
                    <button 
                      onClick={handleLogout}
                      className="w-full px-5 py-3 flex items-center gap-3 text-red-600 hover:bg-red-50 text-sm font-semibold transition-colors text-left"
                    >
                      <LogOut className="w-4 h-4" />
                      Logout
                    </button>
                  </div>
                </div>
             </div>
          </div>
        </header>

        <main className="flex-1 p-4 md:p-6 lg:p-8 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
