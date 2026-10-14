import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Lock, ShieldCheck } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { localDb } from '../../../services/localDb';
import { userService } from '../../users/services/userService';
import { ApiError } from '../../shared/api/http';
import { activateSession, loginWithCredentials } from '../services/authFlow';
import { User, UserRole } from '../../shared/types';
import { preloadLeadStatuses, invalidateLeadStatusCache } from '../../workflow/utils/leadStatusMeta';
import { waitForShellStartup } from '../../shared/api/startupPriority';

function detectRoleFromEmployeeId(empId: string): UserRole {
  const norm = empId.trim().toUpperCase();
  if (norm === 'ADMIN' || norm.startsWith('ADM')) return UserRole.ADMIN;
  if (norm.startsWith('RO')) return UserRole.RO;
  if (norm.startsWith('RM')) return UserRole.RM;
  if (norm.startsWith('ASM')) return UserRole.ASM;
  if (norm.startsWith('BDM')) return UserRole.BDM;
  if (norm.startsWith('BE')) return UserRole.BUSINESS_EXECUTIVE;
  if (norm.startsWith('BH')) return UserRole.BUSINESS_HEAD;
  if (norm.includes('ADMIN')) return UserRole.ADMIN;
  if (norm.includes('BH') || norm.includes('BUSINESSHEAD')) return UserRole.BUSINESS_HEAD;
  if (norm.includes('BE') || norm.includes('BUSINESSEXECUTIVE') || norm.includes('EXEC')) return UserRole.BUSINESS_EXECUTIVE;
  if (norm.includes('BDM') || norm.includes('DEVELOPMENT')) return UserRole.BDM;
  if (norm.includes('ASM')) return UserRole.ASM;
  if (norm.includes('RM') || norm.includes('MANAGER')) return UserRole.RM;
  if (norm.includes('RO') || norm.includes('OFFICER')) return UserRole.RO;
  return UserRole.RO;
}

function getDesignationFromRole(role: UserRole): string {
  switch (role) {
    case UserRole.ADMIN: return 'Administrator';
    case UserRole.RO: return 'Relationship Officer';
    case UserRole.RM: return 'Relationship Manager';
    case UserRole.ASM: return 'Area Sales Manager';
    case UserRole.BDM: return 'Business Development Manager';
    case UserRole.BUSINESS_EXECUTIVE: return 'Business Executive';
    case UserRole.BUSINESS_HEAD: return 'Business Head';
    default: return 'Office Employee';
  }
}

const loginSchema = z.object({
  username: z.string().min(3, 'Employee ID is required'),
  password: z.string().min(5, 'Password must be at least 5 characters'),
});

