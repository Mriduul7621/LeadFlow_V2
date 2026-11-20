import React, { useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { EnterprisePageHeader } from '../../workspace/components/EnterprisePrimitives';
import BackButton from '../../shared/components/BackButton';
import { useCallerTeam } from '../../team/hooks/useCallerTeam';
import { getSelfPerson } from '../../team/services/teamOverviewService';
import { useAuthStore } from '../../auth/store/authStore';
import { usePermissions } from '../../shared/hooks/usePermissions';
import { useEnterpriseDisplayRole } from '../../../layouts/enterpriseDisplayRole';
import { invalidateTeamOverview } from '../../team/services/teamOverviewService';
import { scopePeople } from '../../workspace/utils/teamWorkspaceData';
import { userService } from '../services/userService';

/**
 * TeamUserManagement — User Management for Team Lead / Manager
 * (2026-11-20, Mahadi).
 * ------------------------------------------------------------------
 * The team list + the Employee add flow, visible ONLY with the
 * admin-granted `users.add_employee` grant (the sidebar item is
 * hidden without it too — this page gates itself as well, so a
 * typed URL cannot reach the form). The add flow creates ONLY
 * Employee-role users who report to the adding TL/Manager, in
 * the caller's department — the server forces all three
 * (POST /api/users/employee); no other user-management power
 * comes with it (no edit/delete/role change).
 *
 * The temporary password is generated client-side (the same
 * 10-character generator as the admin form) and shown in the
 * success toast; the new user must change it on first login.
 */

function genTempPw(): string {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 10; i++) out += c[Math.floor(Math.random() * c.length)];
  return out;
}

export default function TeamUserManagement() {
  const user = useAuthStore(state => state.user);
  const callerTeam = useCallerTeam();
  const { canAccess, serverPermissionsSettled } = usePermissions();
  const { role: displayRole, loading: displayLoading } = useEnterpriseDisplayRole();

  const [fullName, setFullName] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [designation, setDesignation] = useState('');
  const [saving, setSaving] = useState(false);

  const self = useMemo(
    () => (callerTeam.overview ? getSelfPerson(callerTeam.overview.people) : undefined),
    [callerTeam.overview],
  );
  const people = useMemo(() => callerTeam.overview?.people ?? [], [callerTeam.overview]);
  const roster = useMemo(
    () => (self ? scopePeople(people, self, displayRole) : []),
    [people, self, displayRole],
  );

  const hasGrant = serverPermissionsSettled && canAccess('user_management', 'add_employee');

  // The page gates on the grant (once the sheet has settled) and
  // on the display role — an Admin uses Users & Roles instead.
  if (serverPermissionsSettled && !displayLoading && (!hasGrant || displayRole === 'admin' || displayRole === 'agent')) {
    return <Navigate to="/" replace />;
  }

  const handleAdd = async () => {
    const name = fullName.trim();
    const empId = employeeId.trim().toUpperCase();
    if (!name || !empId) {
      toast.error('Full name and employee ID are required.');
      return;
    }
    setSaving(true);
    try {
      const tempPassword = genTempPw();
      const saved = await userService.addEmployee({
        fullName: name,
        employeeId: empId,
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        designation: designation.trim() || undefined,
        password: tempPassword,
        mustChangePassword: true,
      });
      toast.success(`${saved.name || name} has been added. Temporary password: "${tempPassword}"`);
      setFullName('');
      setEmployeeId('');
      setEmail('');
      setPhone('');
      setDesignation('');
      if (user?.id) invalidateTeamOverview(user.id);
      callerTeam.refresh();
    } catch (err: any) {
      toast.error(err?.message || 'Could not add the employee.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ep-page">
      <BackButton fallback="/" />
      <EnterprisePageHeader
        path="/users/team"
        actions={(
          <span className="ep-pill">Reports to you · Employee role only</span>
        )}
      />

      {callerTeam.loading ? (
        <div className="ep-card">
          <p className="ep-empty" style={{ textAlign: 'center' }}>Loading your team…</p>
        </div>
      ) : (
        <>
          <div className="ep-card">
            <div className="ep-cardhead">
              <div>
                <h3>Add employee</h3>
                <div className="ep-muted">
                  The new employee reports to {user?.name || 'you'}
                  {self?.department ? ` · ${self.department}` : ''} · Employee role only
                </div>
              </div>
            </div>
            <div className="ep-form-grid">
              <label className="ep-field-label">
                Full name
                <input
                  className="ep-input"
                  value={fullName}
                  onChange={e => setFullName(e.target.value)}
                  placeholder="e.g. Ayesha Rahman"
                  autoComplete="off"
                />
              </label>
              <label className="ep-field-label">
                Employee ID
                <input
                  className="ep-input"
                  value={employeeId}
                  onChange={e => setEmployeeId(e.target.value)}
                  placeholder="e.g. 2026123"
                  autoComplete="off"
                />
              </label>
              <label className="ep-field-label">
                Email (optional)
                <input
                  className="ep-input"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="name@company.com"
                  autoComplete="off"
                />
              </label>
              <label className="ep-field-label">
                Phone (optional)
                <input
                  className="ep-input"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  placeholder="01XXXXXXXXX"
                  autoComplete="off"
                />
              </label>
              <label className="ep-field-label">
                Designation / job title (optional)
                <input
                  className="ep-input"
                  value={designation}
                  onChange={e => setDesignation(e.target.value)}
                  placeholder="e.g. Relationship Officer"
                  autoComplete="off"
                />
              </label>
            </div>
            <p className="ep-muted" style={{ marginTop: 12 }}>
              A temporary password is auto-generated and shown once — the employee must change it on first login.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button
                type="button"
                className="ep-btn ep-btn-primary"
                onClick={() => void handleAdd()}
                disabled={saving || !fullName.trim() || !employeeId.trim()}
              >
                <UserPlus className="w-3.5 h-3.5" />
                {saving ? 'Adding…' : 'Add employee'}
              </button>
            </div>
          </div>

          <div className="ep-card">
            <div className="ep-cardhead">
              <div>
                <h3>Your team</h3>
                <div className="ep-muted">{roster.length} member{roster.length === 1 ? '' : 's'} in scope, including you</div>
              </div>
            </div>
            {roster.length === 0 ? (
              <p className="ep-empty">No team members in scope yet.</p>
            ) : (
              <div className="ep-member-list">
                {roster.map(person => (
                  <div key={person.userId} className="ep-member-row" style={{ cursor: 'default' }}>
                    <span className="ep-miniavatar" aria-hidden="true">
                      {String(person.name || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?'}
                    </span>
                    <span className="ep-member-copy">
                      <strong>
                        {person.name}
                        {person.isSelf && <span className="ep-roster-you">You</span>}
                      </strong>
                      <small>
                        {person.employeeId} · {person.designation || person.roleName || 'Team member'}
                      </small>
                    </span>
                    <span className="ep-member-pct">{person.openLeads} open</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
