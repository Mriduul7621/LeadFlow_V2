import { useEffect, useState, type ComponentType } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Activity,
  ArrowLeft,
  Bell,
  ChevronRight,
  CircleHelp,
  Database,
  Globe,
  LogOut,
  Settings,
  Shield,
  Upload,
  UserRound,
  Users,
  type LucideProps,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuthStore } from '../../auth/store/authStore';
import { DIAGNOSTICS_ADMIN_ROLES } from '../../auth/components/AdminRoute';
import { usePermissions } from '../../shared/hooks/usePermissions';
import type { SystemNotification } from '../../shared/types';
import { notificationService } from '../../notifications/services/notificationService';
import { resolveFeatureRouteAccess } from '../../../layouts/featureRouteAccess';

type IconComponent = ComponentType<LucideProps>;

interface DirectoryItem {
  label: string;
  description: string;
  path: string;
  icon: IconComponent;
}

function PageHeading({ title, backTo = '/more' }: { title: string; backTo?: string }) {
  return (
    <div className="mb-6 flex items-center gap-3">
      <Link
        to={backTo}
        aria-label="Back"
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-600 transition-colors hover:bg-stone-50"
      >
        <ArrowLeft className="h-4 w-4" />
      </Link>
      <h1 className="text-2xl font-bold tracking-tight text-brand-text">{title}</h1>
    </div>
  );
}

