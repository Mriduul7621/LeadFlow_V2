import React, { useEffect, useMemo, useState } from 'react';
import {
  Users,
  Briefcase,
  X,
  Building,
  Mail,
  Phone
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../../../lib/utils';
import { useAuthStore } from '../../auth/store/authStore';
import { useTranslation } from '../../shared/utils/translations';
import { userService } from '../../users/services/userService';
import { leadService } from '../../leads/services/leadService';
import { orgService } from '../services/orgService';
import { User, Lead } from '../../shared/types';
import { toast } from 'sonner';
import { EnterprisePageHeader } from '../../workspace/components/EnterprisePrimitives';
import {
  buildOrganogramBoardView,
  formatPeopleCount,
  formatTeamCount,
  type BoardPerson,
  type OrganogramBoardNodeInput,
  type OrganogramBoardView
} from '../utils/organogramBoard';

// Organogram board rebuild (Mahadi-approved sample, 2026-11-21):
// the page shows the viewing user's reporting world as a board —
// the ancestor chain (root first, viewer last), the viewer's direct
// reports as branch cards, their reports as a flat leaf row, and the
// downline summary card. The tree itself is unchanged: the server
// still derives it from users.manager_id.
//
// Drill-down (2026-11-22): tapping a person WITH direct reports
// re-anchors the board on them — their chain, their reports, their
// grandchildren — so any depth of the org is reachable from the top
// view. Tapping a person with no reports, or the current anchor
// person themself, opens their team view (the detail slide-over).
// A "Back to top" button above the board (only while drilled in)
// returns to the default view, and the summary card's Details button
// opens the anchor person's team view. The anchor is just a viewer
// id passed to the same pure derivation — no util change needed.
//
// Deliberately gone (the board has none of these): the old page back
// control, the Chart/List tab toggle + the entire list view, the
// search input and the zoom controls. The shell (sidebar, topbar,
// bottom nav) stays exactly as it is — the shell redesign is a
// separate programme. The H1 comes from the nav label
// (FALLBACK_LABELS['/team/organogram'] = 'Teams & Hierarchy'); it is
// NOT hardcoded here, so the old fallback title cannot return.

// The board markup, fed by the derived view. Exported (named) for
// the SSR screenshot harness, which renders it directly with
// fixture data — the page itself feeds it the live organogram.
export function OrganogramBoard(props: {
  view: OrganogramBoardView;
  onSelect: (employeeId: string) => void;
  // Drill-down: true while the board is anchored below the default
  // view; the Back to top button returns to it.
  isDrilled: boolean;
  onBackToTop: () => void;
  // Opens the stats slide-over for the given person (the summary
  // card's Details button passes the current anchor person).
  onDetails: (employeeId: string) => void;
}) {
  const { view, onSelect, isDrilled, onBackToTop, onDetails } = props;

  return (
    <div className="orgb-wrap">
      {isDrilled && (
        <button type="button" onClick={onBackToTop} className="orgb-back">
          ← Back to top
        </button>
      )}
      <div className="orgb-tree">
        {view.chain.map((person: BoardPerson, index: number) => (
          <React.Fragment key={person.employeeId}>
            {index > 0 && <div className="orgb-conn" aria-hidden="true" />}
            <button
              type="button"
              onClick={() => onSelect(person.employeeId)}
              className={cn('orgb-node', person.isCeo && 'orgb-node--ceo')}
              aria-label={`${person.name}, ${person.roleLabel}`}
            >
              <span
                className={cn('orgb-av', person.isCeo ? 'orgb-av--blue' : 'orgb-av--olive')}
                aria-hidden="true"
              >
                {person.initials}
              </span>
              <span className="orgb-meta">
                <span className="orgb-name">{person.name}</span>
                <span
                  className={cn('orgb-role', person.isCeo ? 'orgb-role--blue' : 'orgb-role--olive')}
                >
                  {person.roleLabel}
                </span>
              </span>
              {person.downline > 0 && (
                <span className="orgb-count">
                  {formatPeopleCount(person.downline)}
                  {person.teams > 0 ? ` • ${formatTeamCount(person.teams)}` : ''}
                </span>
              )}
            </button>
          </React.Fragment>
        ))}

        {view.branch.length > 0 && (
          <React.Fragment>
            <div className="orgb-conn orgb-conn--tall" aria-hidden="true" />
            <div className="orgb-branch">
              {view.branch.map((person: BoardPerson) => (
                <button
                  key={person.employeeId}
                  type="button"
                  onClick={() => onSelect(person.employeeId)}
                  className="orgb-bnode"
                  aria-label={`${person.name}, ${person.roleLabel}`}
                >
                  <span
                    className={cn('orgb-av', person.hasReports ? 'orgb-av--blue' : 'orgb-av--grey')}
                    aria-hidden="true"
                  >
                    {person.initials}
                  </span>
                  <span className="orgb-name">{person.name}</span>
                  <span
                    className={cn('orgb-role', person.hasReports ? 'orgb-role--blue' : 'orgb-role--grey')}
                  >
                    {person.roleLabel}
                  </span>
                  {person.downline > 0 && (
                    <span className="orgb-count">{formatPeopleCount(person.downline)}</span>
                  )}
                </button>
              ))}
            </div>
          </React.Fragment>
        )}

        {view.leafRow.length > 0 && (
          <React.Fragment>
            <div className="orgb-conn" aria-hidden="true" />
            <div className="orgb-branch orgb-branch--leaf">
              {view.leafRow.map((person: BoardPerson) => (
                <button
                  key={person.employeeId}
                  type="button"
                  onClick={() => onSelect(person.employeeId)}
                  className="orgb-fnode"
                  aria-label={`${person.name}, ${person.roleLabel}`}
                >
                  <span
                    className={cn('orgb-av', person.hasReports ? 'orgb-av--blue' : 'orgb-av--grey')}
                    aria-hidden="true"
                  >
                    {person.initials}
                  </span>
                  <span className="orgb-name">{person.name}</span>
                  <span
                    className={cn('orgb-role', person.hasReports ? 'orgb-role--blue' : 'orgb-role--grey')}
                  >
                    {person.roleLabel}
                  </span>
                  {person.downline > 0 && (
                    <span className="orgb-count">{formatPeopleCount(person.downline)}</span>
                  )}
                </button>
              ))}
            </div>
          </React.Fragment>
        )}
      </div>

      <div className="orgb-card">
        <div className="orgb-sum">
          {view.viewerDownline === 0 ? (
            <>
              <b>No people in your downline yet</b>
              <span className="orgb-sum-muted"> • 1 reporting line each</span>
            </>
          ) : (
            <>
              <b>{formatPeopleCount(view.viewerDownline)}</b>
              <span className="orgb-sum-muted">
                {' '}in your downline
                {view.viewerTeams > 0 ? ` • ${formatTeamCount(view.viewerTeams)}` : ''}
                {' '}• 1 reporting line each
              </span>
            </>
          )}
        </div>
        <div className="orgb-hint">Tap a person to see their team — Details opens their team view.</div>
        {view.viewer && (
          <button
            type="button"
            onClick={() => { if (view.viewer) onDetails(view.viewer.employeeId); }}
            className="orgb-details"
          >Details</button>
        )}
      </div>
    </div>
  );
}

export default function TeamHierarchy() {
  const { t } = useTranslation();
  const { user: currentUser } = useAuthStore();

  const [loading, setLoading] = useState(true);

  // Master lists
  const [users, setUsers] = useState<User[]>([]);

  // Org Tree state (auto-generated from reporting links)
  const [nodes, setNodes] = useState<OrganogramBoardNodeInput[]>([]);

  // Stats Sidebar state
  const [selectedMember, setSelectedMember] = useState<User | null>(null);
  const [selectedMemberStats, setSelectedMemberStats] = useState<any>(null);
  const [selectedMemberLeads, setSelectedMemberLeads] = useState<Lead[]>([]);
  const [loadingStats, setLoadingStats] = useState(false);

  // Drill-down anchor: null = the default view (the viewing user, or
  // the first root for an admin). Tapping a person with reports sets
  // this to their id; "Back to top" clears it.
  const [anchorEmployeeId, setAnchorEmployeeId] = useState<string | null>(null);


  // ----------------------------------------------------
  // DATA LOADING
  // ----------------------------------------------------
  const loadAllData = async () => {
    if (!currentUser) return;
    setLoading(true);
    try {
      // 1. Users roster (member details for the slide-over).
      const roster = await userService.getAllUsers();
      setUsers(roster);

      // 2. Auto-generated organogram — the server derives the tree from
      //    users.manager_id (single source of truth; no manual drawing).
      const organogram = await orgService.getOrganogram();
      setNodes(organogram.nodes.map(n => ({
        employeeId: n.employeeId,
        name: n.fullName || n.name,
        roleId: n.roleId || '',
        roleName: n.roleName || '',
        designation: n.designation || '',
        level: n.level,
        managerEmployeeId: n.managerEmployeeId,
        isActive: n.isActive,
      })));
    } catch (err) {
      console.error("Error computing team progress stats:", err);
      toast.error("Error loading data.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAllData();
  }, [currentUser]);

  // The default view (the viewing user, or the first root when the
  // viewer is not in the tree) — its anchor person is the "top" the
  // Back to top button returns to.
  const defaultView = useMemo(
    () => buildOrganogramBoardView(nodes, currentUser?.employeeId ?? ''),
    [nodes, currentUser?.employeeId],
  );

  // The board view for the current anchor (the default view until the
  // user drills down by tapping a person with reports).
  const boardView = useMemo(
    () => buildOrganogramBoardView(nodes, anchorEmployeeId ?? currentUser?.employeeId ?? ''),
    [nodes, anchorEmployeeId, currentUser?.employeeId],
  );

  // Drilled in when an anchor is set and it is not the default
  // anchor (tapping back up to the default anchor hides the button
  // again — the view is already the top one).
  const isDrilled =
    anchorEmployeeId !== null &&
    anchorEmployeeId !== (defaultView.viewer?.employeeId ?? null);

  // ----------------------------------------------------
  // DRILL-DOWN TAP ROUTING
  // ----------------------------------------------------
  // A person WITH direct reports re-anchors the board on them
  // (unless they are already the anchor — tapping the anchor person
  // opens their team view instead). A person with no reports opens
  // their team view directly. Chain ancestors always have reports,
  // so tapping one navigates back up to them.
  const handleTap = (employeeId: string) => {
    if (!employeeId) return;
    const person =
      boardView.chain.find((p) => p.employeeId === employeeId) ??
      boardView.branch.find((p) => p.employeeId === employeeId) ??
      boardView.leafRow.find((p) => p.employeeId === employeeId);
    const isCurrentAnchor = boardView.viewer?.employeeId === employeeId;
    if (person?.hasReports && !isCurrentAnchor) {
      setAnchorEmployeeId(employeeId);
      window.scrollTo(0, 0);
    } else {
      void handleSelect(employeeId);
    }
  };

  // ----------------------------------------------------
  // INTERACTIVE STATS DRAWER (DETAILS SIDEBAR)
  // ----------------------------------------------------
  const handleSelect = async (employeeId: string) => {
    if (!employeeId) return;

    const emp = users.find(u => u.employeeId === employeeId);
    if (!emp) {
      toast.error('Employee details not found.');
      return;
    }

    setSelectedMember(emp);
    setLoadingStats(true);
    try {
      const allLeads = await leadService.getLeads({
        employeeId: emp.employeeId,
        role: emp.role
      });
      setSelectedMemberLeads(allLeads);

      const lCount = allLeads.length;
      const contacted = allLeads.filter(l => l.currentStatus !== 'New').length;
      const meetings = allLeads.filter(l => l.currentStatus === 'Meeting Completed' || l.meetingDate).length;
      const collected = allLeads.reduce((acc, curr) => acc + (curr.collectedNCP || 0), 0);
      const convertedCount = allLeads.filter(l => l.currentStatus === 'Converted' || l.collectedNCP > 0).length;
      const rate = lCount > 0 ? `${Math.round((convertedCount / lCount) * 100)}%` : '0%';

      setSelectedMemberStats({
        totalLeads: lCount,
        contactedCalls: contacted,
        meetingsCompleted: meetings,
        collectedNCP: collected,
        conversionRate: rate
      });
    } catch (e) {
      console.error("Error computing sidebar user statistics:", e);
      setSelectedMemberStats(null);
      setSelectedMemberLeads([]);
    } finally {
      setLoadingStats(false);
    }
  };

  return (
    <div className="ep-page">
      <EnterprisePageHeader path="/team/organogram" />

      {/* Loading animation */}
      {loading ? (
        <div className="flex justify-center items-center py-32">
          <div className="w-12 h-12 border-4 border-slate-100 border-t-[#978C21] rounded-full animate-spin"></div>
        </div>
      ) : boardView.empty ? (
        <div className="orgb-empty">
          No organogram yet — assign reporting managers to employees in User Management.
        </div>
      ) : (
        <OrganogramBoard
          view={boardView}
          onSelect={handleTap}
          isDrilled={isDrilled}
          onBackToTop={() => setAnchorEmployeeId(null)}
          onDetails={(employeeId) => { void handleSelect(employeeId); }}
        />
      )}

      {/* ----------------------------------------------------
          SIDEBAR SLIDE-OVER: DETAILED INTEL MATRIX
         ---------------------------------------------------- */}
      <AnimatePresence>
        {selectedMember && (
          <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-50 flex justify-end">
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'tween', duration: 0.3 }}
              className="bg-white w-full max-w-2xl h-full shadow-2xl p-8 overflow-y-auto flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between border-b border-slate-100 pb-5 mb-6">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 bg-slate-50 rounded-xl flex items-center justify-center text-[#978C21] border border-slate-100">
                      <Building className="w-6 h-6" />
                    </div>
                    <div>
                      <h2 className="text-xl font-extrabold text-slate-800 uppercase tracking-tight leading-none">
                        {selectedMember.name}
                      </h2>
                      <p className="text-[10px] font-bold text-[#978C21] uppercase tracking-widest mt-1.5 italic">
                        Clearance: {selectedMember.role} reporting branch
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedMember(null);
                      setSelectedMemberStats(null);
                    }}
                    className="w-10 h-10 rounded-full hover:bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-400 hover:text-slate-800 transition-colors"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {loadingStats ? (
                  <div className="flex justify-center items-center py-20">
                    <div className="w-10 h-10 border-4 border-slate-100 border-t-[#978C21] rounded-full animate-spin"></div>
                  </div>
                ) : (
                  <>
                    {/* Stats bento layout */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
                      <div className="ep-card" style={{ padding: 12, textAlign: 'center' }}>
                        <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest mb-1">Assigned Leads</p>
                        <h4 className="text-2xl font-extrabold text-slate-800 leading-none">{selectedMemberStats?.totalLeads ?? 0}</h4>
                      </div>
                      <div className="ep-card" style={{ padding: 12, textAlign: 'center' }}>
                        <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest mb-1">Contacted</p>
                        <h4 className="text-2xl font-extrabold text-brand-blue leading-none">{selectedMemberStats?.contactedCalls ?? 0}</h4>
                      </div>
                      <div className="ep-card" style={{ padding: 12, textAlign: 'center' }}>
                        <p className="text-[8px] font-bold text-emerald-600 uppercase tracking-widest mb-1">Collected NCP</p>
                        <h4 className="text-2xl font-extrabold text-emerald-600 leading-none">৳{(selectedMemberStats?.collectedNCP ?? 0).toLocaleString()}</h4>
                      </div>
                      <div className="ep-card" style={{ padding: 12, textAlign: 'center' }}>
                        <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest mb-1">Conversion %</p>
                        <h4 className="text-2xl font-extrabold text-slate-800 leading-none">{selectedMemberStats?.conversionRate ?? '0%'}</h4>
                      </div>
                    </div>

                    {/* Member Profile Details card */}
                    <div className="ep-card space-y-3.5 mb-6 text-xs text-slate-600">
                      <h4 className="text-sm font-semibold text-slate-700">{t('profileSummary')}</h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="flex items-center gap-2">
                          <Users className="w-4 h-4 text-slate-400" />
                          <span><strong>ID:</strong> {selectedMember.employeeId}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Briefcase className="w-4 h-4 text-slate-400" />
                          <span><strong>Designation:</strong> {selectedMember.designation || 'Officer'}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Mail className="w-4 h-4 text-slate-400" />
                          <span><strong>Email:</strong> {selectedMember.email}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Phone className="w-4 h-4 text-slate-400" />
                          <span><strong>Contact:</strong> {selectedMember.contact || 'No Number Provided'}</span>
                        </div>
                      </div>
                    </div>

                    {/* Lead table */}
                    <div>
                      <h4 className="text-sm font-semibold text-slate-700 mb-3">
                        {t('latestLeads')}
                      </h4>

                      <div className="ep-card ep-tablecard">
                        <div className="ep-tablewrap">
                          <table>
                            <thead>
                              <tr>
                                <th>Client Name</th>
                                <th>Area</th>
                                <th style={{ textAlign: 'right' }}>NCP Collected</th>
                                <th style={{ textAlign: 'center' }}>Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {selectedMemberLeads.length === 0 ? (
                                <tr>
                                  <td colSpan={4} className="ep-td-empty">
                                    No active lead rows registered
                                  </td>
                                </tr>
                              ) : (
                                selectedMemberLeads.slice(0, 10).map((lead, index) => (
                                  <tr key={index}>
                                    <td><strong>{lead.prospectName || 'Unknown'}</strong></td>
                                    <td>{lead.area}</td>
                                    <td style={{ textAlign: 'right' }}><strong>৳{(lead.collectedNCP || 0).toLocaleString()}</strong></td>
                                    <td style={{ textAlign: 'center' }}>
                                      <span className="ep-pill">
                                        {lead.currentStatus}
                                      </span>
                                    </td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>

              <div className="mt-6 border-t border-slate-100 pt-5">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedMember(null);
                    setSelectedMemberStats(null);
                  }}
                  className="ep-btn ep-btn-primary"
                  style={{ width: '100%', justifyContent: 'center', padding: '12px' }}
                >
                  {t('closeDetails')}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
