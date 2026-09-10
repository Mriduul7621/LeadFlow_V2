import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Lock, User as UserIcon, LogIn, ShieldCheck, ArrowRight, ArrowLeft, Mail } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import { localDb } from '../../../services/localDb';
import { userService } from '../../users/services/userService';
import { ApiError } from '../../shared/api/http';
import { activateSession, loginWithCredentials } from '../services/authFlow';
import { User, UserRole } from '../../shared/types';
import { useTranslation } from '../../shared/utils/translations';
import { preloadLeadStatuses, invalidateLeadStatusCache } from '../../workflow/utils/leadStatusMeta';

function detectRoleFromEmployeeId(empId: string): UserRole {
  const norm = empId.trim().toUpperCase();
  if (norm === 'ADMIN' || norm.startsWith('ADM')) return UserRole.ADMIN;
  if (norm.startsWith('RO')) return UserRole.RO;
  if (norm.startsWith('RM')) return UserRole.RM;
  if (norm.startsWith('ASM')) return UserRole.ASM;
  if (norm.startsWith('BDM')) return UserRole.BDM;
  if (norm.startsWith('BE')) return UserRole.BUSINESS_EXECUTIVE;
  if (norm.startsWith('BH')) return UserRole.BUSINESS_HEAD;

  // Contains search fallback
  if (norm.includes('ADMIN')) return UserRole.ADMIN;
  if (norm.includes('BH') || norm.includes('BUSINESSHEAD')) return UserRole.BUSINESS_HEAD;
  if (norm.includes('BE') || norm.includes('BUSINESSEXECUTIVE') || norm.includes('EXEC')) return UserRole.BUSINESS_EXECUTIVE;
  if (norm.includes('BDM') || norm.includes('DEVELOPMENT')) return UserRole.BDM;
  if (norm.includes('ASM')) return UserRole.ASM;
  if (norm.includes('RM') || norm.includes('MANAGER')) return UserRole.RM;
  if (norm.includes('RO') || norm.includes('OFFICER')) return UserRole.RO;

  return UserRole.RO; // default dynamic fallback
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

// @ts-ignore
import bgImage from '../../../assets/images/income_planner_bg_1779253838380.png';

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
  const { t, language, setLanguage } = useTranslation();
  const navigate = useNavigate();
  const [showForm, setShowForm] = React.useState(false);
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
      // Never decide first-run state from browser cache - ask the server
      // again later; default to the login form with a clear error.
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

  // A session that has actually been established (login here, or a persisted
  // token the server confirmed at startup) must never stay parked on /login.
  // Both flags are required: `isAuthenticated` alone can be true for a
  // persisted snapshot that startup validation has not cleared yet.
  React.useEffect(() => {
    if (isInitialized && isAuthenticated) {
      navigate('/', { replace: true });
    }
  }, [isInitialized, isAuthenticated, navigate]);

  /**
   * Everything that is merely nice-to-have once a session exists: refresh the
   * read cache and warm the admin-configured lead-status metadata.
   *
   * It is called AFTER the session is established and AFTER navigation, and
   * `activateSession` funnels it through a catch, so neither a localStorage
   * failure nor a metadata outage can delay, fail or undo a login. localDb is
   * a read cache only - it is written after the server confirmed the
   * credentials against PostgreSQL and is never consulted to authenticate.
   */
  const warmUpAfterAuthentication = (user: User) => {
    localDb.createUser(user);
    invalidateLeadStatusCache();
    return preloadLeadStatuses().then(
      () => undefined,
      err => {
        console.warn('[auth] Lead-status preload failed; default statuses stay in use.', err);
      }
    );
  };

  const onSetupSubmit = async (data: any) => {
    try {
      const empId = data.employeeId.toUpperCase().trim();

      // Create the first ADMIN account through the dedicated, guarded
      // bootstrap endpoint. The server refuses this call (409) as soon
      // as any ADMIN exists, validates the input, hashes the password
      // with bcrypt and creates the user inside a database transaction.
      const session = await userService.bootstrapAdmin({
        fullName: data.fullName,
        employeeId: empId,
        email: data.email.toLowerCase().trim(),
        password: data.password,
      });

      // Same post-login sequence as a normal login: session + navigation
      // first, cache/metadata warm-up afterwards.
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
      // Server-side login through the centralized API contract helper: the
      // password is verified against the bcrypt hash in PostgreSQL and the
      // `{ success, data }` envelope is unwrapped in exactly one place
      // (shared/api/http.ts + auth/services/loginContract.ts).
      const session = await loginWithCredentials(empId, data.password);

      // Establishes the authenticated Zustand state and navigates to '/',
      // then (never before) kicks off the background warm-up.
      await activateSession(session, {
        navigate,
        welcome: user => toast.success(t('welcomeMessage', { name: user.name })),
        afterAuthentication: warmUpAfterAuthentication,
      });
    } catch (err) {
      // Meaningful server errors (invalid credentials, locked/inactive
      // account, 503 database unavailable) are surfaced verbatim; nothing
      // here can leave a half-authenticated state behind.
      console.error('Login failed:', err);
      const message =
        err instanceof ApiError
          ? err.message
          : 'Login failed. Please check your connection and try again.';
      toast.error(message);
    }
  };

  return (
    <div 
      className="min-h-screen bg-black flex flex-col items-center justify-between p-6 sm:p-8 relative overflow-hidden select-none font-sans"
      id="login-page-container"
    >
      {/* Background Image with Dark Vignette Overlay */}
      <div 
        className="absolute inset-0 bg-cover bg-center opacity-85 transition-opacity duration-700 mix-blend-luminosity pointer-events-none scale-105"
        style={{ backgroundImage: `url(${bgImage})` }}
        id="login-bg-overlay"
      />
      <div 
        className="absolute inset-0 bg-gradient-to-b from-black/85 via-black/60 to-black/90 pointer-events-none"
        id="login-dark-gradient"
      />

      {/* Language Switcher in top right corner */}
      <div className="absolute top-6 right-6 z-30 flex items-center gap-1 bg-black/50 backdrop-blur-md border border-white/10 p-1 rounded-full shadow-lg" id="login-language-switcher">
        <button
          type="button"
          onClick={() => setLanguage('en')}
          className={`px-3.5 py-1 text-xs font-semibold rounded-full transition-all cursor-pointer ${
            language === 'en'
              ? 'bg-[#978C21] text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          EN
        </button>
        <button
          type="button"
          onClick={() => setLanguage('bn')}
          className={`px-3.5 py-1 text-xs font-semibold rounded-full transition-all cursor-pointer ${
            language === 'bn'
              ? 'bg-[#978C21] text-white shadow-sm'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          BN
        </button>
      </div>

      {/* Decorative Bottom Bar Indicator */}
      <div className="absolute bottom-6 left-8 z-20 hidden md:flex flex-col items-start gap-1" id="system-ready-indicator">
        <span className="text-sm text-slate-400 opacity-70">{t('systemReady')}</span>
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-[#978C21] animate-ping" />
          <span className="text-sm text-slate-400 opacity-80">
            {isFirstTimeSetup ? t('setupRequired') : t('secureNodeOnline')}
          </span>
        </div>
      </div>

      <div className="absolute bottom-6 right-8 z-20 hidden md:block" id="system-shield-indicator">
        <ShieldCheck className="w-5 h-5 text-slate-500 opacity-40 hover:opacity-80 transition-opacity" />
      </div>

      {/* Content Container */}
      <div className="flex-1 w-full flex flex-col items-center justify-center relative z-10 max-w-xl mx-auto" id="login-inner-wrap">
        
        {/* Company Logo - Fully Visible and Prominent */}
        <motion.div
          initial={{ opacity: 0, y: -25 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
          className="mb-8 flex justify-center items-center select-none"
          id="company-logo-container"
        >
          <img 
            src="https://lh3.googleusercontent.com/d/1NrB07Qg9d6yhOib8gds5g4-HZLmbJng3"
            alt="Shanta Life Logo"
            className="h-24 md:h-28 w-auto object-contain transition-all duration-300"
            referrerPolicy="no-referrer"
          />
        </motion.div>

        {/* Institutional Pill Badge */}
        <motion.div 
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="inline-flex items-center gap-2 px-4 py-1.5 bg-black/40 backdrop-blur-md rounded-full border border-white/10 text-sm text-slate-300 mb-8 select-none tracking-wide"
          id="institutional-pill-badge"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[#978C21] animate-pulse"></span>
          Institutional Lead Management
        </motion.div>

        {/* Dynamic Inner Panel holding Presentation or Form */}
        <AnimatePresence mode="wait">
          {!showForm ? (
            <motion.div
              key="presentation"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.4 }}
              className="w-full flex flex-col items-center justify-center text-center space-y-6"
              id="presentation-panel"
            >
              {/* Main Headlines */}
              <div className="space-y-1" id="headline-wrapper">
                <h1 className="text-6xl sm:text-7xl font-black tracking-tight text-white uppercase leading-none select-none">
                  LEAD
                </h1>
                <h1 className="text-6xl sm:text-7xl font-black tracking-tight text-[#978C21] uppercase leading-none select-none">
                  FLOW
                </h1>
              </div>

              {/* Subheading */}
              <h2 className="text-base sm:text-lg font-semibold text-white tracking-wide select-none">
                {t('loginSubheading')}
              </h2>

              {/* Small description copy */}
              <p className="text-slate-300 text-xs sm:text-sm font-medium leading-relaxed max-w-sm select-none opacity-80 decoration-none">
                {t('loginDesc')}
              </p>

              {/* Call To Action button */}
              <div className="pt-4" id="cta-button-container">
                <motion.button 
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => setShowForm(true)}
                  className="px-8 py-3.5 bg-[#978C21] hover:bg-[#a59924] text-white rounded-lg font-semibold text-sm transition-all flex items-center justify-center gap-2.5 shadow-lg shadow-[#978C21]/20 group cursor-pointer"
                  id="login-now-btn"
                >
                  {isFirstTimeSetup ? t('initializeConsoleBtn') : t('loginButton')} 
                  <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                </motion.button>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key={isFirstTimeSetup ? "setup-form" : "login-form"}
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.4 }}
              className="w-full max-w-sm bg-black/40 backdrop-blur-2xl border border-white/10 p-8 sm:p-10 rounded-2xl shadow-2xl relative overflow-hidden"
              id="glassmorphic-form-panel"
            >
              {/* Top Accent line matching our theme */}
              <div className="absolute top-0 left-0 w-full h-1.5 bg-[#978C21]" id="border-accent" />

              {isFirstTimeSetup ? (
                <>
                  <div className="text-center mb-6" id="setup-header">
                    <h2 className="text-2xl font-bold text-white tracking-tight">{t('setupTitle')}</h2>
                    <p className="text-[#978C21] text-sm text-[#978C21] mt-1">{t('setupSub')}</p>
                  </div>

                  <form onSubmit={handleSetupSubmit(onSetupSubmit)} className="space-y-4" id="setup-credentials-form">
                    {/* Full Name input */}
                    <div className="space-y-1" id="setup-name-group">
                      <label className="text-sm font-medium text-slate-300 block">{t('fullNameLabel')}</label>
                      <div className="relative group">
                        <UserIcon className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-[#978C21] transition-colors" />
                        <input 
                          {...registerSetup('fullName')}
                          type="text" 
                          className="w-full pl-11 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#978C21]/20 focus:border-[#978C21] transition-all text-xs font-semibold text-white placeholder-slate-500"
                          placeholder={t('fullNamePlaceholder')}
                          autoComplete="off"
                        />
                      </div>
                      {setupErrors.fullName && <p className="text-[10px] text-red-400 font-bold">{setupErrors.fullName.message as string}</p>}
                    </div>

                    {/* Employee ID input */}
                    <div className="space-y-1" id="setup-empid-group">
                      <label className="text-sm font-medium text-slate-300 block">{t('employeeIdLabel')}</label>
                      <div className="relative group">
                        <ShieldCheck className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-[#978C21] transition-colors" />
                        <input 
                          {...registerSetup('employeeId')}
                          type="text" 
                          className="w-full pl-11 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#978C21]/20 focus:border-[#978C21] transition-all text-xs font-semibold text-white placeholder-slate-500 uppercase tracking-wider"
                          placeholder={t('employeeIdPlaceholder')}
                          autoComplete="off"
                        />
                      </div>
                      {setupErrors.employeeId && <p className="text-[10px] text-red-400 font-bold">{setupErrors.employeeId.message as string}</p>}
                    </div>

                    {/* Email input */}
                    <div className="space-y-1" id="setup-email-group">
                      <label className="text-sm font-medium text-slate-300 block">{t('emailLabel')}</label>
                      <div className="relative group">
                        <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-[#978C21] transition-colors" />
                        <input 
                          {...registerSetup('email')}
                          type="email" 
                          className="w-full pl-11 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#978C21]/20 focus:border-[#978C21] transition-all text-xs font-semibold text-white placeholder-slate-500"
                          placeholder={t('emailPlaceholder')}
                          autoComplete="off"
                        />
                      </div>
                      {setupErrors.email && <p className="text-[10px] text-red-400 font-bold">{setupErrors.email.message as string}</p>}
                    </div>

                    {/* Password input */}
                    <div className="space-y-1" id="setup-password-group">
                      <label className="text-sm font-medium text-slate-300 block">{t('passwordLabel')}</label>
                      <div className="relative group">
                        <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-[#978C21] transition-colors" />
                        <input 
                          {...registerSetup('password')}
                          type="password" 
                          className="w-full pl-11 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#978C21]/20 focus:border-[#978C21] transition-all text-xs font-semibold text-white placeholder-slate-600"
                          placeholder={t('passwordPlaceholder')}
                        />
                      </div>
                      {setupErrors.password && <p className="text-[10px] text-red-400 font-bold">{setupErrors.password.message as string}</p>}
                    </div>

                    {/* Confirm Password input */}
                    <div className="space-y-1" id="setup-confirmpassword-group">
                      <label className="text-sm font-medium text-slate-300 block">{t('confirmPasswordLabel')}</label>
                      <div className="relative group">
                        <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-[#978C21] transition-colors" />
                        <input 
                          {...registerSetup('confirmPassword')}
                          type="password" 
                          className="w-full pl-11 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#978C21]/20 focus:border-[#978C21] transition-all text-xs font-semibold text-white placeholder-slate-600"
                          placeholder={t('passwordPlaceholder')}
                        />
                      </div>
                      {setupErrors.confirmPassword && <p className="text-[10px] text-red-400 font-bold">{setupErrors.confirmPassword.message as string}</p>}
                    </div>

                    {/* Submit button */}
                    <button 
                      type="submit" 
                      disabled={isSetupSubmitting}
                      className="w-full py-3 mt-2 bg-[#978C21] hover:bg-[#a59924] text-white rounded-xl font-semibold text-sm transition-all flex items-center justify-center gap-2 shadow-lg shadow-[#978C21]/15 cursor-pointer active:scale-[0.98]"
                      id="setup-submit-btn"
                    >
                      {isSetupSubmitting ? (
                        <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                      ) : (
                        <>
                          <ShieldCheck className="w-4 h-4" />
                          {t('registerBtn')}
                        </>
                      )}
                    </button>
                  </form>
                </>
              ) : (
                <>
                  <div className="text-center mb-8" id="form-header">
                    <h2 className="text-2xl font-black text-white uppercase tracking-tight">{t('systemLoginTitle')}</h2>
                    <p className="text-[#978C21] text-[10px] font-bold uppercase tracking-widest mt-1">{t('systemLoginSub')}</p>
                  </div>

                  <form onSubmit={handleSubmit(onSubmit)} className="space-y-6" id="credential-form">
                    
                    {/* Employee ID input */}
                    <div className="space-y-2" id="username-field-group">
                      <label className="text-sm font-medium text-slate-300 block">{t('loginEmpIdLabel')}</label>
                      <div className="relative group">
                        <UserIcon className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-[#978C21] transition-colors" />
                        <input 
                          {...register('username')}
                          type="text" 
                          className="w-full pl-11 pr-4 py-3.5 bg-white/5 border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#978C21]/20 focus:border-[#978C21] transition-all text-sm font-semibold text-white placeholder-slate-500 uppercase tracking-wider"
                          placeholder={t('loginEmpIdPlaceholder')}
                          autoComplete="off"
                        />
                      </div>
                      {errors.username && <p className="text-xs text-red-400 font-bold">{errors.username.message as string}</p>}
                    </div>

                    {/* Password input */}
                    <div className="space-y-2" id="password-field-group">
                      <label className="text-sm font-medium text-slate-300 block">{t('loginPasswordLabel')}</label>
                      <div className="relative group">
                        <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-[#978C21] transition-colors" />
                        <input 
                          {...register('password')}
                          type="password" 
                          className="w-full pl-11 pr-4 py-3.5 bg-white/5 border border-white/10 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#978C21]/20 focus:border-[#978C21] transition-all text-sm font-semibold text-white placeholder-slate-600"
                          placeholder={t('loginPasswordPlaceholder')}
                        />
                      </div>
                      {errors.password && <p className="text-xs text-red-400 font-bold">{errors.password.message as string}</p>}
                    </div>

                    {/* Submit button */}
                    <button 
                      type="submit" 
                      disabled={isSubmitting}
                      className="w-full py-4 mt-2 bg-[#978C21] hover:bg-[#a59924] text-white rounded-xl font-semibold text-sm transition-all flex items-center justify-center gap-2 shadow-lg shadow-[#978C21]/15 cursor-pointer active:scale-[0.98]"
                      id="form-submit-btn"
                    >
                      {isSubmitting ? (
                        <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                      ) : (
                        <>
                          <LogIn className="w-4 h-4" />
                          {t('loginSubmitBtn')}
                        </>
                      )}
                    </button>
                  </form>
                </>
              )}

              {/* Back navigation */}
              <div className="mt-8 pt-6 border-t border-white/5 flex justify-center text-center" id="form-back-nav">
                <button 
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="text-sm text-slate-400 hover:text-[#978C21] transition-colors font-medium flex items-center gap-2 cursor-pointer"
                  id="back-trigger"
                >
                  <ArrowLeft className="w-3 h-3" /> {t('backToMainBtn')}
                </button>
              </div>

            </motion.div>
          )}
        </AnimatePresence>

      </div>

      {/* Footer Copy */}
      <div className="relative z-10 w-full text-center pb-2 select-none" id="login-footer">
        <p className="text-sm text-slate-500 opacity-70">
          © 2024 Shanta Life Insurance. All Rights Reserved.
        </p>
      </div>
    </div>
  );
}