function DirectoryList({ items }: { items: DirectoryItem[] }) {
  return (
    <nav className="divide-y divide-stone-100 border-y border-stone-100 bg-white" aria-label="More options">
      {items.map(item => (
        <Link
          key={item.path}
          to={item.path}
          className="group flex min-h-[68px] items-center gap-4 px-4 py-3 transition-colors hover:bg-stone-50 sm:px-5"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-stone-50 text-stone-600 group-hover:bg-[#978C21]/10 group-hover:text-[#756c1b]">
            <item.icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-stone-800">{item.label}</span>
            <span className="mt-0.5 block truncate text-xs text-stone-500">{item.description}</span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-stone-400 transition-transform group-hover:translate-x-0.5" />
        </Link>
      ))}
    </nav>
  );
}

export function MorePage() {
  const { user, logout } = useAuthStore();
  const { canAccess, roles } = usePermissions();
  const navigate = useNavigate();
  const role = String(user?.role || '').toUpperCase();
  const isAdministrator = DIAGNOSTICS_ADMIN_ROLES.includes(role);
  const matchedRole = roles.find(permission => permission.roleId === user?.role || permission.roleId === role);
  const canOpen = (route: string) => resolveFeatureRouteAccess(route, user?.role, matchedRole);

  const items: DirectoryItem[] = [
    ...(canOpen('/settings')
      ? [{ label: 'Profile & settings', description: 'Update your contact details and password', path: '/settings', icon: UserRound }]
      : []),
    ...(canOpen('/notifications')
      ? [{ label: 'Notifications', description: 'Recent updates and reminders', path: '/notifications', icon: Bell }]
      : []),
    ...(canOpen('/help')
      ? [{ label: 'Help & Support', description: 'Guidance for everyday LeadFlow tasks', path: '/help', icon: CircleHelp }]
      : []),
    ...(canOpen('/about')
      ? [{ label: 'About LeadFlow', description: 'What LeadFlow helps your team do', path: '/about', icon: Globe }]
      : []),
    ...(isAdministrator && canOpen('/administration')
      ? [{ label: 'Administration', description: 'Users, lead intake, lead pool and system', path: '/administration', icon: Shield }]
      : []),
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-5 pb-10">
      <h1 className="text-2xl font-bold tracking-tight text-brand-text">More</h1>
      {user && (
        <div className="flex items-center gap-3 border-b border-stone-100 pb-5">
          <span className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full bg-[#978C21]/10 text-base font-bold text-[#756c1b]">
            {user.avatarUrl
              ? <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
              : (user.name || user.email || 'U').trim().charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-stone-800">{user.name}</p>
            <p className="truncate text-xs text-stone-500">{user.email}</p>
          </div>
          <span className="ml-auto rounded-full bg-stone-100 px-2.5 py-1 text-[11px] font-medium text-stone-600">{user.role}</span>
        </div>
      )}
      <DirectoryList items={items} />
      <button
        type="button"
        onClick={() => { logout(); navigate('/login'); }}
        className="flex min-h-12 w-full items-center gap-3 border-b border-stone-100 px-4 text-sm font-semibold text-red-600 transition-colors hover:bg-red-50"
      >
        <LogOut className="h-[18px] w-[18px]" strokeWidth={1.8} />
        Log out
      </button>
    </div>
  );
}

export function AdministrationPage() {
  const { user, roles } = usePermissions();
  const role = String(user?.role || '').toUpperCase();
  const matchedRole = roles.find(permission => permission.roleId === user?.role || permission.roleId === role);
  const canOpen = (route: string) => resolveFeatureRouteAccess(route, user?.role, matchedRole);
  const isAdministrator = DIAGNOSTICS_ADMIN_ROLES.includes(role);

  const items: DirectoryItem[] = [
    { label: 'User Management', description: 'Users, roles and access', path: '/users', icon: Users },
    { label: 'Lead Upload', description: 'Import leads from a file', path: '/leads/upload', icon: Upload },
    { label: 'Lead Pool', description: 'Review and assign available leads', path: '/leads/all', icon: Database },
    { label: 'System', description: 'Strategy, forms, workflow, sync and system tools', path: '/settings/system', icon: Settings },
    // Performance Diagnostics moved here from the retired Reports directory —
    // it is an administration tool, not a report a sales user reads.
    ...(isAdministrator && canOpen('/settings/performance-diagnostics')
      ? [{ label: 'Performance Diagnostics', description: 'System diagnostics and request performance', path: '/settings/performance-diagnostics', icon: Activity }]
      : []),
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-5 pb-10">
      <PageHeading title="Administration" />
      <p className="max-w-prose text-sm leading-6 text-stone-600">
        Manage access and lead operations. System settings are grouped separately from your personal profile.
      </p>
      <DirectoryList items={items} />
    </div>
  );
}

export function NotificationsPage() {
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<SystemNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!user?.employeeId) {
      setNotifications([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    notificationService.getNotifications(user.employeeId)
      .then(rows => { if (!cancelled) setNotifications(rows); })
      .catch(err => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load notifications.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [user?.employeeId]);

  const markRead = async (notification: SystemNotification) => {
    if (notification.read) return;
    try {
      await notificationService.markNotificationAsRead(notification.id);
      setNotifications(current => current.map(item => item.id === notification.id ? { ...item, read: true } : item));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not mark notification as read.');
    }
  };

  const markAllRead = async () => {
    if (!user?.employeeId) return;
    try {
      await notificationService.markAllNotificationsAsRead(user.employeeId);
      setNotifications(current => current.map(item => ({ ...item, read: true })));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not mark notifications as read.');
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-5 pb-10">
      <div className="flex items-center justify-between gap-3">
        <PageHeading title="Notifications" />
        <button
          type="button"
          onClick={() => void markAllRead()}
          disabled={!notifications.some(item => !item.read)}
          className="mb-6 shrink-0 text-xs font-semibold text-[#756c1b] disabled:cursor-not-allowed disabled:text-stone-400"
        >
          Mark all read
        </button>
      </div>
      {loading ? <p className="py-8 text-center text-sm text-stone-500">Loading notifications…</p> : null}
      {error ? <p role="alert" className="py-8 text-center text-sm text-red-600">{error}</p> : null}
      {!loading && !error && notifications.length === 0 ? (
        <p className="border-y border-stone-100 bg-white px-4 py-8 text-center text-sm text-stone-500">You’re all caught up.</p>
      ) : null}
      {!loading && !error && notifications.length > 0 ? (
        <div className="divide-y divide-stone-100 border-y border-stone-100 bg-white">
          {notifications.map(notification => {
            const content = (
              <>
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${notification.read ? 'bg-stone-200' : 'bg-[#978C21]'}`} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-3">
                    <strong className="truncate text-sm font-semibold text-stone-800">{notification.title}</strong>
                    <time className="shrink-0 text-[11px] text-stone-500" dateTime={notification.date}>
                      {new Date(notification.date).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </time>
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-stone-600">{notification.message}</span>
                </span>
              </>
            );
            return notification.leadId ? (
              <button
                key={notification.id}
                type="button"
                onClick={() => {
                  void markRead(notification);
                  navigate(`/leads/${encodeURIComponent(notification.leadId)}`);
                }}
                className="flex w-full items-start gap-3 px-4 py-4 text-left hover:bg-stone-50 sm:px-5"
              >
                {content}
              </button>
            ) : (
              <div key={notification.id} className="flex items-start gap-3 px-4 py-4 sm:px-5">
                {content}
                {!notification.read ? (
                  <button type="button" onClick={() => void markRead(notification)} className="shrink-0 text-[11px] font-semibold text-[#756c1b]">
                    Mark read
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function HelpPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-5 pb-10">
      <PageHeading title="Help & Support" />
      <div className="divide-y divide-stone-100 border-y border-stone-100 bg-white">
        <section className="px-4 py-5 sm:px-5">
          <h2 className="text-sm font-semibold text-stone-800">Find and update a lead</h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">Open Leads, search or filter the list, then select a lead to view its details and available actions.</p>
        </section>
        <section className="px-4 py-5 sm:px-5">
          <h2 className="text-sm font-semibold text-stone-800">Review today’s work</h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">Use My Work to review due calls, meetings, follow-ups and tasks. Select an item to see its details.</p>
        </section>
        <section className="px-4 py-5 sm:px-5">
          <h2 className="text-sm font-semibold text-stone-800">Access or data questions</h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">Contact your workspace administrator if a page or action is unavailable for your role.</p>
        </section>
      </div>
    </div>
  );
}

export function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-5 pb-10">
      <PageHeading title="About LeadFlow" />
      <div className="border-y border-stone-100 bg-white px-4 py-5 sm:px-5">
        <p className="text-base font-semibold text-stone-800">LeadFlow</p>
        <p className="mt-2 max-w-prose text-sm leading-6 text-stone-600">
          LeadFlow helps sales teams manage prospects, lead follow-ups, scheduled activities and conversion reporting in one role-scoped workspace.
        </p>
      </div>
    </div>
  );
}
