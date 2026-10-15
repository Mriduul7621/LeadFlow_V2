import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, ChevronDown, Clock3, MapPinned, Pencil, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { userService } from '../../users/services/userService';
import type { User } from '../../shared/types';
import BackButton from '../../shared/components/BackButton';
import {
  roadshowService,
  type Roadshow,
  type RoadshowInput,
  type RoadshowStatus,
} from '../services/roadshowService';
import NoAccessYet from '../../shared/components/NoAccessYet';
import { isForbiddenError } from '../../shared/api/forbidden';

type TabKey = 'status' | 'add' | 'performance';
interface RoadshowFormState {
  organization: string;
  location: string;
  scheduledAt: string;
  assignedUserIds: string[];
  status: RoadshowStatus;
}

const EMPTY_FORM: RoadshowFormState = {
  organization: '',
  location: '',
  scheduledAt: '',
  assignedUserIds: [],
  status: 'pending',
};

const STATUS_LABEL: Record<RoadshowStatus, string> = {
  pending: 'Pending',
  execute: 'Execute',
  reschedule: 'Reschedule',
  cancel: 'Cancel',
};

function dateInputValue(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: string) => parts.find(item => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-BD', {
    timeZone: 'Asia/Dhaka',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function toInput(form: RoadshowFormState): RoadshowInput {
  return {
    organization: form.organization.trim(),
    location: form.location.trim(),
    scheduledAt: dhakaLocalToIso(form.scheduledAt),
    assignedUserIds: form.assignedUserIds,
  };
}

function dhakaLocalToIso(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('Enter a valid roadshow date and time.');
  const [, year, month, day, hour, minute] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 6, Number(minute))).toISOString();
}

