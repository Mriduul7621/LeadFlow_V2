import React, { useCallback, useEffect, useMemo, useState, type FC } from 'react';
import { Calendar, Clock, AlertTriangle, RefreshCw, X } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { cn } from '../../../lib/utils';
import { leadService, type FollowUpQueueItem, type FollowUpQueueResult } from '../services/leadService';
import { metadataService } from '../../metadata/services/metadataService';
import { toast } from 'sonner';
import { EnterprisePageHeader, KpiCard } from '../../workspace/components/EnterprisePrimitives';
import BackButton from '../../shared/components/BackButton';
import { formatDhakaShort, formatDhakaTime, resolveTerminalNames } from '../../workspace/utils/enterpriseData';
import { completedToday, onTimeRate } from '../../workspace/utils/agentWorkspaceData';
import { useAuthStore } from '../../auth/store/authStore';
import { useCallerTeam } from '../../team/hooks/useCallerTeam';
import { getSelfPerson } from '../../team/services/teamOverviewService';
import { useEnterpriseDisplayRole } from '../../../layouts/enterpriseDisplayRole';
import {
  isAdminPerson,
  scopeLeadsByAssignee,
  scopePeople,
  tlAncestorOf,
} from '../../workspace/utils/teamWorkspaceData';
import type { DropdownOption, Lead } from '../../shared/types';
import type { TeamOverviewPerson } from '../../team/services/teamOverviewService';

type Bucket = 'overdue' | 'today' | 'upcoming';

const isValidBucket = (value: string | null): value is Bucket =>
  value === 'overdue' || value === 'today' || value === 'upcoming';

const BUCKET_HEADINGS: Record<Bucket, string> = {
  overdue: 'Overdue follow-ups',
  today: "Today's follow-ups",
  upcoming: 'Upcoming follow-ups',
};

/**
 * FollowUpStrategy — the Follow-up Queue page (Agent workspace
 * rebuild, 2026-11-20, Mahadi's demo screenshot 5).
 * ------------------------------------------------------------------
 * Four KPI cards, then the checklist for the active bucket:
 *
 *   Due today    -> the queue's own today count; the subline names
 *                   the real overdue count
 *   Upcoming     -> the queue's upcoming count. The demo's subline
 *                   says "Next 7 days", but the server's upcoming
 *                   bucket is UNBOUNDED (everything from tomorrow
 *                   on), so the honest subline is "Scheduled ahead"
 *   Completed    -> leads whose latest history entry was logged
 *                   today (the only completion the lead model
 *                   records)
 *   On-time rate -> completed on time / completed, measured
 *                   against the date the previous entry scheduled.
 *                   OMITTED when nothing is measurable — never a
 *                   fabricated rate
 *
 * Checking a row opens the outcome dialog: the agent picks the
 * outcome status, adds remarks, and schedules the next follow-up.
 * Saving calls the REAL update flow (leadService.updateLeadStatus
 * — the same endpoint the Update page uses), so the outcome lands
 * in the lead's history and the item leaves the pending list on
 * reload. Cancel unchecks the box; nothing is saved. A completed
 * follow-up is a logged outcome in append-only history and cannot
 * be un-logged — the dialog says so plainly.
 *
 * "+ Add follow-up" schedules a follow-up on one of the caller's
 * visible non-terminal leads via the existing lead update (the
 * note is appended to the lead's notes, never overwriting them).
 *
 * The Overdue / Today / Upcoming tabs and the ?bucket= deep-link
 * contract stay exactly as they were — the dashboards link here.
 *
 * Follow-up Monitor (2026-11-20, Mahadi): the TL/Manager/Admin
 * sidebar label is "Follow-up Monitor" (the page H1 stays
 * "Follow-up Queue" per the demo). The KPI cards stay team-wide
 * for every role. The LIST differs by role:
 *   Agent   — own follow-ups (server scope), unchanged.
 *   TL      — full-team data, with a Team / Self toggle on the
 *             LIST only (Self loads a second queue result with
 *             assignedTo=self; the KPI cards never change).
 *   Manager — TL-grouped: each Team Lead's group expands to
 *             member sub-groups, then items (Manager → TL →
 *             member → lead).
 *   Admin   — flat org-wide, with admin-assigned items filtered
 *             out client-side (an admin never appears in report
 *             data). Caveat: the server-computed KPI counts
 *             cannot be filtered client-side, so an
 *             admin-assigned lead's follow-up still counts in
 *             the server totals — only the ITEMS list is
 *             filtered. Reported to Mahadi.
 */
