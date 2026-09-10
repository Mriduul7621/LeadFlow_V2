import { useEffect, useState } from 'react';
import { ShieldCheck, History, Save } from 'lucide-react';
import { toast } from 'sonner';
import { User } from '../../shared/types';
import { useAuthStore } from '../../auth/store/authStore';
import { invalidateSessionCache } from '../../shared/api/sessionCache';
import { useTranslation } from '../../shared/utils/translations';

interface PermissionRow {
  permission_code: string;
  module_name: string;
  action_name: string;
  is_allowed: boolean;
  user_override?: boolean | null;
}

interface AuditRow {
  id: string;
  action_code: string;
  entity_type: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

export default function EnterpriseAccessPanel({ users }: { users: User[] }) {
  const { t } = useTranslation();
  const [selectedUserId, setSelectedUserId] = useState(users[0]?.id || '');
  const [permissions, setPermissions] = useState<PermissionRow[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedUserId && users[0]?.id) setSelectedUserId(users[0].id);
  }, [selectedUserId, users]);

  useEffect(() => {
    if (!selectedUserId) return;
    setLoading(true);
    Promise.all([
      fetch(`/api/users/${encodeURIComponent(selectedUserId)}/permissions`).then(response => response.json()),
      fetch('/api/audit-logs').then(response => response.json()),
    ]).then(([permissionBody, auditBody]) => {
      setPermissions(permissionBody?.data || []);
      setAuditLogs(auditBody?.data || []);
    }).catch(() => {
      setPermissions([]);
      setAuditLogs([]);
    }).finally(() => setLoading(false));
  }, [selectedUserId]);

  const saveOverrides = async () => {
    const response = await fetch(`/api/users/${encodeURIComponent(selectedUserId)}/permissions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        permissions: permissions
          .filter(permission => permission.user_override !== undefined && permission.user_override !== null)
          .map(permission => ({
            code: permission.permission_code,
            allowed: permission.user_override,
            reason: 'Configured from User Management',
          })),
      }),
    });
    if (!response.ok) {
      toast.error(t('permissionOverridesSaveFailed'));
      return;
    }
    toast.success(t('permissionOverridesSaved'));

    // If the saved overrides belong to the signed-in user, their
    // session-scoped permission sheet is now stale: invalidate it so the
    // next permission check sees the new grants (other users' overrides
    // never touch this session's cache).
    const currentUser = useAuthStore.getState().user;
    if (currentUser && (currentUser.id === selectedUserId || currentUser.employeeId === selectedUserId)) {
      invalidateSessionCache(`userPermissions:${currentUser.id}`);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
      <section className="lg:col-span-7 bg-[#FBFAF8] border border-slate-200 p-6 rounded-sm space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-black uppercase tracking-widest text-slate-900">{t('effectivePermissionOverrides')}</h3>
            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">{t('rolePermissionPlusOverride')}</p>
          </div>
          <ShieldCheck className="w-5 h-5 text-[#978C21]" />
        </div>
        <select value={selectedUserId} onChange={event => setSelectedUserId(event.target.value)} className="w-full px-3 py-3 bg-white border border-slate-200 text-xs uppercase font-black tracking-widest">
          {users.map(user => <option key={user.id} value={user.id}>{user.name} ({user.employeeId})</option>)}
        </select>
        {loading ? <p className="text-xs text-slate-400 uppercase tracking-widest">{t('loadingAuthorizationMatrix')}</p> : (
          <div className="max-h-[430px] overflow-auto border border-slate-200 bg-white">
            {permissions.map(permission => (
              <label key={permission.permission_code} className="flex items-center justify-between gap-4 px-4 py-3 border-b border-slate-100 text-xs">
                <span><strong className="block uppercase tracking-wider">{permission.permission_code}</strong><small className="text-slate-400">{permission.module_name} / {permission.action_name}</small></span>
                <select value={permission.user_override === undefined || permission.user_override === null ? 'ROLE' : permission.user_override ? 'ALLOW' : 'DENY'} onChange={event => setPermissions(current => current.map(item => item.permission_code === permission.permission_code ? { ...item, user_override: event.target.value === 'ROLE' ? null : event.target.value === 'ALLOW' } : item))} className="px-2 py-2 border border-slate-200 text-[10px] font-black">
                  <option value="ROLE">{t('role')}</option><option value="ALLOW">{t('allow')}</option><option value="DENY">{t('deny')}</option>
                </select>
              </label>
            ))}
          </div>
        )}
        <button type="button" onClick={saveOverrides} className="w-full py-3 bg-[#978C21] text-white text-[10px] font-black uppercase tracking-widest flex items-center justify-center gap-2"><Save className="w-4 h-4" /> {t('saveUserOverrides')}</button>
      </section>
      <section className="lg:col-span-5 bg-[#FBFAF8] border border-slate-200 p-6 rounded-sm space-y-5">
        <div className="flex items-center gap-3"><History className="w-5 h-5 text-[#978C21]" /><div><h3 className="text-sm font-black uppercase tracking-widest text-slate-900">{t('auditTrail')}</h3><p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">{t('recentIdentityActivity')}</p></div></div>
        <div className="space-y-2 max-h-[500px] overflow-auto">
          {auditLogs.length === 0 ? <p className="text-xs text-slate-400 uppercase tracking-widest">{t('noAuditEvents')}</p> : auditLogs.map(log => <div key={log.id} className="border border-slate-200 bg-white p-3"><p className="text-[10px] font-black uppercase tracking-widest">{log.action_code}</p><p className="text-[10px] text-slate-500">{log.entity_type} · {new Date(log.created_at).toLocaleString()}</p></div>)}
        </div>
      </section>
    </div>
  );
}
