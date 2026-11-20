import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Search,
  Filter,
  Download,
  ChevronRight,
  XCircle,
  RefreshCw,
  Target,
  Trash2,
  UserCog,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuthStore } from '../../auth/store/authStore';
import { Lead, LeadQuality, LeadStatus } from '../../shared/types';
import { toast } from 'sonner';
import { leadService, type LeadExportScope, type LeadExportBasis } from '../services/leadService';
import { settingsService } from '../../../services/settingsService';
import AdvancedFilterPanel from '../../shared/components/AdvancedFilterPanel';
import { EnterprisePageHeader } from '../../workspace/components/EnterprisePrimitives';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { useCallerTeam } from '../../team/hooks/useCallerTeam';
import { downlineOf, getSelfPerson } from '../../team/services/teamOverviewService';
import { useEnterpriseDisplayRole } from '../../../layouts/enterpriseDisplayRole';
import {
  groupLeadsByTl,
  leadCreatorEmployeeId,
  myLeadsFor,
  teamLeadsForRole,
} from '../../workspace/utils/teamWorkspaceData';
import { useCanReassign } from '../hooks/useCanReassign';
import ReassignLeadDialog from '../components/ReassignLeadDialog';
import RequestDeleteDialog from '../components/RequestDeleteDialog';
import { LeadQuickViewModal } from '../components/LeadQuickViewModal';
import { getLeadStatusColorClasses, getLeadStatusOrder } from '../../workflow/utils/leadStatusMeta';
import { dhakaDayKey, formatDhakaShort } from '../../workspace/utils/enterpriseData';
import { isTerminalStatus } from '../../workspace/utils/agentWorkspaceData';
import type { TeamOverviewPerson } from '../../team/services/teamOverviewService';
import type { TlLeadGroup } from '../../workspace/utils/teamWorkspaceData';
import { Link } from 'react-router-dom';

const getStatusColor = (status: string) => getLeadStatusColorClasses(status);

/** Priority pill tone (Priority is a configurable metadata list,
    so anything outside High/Medium falls back to the default). */
const getPriorityTone = (priority: string): string => {
  const p = String(priority || '').toLowerCase();
  if (p === 'high') return 'red';
  if (p === 'medium') return 'orange';
  return '';
};

/**
 * Manager TL-group cards (2026-11-20, Mahadi: the Manager FIRST
 * sees data grouped by Team Lead). One card per TL: their member
 * count, lead count, open/converted split. Clicking drills to
 * that TL's member-wise data (?tl=).
 */
function ManagerTlGroups(props: { groups: TlLeadGroup[]; people: TeamOverviewPerson[] }) {
  const { groups, people } = props;
  if (groups.length === 0) {
    return <p className="ep-empty">No team leads in scope yet.</p>;
  }
  return (
    <div className="ep-grid">
      {groups.map(group => {
        const memberCount = 1 + downlineOf(people, group.tl.employeeId).length;
        const open = group.leads.filter(l => !isTerminalStatus(l.currentStatus)).length;
        const converted = group.leads.filter(l => l.currentStatus === 'Converted').length;
        return (
          <Link
            key={group.tl.employeeId}
            to={`/leads?tl=${encodeURIComponent(group.tl.employeeId)}`}
            className="ep-card ep-kpi-link"
            aria-label={`Open ${group.tl.name}'s team leads`}
          >
            <div className="ep-metric-label">{group.tl.name}</div>
            <div className="ep-metric">{group.leads.length}</div>
            <div className="ep-trend">
              {memberCount} member{memberCount === 1 ? '' : 's'} · {open} open · {converted} converted
            </div>
          </Link>
        );
      })}
    </div>
  );
}

/**
 * Manager member-wise rows for one TL (the second drill-down
 * level): each member's lead count, clicking through to their
 * leads in the standard table (?tl= + ?member=).
 */