interface ChecklistRowProps {
  item: FollowUpQueueItem;
  done: boolean;
  onComplete: (item: FollowUpQueueItem) => void;
}

const ChecklistRow: FC<ChecklistRowProps> = ({ item, done, onComplete }) => {
  const navigate = useNavigate();
  const name = item.prospectName || item.customerName || 'Unnamed lead';
  const assignee = item.assignedEmployeeName || item.assignedTo || 'Unassigned';
  const overdueLabel = item.dueState === 'overdue'
    ? `Overdue${item.overdueDays ? ` ${item.overdueDays}d` : ''} · `
    : '';
  return (
    <div className={cn('ep-checklist-row', done && 'ep-checklist-done')}>
      <input
        type="checkbox"
        className="ep-checklist-box"
        checked={done}
        disabled={done}
        onChange={() => onComplete(item)}
        aria-label={`Complete follow-up for ${name}`}
      />
      <button
        type="button"
        className="ep-checklist-copy"
        onClick={() => navigate(`/leads/${encodeURIComponent(item.id)}`)}
        aria-label={`Open ${name}`}
      >
        <strong>{name}</strong>
        <small>{overdueLabel}{item.currentStatus} · {assignee}</small>
      </button>
      <span className="ep-checklist-time">
        {item.dueState === 'overdue'
          ? formatDhakaShort(item.nextFollowUpAt)
          : formatDhakaTime(item.nextFollowUpAt)}
      </span>
      <Link
        className="ep-checklist-update"
        to={`/leads/${encodeURIComponent(item.id)}/update`}
      >
        Update
      </Link>
    </div>
  );
};

