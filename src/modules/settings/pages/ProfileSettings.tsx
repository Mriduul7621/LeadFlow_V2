import { useEffect, useState, type FormEvent } from 'react';
import { useAuthStore } from '../../auth/store/authStore';
import { userService } from '../../users/services/userService';
import { apiRequest, jsonBody } from '../../shared/api/http';
import { toast } from 'sonner';

export default function ProfileSettings() {
  const { user, login, isOfflineMode } = useAuthStore();
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [phone, setPhone] = useState(user?.phone || user?.contact || '');
  const [savingProfile, setSavingProfile] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    setName(user?.name || '');
    setEmail(user?.email || '');
    setPhone(user?.phone || user?.contact || '');
  }, [user?.id, user?.name, user?.email, user?.phone, user?.contact]);

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user) return;
    const cleanName = name.trim();
    const cleanEmail = email.trim().toLowerCase();
    const cleanPhone = phone.trim();
    if (!cleanName) {
      toast.error('Name is required.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      toast.error('Enter a valid email address.');
      return;
    }
    setSavingProfile(true);
    try {
      const updatedUser = await userService.updateOwnProfile({
        name: cleanName,
        email: cleanEmail,
        phone: cleanPhone,
      });
      login(updatedUser, useAuthStore.getState().token || undefined, isOfflineMode);
      toast.success('Profile updated.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update your profile.');
    } finally {
      setSavingProfile(false);
    }
  };

  const savePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user) return;
    if (!currentPassword || !newPassword || !confirmPassword) {
      toast.error('Complete all password fields.');
      return;
    }
    if (newPassword.length < 6) {
      toast.error('Use at least 6 characters for your new password.');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('The new passwords do not match.');
      return;
    }
    setSavingPassword(true);
    try {
      await apiRequest('/api/auth/change-password', {
        method: 'POST',
        ...jsonBody({ userId: user.id, currentPassword, newPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast.success('Password updated.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update your password.');
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-8 pb-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-brand-text">Profile & settings</h1>
        <p className="mt-1 text-sm text-stone-500">Keep your contact details and sign-in information current.</p>
      </div>

      <section className="border-y border-stone-100 bg-white px-4 py-5 sm:px-6">
        <h2 className="text-base font-semibold text-stone-800">Personal details</h2>
        <form onSubmit={saveProfile} className="mt-5 space-y-4">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-stone-600">Name</span>
            <input autoComplete="name" value={name} onChange={event => setName(event.target.value)} className="input-standard" required />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-stone-600">Mobile number</span>
            <input type="tel" autoComplete="tel" maxLength={20} value={phone} onChange={event => setPhone(event.target.value)} className="input-standard" />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-stone-600">Email address</span>
            <input type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} className="input-standard" required />
          </label>
          <button type="submit" disabled={savingProfile} className="btn-primary min-h-11 normal-case tracking-normal">
            {savingProfile ? 'Saving…' : 'Save changes'}
          </button>
        </form>
      </section>

      <section className="border-y border-stone-100 bg-white px-4 py-5 sm:px-6">
        <h2 className="text-base font-semibold text-stone-800">Password</h2>
        <form onSubmit={savePassword} className="mt-5 space-y-4">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-stone-600">Current password</span>
            <input type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} className="input-standard" required />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-stone-600">New password</span>
            <input type="password" autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} className="input-standard" minLength={6} required />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-stone-600">Confirm new password</span>
            <input type="password" autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} className="input-standard" minLength={6} required />
          </label>
          <button type="submit" disabled={savingPassword} className="btn-secondary min-h-11 normal-case tracking-normal">
            {savingPassword ? 'Updating…' : 'Update password'}
          </button>
        </form>
      </section>
    </div>
  );
}