function ManagerTlMembers(props: {
  tl: TeamOverviewPerson;
  members: Array<{ person: TeamOverviewPerson; leads: Lead[] }>;
}) {
  const { tl, members } = props;
  return (
    <div className="ep-card">
      <div className="ep-cardhead">
        <div>
          <h3>{tl.name}&rsquo;s team</h3>
          <div className="ep-muted">{members.length} member{members.length === 1 ? '' : 's'} · click a member to see their leads</div>
        </div>
        <Link className="ep-viewall" to="/leads">← All teams</Link>
      </div>
      {members.length === 0 ? (
        <p className="ep-empty">No members in this team yet.</p>
      ) : (
        <div className="ep-member-list">
          {members.map(({ person, leads }) => {
            const converted = leads.filter(l => l.currentStatus === 'Converted').length;
            return (
              <Link
                key={person.userId}
                to={`/leads?tl=${encodeURIComponent(tl.employeeId)}&member=${encodeURIComponent(person.employeeId)}`}
                className="ep-member-row"
                aria-label={`Open ${person.name}'s leads`}
              >
                <span className="ep-miniavatar" aria-hidden="true">
                  {String(person.name || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?'}
                </span>
                <span className="ep-member-copy">
                  <strong>{person.name}</strong>
                  <small>
                    {person.designation || person.roleName || 'Team member'}
                    {` · ${leads.length} lead${leads.length === 1 ? '' : 's'} · ${converted} converted`}
                  </small>
                </span>
                <span className="ep-member-pct">→</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function LeadList(props: { scope?: 'default' | 'my' }) {
  const listScope = props.scope ?? 'default';
  const { user } = useAuthStore();
  const { role: displayRole, loading: displayLoading } = useEnterpriseDisplayRole();
  const [searchParams] = useSearchParams();
  const { canAccess } = usePermissions();
  const canEditLead = canAccess('lead_tracking', 'edit');
  const canExportLeads = canAccess('lead_tracking', 'export');
  // Reassign (2026-11-19, extended 2026-11-20, Mahadi): same hook
  // as Lead360 — Team Lead / Manager / Admin holding the
  // leads.assign grant; a plain Agent (or a super admin previewing
  // as Agent) never sees the button.
  const canReassign = useCanReassign();
  const callerTeam = useCallerTeam();
  const [reassignLead, setReassignLead] = useState<Lead | null>(null);

  // Delete request (migration 062): clicking the trash icon opens the
  // shared request dialog — it files a REQUEST for admin review, it
  // never deletes the lead at once. A pending lead shows a
  // "Delete requested" marker and the icon is disabled until the
  // admin reviews it.
  const [deleteTarget, setDeleteTarget] = useState<Lead | null>(null);

  const markDeleteRequested = (leadId: string) => {
    setLeads(prev => prev.map(l => (l.id === leadId ? { ...l, deleteRequested: true } : l)));
  };
  const location = useLocation();
  const navigate = useNavigate();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [advancedFilteredLeads, setAdvancedFilteredLeads] = useState<Lead[]>([]);
  const [sortLogic, setSortLogic] = useState<'Recency' | 'Economic Potential' | 'Priority Status' | 'Quality: High to Low' | 'Quality: Low to High'>('Recency');
  // Lead Quality band filter — compares the SERVER-computed band only.
  const [qualityBand, setQualityBand] = useState<string>('All');
  const [search, setSearch] = useState('');
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [activeStatus, setActiveStatus] = useState('All');
  // Priority filter (Agent workspace rebuild, 2026-11-20): the
  // demo's "All priorities" dropdown. The stage filter stays the
  // status tabs above — one control per filter, no duplicate
  // "All stages" dropdown.
  const [priorityFilter, setPriorityFilter] = useState<string>('All');
  // The quick-view modal (demo screenshot 3): read-only, with a
  // path to the full Lead360 workspace and the update flow.
  const [quickViewLead, setQuickViewLead] = useState<Lead | null>(null);
  const mobileSearchRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(true);
  const [statusOptions, setStatusOptions] = useState<string[]>([]);
  // FIX-2 scoped export dialog (server-built Excel workbook, leads.export).
  const [exportOpen, setExportOpen] = useState(false);
  const [exportScopes, setExportScopes] = useState<LeadExportScope[]>(['own']);
  const [exportMaxRows, setExportMaxRows] = useState(10000);
  const [exportScope, setExportScope] = useState<LeadExportScope>('own');
  const [exportBasis, setExportBasis] = useState<LeadExportBasis>('updated');
  const [exportFrom, setExportFrom] = useState('');
  const [exportTo, setExportTo] = useState('');
  const [exportBusy, setExportBusy] = useState(false);

  // FIX-1c — deep links (?leadId=, used by notifications and the Task
  // Calendar) land on the Lead 360 workspace, the same full-page format
  // every other lead entry point opens. The quick-view modal on this
  // page is read-only (a glance + links to Lead 360 and the update
  // flow); opening or editing a lead from this page still navigates
  // to /leads/:id, and status updates run through the Update page.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const leadId = params.get('leadId');
    if (leadId) {
      navigate(`/leads/${encodeURIComponent(leadId)}`, { replace: true });
    }
  }, [location.search, navigate]);

  // Lead Workspace intentionally has no assignment-management data load.
  // Ownership changes belong to Lead Pool; this page stays focused on
  // operational execution against the server-visible lead set.

  useEffect(() => {
    loadLeads();
    loadStatusOptions();
  }, [user]);

  useEffect(() => {
    if (mobileSearchOpen) mobileSearchRef.current?.focus();
  }, [mobileSearchOpen]);

  const loadLeads = async () => {
    if (!user) return;
    setLoading(true);
    try {
      // The API derives both identity and Data Visibility from the session.
      // Do not send a client-selected role or employee id to widen scope.
      const visibleLeads = await leadService.getLeads();
      setLeads(visibleLeads);
    } catch (err) {
      toast.error('Failed to sync lead intelligence');
    } finally {
      setLoading(false);
    }
  };

  // Scope split (2026-11-20, Mahadi): the server-visible set is
  // narrowed client-side per display role — never widened.
  //   TL /leads      = members-only (+ own-created unassigned)
  //   TL /leads/my   = assigned-to-self OR created-by-self
  //   Manager /leads = downline, TL-grouped (see below)
  //   Admin /leads   = org-wide minus admin-assigned leads
  //   Agent /leads   = unchanged (server scope is own-only)
  // While the overview is still loading the list stays empty —
  // the page spinner covers that window (see the loading check
  // below), so no out-of-scope row ever flashes.
  const self = useMemo(
    () => (callerTeam.overview ? getSelfPerson(callerTeam.overview.people) : undefined),
    [callerTeam.overview],
  );
  const people = useMemo(() => callerTeam.overview?.people ?? [], [callerTeam.overview]);
  const peopleByUserId = useMemo(
    () => new Map(people.map(p => [p.userId, p])),
    [people],
  );
  const scopedLeads = useMemo(() => {
    if (!self) return [];
    if (listScope === 'my') return myLeadsFor(leads, people, self);
    return teamLeadsForRole(leads, people, self, displayRole);
  }, [leads, people, self, listScope, displayRole]);

  // Manager drill-down (2026-11-20, Mahadi: Manager → TL → member
  // → lead): ?tl=<empId> shows one TL's member-wise data;
  // ?member=<empId> shows that member's leads in the standard
  // table. A member's leads are the ones they own OR created.
  const tlParam = searchParams.get('tl');
  const memberParam = searchParams.get('member');
  const isManagerView = displayRole === 'manager' && listScope === 'default';
  const tlGroups = useMemo(
    () => (isManagerView && self ? groupLeadsByTl(scopedLeads, people, self) : []),
    [isManagerView, scopedLeads, people, self],
  );
  const selectedTlGroup = useMemo(
    () => tlGroups.find(g => String(g.tl.employeeId).toUpperCase() === String(tlParam || '').toUpperCase()),
    [tlGroups, tlParam],
  );
  const selectedMember = useMemo(
    () => people.find(p => String(p.employeeId).toUpperCase() === String(memberParam || '').toUpperCase()),
    [people, memberParam],
  );
  const memberFilteredLeads = useMemo(() => {
    if (!memberParam) return scopedLeads;
    const memberId = String(memberParam).toUpperCase();
    return scopedLeads.filter(lead =>
      String(lead.assignedTo || '').toUpperCase() === memberId
      || leadCreatorEmployeeId(lead, peopleByUserId) === memberId
    );
  }, [scopedLeads, memberParam, peopleByUserId]);
  const memberLeadIds = useMemo(
    () => new Set(memberFilteredLeads.map(l => String(l.id))),
    [memberFilteredLeads],
  );
  // Which Manager view renders: 'groups' (TL cards), 'members'
  // (one TL's member rows), null (the standard table).
  const managerGroupView: 'groups' | 'members' | null = !isManagerView
    ? null
    : memberParam
      ? null
      : tlParam
        ? 'members'
        : 'groups';
  const selectedTlMembers = useMemo(() => {
    if (!selectedTlGroup) return [];
    const tl = selectedTlGroup.tl;
    const members = [tl, ...downlineOf(people, tl.employeeId)];
    return members.map(person => {
      const memberId = String(person.employeeId).toUpperCase();
      const memberLeads = selectedTlGroup.leads.filter(lead =>
        String(lead.assignedTo || '').toUpperCase() === memberId
        || leadCreatorEmployeeId(lead, peopleByUserId) === memberId
      );
      return { person, leads: memberLeads };
    });
  }, [selectedTlGroup, people, peopleByUserId]);

  const DEFAULT_STATUS_LIST: LeadStatus[] = [
    'New',
    'Contacted',
    'No Response',
    'Busy',
    'Interested',
    'Follow-up Set',
    'Meeting Fixed',
    'Meeting Completed',
    'Pipeline Locked',
    'Converted',
    'Not Interested'
  ];
  const statusTabs = [
    'All',
    ...Array.from(new Set([
      ...(statusOptions.length ? statusOptions : DEFAULT_STATUS_LIST),
      ...memberFilteredLeads.map(lead => lead.currentStatus).filter(Boolean),
    ])),
  ];

  const loadStatusOptions = async () => {
    try {
      const res = await settingsService.getOptionsByType('FollowUpStatus');
      setStatusOptions(res && res.length > 0 ? res : DEFAULT_STATUS_LIST);
    } catch (err) {
      console.error(err);
      setStatusOptions(DEFAULT_STATUS_LIST);
    }
  };

  // Owner names for the table (Agent workspace rebuild): the roster
  // map resolves an assignee's employee ID to their name; the ID
  // itself is the fallback, and 'Unassigned' covers blank assignees.
  const ownerNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const person of callerTeam.overview?.people ?? []) {
      if (person.employeeId) map.set(String(person.employeeId).toUpperCase(), person.name);
    }
    if (user?.employeeId) map.set(String(user.employeeId).toUpperCase(), user.name);
    return map;
  }, [callerTeam.overview, user]);
  const ownerName = (lead: Lead): string => {
    if (!lead.assignedTo) return 'Unassigned';
    return ownerNameById.get(String(lead.assignedTo).toUpperCase()) || lead.assignedTo;
  };

  // Priority options come from the visible leads themselves (the
  // Priority list is configurable metadata, so no hardcoded set).
  const priorityOptions = useMemo(() => {
    const values = new Set<string>();
    for (const lead of memberFilteredLeads) if (lead.priority) values.add(lead.priority);
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [memberFilteredLeads]);

  const createdLabel = (lead: Lead): string => {
    if (!lead.creationDate) return '—';
    const created = new Date(lead.creationDate);
    if (Number.isNaN(created.getTime())) return '—';
    return dhakaDayKey(created) === dhakaDayKey(new Date())
      ? 'Today'
      : formatDhakaShort(lead.creationDate);
  };

  const filteredLeads = (() => {
    // Authoritative source of rules-filtered leads from dynamic query builder
    const baseList = advancedFilteredLeads.length > 0 || scopedLeads.length === 0 ? advancedFilteredLeads : scopedLeads;

    // Manager member drill-down: one member's leads only (the
    // advanced filter ran over the scoped set, so narrow here).
    const memberScoped = memberParam
      ? baseList.filter(lead => memberLeadIds.has(String(lead.id)))
      : baseList;

    // Narrow by server-computed Lead Quality band (never widens scope).
    const statusScoped = activeStatus === 'All'
      ? memberScoped
      : memberScoped.filter(lead => String(lead.currentStatus || '').toLowerCase() === activeStatus.toLowerCase());
    const qualityScoped =
      qualityBand === 'All'
        ? statusScoped
        : statusScoped.filter(lead => (lead.leadQuality as LeadQuality | undefined)?.band === qualityBand);
    const priorityScoped =
      priorityFilter === 'All'
        ? qualityScoped
        : qualityScoped.filter(lead => lead.priority === priorityFilter);

    // Filter using fast text search across demographics
    let result = priorityScoped.filter(lead => {
      const prospectName = String(lead.prospectName || '').toLowerCase();
      const mobile = String(lead.mobile || '');
      const mobileNum = String(lead.mobileNumber || '').toLowerCase();
      const leadId = String(lead.id || '').toLowerCase();
      const campaignName = String(lead.campaignName || '').toLowerCase();
      const areaVal = String(lead.area || '').toLowerCase();
      const sourceVal = String(lead.source || '').toLowerCase();
      const searchTerm = search.toLowerCase();

      const matchesRemarks = (lead.statusHistory || []).some(h => 
        String(h.remarks || '').toLowerCase().includes(searchTerm)
      );

      return prospectName.includes(searchTerm) || 
             mobile.includes(search) ||
             mobileNum.includes(search) ||
             leadId.includes(searchTerm) ||
             campaignName.includes(searchTerm) ||
             areaVal.includes(searchTerm) ||
             sourceVal.includes(searchTerm) ||
             matchesRemarks;
    });

    // Apply sort criteria
    result = [...result].sort((a, b) => {
      if (sortLogic === 'Recency') {
        const keyA = new Date(a.timestamp || a.creationDate || 0).getTime();
        const keyB = new Date(b.timestamp || b.creationDate || 0).getTime();
        return keyB - keyA;
      } else if (sortLogic === 'Economic Potential') {
        const potA = (a.collectedNCP || 0) + (a.projectedNCP || 0);
        const potB = (b.collectedNCP || 0) + (b.projectedNCP || 0);
        return potB - potA;
      } else if (sortLogic === 'Priority Status') {
        return getLeadStatusOrder(b.currentStatus) - getLeadStatusOrder(a.currentStatus);
      } else if (sortLogic === 'Quality: High to Low' || sortLogic === 'Quality: Low to High') {
        // Sort by the SERVER-computed score (missing scores sort last).
        const scoreA = (a.leadQuality as LeadQuality | undefined)?.score;
        const scoreB = (b.leadQuality as LeadQuality | undefined)?.score;
        const valA = typeof scoreA === 'number' ? scoreA : -1;
        const valB = typeof scoreB === 'number' ? scoreB : -1;
        if (valA !== valB) return sortLogic === 'Quality: High to Low' ? valB - valA : valA - valB;
        const keyA = new Date(a.timestamp || a.creationDate || 0).getTime();
        const keyB = new Date(b.timestamp || b.creationDate || 0).getTime();
        return keyB - keyA;
      }
      return 0;
    });

    return result;
  })();

  // FIX-2: the Export button opens the scoped-export dialog. The
  // workbook is built on the server (POST /api/leads/export) under
  // the caller's own visibility scope — this replaces the old
  // client-side CSV dump of whichever leads happened to be loaded.
  const openExportDialog = async () => {
    if (!canExportLeads) {
      toast.error('You do not have permission to export leads.');
      return;
    }
    setExportOpen(true);
    try {
      const options = await leadService.getLeadExportOptions();
      setExportScopes(options.scopes);
      setExportMaxRows(options.maxRows);
      if (!options.scopes.includes(exportScope)) setExportScope('own');
      if (!exportFrom) setExportFrom(options.defaults.from);
      if (!exportTo) setExportTo(options.defaults.to);
    } catch (err: any) {
      toast.error(err?.message || 'Could not load export options.');
    }
  };

  const runExport = async () => {
    if (exportFrom && exportTo && exportFrom > exportTo) {
      toast.error('The From date must not be after the To date.');
      return;
    }
    setExportBusy(true);
    try {
      const { blob, filename, leadCount, historyCount } = await leadService.exportLeads({
        scope: exportScope,
        basis: exportBasis,
        from: exportFrom || undefined,
        to: exportTo || undefined,
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportOpen(false);
      toast.success(`Exported ${leadCount} lead${leadCount === 1 ? '' : 's'} with ${historyCount} history events (Excel).`);
    } catch (err: any) {
      toast.error(err?.message || 'Export failed.');
    } finally {
      setExportBusy(false);
    }
  };

  if (!canAccess('lead_tracking', 'view')) {
    return (
      <div className="ep-page" style={{ maxWidth: 640 }}>
        <div className="ep-card" style={{ textAlign: 'center', marginTop: 48 }}>
          <h2 className="text-xl font-bold text-slate-800">Lead Workspace unavailable</h2>
          <p className="ep-muted" style={{ marginTop: 8 }}>Your current Feature Access does not include the Lead Workspace.</p>
        </div>
      </div>
    );
  }

  // My Leads is a Team Lead page only — every other role lands on
  // the standard list (the route gate cannot express a display-role
  // rule, so the page gates itself). Only once the display role
  // has settled — before that the derived role reads 'agent' and
  // a real TL would be bounced off their own page.
  if (listScope === 'my' && !displayLoading && displayRole !== 'teamLead') {
    return <Navigate to="/leads" replace />;
  }

  if (loading || callerTeam.loading || displayLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-4">
          <RefreshCw className="w-8 h-8 text-primary animate-spin" />
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Loading leads...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="ep-page">
      <EnterprisePageHeader
        path={listScope === 'my' ? '/leads/my' : '/leads'}
        actions={(
          <>
            {managerGroupView === null && (
            <div className="lf-mobile-lead-tools" aria-label="Lead search and filters">
              <button
                type="button"
                onClick={() => setMobileSearchOpen((open) => !open)}
                className={cn('lf-mobile-lead-tool', mobileSearchOpen && 'is-active')}
                aria-label={mobileSearchOpen ? 'Close lead search' : 'Search leads'}
                aria-expanded={mobileSearchOpen}
                aria-controls="mobile-lead-search"
              >
                <Search size={19} />
              </button>
              <button
                type="button"
                onClick={() => setMobileFiltersOpen((open) => !open)}
                className={cn('lf-mobile-lead-tool', mobileFiltersOpen && 'is-active')}
                aria-label={mobileFiltersOpen ? 'Close lead filters' : 'Filter leads'}
                aria-expanded={mobileFiltersOpen}
                aria-controls="mobile-lead-filters"
              >
                <Filter size={19} />
              </button>
            </div>
            )}
            <div className="lf-desktop-lead-actions flex items-center gap-2">
              {managerGroupView === null && (
              <button
                type="button"
                onClick={() => {
                  const panelBtn = document.getElementById('btn-advanced-filter-toggle');
                  if (panelBtn) {
                    panelBtn.click();
                    panelBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  }
                }}
                className="ep-btn"
              >
                <Filter className="w-3.5 h-3.5" />
                Segment Matrix
              </button>
              )}
              {canExportLeads && (
                <button
                  type="button"
                  onClick={openExportDialog}
                  className="ep-btn ep-btn-primary"
                >
                  <Download className="w-3.5 h-3.5" />
                  Export
                </button>
              )}
            </div>
          </>
        )}
      />

      {/* Manager drill-down views (2026-11-20): TL groups first,
          then one TL's members; the standard table renders only
          at the member level or for other roles. */}
      {managerGroupView === 'groups' && (
        <ManagerTlGroups groups={tlGroups} people={people} />
      )}
      {managerGroupView === 'members' && (
        selectedTlGroup ? (
          <ManagerTlMembers tl={selectedTlGroup.tl} members={selectedTlMembers} />
        ) : (
          <div className="ep-card" style={{ textAlign: 'center' }}>
            <p className="ep-muted">That team lead is not in your scope.</p>
            <Link className="ep-btn" to="/leads" style={{ marginTop: 12 }}>← All teams</Link>
          </div>
        )
      )}
      {isManagerView && memberParam && selectedMember && (
        <div style={{ marginBottom: 12 }}>
          <button
            type="button"
            className="ep-btn"
            onClick={() => navigate(tlParam ? `/leads?tl=${encodeURIComponent(tlParam)}` : '/leads')}
          >
            ← Back to {tlParam && selectedTlGroup ? `${selectedTlGroup.tl.name}'s team` : 'all teams'}
          </button>
        </div>
      )}

      {managerGroupView === null && (
      <>
      {mobileSearchOpen && (
        <div className="lf-mobile-lead-search" id="mobile-lead-search">
          <Search className="lf-mobile-lead-search-icon" size={18} aria-hidden="true" />
          <input
            ref={mobileSearchRef}
            type="search"
            placeholder="Search name, phone or lead ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search leads by name, phone, or lead ID"
          />
        </div>
      )}

      {mobileFiltersOpen && (
        <div className="lf-mobile-lead-filters" id="mobile-lead-filters">
          <label>
            <span>Lead quality</span>
            <select value={qualityBand} onChange={(e) => setQualityBand(e.target.value)}>
              <option value="All">All quality</option>
              <option value="Hot">Hot</option>
              <option value="Warm">Warm</option>
              <option value="Developing">Developing</option>
              <option value="Cold">Cold</option>
              <option value="Converted">Converted</option>
              <option value="Not Interested">Not interested</option>
            </select>
          </label>
          <label>
            <span>Priority</span>
            <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)}>
              <option value="All">All priorities</option>
              {priorityOptions.map(priority => (
                <option key={priority} value={priority}>{priority}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Sort leads</span>
            <select
              value={sortLogic}
              onChange={(e) => setSortLogic(e.target.value as typeof sortLogic)}
            >
              <option value="Recency">Most recent</option>
              <option value="Economic Potential">Economic potential</option>
              <option value="Priority Status">Priority status</option>
              <option value="Quality: High to Low">Quality: high to low</option>
              <option value="Quality: Low to High">Quality: low to high</option>
            </select>
          </label>
        </div>
      )}

      <div className="flex gap-2 overflow-x-auto border-b border-stone-100 pb-2" role="tablist" aria-label="Filter leads by status">
        {statusTabs.map(status => {
          const count = status === 'All'
            ? memberFilteredLeads.length
            : memberFilteredLeads.filter(lead => String(lead.currentStatus || '').toLowerCase() === status.toLowerCase()).length;
          const active = activeStatus === status;
          return (
            <button
              key={status}
              type="button"
              role="tab"
              aria-selected={active}
              aria-pressed={active}
              onClick={() => setActiveStatus(status)}
              className={cn(
                'inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-xs font-semibold transition-colors',
                active
                  ? 'border-[#978C21] bg-[#978C21] text-white'
                  : 'border-stone-200 bg-white text-stone-600 hover:border-stone-300 hover:bg-stone-50',
              )}
            >
              {status}
              <span className={cn('text-[10px]', active ? 'text-white/80' : 'text-stone-400')}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* Advanced multi-criteria search and dynamic filtering builder */}
      <AdvancedFilterPanel 
        onFilterChange={setAdvancedFilteredLeads} 
        allLeads={scopedLeads}
        className={cn(
          'ep-card lf-lead-advanced-filters',
          mobileFiltersOpen && 'is-mobile-open',
        )}
        isOpen={mobileFiltersOpen}
        onOpenChange={setMobileFiltersOpen}
      />

      <div className="ep-card ep-tablecard">
        <div className="lf-desktop-lead-controls p-6 border-b border-slate-50 flex flex-col md:flex-row md:items-center gap-6">
          <div className="relative flex-1">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input 
              type="text" 
              placeholder="Search name, phone or lead ID…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="ep-search"
              style={{ width: '100%', paddingLeft: 36 }}
            />
          </div>
          <div className="flex items-center gap-4">
             <div className="h-10 w-px bg-slate-200 hidden md:block" />
            <label className="text-[10px] font-black text-slate-300 uppercase tracking-widest italic whitespace-nowrap">Priority</label>
            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
              title="Filter by priority"
              className="ep-select"
            >
              <option value="All">All priorities</option>
              {priorityOptions.map(priority => (
                <option key={priority} value={priority}>{priority}</option>
              ))}
            </select>
            <label className="text-[10px] font-black text-slate-300 uppercase tracking-widest italic whitespace-nowrap">Quality</label>
            <select
              value={qualityBand}
              onChange={(e) => setQualityBand(e.target.value)}
              title="Filter by server-computed Lead Quality band"
              className="ep-select"
            >
              <option value="All">All Quality</option>
              <option value="Hot">Hot</option>
              <option value="Warm">Warm</option>
              <option value="Developing">Developing</option>
              <option value="Cold">Cold</option>
              <option value="Converted">Converted</option>
              <option value="Not Interested">Not Interested</option>
            </select>
            <label className="text-[10px] font-black text-slate-300 uppercase tracking-widest italic whitespace-nowrap">Sort by</label>
            <select 
              value={sortLogic}
              onChange={(e) => setSortLogic(e.target.value as any)}
              className="ep-select"
            >
              <option value="Recency">Recency</option>
              <option value="Economic Potential">Economic Potential</option>
              <option value="Priority Status">Priority Status</option>
              <option value="Quality: High to Low">Quality: High to Low</option>
              <option value="Quality: Low to High">Quality: Low to High</option>
            </select>
          </div>
        </div>

        <div className="lf-mobile-lead-list" aria-label="Lead prospects">
  {filteredLeads.length > 0 ? filteredLeads.map((lead) => (
    <div key={lead.id} className="lf-mobile-lead-row">
      <button
        type="button"
        className="lf-mobile-lead-open"
        onClick={() => navigate('/leads/' + lead.id)}
        aria-label={'Open details for ' + (lead.prospectName || 'Unknown Prospect')}
      >
        <span className="lf-mobile-lead-avatar" aria-hidden="true">
          {String(lead.prospectName || 'U').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}
        </span>
        <span className="lf-mobile-lead-copy">
          <strong>{lead.prospectName || 'Unknown Prospect'}</strong>
          <small>{lead.mobile || 'No mobile'}{lead.area ? ' · ' + lead.area : ''}</small>
          <span className="lf-mobile-lead-status">{lead.currentStatus || 'New'}</span>
          {lead.deleteRequested && (
            <span className="text-[9px] font-black uppercase tracking-wider text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-sm self-start">Delete requested</span>
          )}
        </span>
      </button>
      {/* Quick status update straight from the list (same rule as Lead 360:
          only when the role may edit leads). */}
      {canEditLead && (
        <button
          type="button"
          className="lf-row-action lf-row-action--primary"
          onClick={() => navigate(`/leads/${encodeURIComponent(lead.id)}/update`)}
          aria-label={'Update status for ' + (lead.prospectName || 'lead')}
          title="Update status"
        >
          <Target size={17} />
        </button>
      )}
      {canReassign && (
        <button
          type="button"
          className="lf-row-action"
          onClick={() => setReassignLead(lead)}
          aria-label={'Reassign lead for ' + (lead.prospectName || 'lead')}
          title="Reassign"
        >
          <UserCog size={17} />
        </button>
      )}
      {lead.deleteRequested ? (
        <button
          type="button"
          disabled
          className="lf-row-action"
          aria-label="Delete requested — waiting for admin review"
          title="Delete requested"
        >
          <Trash2 size={17} className="text-amber-500" />
        </button>
      ) : (
        <button
          type="button"
          className="lf-row-action"
          onClick={() => setDeleteTarget(lead)}
          aria-label={'Request deletion of ' + (lead.prospectName || 'lead')}
          title="Request deletion"
        >
          <Trash2 size={17} />
        </button>
      )}
      <button
        type="button"
        className="lf-row-action"
        onClick={() => navigate('/leads/' + lead.id)}
        aria-label={'Open details for ' + (lead.prospectName || 'Unknown Prospect')}
        title="Open lead"
      >
        <ChevronRight size={19} aria-hidden="true" />
      </button>
    </div>
  )) : <div className="lf-mobile-lead-empty">No prospects match your filters.</div>}
</div>

<div className="lf-desktop-lead-table ep-tablewrap">
  <table className="w-full text-left">
            <thead>
              <tr>
                <th>Lead</th>
                <th>Source</th>
                <th>Owner</th>
                <th>Priority</th>
                <th>Stage</th>
                <th>Created</th>
                <th style={{ textAlign: 'right' }}>Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredLeads.length > 0 ? filteredLeads.map((lead, idx) => (
                <motion.tr 
                  key={lead.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  className="group hover:bg-[#FBFAF8] transition-colors cursor-pointer relative"
                  onClick={() => navigate(`/leads/${lead.id}`)}
                >
                  {/* Desktop columns follow the demo (Agent workspace
                      rebuild, 2026-11-20): Lead / Source / Owner /
                      Priority / Stage / Created / Action. The Quality,
                      Campaign and Last Activity columns are gone from
                      this table (the quality filter stays above, and
                      quality + history stay on Lead 360). Row click
                      still opens Lead 360; "View ↗" opens the
                      read-only quick view instead. */}
                  <td>
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-[#F7F5E9] flex items-center justify-center text-[#817719] font-bold text-xs shrink-0 border border-[#EAE7D6]">
                        {String(lead.prospectName || 'U').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase()}
                      </div>
                      <div>
                        <div className="font-bold text-brand-text text-[13px] tracking-tight">
                           {lead.prospectName || 'Unknown Prospect'}
                        </div>
                        <p className="ep-cellsub">
                          {lead.id} · {lead.mobile || 'No mobile'}
                        </p>
                        {lead.deleteRequested && (
                          <span className="text-[8px] font-black text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-sm uppercase tracking-wider shrink-0">
                            Delete requested
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td>{lead.source || '—'}</td>
                  <td>{ownerName(lead)}</td>
                  <td>
                    {lead.priority ? (
                      <span className={cn('ep-pill', getPriorityTone(lead.priority))}>
                        {lead.priority}
                      </span>
                    ) : '—'}
                  </td>
                  <td>
                    <span className={cn('ep-pill', getStatusColor(lead.currentStatus))}>
                      {lead.currentStatus}
                    </span>
                  </td>
                  <td>{createdLabel(lead)}</td>
                  <td className="px-6 py-6 text-right">
                    <div className="flex items-center justify-end gap-1.5 opacity-100 transition-opacity">
                       <button
                         onClick={(e) => { e.stopPropagation(); setQuickViewLead(lead); }}
                         className="ep-btn"
                         title="View lead details"
                         aria-label={'View details for ' + (lead.prospectName || 'lead')}
                       >
                        View ↗
                       </button>
                       {canEditLead && (
                         <button
                           onClick={(e) => { e.stopPropagation(); navigate(`/leads/${encodeURIComponent(lead.id)}/update`); }}
                           className="p-2 border border-slate-100 hover:border-[#978C21] text-slate-400 hover:text-[#978C21] hover:bg-slate-50 rounded-sm shadow-xs transition-all bg-white cursor-pointer"
                           title="Update status"
                           aria-label={'Update status for ' + (lead.prospectName || 'lead')}
                         >
                          <Target className="w-3.5 h-3.5" />
                         </button>
                       )}
                       {canReassign && (
                         <button
                           onClick={(e) => { e.stopPropagation(); setReassignLead(lead); }}
                           className="p-2 border border-slate-100 hover:border-[#978C21] text-slate-400 hover:text-[#978C21] hover:bg-slate-50 rounded-sm shadow-xs transition-all bg-white cursor-pointer"
                           title="Reassign lead"
                           aria-label={'Reassign lead for ' + (lead.prospectName || 'lead')}
                         >
                          <UserCog className="w-3.5 h-3.5" />
                         </button>
                       )}
                       {lead.deleteRequested ? (
                         <button
                           disabled
                           onClick={(e) => e.stopPropagation()}
                           className="p-2 border border-amber-200 bg-amber-50 text-amber-500 rounded-sm shadow-xs transition-all cursor-not-allowed opacity-80"
                           title="Delete requested — waiting for admin review"
                           aria-label={'Delete requested for ' + (lead.prospectName || 'lead')}
                         >
                          <Trash2 className="w-3.5 h-3.5" />
                         </button>
                       ) : (
                         <button
                           onClick={(e) => { e.stopPropagation(); setDeleteTarget(lead); }}
                           className="p-2 border border-slate-100 hover:border-red-300 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-sm shadow-xs transition-all bg-white cursor-pointer"
                           title="Request deletion — an admin reviews it"
                           aria-label={'Request deletion of ' + (lead.prospectName || 'lead')}
                         >
                          <Trash2 className="w-3.5 h-3.5" />
                         </button>
                       )}
                    </div>
                  </td>
                </motion.tr>
              )) : (
                <tr>
                  <td colSpan={7} className="px-8 py-20 text-center">
                    <div className="flex flex-col items-center gap-3">
                       <div className="w-12 h-12 bg-slate-50 rounded-full flex items-center justify-center">
                          <Search className="w-6 h-6 text-slate-200" />
                       </div>
                       <p className="text-[10px] font-black text-slate-300 uppercase tracking-[0.3em] italic">No lead entities found matching criteria</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* The old 1/2/3 pager buttons did nothing (the list is not
          paginated) — removed (Agent workspace rebuild). The real
          count line stays. */}
      <div className="px-4 py-6 flex items-center justify-between gap-6 mt-2 mx-1">
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none">Showing {filteredLeads.length} of {memberFilteredLeads.length} leads</p>
      </div>
      </>
      )}

      {/* FIX-2 Export Dialog */}
      <AnimatePresence>
        {exportOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => !exportBusy && setExportOpen(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 16 }}
              className="relative bg-white w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden border border-slate-100 flex flex-col max-h-[90vh]"
            >
              <div className="px-6 py-5 flex items-center justify-between border-b border-slate-100">
                <div>
                  <h3 className="text-lg font-black uppercase tracking-tight text-slate-800">Export Leads</h3>
                  <p className="ep-muted">Excel workbook — lead details + history</p>
                </div>
                <button
                  type="button"
                  onClick={() => !exportBusy && setExportOpen(false)}
                  className="ep-btn"
                  aria-label="Close export dialog"
                >
                  <XCircle className="w-5 h-5" />
                </button>
              </div>

              <div className="p-6 space-y-6 overflow-y-auto">
                <div className="space-y-2">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Whose leads</p>
                  <div className="space-y-2">
                    {([
                      { value: 'own', label: 'My leads', desc: 'Leads assigned to me.' },
                      { value: 'team', label: 'My team', desc: "My leads plus my team members' leads." },
                      { value: 'teamwise', label: 'My team, grouped by member', desc: 'Same team leads, grouped per person with subtotals.' },
                    ] as Array<{ value: LeadExportScope; label: string; desc: string }>)
                      .filter(option => exportScopes.includes(option.value))
                      .map(option => (
                        <label
                          key={option.value}
                          className={cn(
                            'flex items-start gap-3 border rounded-sm px-4 py-3 cursor-pointer transition-all',
                            exportScope === option.value ? 'border-[#978C21] bg-[#978C21]/5' : 'border-slate-200 hover:bg-slate-50'
                          )}
                        >
                          <input
                            type="radio"
                            name="export-scope"
                            checked={exportScope === option.value}
                            onChange={() => setExportScope(option.value)}
                            className="mt-1 accent-[#978C21]"
                          />
                          <span>
                            <span className="block text-sm font-bold text-slate-800">{option.label}</span>
                            <span className="block text-xs text-slate-500 mt-0.5">{option.desc}</span>
                          </span>
                        </label>
                      ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Date based on</p>
                  <div className="flex gap-2">
                    {([
                      { value: 'updated', label: 'Updated date' },
                      { value: 'added', label: 'Added date' },
                    ] as Array<{ value: LeadExportBasis; label: string }>).map(option => (
                      <button
                        key={option.value}
                        onClick={() => setExportBasis(option.value)}
                        className={cn(
                          'flex-1 px-4 py-2 border text-[11px] font-black uppercase tracking-widest rounded-sm transition-all',
                          exportBasis === option.value
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                        )}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">From</p>
                    <input
                      type="date"
                      value={exportFrom}
                      onChange={e => setExportFrom(e.target.value)}
                      className="w-full border border-slate-200 rounded-sm px-3 py-2 text-sm text-slate-700"
                    />
                  </div>
                  <div className="space-y-2">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">To</p>
                    <input
                      type="date"
                      value={exportTo}
                      onChange={e => setExportTo(e.target.value)}
                      className="w-full border border-slate-200 rounded-sm px-3 py-2 text-sm text-slate-700"
                    />
                  </div>
                </div>

                <p className="text-xs text-slate-400 leading-relaxed">
                  Dates are Asia/Dhaka calendar days. The file has two sheets — Leads and Lead History —
                  and is limited to {exportMaxRows.toLocaleString()} leads per export.
                </p>
              </div>

              <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-end gap-3">
                <button
                  onClick={() => setExportOpen(false)}
                  disabled={exportBusy}
                  className="ep-btn"
                >
                  Cancel
                </button>
                <button
                  onClick={runExport}
                  disabled={exportBusy}
                  className="ep-btn ep-btn-primary"
                >
                  <Download className="w-3.5 h-3.5 text-[#978C21]" />
                  {exportBusy ? 'Preparing…' : 'Download Excel'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <ReassignLeadDialog
        lead={reassignLead ? { id: reassignLead.id, prospectName: reassignLead.prospectName, assignedTo: reassignLead.assignedTo } : null}
        onClose={() => setReassignLead(null)}
        onReassigned={() => { setReassignLead(null); void loadLeads(); }}
      />

      <RequestDeleteDialog
        lead={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onRequested={markDeleteRequested}
      />

      {quickViewLead && (
        <LeadQuickViewModal
          lead={quickViewLead}
          ownerName={ownerName(quickViewLead)}
          onClose={() => setQuickViewLead(null)}
        />
      )}

    </div>
  );
}