const setupSchema = z.object({
  fullName: z.string().min(3, 'Full name must be at least 3 characters'),
  employeeId: z.string().min(3, 'Employee ID must be at least 3 characters'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(5, 'Password must be at least 5 characters'),
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

export default function Login() {
  const navigate = useNavigate();
  const [showSplash, setShowSplash] = React.useState(true);
  const [isFirstTimeSetup, setIsFirstTimeSetup] = React.useState(false);
  const [checkingSetup, setCheckingSetup] = React.useState(true);
  const isAuthenticated = useAuthStore(state => state.isAuthenticated);
  const isInitialized = useAuthStore(state => state.isInitialized);

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(loginSchema),
  });

  const { register: registerSetup, handleSubmit: handleSetupSubmit, formState: { errors: setupErrors, isSubmitting: isSetupSubmitting }, reset: resetSetup } = useForm({
    resolver: zodResolver(setupSchema),
  });

  const checkUserCount = async () => {
    try {
      const adminExists = await userService.checkAdminExists();
      setIsFirstTimeSetup(!adminExists);
    } catch (err) {
      console.error("Error checking admin existence:", err);
      setIsFirstTimeSetup(false);
      toast.error(
        err instanceof ApiError
          ? err.message
          : 'Could not verify the database. Please check the server configuration and try again.'
      );
    } finally {
      setCheckingSetup(false);
    }
  };

  React.useEffect(() => {
    checkUserCount();
  }, []);

  React.useEffect(() => {
    const timer = window.setTimeout(() => setShowSplash(false), 1700);
    return () => window.clearTimeout(timer);
  }, []);

  React.useEffect(() => {
    if (isInitialized && isAuthenticated) {
      navigate('/', { replace: true });
    }
  }, [isInitialized, isAuthenticated, navigate]);

  const warmUpAfterAuthentication = (user: User) => {
    localDb.createUser(user);
    invalidateLeadStatusCache();
    // Tier 3: GET /api/options must not join the first-dashboard burst
    // when we land on `/`. If the first protected route is not Dashboard,
    // the shell gate releases so this cannot hang.
    return waitForShellStartup().then(() =>
      preloadLeadStatuses().then(
        () => undefined,
        err => {
          console.warn('[auth] Lead-status preload failed; default statuses stay in use.', err);
        }
      )
    );
  };

  const onSetupSubmit = async (data: any) => {
    try {
      const empId = data.employeeId.toUpperCase().trim();
      const session = await userService.bootstrapAdmin({
        fullName: data.fullName,
        employeeId: empId,
        email: data.email.toLowerCase().trim(),
        password: data.password,
      });
      await activateSession(session, {
        navigate,
        welcome: () => toast.success('Super Admin console initialized successfully!'),
        afterAuthentication: warmUpAfterAuthentication,
      });
    } catch (err) {
      console.error("Super Admin setup failed:", err);
      const message =
        err instanceof ApiError
          ? err.message
          : "Failed to setup Super Admin account. Please try again.";
      toast.error(message);
    }
  };

  const onSubmit = async (data: any) => {
    const empId = data.username.toUpperCase().trim();
    try {
      const session = await loginWithCredentials(empId, data.password);
      await activateSession(session, {
        navigate,
        welcome: user => toast.success(`Welcome back, ${user.name}!`),
        afterAuthentication: warmUpAfterAuthentication,
      });
    } catch (err) {
      console.error('Login failed:', err);
      const message =
        err instanceof ApiError
          ? err.message
          : 'Login failed. Please check your connection and try again.';
      toast.error(message);
    }
  };

  return (
    <div id="login-page-container" className="leadflow-auth-root">
      <AnimatePresence mode="wait" initial={false}>
        {showSplash ? (
          <motion.section key="splash" className="leadflow-splash-screen" initial={{ opacity: 1 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }} onClick={() => setShowSplash(false)} aria-label="LeadFlow splash screen">
            <div className="leadflow-splash-brand">
              <img src="/shanta-life-logo.png" alt="Shanta Life" className="leadflow-splash-logo" />
              <div className="leadflow-wordmark" aria-label="LeadFlow"><span>Lead</span><strong>Flow</strong></div>
              <p className="leadflow-tagline">More Leads. Bigger Tomorrow.</p>
            </div>
            <div className="leadflow-splash-leaves" aria-hidden="true"><span className="leaf leaf-one" /><span className="leaf leaf-two" /><span className="leaf leaf-three" /></div>
            <div className="leadflow-splash-footer">
              <img src="https://lh3.googleusercontent.com/d/1Mv6Wn1SLKO9c-fCyEj2G36dzxpSRNOFO" alt="" referrerPolicy="no-referrer" />
              <span>Shanta Life</span>
            </div>
          </motion.section>
        ) : (
          <motion.section key="login" className="leadflow-login-screen" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
            <div className="leadflow-login-content">
              <div className="leadflow-login-heading">
                <h1>{isFirstTimeSetup ? 'Welcome' : 'Welcome Back'}</h1>
                <p>{isFirstTimeSetup ? 'Set up your LeadFlow account' : 'Sign in to your LeadFlow account'}</p>
              </div>
              <div className="leadflow-login-form">
                {isFirstTimeSetup ? (
                  <form onSubmit={handleSetupSubmit(onSetupSubmit)} className="leadflow-credentials-form">
                    <div className="leadflow-login-field"><label htmlFor="setup-full-name">Full Name</label><input id="setup-full-name" {...registerSetup('fullName')} type="text" placeholder="Enter your full name" autoComplete="name" />{setupErrors.fullName && <p className="leadflow-field-error">{setupErrors.fullName.message as string}</p>}</div>
                    <div className="leadflow-login-field"><label htmlFor="setup-employee-id">Employee ID</label><input id="setup-employee-id" {...registerSetup('employeeId')} type="text" placeholder="Enter your employee ID" autoComplete="off" />{setupErrors.employeeId && <p className="leadflow-field-error">{setupErrors.employeeId.message as string}</p>}</div>
                    <div className="leadflow-login-field"><label htmlFor="setup-email">Email Address</label><input id="setup-email" {...registerSetup('email')} type="email" placeholder="Enter your email address" autoComplete="email" />{setupErrors.email && <p className="leadflow-field-error">{setupErrors.email.message as string}</p>}</div>
                    <div className="leadflow-login-field"><label htmlFor="setup-password">Password</label><input id="setup-password" {...registerSetup('password')} type="password" placeholder="Create a password" autoComplete="new-password" />{setupErrors.password && <p className="leadflow-field-error">{setupErrors.password.message as string}</p>}</div>
                    <div className="leadflow-login-field"><label htmlFor="setup-confirm-password">Confirm Password</label><input id="setup-confirm-password" {...registerSetup('confirmPassword')} type="password" placeholder="Confirm your password" autoComplete="new-password" />{setupErrors.confirmPassword && <p className="leadflow-field-error">{setupErrors.confirmPassword.message as string}</p>}</div>
                    <button type="submit" disabled={isSetupSubmitting} className="leadflow-login-submit">{isSetupSubmitting ? <span className="leadflow-spinner" /> : <><ShieldCheck size={16} /> Create Admin Account</>}</button>
                  </form>
                ) : (
                  <form onSubmit={handleSubmit(onSubmit)} className="leadflow-credentials-form" id="credential-form">
                    <div className="leadflow-login-field"><label htmlFor="employee-id">Employee ID</label><input id="employee-id" {...register('username')} type="text" placeholder="Enter your employee ID" autoComplete="username" autoCapitalize="characters" />{errors.username && <p className="leadflow-field-error">{errors.username.message as string}</p>}</div>
                    <div className="leadflow-login-field"><label htmlFor="employee-password">Password</label><div className="leadflow-password-wrap"><input id="employee-password" {...register('password')} type="password" placeholder="Enter your password" autoComplete="current-password" /><Lock size={16} aria-hidden="true" /></div>{errors.password && <p className="leadflow-field-error">{errors.password.message as string}</p>}</div>
                    <div className="leadflow-login-options"><label className="leadflow-remember"><input type="checkbox" /> <span>Remember Me</span></label><button type="button" className="leadflow-forgot" onClick={() => toast.info('Please contact your administrator to reset your password.')}>Forgot Password?</button></div>
                    <button type="submit" disabled={isSubmitting || checkingSetup} className="leadflow-login-submit" id="form-submit-btn">{isSubmitting ? <span className="leadflow-spinner" /> : 'Login'}</button>
                  </form>
                )}
                <p className="leadflow-login-help">Don’t have an account? Contact your admin</p>
              </div>
            </div>
            <div className="leadflow-login-silhouette" aria-hidden="true"><span /><span /><span /><span /><span /><span /><span /></div>
            <footer className="leadflow-auth-footer">© 2026 Shanta Life Insurance. All Rights Reserved.</footer>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
}
