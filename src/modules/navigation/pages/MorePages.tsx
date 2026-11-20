import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
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
  Trash2,
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
import { EnterprisePageHeader } from '../../workspace/components/EnterprisePrimitives';

type IconComponent = ComponentType<LucideProps>;

interface DirectoryItem {
  label: string;
  description: string;
  path: string;
  icon: IconComponent;
}

function PageHeading({ path, backTo = '/more', actions }: { path: string; backTo?: string; actions?: ReactNode }) {
  return (
    <EnterprisePageHeader
      path={path}
      actions={(
        <>
          {actions}
          <Link to={backTo} className="ep-btn" aria-label="Back">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        </>
      )}
    />
  );
}

function DirectoryList({ items }: { items: DirectoryItem[] }) {
  return (
    <nav className="ep-card" style={{ padding: 0, overflow: 'hidden' }} aria-label="More options">
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
    <div className="ep-page" style={{ maxWidth: 720 }}>
      <EnterprisePageHeader path="/more" />
      {user && (
        <div className="ep-card flex items-center gap-3" style={{ marginBottom: 16 }}>
          <span className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full bg-[#978C21]/10 text-base font-bold text-[#756c1b]">
            {user.avatarUrl
              ? <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
              : (user.name || user.email || 'U').trim().charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-stone-800">{user.name}</p>
            <p className="truncate text-xs text-stone-500">{user.email}</p>
          </div>
          <span className="ep-pill ml-auto">{user.role}</span>
        </div>
      )}
      <DirectoryList items={items} />
      <button
        type="button"
        onClick={() => { logout(); navigate('/login'); }}
        className="ep-btn ep-btn-danger"
        style={{ width: '100%', justifyContent: 'center', marginTop: 16 }}
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
    { label: 'Team', description: 'Team-wise leads: managers, team leaders, members', path: '/team', icon: Users },
    { label: 'Lead Upload', description: 'Import leads from a file', path: '/leads/upload', icon: Upload },
    { label: 'Lead Pool', description: 'Review and assign available leads', path: '/leads/all', icon: Database },
    { label: 'Delete Requests', description: 'Review lead deletion requests', path: '/leads/delete-requests', icon: Trash2 },
    { label: 'System', description: 'Strategy, forms, workflow, sync and system tools', path: '/settings/system', icon: Settings },
    // Performance Diagnostics moved here from the retired Reports directory —
    // it is an administration tool, not a report a sales user reads.
    ...(isAdministrator && canOpen('/settings/performance-diagnostics')
      ? [{ label: 'Performance Diagnostics', description: 'System diagnostics and request performance', path: '/settings/performance-diagnostics', icon: Activity }]
      : []),
  ];

  return (
    <div className="ep-page" style={{ maxWidth: 720 }}>
      <PageHeading path="/administration" />
      <p className="ep-muted" style={{ marginBottom: 16 }}>
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
    <div className="ep-page" style={{ maxWidth: 720 }}>
      <PageHeading
        path="/notifications"
        actions={(
          <button
            type="button"
            onClick={() => void markAllRead()}
            disabled={!notifications.some(item => !item.read)}
            className="ep-btn"
          >
            Mark all read
          </button>
        )}
      />
      {loading ? <p className="ep-empty" style={{ textAlign: 'center', padding: '24px 0' }}>Loading notifications…</p> : null}
      {error ? <p role="alert" className="py-8 text-center text-sm text-red-600">{error}</p> : null}
      {!loading && !error && notifications.length === 0 ? (
        <div className="ep-card">
          <p className="ep-empty" style={{ textAlign: 'center' }}>You’re all caught up.</p>
        </div>
      ) : null}
      {!loading && !error && notifications.length > 0 ? (
        <div className="ep-card" style={{ padding: 0, overflow: 'hidden' }}>
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
            return notification.leadId || notification.eventType === 'lead-delete-request' ? (
              <button
                key={notification.id}
                type="button"
                onClick={() => {
                  void markRead(notification);
                  // A delete-request notification opens the admin
                  // review page (the lead itself is not the action);
                  // every other notification keeps the Lead360 link.
                  if (notification.eventType === 'lead-delete-request') {
                    navigate('/leads/delete-requests');
                  } else {
                    navigate(`/leads/${encodeURIComponent(notification.leadId)}`);
                  }
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
    <div className="ep-page" style={{ maxWidth: 720 }}>
      <PageHeading path="/help" />
      <div className="ep-card" style={{ padding: 0, overflow: 'hidden' }}>
        <p className="px-4 pt-5 text-[11px] font-bold uppercase tracking-wider text-stone-400 sm:px-5">Leads</p>
        <section className="px-4 py-5 sm:px-5">
          <h2 className="text-sm font-semibold text-stone-800">Add a lead</h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            Open <Link to="/leads/new" className="font-semibold text-[#756c1b]">Add Lead</Link>, enter the customer&apos;s details and save.
            The lead appears in My Leads, ready for follow-up.
          </p>
        </section>
        <section className="px-4 py-5 sm:px-5" style={{ borderTop: '1px solid #f0f0eb' }}>
          <h2 className="text-sm font-semibold text-stone-800">Find and update a lead</h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            Open <Link to="/leads" className="font-semibold text-[#756c1b]">Leads</Link>, search or filter the list, then select a lead to view
            its details and available actions.
          </p>
        </section>
        <section className="px-4 py-5 sm:px-5" style={{ borderTop: '1px solid #f0f0eb' }}>
          <h2 className="text-sm font-semibold text-stone-800">Edit a lead</h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">Open a lead and use Edit to correct its details, then save to return to the lead.</p>
        </section>
        <p className="px-4 pt-5 text-[11px] font-bold uppercase tracking-wider text-stone-400 sm:px-5" style={{ borderTop: '1px solid #f0f0eb' }}>Follow-ups &amp; meetings</p>
        <section className="px-4 py-5 sm:px-5">
          <h2 className="text-sm font-semibold text-stone-800">Follow-up Queue</h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            The <Link to="/follow-up" className="font-semibold text-[#756c1b]">Follow-up Queue</Link> lists today&apos;s due calls and visits.
            Open an item to complete it, or reschedule it to a new date.
          </p>
        </section>
        <section className="px-4 py-5 sm:px-5" style={{ borderTop: '1px solid #f0f0eb' }}>
          <h2 className="text-sm font-semibold text-stone-800">WhatsApp a customer</h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">From a lead, use WhatsApp to message the customer directly — pick a suggested message or write your own.</p>
        </section>
        <section className="px-4 py-5 sm:px-5" style={{ borderTop: '1px solid #f0f0eb' }}>
          <h2 className="text-sm font-semibold text-stone-800">Meetings and Task Calendar</h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            Book meetings and see your schedule on the <Link to="/task-calendar" className="font-semibold text-[#756c1b]">Task Calendar</Link>.
            Meetings you are invited to appear there with your RSVP.
          </p>
        </section>
        <section className="px-4 py-5 sm:px-5" style={{ borderTop: '1px solid #f0f0eb' }}>
          <h2 className="text-sm font-semibold text-stone-800">Roadshows</h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            <Link to="/roadshows" className="font-semibold text-[#756c1b]">Roadshows</Link> list team field events — check the schedule
            and who is assigned before the day.
          </p>
        </section>
        <p className="px-4 pt-5 text-[11px] font-bold uppercase tracking-wider text-stone-400 sm:px-5" style={{ borderTop: '1px solid #f0f0eb' }}>Data &amp; reports</p>
        <section className="px-4 py-5 sm:px-5">
          <h2 className="text-sm font-semibold text-stone-800">Import leads in bulk</h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            <Link to="/leads/upload" className="font-semibold text-[#756c1b]">Lead Intake</Link> imports many leads at once from a spreadsheet.
            A mobile number is required for every row.
          </p>
        </section>
        <section className="px-4 py-5 sm:px-5" style={{ borderTop: '1px solid #f0f0eb' }}>
          <h2 className="text-sm font-semibold text-stone-800">Reports and performance</h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            <Link to="/performance/self" className="font-semibold text-[#756c1b]">My Performance</Link> shows your own results;{' '}
            <Link to="/execution-intelligence" className="font-semibold text-[#756c1b]">Team Performance</Link> shows your team&apos;s.
            Both update from your lead activity.
          </p>
        </section>
        <section className="px-4 py-5 sm:px-5" style={{ borderTop: '1px solid #f0f0eb' }}>
          <h2 className="text-sm font-semibold text-stone-800">Notifications</h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            Reminders for due follow-ups and meetings arrive as notifications. Open{' '}
            <Link to="/notifications" className="font-semibold text-[#756c1b]">Notifications</Link> to review them.
          </p>
        </section>
        <section className="px-4 py-5 sm:px-5" style={{ borderTop: '1px solid #f0f0eb' }}>
          <h2 className="text-sm font-semibold text-stone-800">Review today&apos;s work</h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">Use My Work to review due calls, meetings, follow-ups and tasks. Select an item to see its details.</p>
        </section>
        <p className="px-4 pt-5 text-[11px] font-bold uppercase tracking-wider text-stone-400 sm:px-5" style={{ borderTop: '1px solid #f0f0eb' }}>Account</p>
        <section className="px-4 py-5 sm:px-5">
          <h2 className="text-sm font-semibold text-stone-800">Your password</h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            Change your password from <Link to="/settings" className="font-semibold text-[#756c1b]">Profile &amp; Settings</Link>.
            If you forget your password, ask your workspace administrator to reset it — there is no self-service reset.
          </p>
        </section>
        <section className="px-4 py-5 sm:px-5" style={{ borderTop: '1px solid #f0f0eb' }}>
          <h2 className="text-sm font-semibold text-stone-800">Locked out?</h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            After 10 failed sign-in attempts your account is locked for 30 minutes. Wait for the lock to lift, then try again —
            or ask your workspace administrator for help.
          </p>
        </section>
        <section className="px-4 py-5 sm:px-5" style={{ borderTop: '1px solid #f0f0eb' }}>
          <h2 className="text-sm font-semibold text-stone-800">Access or data questions</h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">Contact your workspace administrator if a page or action is unavailable for your role.</p>
        </section>
      </div>
    </div>
  );
}

export function AboutPage() {
  return (
    <div className="ep-page" style={{ maxWidth: 720 }}>
      <PageHeading path="/about" />
      <div className="ep-card">
        <p className="text-base font-semibold text-stone-800">LeadFlow — Lead Management System</p>
        <p className="mt-2 max-w-prose text-sm leading-6 text-stone-600">
          LeadFlow is Shanta Life&apos;s lead workspace for the field force. It helps sales teams manage prospects,
          lead follow-ups, scheduled activities and conversion reporting in one role-scoped workspace.
        </p>
        <h2 className="mt-6 text-sm font-semibold text-stone-800">What LeadFlow covers</h2>
        <ul className="mt-2 max-w-prose list-disc space-y-1 pl-5 text-sm leading-6 text-stone-600">
          <li><strong className="font-semibold text-stone-800">Leads</strong> — add, find and update prospects, and track each one through to conversion.</li>
          <li><strong className="font-semibold text-stone-800">Follow-ups</strong> — a daily queue of due calls and visits, with reminders so nothing slips.</li>
          <li><strong className="font-semibold text-stone-800">Meetings</strong> — book meetings and keep them on the Task Calendar.</li>
          <li><strong className="font-semibold text-stone-800">Roadshows</strong> — team field events and who is assigned to each one.</li>
          <li><strong className="font-semibold text-stone-800">Performance &amp; reports</strong> — your own results and your team&apos;s, drawn from lead activity.</li>
        </ul>
        <h2 className="mt-6 text-sm font-semibold text-stone-800">Who it serves</h2>
        <p className="mt-2 max-w-prose text-sm leading-6 text-stone-600">
          Agents manage their own leads and follow-ups; Team Leads see their team as well as their own work;
          Managers see their whole subtree; Admins oversee the organisation.
        </p>
        <h2 className="mt-6 text-sm font-semibold text-stone-800">Your data</h2>
        <p className="mt-2 max-w-prose text-sm leading-6 text-stone-600">
          What you see follows your role and your reporting line — you only ever see the leads, follow-ups and reports your role allows. If a page or action is missing for you, your workspace administrator can help.
        </p>
        <p className="mt-6 max-w-prose border-t border-stone-100 pt-4 text-xs leading-5 text-stone-500">
          Built by the Training &amp; Development Department, Shanta Life Insurance PLC.
        </p>
      </div>
    </div>
  );
}