export default function FollowUpStrategy() {
  const user = useAuthStore(state => state.user);
  const { role: displayRole } = useEnterpriseDisplayRole();
  const callerTeam = useCallerTeam();
  const [searchParams, setSearchParams] = useSearchParams();
  const bucketFromUrl = searchParams.get('bucket');
  const [active, setActive] = useState<Bucket>(isValidBucket(bucketFromUrl) ? bucketFromUrl : 'overdue');
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<FollowUpQueueResult | null>(null);

  // TL Team / Self toggle (2026-11-20): the LIST only — the KPI
  // cards stay team-wide. Self loads a second queue result with
  // assignedTo=self; the server narrows within visibility.
  const [listScope, setListScope] = useState<'team' | 'self'>('team');
  const [selfData, setSelfData] = useState<FollowUpQueueResult | null>(null);
  const [selfLoading, setSelfLoading] = useState(false);
  // Manager TL groups: which TL groups are expanded.
  const [expandedTls, setExpandedTls] = useState<Set<string>>(new Set());

  // The caller's visible leads (for the Completed / On-time cards
  // and the Add-follow-up lead picker). Loaded once, separately
  // from the queue — a slow leads load never blocks the queue.
  const [leads, setLeads] = useState<Lead[]>([]);
  const [leadsLoading, setLeadsLoading] = useState(true);
  const [leadsError, setLeadsError] = useState(false);

  // The FollowUpStatus dictionary (names for the outcome select,
  // terminal flags for the next-follow-up rule). getAllValues — not
  // getOptionsByType — because only the full options carry meta.
  const [statusOptions, setStatusOptions] = useState<DropdownOption[]>([]);

  // Rows completed this session that still sit in the bucket:
  // struck through until the next load drops them.
  const [justCompleted, setJustCompleted] = useState<Set<string>>(new Set());

  // Outcome dialog state.
  const [outcomeLead, setOutcomeLead] = useState<FollowUpQueueItem | null>(null);
  const [outcomeStatus, setOutcomeStatus] = useState('');
  const [outcomeRemarks, setOutcomeRemarks] = useState('');
  const [outcomeNext, setOutcomeNext] = useState('');
  const [outcomeBusy, setOutcomeBusy] = useState(false);
  const [outcomeError, setOutcomeError] = useState<string | null>(null);

  // Add-follow-up dialog state.
  const [addOpen, setAddOpen] = useState(false);
  const [addLeadId, setAddLeadId] = useState('');
  const [addWhen, setAddWhen] = useState('');
  const [addNote, setAddNote] = useState('');
  const [addBusy, setAddBusy] = useState(false);

  // Keep the selected bucket in the URL so dashboard deep links
  // (/follow-up?bucket=overdue|today|upcoming) open the right tab, and the
  // browser back/forward buttons still work.
  const selectBucket = (bucket: Bucket) => {
    setActive(bucket);
    setSearchParams({ bucket }, { replace: true });
  };

  useEffect(() => {
    const next = searchParams.get('bucket');
    if (isValidBucket(next) && next !== active) setActive(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const load = useCallback(async (bucket: Bucket) => {
    setLoading(true);
    try {
      const result = await leadService.getFollowUpQueue({ bucket, limit: 100 });
      setData(result);
    } catch (err: any) {
      toast.error(err?.message || 'Could not load follow-up queue');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSelf = useCallback(async (bucket: Bucket) => {
    if (!user?.employeeId) return;
    setSelfLoading(true);
    try {
      const result = await leadService.getFollowUpQueue({ bucket, limit: 100, assignedTo: user.employeeId });
      setSelfData(result);
    } catch {
      setSelfData(null);
    } finally {
      setSelfLoading(false);
    }
  }, [user?.employeeId]);

  const loadLeads = useCallback(async () => {
    setLeadsLoading(true);
    setLeadsError(false);
    try {
      setLeads(await leadService.getLeads());
    } catch {
      setLeads([]);
      setLeadsError(true);
    } finally {
      setLeadsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(active);
  }, [active, load]);

  useEffect(() => {
    if (displayRole === 'teamLead' && listScope === 'self') void loadSelf(active);
  }, [active, displayRole, listScope, loadSelf]);

  useEffect(() => {
    void loadLeads();
    void (async () => {
      try {
        const options = await metadataService.getAllValues('FollowUpStatus');
        setStatusOptions(Array.isArray(options) ? options : []);
      } catch {
        setStatusOptions([]);
      }
    })();
  }, [loadLeads]);

  const counts = data?.counts || { overdue: 0, today: 0, upcoming: 0, all: 0 };
  const self = useMemo(
    () => (callerTeam.overview ? getSelfPerson(callerTeam.overview.people) : undefined),
    [callerTeam.overview],
  );
  const people = useMemo(() => callerTeam.overview?.people ?? [], [callerTeam.overview]);
  const scopeIds = useMemo(
    () => (self ? new Set(scopePeople(people, self, displayRole).map(p => String(p.employeeId).toUpperCase())) : null),
    [people, self, displayRole],
  );
  const adminIds = useMemo(
    () => new Set(people.filter(isAdminPerson).map(p => String(p.employeeId).toUpperCase())),
    [people],
  );
  // Completed / On-time / Add-follow-up use the scope's own leads
  // (assignee-scoped; the Agent's list is unchanged).
  const scopedLeads = useMemo(() => {
    if (displayRole === 'agent' || !scopeIds) return leads;
    return scopeLeadsByAssignee(leads, scopeIds);
  }, [leads, scopeIds, displayRole]);
  const completedCount = useMemo(() => completedToday(scopedLeads).length, [scopedLeads]);
  const onTime = useMemo(() => onTimeRate(scopedLeads), [scopedLeads]);
  const terminalNames = useMemo(
    () => resolveTerminalNames(statusOptions),
    [statusOptions],
  );
  const statusNames = useMemo(
    () => statusOptions
      .map(option => option.label || option.value || '')
      .filter(Boolean),
    [statusOptions],
  );
  const addLeadOptions = useMemo(
    () => scopedLeads
      .filter(lead => !terminalNames.has(lead.currentStatus))
      .sort((a, b) => String(a.prospectName || '').localeCompare(String(b.prospectName || ''))),
    [scopedLeads, terminalNames],
  );

  // The displayed items: the Self result for a TL on Self, else
  // the team result — filtered to the scope (Manager subtree;
  // Admin minus admin-assigned). Unassigned items stay
  // (distribution work); the Agent's list is unchanged.
  const rawItems = (displayRole === 'teamLead' && listScope === 'self' ? selfData?.items : data?.items) || [];
  const items = useMemo(() => {
    if (displayRole === 'agent' || !scopeIds) return rawItems;
    return rawItems.filter(item => {
      const assignee = String(item.assignedTo || '').toUpperCase();
      if (!assignee) return true;
      if (adminIds.has(assignee)) return false;
      if (displayRole === 'manager' && !scopeIds.has(assignee)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawItems, displayRole, scopeIds, adminIds]);

  // Manager TL groups: items under their assignee's nearest TL
  // ancestor (unassigned items group under the Manager themself).
  const managerGroups = useMemo(() => {
    if (displayRole !== 'manager' || !self) return [];
    const groups = new Map<string, { tl: TeamOverviewPerson; total: number; members: Map<string, { name: string; items: FollowUpQueueItem[] }> }>();
    for (const item of items) {
      const assignee = String(item.assignedTo || '').trim();
      const tl = assignee ? tlAncestorOf(people, assignee, self.employeeId) : null;
      const groupPerson = tl ?? self;
      const key = String(groupPerson.employeeId).toUpperCase();
      let group = groups.get(key);
      if (!group) {
        group = { tl: groupPerson, total: 0, members: new Map() };
        groups.set(key, group);
      }
      group.total += 1;
      const memberKey = assignee ? assignee.toUpperCase() : 'UNASSIGNED';
      const memberName = assignee ? (item.assignedEmployeeName || assignee) : 'Unassigned';
      let member = group.members.get(memberKey);
      if (!member) {
        member = { name: memberName, items: [] };
        group.members.set(memberKey, member);
      }
      member.items.push(item);
    }
    return [...groups.values()].sort((a, b) => a.tl.name.localeCompare(b.tl.name));
  }, [items, people, self, displayRole]);

  const tabs: Array<{ id: Bucket; label: string; icon: typeof Clock; count: number }> = [
    { id: 'overdue', label: 'Overdue', icon: AlertTriangle, count: counts.overdue },
    { id: 'today', label: 'Due Today', icon: Clock, count: counts.today },
    { id: 'upcoming', label: 'Upcoming', icon: Calendar, count: counts.upcoming },
  ];

  const openOutcome = (item: FollowUpQueueItem) => {
    setOutcomeLead(item);
    setOutcomeStatus('');
    setOutcomeRemarks('');
    setOutcomeNext('');
    setOutcomeError(null);
  };
  const closeOutcome = () => {
    setOutcomeLead(null);
    setOutcomeError(null);
  };

  const outcomeIsTerminal = outcomeStatus !== '' && terminalNames.has(outcomeStatus);
  const outcomeCanSave =
    outcomeLead !== null
    && outcomeStatus !== ''
    && (outcomeIsTerminal || outcomeNext !== '');

  const submitOutcome = async () => {
    if (!outcomeLead || !outcomeCanSave) return;
    setOutcomeBusy(true);
    setOutcomeError(null);
    try {
      const nextDate = outcomeIsTerminal || !outcomeNext
        ? undefined
        : new Date(outcomeNext).toISOString();
      await leadService.updateLeadStatus(
        outcomeLead.id,
        outcomeStatus as never,
        undefined,
        outcomeRemarks.trim() || undefined,
        nextDate,
      );
      setJustCompleted(prev => new Set(prev).add(outcomeLead.id));
      toast.success('Outcome logged — the follow-up is done.');
      closeOutcome();
      void load(active);
      if (displayRole === 'teamLead' && listScope === 'self') void loadSelf(active);
      void loadLeads();
    } catch (err: any) {
      // The server's own message (e.g. a stage-rule refusal), plus
      // the escape hatch to the full update page in the footer.
      setOutcomeError(err?.message || 'Could not save the outcome.');
    } finally {
      setOutcomeBusy(false);
    }
  };

  const submitAddFollowUp = async () => {
    const lead = leads.find(l => l.id === addLeadId);
    if (!lead || !addWhen) return;
    setAddBusy(true);
    try {
      const note = addNote.trim();
      const existing = String(lead.otherInfo || '').trim();
      const dateLabel = formatDhakaShort(new Date(addWhen).toISOString());
      const otherInfo = note
        ? existing ? `${existing}\n[${dateLabel}] ${note}` : `[${dateLabel}] ${note}`
        : lead.otherInfo;
      await leadService.updateLead(lead.id, {
        nextFollowUpDate: new Date(addWhen).toISOString(),
        otherInfo,
      });
      toast.success(`Follow-up scheduled for ${lead.prospectName || 'the lead'}.`);
      setAddOpen(false);
      setAddLeadId('');
      setAddWhen('');
      setAddNote('');
      void load(active);
      if (displayRole === 'teamLead' && listScope === 'self') void loadSelf(active);
      void loadLeads();
    } catch (err: any) {
      toast.error(err?.message || 'Could not schedule the follow-up.');
    } finally {
      setAddBusy(false);
    }
  };

  const listLoading = displayRole === 'teamLead' && listScope === 'self' ? selfLoading : loading;

  const toggleTlGroup = (employeeId: string) => {
    setExpandedTls(prev => {
      const next = new Set(prev);
      const key = employeeId.toUpperCase();
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="ep-page">
      <BackButton fallback="/" />
      <EnterprisePageHeader
        path="/follow-up"
        actions={(
          <>
            <span className="ep-pill">Asia/Dhaka · {data?.todayDate || '—'}</span>
            <button
              type="button"
              onClick={() => { void load(active); if (displayRole === 'teamLead' && listScope === 'self') void loadSelf(active); void loadLeads(); }}
              className="ep-btn"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </button>
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="ep-btn ep-btn-primary"
            >
              ＋ Add follow-up
            </button>
          </>
        )}
      />

      <div className="ep-grid">
        <KpiCard
          label="Due today"
          value={counts.today}
          foot={counts.overdue > 0 ? `${counts.overdue} overdue` : 'Nothing overdue'}
          tone={counts.overdue > 0 ? 'orange' : undefined}
        />
        <KpiCard
          label="Upcoming"
          value={counts.upcoming}
          foot="Scheduled ahead"
        />
        <KpiCard
          label="Completed"
          value={leadsLoading ? '…' : leadsError ? '—' : completedCount}
          foot={leadsError ? 'Could not be loaded' : 'Logged today'}
        />
        {onTime && (
          <KpiCard
            label="On-time rate"
            value={`${onTime.rate}%`}
            foot={`${onTime.onTime} of ${onTime.total} on time`}
          />
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3" style={{ marginBottom: 18 }}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => selectBucket(tab.id)}
            className={cn(
              'ep-card ep-kpi-btn',
              active === tab.id && 'active'
            )}
            aria-pressed={active === tab.id}
          >
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-2">
                <tab.icon className="w-4 h-4 text-[#978C21]" />
                {tab.label}
              </span>
              <span className="text-2xl font-black italic text-slate-800">{tab.count}</span>
            </div>
          </button>
        ))}
      </div>

      {displayRole === 'teamLead' && (
        <div className="ep-scope-toggle" role="group" aria-label="Whose follow-ups to show">
          <button
            type="button"
            className={listScope === 'team' ? 'active' : ''}
            aria-pressed={listScope === 'team'}
            onClick={() => setListScope('team')}
          >
            Team
          </button>
          <button
            type="button"
            className={listScope === 'self' ? 'active' : ''}
            aria-pressed={listScope === 'self'}
            onClick={() => setListScope('self')}
          >
            Self
          </button>
          <span className="ep-scope-toggle-note">
            {listScope === 'team' ? 'Your whole team\u2019s follow-ups' : 'Only your own follow-ups'}
          </span>
        </div>
      )}

      {listLoading ? (
        <div className="flex justify-center py-16">
          <div className="w-10 h-10 border-4 border-slate-100 border-t-[#978C21] rounded-full animate-spin" />
        </div>
      ) : displayRole === 'manager' ? (
        <div className="ep-card">
          <div className="ep-cardhead">
            <h3>{BUCKET_HEADINGS[active]}</h3>
            <span className="ep-muted">{items.length} follow-up{items.length === 1 ? '' : 's'} · grouped by team lead</span>
          </div>
          {managerGroups.length === 0 ? (
            <p className="ep-empty">No {active} follow-ups in your visibility</p>
          ) : (
            <div className="ep-tlgroup-list">
              {managerGroups.map(group => {
                const expanded = expandedTls.has(String(group.tl.employeeId).toUpperCase());
                const members = [...group.members.values()];
                return (
                  <div key={group.tl.employeeId} className="ep-tlgroup">
                    <button
                      type="button"
                      className="ep-tlgroup-head"
                      onClick={() => toggleTlGroup(group.tl.employeeId)}
                      aria-expanded={expanded}
                    >
                      <span className="ep-tlgroup-name">
                        {group.tl.name}
                        <small>{group.tl.designation || group.tl.roleName || 'Team Lead'}</small>
                      </span>
                      <span className="ep-tlgroup-count">{group.total} follow-up{group.total === 1 ? '' : 's'}</span>
                      <span className="ep-tlgroup-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                    </button>
                    {expanded && (
                      <div className="ep-tlgroup-body">
                        {members.map(member => (
                          <div key={member.name} className="ep-tlgroup-member">
                            <p className="ep-tlgroup-member-name">
                              {member.name} · {member.items.length} follow-up{member.items.length === 1 ? '' : 's'}
                            </p>
                            <div className="ep-checklist">
                              {member.items.map(item => (
                                <ChecklistRow
                                  key={item.id}
                                  item={item}
                                  done={justCompleted.has(item.id)}
                                  onComplete={openOutcome}
                                />
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="ep-card">
          <div className="ep-cardhead">
            <h3>{BUCKET_HEADINGS[active]}</h3>
            <span className="ep-muted">{items.length} follow-up{items.length === 1 ? '' : 's'}</span>
          </div>
          {items.length === 0 ? (
            <p className="ep-empty">No {active} follow-ups in your visibility</p>
          ) : (
            <div className="ep-checklist">
              {items.map(item => (
                <ChecklistRow
                  key={item.id}
                  item={item}
                  done={justCompleted.has(item.id)}
                  onComplete={openOutcome}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="ep-tipbar">
        <span>
          <strong>Tip:</strong> after every call or message, log the outcome and schedule the
          next follow-up to keep your pipeline accurate.
        </span>
      </div>

      {outcomeLead && (
        <div className="ep-dialog-overlay" role="dialog" aria-modal="true" aria-label="Log follow-up outcome">
          <div className="ep-dialog">
            <div className="ep-dialog-head">
              <div>
                <h3>Log follow-up outcome</h3>
                <div className="ep-muted">
                  {outcomeLead.prospectName || outcomeLead.customerName || 'Unnamed lead'} · {outcomeLead.currentStatus}
                </div>
              </div>
              <button type="button" className="ep-btn" onClick={closeOutcome} aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="ep-dialog-body">
              <div className="space-y-4" style={{ paddingTop: 8 }}>
                <label className="ep-field-label">
                  Outcome status
                  <select
                    className="ep-select"
                    value={outcomeStatus}
                    onChange={e => setOutcomeStatus(e.target.value)}
                  >
                    <option value="">Select the outcome…</option>
                    {statusNames.map(name => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </label>
                <label className="ep-field-label">
                  Remarks (optional)
                  <textarea
                    className="ep-input"
                    rows={2}
                    value={outcomeRemarks}
                    onChange={e => setOutcomeRemarks(e.target.value)}
                    placeholder="What happened on the call?"
                  />
                </label>
                <label className="ep-field-label">
                  Next follow-up{outcomeIsTerminal ? ' (not needed — terminal status)' : ''}
                  <input
                    type="datetime-local"
                    className="ep-input"
                    value={outcomeNext}
                    onChange={e => setOutcomeNext(e.target.value)}
                    disabled={outcomeIsTerminal}
                  />
                </label>
                <p className="ep-muted">
                  Saving logs this outcome in the lead's history — it cannot be un-logged.
                </p>
                {outcomeError && (
                  <p className="ep-error-body" role="alert">{outcomeError}</p>
                )}
              </div>
            </div>
            <div className="ep-dialog-foot">
              <Link
                className="ep-btn"
                to={`/leads/${encodeURIComponent(outcomeLead.id)}/update`}
              >
                Open the full update page →
              </Link>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="ep-btn" onClick={closeOutcome}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="ep-btn ep-btn-primary"
                  onClick={() => void submitOutcome()}
                  disabled={!outcomeCanSave || outcomeBusy}
                >
                  {outcomeBusy ? 'Saving…' : 'Save outcome'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {addOpen && (
        <div className="ep-dialog-overlay" role="dialog" aria-modal="true" aria-label="Add follow-up">
          <div className="ep-dialog">
            <div className="ep-dialog-head">
              <div>
                <h3>Add follow-up</h3>
                <div className="ep-muted">Schedule a follow-up on one of your leads</div>
              </div>
              <button type="button" className="ep-btn" onClick={() => setAddOpen(false)} aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="ep-dialog-body">
              <div className="space-y-4" style={{ paddingTop: 8 }}>
                <label className="ep-field-label">
                  Lead
                  <select
                    className="ep-select"
                    value={addLeadId}
                    onChange={e => setAddLeadId(e.target.value)}
                  >
                    <option value="">Select a lead…</option>
                    {addLeadOptions.map(lead => (
                      <option key={lead.id} value={lead.id}>
                        {lead.prospectName || 'Unnamed lead'} · {lead.currentStatus}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="ep-field-label">
                  Follow-up date &amp; time
                  <input
                    type="datetime-local"
                    className="ep-input"
                    value={addWhen}
                    onChange={e => setAddWhen(e.target.value)}
                  />
                </label>
                <label className="ep-field-label">
                  Note (optional)
                  <textarea
                    className="ep-input"
                    rows={2}
                    value={addNote}
                    onChange={e => setAddNote(e.target.value)}
                    placeholder="What is this follow-up about?"
                  />
                </label>
                {addLeadOptions.length === 0 && !leadsLoading && (
                  <p className="ep-muted">No open leads to schedule a follow-up on.</p>
                )}
              </div>
            </div>
            <div className="ep-dialog-foot">
              <button type="button" className="ep-btn" onClick={() => setAddOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="ep-btn ep-btn-primary"
                onClick={() => void submitAddFollowUp()}
                disabled={!addLeadId || !addWhen || addBusy}
              >
                {addBusy ? 'Scheduling…' : 'Schedule follow-up'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