function StatusPill({ status }: { status: RoadshowStatus }) {
  const tone: Record<RoadshowStatus, string> = {
    pending: 'bg-amber-50 text-amber-800',
    execute: 'bg-emerald-50 text-emerald-800',
    reschedule: 'bg-sky-50 text-sky-800',
    cancel: 'bg-stone-100 text-stone-600',
  };
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold ${tone[status]}`}>{STATUS_LABEL[status]}</span>;
}

export default function RoadshowPage() {
  const { canAccess, userRoleNormalized } = usePermissions();
  const canView = canAccess('roadshow_follow_up', 'view');
  const canCreate = canAccess('roadshow_follow_up', 'create');
  const canEdit = canAccess('roadshow_follow_up', 'edit');
  const canCancel = canAccess('roadshow_follow_up', 'cancel');
  const canReport = canAccess('roadshow_follow_up', 'report');
  const isAdmin = userRoleNormalized === 'ADMIN' || userRoleNormalized === 'SUPERADMIN';

  const [activeTab, setActiveTab] = useState<TabKey>('status');
  const [roadshows, setRoadshows] = useState<Roadshow[]>([]);
  const [performance, setPerformance] = useState<Roadshow[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [performanceLoading, setPerformanceLoading] = useState(false);
  const [performanceError, setPerformanceError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // F3: a 403 from /api/roadshows is a missing grant, not a failed fetch.
  const [forbidden, setForbidden] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<RoadshowFormState>(EMPTY_FORM);

  const activeUsers = useMemo(
    () => users.filter(person => person.status === 'Active' || person.employmentStatus === 'Active'),
    [users],
  );

  const loadRoadshows = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setForbidden(false);
    try {
      setRoadshows(await roadshowService.list());
    } catch (error) {
      if (isForbiddenError(error)) {
        setRoadshows([]);
        setForbidden(true);
      } else {
        setLoadError(error instanceof Error ? error.message : 'Roadshows could not be loaded.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const loadPerformance = useCallback(async () => {
    setPerformanceLoading(true);
    setPerformanceError(null);
    try {
      setPerformance(await roadshowService.performance());
    } catch (error) {
      setPerformanceError(error instanceof Error ? error.message : 'Roadshow performance could not be loaded.');
    } finally {
      setPerformanceLoading(false);
    }
  }, []);

  useEffect(() => { void loadRoadshows(); }, [loadRoadshows]);

  useEffect(() => {
    if (!canCreate && !canEdit) return;
    userService.getAllUsers()
      .then(setUsers)
      .catch(error => toast.error(error instanceof Error ? error.message : 'Assignee list could not be loaded.'));
  }, [canCreate, canEdit]);

  useEffect(() => {
    if (activeTab === 'performance' && canReport) void loadPerformance();
  }, [activeTab, canReport, loadPerformance]);

  const resetForm = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  const beginEdit = (roadshow: Roadshow) => {
    if (!canEdit || (roadshow.status === 'execute' && !isAdmin) || (roadshow.status === 'cancel' && !isAdmin)) return;
    setSelectedId(roadshow.id);
    setEditingId(roadshow.id);
    setForm({
      organization: roadshow.organization,
      location: roadshow.location,
      scheduledAt: dateInputValue(roadshow.scheduledAt),
      assignedUserIds: roadshow.assignedUsers.map(person => person.id),
      status: roadshow.status,
    });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.organization.trim() || !form.location.trim() || !form.scheduledAt || !form.assignedUserIds.length) {
      toast.error('Organization, location, date/time, and at least one assignee are required.');
      return;
    }
    if (Number.isNaN(new Date(form.scheduledAt).getTime())) {
      toast.error('Enter a valid roadshow date and time.');
      return;
    }
    if (form.status === 'cancel' && !canCancel && !isAdmin) {
      toast.error('You do not have permission to cancel Roadshows.');
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await roadshowService.update(editingId, { ...toInput(form), status: form.status });
        toast.success(form.status === 'execute' ? 'Roadshow executed. Its source code is now active.' : 'Roadshow updated.');
        setActiveTab('status');
      } else {
        await roadshowService.create(toInput(form));
        toast.success('Roadshow added.');
        setActiveTab('status');
      }
      resetForm();
      await loadRoadshows();
      if (activeTab === 'performance') await loadPerformance();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Roadshow could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const changeStatus = async (roadshow: Roadshow, status: RoadshowStatus) => {
    if (status === 'cancel' && !canCancel && !isAdmin) {
      toast.error('You do not have permission to cancel Roadshows.');
      return;
    }
    if (status !== 'cancel' && !canEdit && !isAdmin) {
      toast.error('You do not have permission to edit Roadshows.');
      return;
    }
    if (roadshow.status === 'execute' && !isAdmin) return;
    try {
      await roadshowService.update(roadshow.id, { status });
      toast.success(status === 'execute' ? 'Roadshow executed. Its source code is now active.' : `Roadshow marked ${STATUS_LABEL[status].toLowerCase()}.`);
      await loadRoadshows();
      if (activeTab === 'performance') await loadPerformance();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Roadshow status could not be updated.');
    }
  };

  if (!canView) {
    return (
      <div className="mx-auto max-w-xl py-16 text-center">
        <h1 className="text-lg font-semibold text-stone-800">Roadshow access unavailable</h1>
        <p className="mt-2 text-sm text-stone-500">Your role does not have permission to view Roadshow Follow-up.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-10">
      <BackButton fallback="/" />
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-brand-text">Roadshow Follow-up</h1>
        <p className="mt-1 text-sm text-stone-500">Schedule field events, assign your team, and track leads by roadshow.</p>
      </header>

      <nav className="flex gap-2 overflow-x-auto border-b border-stone-200" aria-label="Roadshow sections">
        <button type="button" onClick={() => { setActiveTab('status'); resetForm(); }} className={`min-h-11 shrink-0 border-b-2 px-3 text-sm font-semibold ${activeTab === 'status' ? 'border-[#978C21] text-[#756c1b]' : 'border-transparent text-stone-500'}`}>
          Roadshow Status
        </button>
        {canCreate && (
          <button type="button" onClick={() => { setActiveTab('add'); resetForm(); }} className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-semibold ${activeTab === 'add' ? 'border-[#978C21] text-[#756c1b]' : 'border-transparent text-stone-500'}`}>
            <Plus className="h-4 w-4" /> Add Roadshow
          </button>
        )}
        {canReport && (
          <button type="button" onClick={() => { setActiveTab('performance'); resetForm(); }} className={`min-h-11 shrink-0 border-b-2 px-3 text-sm font-semibold ${activeTab === 'performance' ? 'border-[#978C21] text-[#756c1b]' : 'border-transparent text-stone-500'}`}>
            Performance
          </button>
        )}
      </nav>

      {(activeTab === 'add' || editingId) && (
        <form onSubmit={submit} className="space-y-5 border-y border-stone-100 bg-white px-4 py-5 sm:px-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-stone-800">{editingId ? 'Update Roadshow' : 'Add Roadshow'}</h2>
              <p className="mt-1 text-xs text-stone-500">Enter the host organization, venue, schedule and assigned team.</p>
            </div>
            {editingId && <button type="button" onClick={resetForm} className="rounded-md p-2 text-stone-500 hover:bg-stone-100" aria-label="Close edit form"><X className="h-4 w-4" /></button>}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1.5 text-xs font-medium text-stone-600">
              Organization
              <input required maxLength={255} value={form.organization} onChange={event => setForm(current => ({ ...current, organization: event.target.value }))} className="input-standard" placeholder="Organization name" />
            </label>
            <label className="space-y-1.5 text-xs font-medium text-stone-600">
              Location
              <input required maxLength={255} value={form.location} onChange={event => setForm(current => ({ ...current, location: event.target.value }))} className="input-standard" placeholder="Venue or area" />
            </label>
            <label className="space-y-1.5 text-xs font-medium text-stone-600">
              Date and time
              <input required type="datetime-local" value={form.scheduledAt} onChange={event => setForm(current => ({ ...current, scheduledAt: event.target.value }))} className="input-standard" />
              <span className="block text-[11px] text-stone-400">Bangladesh time (Asia/Dhaka)</span>
            </label>
            {editingId && (
              <label className="space-y-1.5 text-xs font-medium text-stone-600">
                Status
                <select value={form.status} onChange={event => setForm(current => ({ ...current, status: event.target.value as RoadshowStatus }))} className="select-standard">
                  {ROADSHOW_STATUSES.filter(status => status !== 'cancel' || canCancel || isAdmin).map(status => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}
                </select>
              </label>
            )}
          </div>
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold text-stone-700">Assign users <span className="font-normal text-stone-500">(select one or more)</span></legend>
            {activeUsers.length === 0 ? (
              <p className="text-xs text-stone-500">No active users are available to assign.</p>
            ) : (
              <div className="grid max-h-48 gap-2 overflow-y-auto rounded-lg border border-stone-200 p-3 sm:grid-cols-2">
                {activeUsers.map(person => {
                  const checked = form.assignedUserIds.includes(person.id);
                  return (
                    <label key={person.id} className="flex min-h-10 items-center gap-2 rounded-md px-2 text-sm text-stone-700 hover:bg-stone-50">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={event => setForm(current => ({
                          ...current,
                          assignedUserIds: event.target.checked
                            ? [...current.assignedUserIds, person.id]
                            : current.assignedUserIds.filter(id => id !== person.id),
                        }))}
                      />
                      <span className="truncate">{person.name} <span className="text-xs text-stone-400">· {person.employeeId}</span></span>
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={saving} className="btn-primary normal-case tracking-normal">
              {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add Roadshow'}
            </button>
            {editingId && form.status === 'execute' && (
              <p className="text-xs text-amber-700">Executing locks this record for everyone except administrators.</p>
            )}
          </div>
        </form>
      )}

      {activeTab === 'status' && !editingId && (
        <section className="space-y-3">
          {forbidden ? (
            <NoAccessYet module="Roadshow Follow-up" hint="Roadshows are a separate grant from the leads module." />
          ) : loadError && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <span>{loadError}</span>
              <button type="button" onClick={() => void loadRoadshows()} className="font-semibold underline underline-offset-2">Retry</button>
            </div>
          )}
          {loading ? (
            <p className="py-12 text-center text-sm text-stone-500">Loading Roadshows…</p>
          ) : forbidden || loadError ? null : roadshows.length === 0 ? (
            <div className="border-y border-stone-100 bg-white px-4 py-12 text-center">
              <MapPinned className="mx-auto h-7 w-7 text-stone-400" />
              <p className="mt-3 text-sm font-semibold text-stone-700">No Roadshows added</p>
              <p className="mt-1 text-xs text-stone-500">Roadshows created for your team will appear here.</p>
            </div>
          ) : roadshows.map(roadshow => {
            const isSelected = selectedId === roadshow.id;
            const locked = roadshow.status === 'execute' || roadshow.status === 'cancel';
            const canManage = canEdit && (!locked || isAdmin);
            return (
              <article key={roadshow.id} className="border-y border-stone-100 bg-white">
                <button type="button" onClick={() => setSelectedId(isSelected ? null : roadshow.id)} aria-expanded={isSelected} className="flex min-h-[76px] w-full items-center gap-3 px-4 py-3 text-left sm:px-5">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#978C21]/10 text-[#756c1b]"><MapPinned className="h-[18px] w-[18px]" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold text-stone-800">{roadshow.organization}</span>
                      <StatusPill status={roadshow.status} />
                    </span>
                    <span className="mt-1 block truncate text-xs text-stone-500">{roadshow.location} · {formatDate(roadshow.scheduledAt)}</span>
                  </span>
                  <span className="hidden shrink-0 text-right sm:block">
                    <span className="block text-sm font-semibold text-stone-700">{roadshow.totalLeads} leads</span>
                    {roadshow.sourceCode && <span className="block text-[11px] font-medium text-[#756c1b]">{roadshow.sourceCode}</span>}
                  </span>
                  <ChevronDown className={`h-4 w-4 shrink-0 text-stone-400 transition-transform ${isSelected ? 'rotate-180' : ''}`} />
                </button>
                {isSelected && (
                  <div className="space-y-4 border-t border-stone-100 px-4 py-4 sm:px-5">
                    <div className="grid gap-3 text-sm sm:grid-cols-2">
                      <p><span className="text-xs text-stone-500">Organization</span><span className="mt-0.5 block font-medium text-stone-800">{roadshow.organization}</span></p>
                      <p><span className="text-xs text-stone-500">Location</span><span className="mt-0.5 block font-medium text-stone-800">{roadshow.location}</span></p>
                      <p><span className="text-xs text-stone-500">Date & time</span><span className="mt-0.5 flex items-center gap-1.5 font-medium text-stone-800"><Clock3 className="h-3.5 w-3.5 text-stone-400" />{formatDate(roadshow.scheduledAt)}</span></p>
                      <p><span className="text-xs text-stone-500">Assigned team</span><span className="mt-0.5 block font-medium text-stone-800">{roadshow.assignedUsers.map(person => person.name).join(', ') || 'No assignees'}</span></p>
                    </div>
                    {roadshow.sourceCode && (
                      <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                        Lead source code <strong>{roadshow.sourceCode}</strong> · {roadshow.totalLeads} collected · {roadshow.convertedLeads} converted
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      {canManage && (
                        <button type="button" onClick={() => beginEdit(roadshow)} className="btn-secondary normal-case tracking-normal">
                          <Pencil className="h-3.5 w-3.5" /> Edit
                        </button>
                      )}
                      {roadshow.status !== 'execute' && roadshow.status !== 'cancel' && canEdit && (
                        <button type="button" onClick={() => void changeStatus(roadshow, 'execute')} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800">
                          <Check className="h-4 w-4" /> Execute
                        </button>
                      )}
                      {roadshow.status !== 'execute' && roadshow.status !== 'cancel' && canCancel && (
                        <button type="button" onClick={() => void changeStatus(roadshow, 'cancel')} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-stone-200 px-4 text-sm font-semibold text-stone-600 hover:bg-stone-50">
                          <X className="h-4 w-4" /> Cancel
                        </button>
                      )}
                      {roadshow.status === 'execute' && !isAdmin && <span className="text-xs text-stone-500">Executed roadshows are locked.</span>}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </section>
      )}

      {activeTab === 'performance' && canReport && !editingId && (
        <section className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-stone-800">Roadshow Performance</h2>
            <p className="mt-1 text-xs text-stone-500">Lead counts are calculated from active leads carrying each executed roadshow source code.</p>
          </div>
          {performanceLoading ? (
            <p className="border-y border-stone-100 bg-white px-4 py-10 text-center text-sm text-stone-500">Loading performance…</p>
          ) : performanceError ? (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <span>{performanceError}</span>
              <button type="button" onClick={() => void loadPerformance()} className="font-semibold underline underline-offset-2">Retry</button>
            </div>
          ) : performance.length === 0 ? (
            <p className="border-y border-stone-100 bg-white px-4 py-10 text-center text-sm text-stone-500">No executed Roadshows have performance data yet.</p>
          ) : performance.map(roadshow => (
            <article key={roadshow.id} className="border-y border-stone-100 bg-white px-4 py-4 sm:px-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-stone-800">{roadshow.organization}</h3>
                  <p className="mt-1 text-xs text-stone-500">{roadshow.location} · {formatDate(roadshow.scheduledAt)}</p>
                  <p className="mt-1 text-xs font-semibold text-[#756c1b]">{roadshow.sourceCode}</p>
                </div>
                <div className="flex gap-6 text-right">
                  <p><strong className="block text-lg text-stone-800">{roadshow.totalLeads}</strong><span className="text-[11px] text-stone-500">Collected</span></p>
                  <p><strong className="block text-lg text-emerald-800">{roadshow.convertedLeads}</strong><span className="text-[11px] text-stone-500">Converted</span></p>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {roadshow.stageBreakdown.map(stage => (
                  <span key={stage.status} className="rounded-full bg-stone-100 px-2.5 py-1 text-[11px] text-stone-700">{stage.status || 'Unassigned'} · {stage.count}</span>
                ))}
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

const ROADSHOW_STATUSES: RoadshowStatus[] = ['pending', 'execute', 'reschedule', 'cancel'];
