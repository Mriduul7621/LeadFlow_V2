import React, { Suspense, lazy } from 'react';
import {
  createBrowserRouter,
  RouterProvider,
  Navigate
} from 'react-router-dom';
import Login from './modules/auth/pages/Login';
import ProtectedRoute from './modules/auth/components/ProtectedRoute';
import AdminRoute from './modules/auth/components/AdminRoute';
import FeatureGate from './modules/auth/components/FeatureGate';
import { initializeAuthSession } from './modules/auth/services/authFlow';
import ChunkErrorBoundary from './modules/shared/components/ChunkErrorBoundary';
import { Toaster } from 'sonner';
import { useSessionTimeout } from './modules/shared/hooks/useSessionTimeout';

/**
 * Route-level code splitting (Performance Phase 2)
 * ------------------------------------------------------------------
 * Every feature page is loaded with `React.lazy` so the production build
 * emits one chunk per route. The login page and the app shell therefore
 * never download or parse the code of pages the user will not visit
 * (recharts, xlsx, the full calendar, admin tables, ...). Login stays a
 * STATIC import on purpose: it is the only unauthenticated route and it
 * must render without any chunk round-trip.
 *
 * Security is untouched: every authenticated route still renders through
 * the same `ProtectedRoute` gate (server-confirmed session before any
 * business data), and the gate's children are wrapped in a Suspense
 * boundary that lives INSIDE `AppLayout` - so while a route chunk is
 * streaming in, the sidebar/header stay visible and only the content
 * area shows a compact placeholder. No full-screen spinner per
 * navigation, no route behavior change.
 */
const Dashboard = lazy(() => import('./modules/dashboard/pages/Dashboard'));
const LeadGenerate = lazy(() => import('./modules/leads/pages/LeadGenerate'));
const LeadList = lazy(() => import('./modules/leads/pages/LeadList'));
const LeadUpload = lazy(() => import('./modules/leads/pages/LeadUpload'));
const AllLeads = lazy(() => import('./modules/leads/pages/AllLeads'));
const FollowUpStrategy = lazy(() => import('./modules/leads/pages/FollowUpStrategy'));
const TaskCalendar = lazy(() => import('./modules/auth/pages/TaskCalendar'));
const Activities = lazy(() => import('./modules/leads/pages/Activities'));
const DailyWorkbench = lazy(() => import('./modules/workbench/pages/DailyWorkbench'));
const Lead360 = lazy(() => import('./modules/leads/pages/Lead360'));
const UserManagement = lazy(() => import('./modules/users/pages/UserManagement'));
const TeamHierarchy = lazy(() => import('./modules/hierarchy/pages/TeamHierarchy'));
const ExecutionIntelligence = lazy(() => import('./modules/dashboard/pages/ExecutionIntelligence'));
const NcpProgress = lazy(() => import('./modules/dashboard/pages/NcpProgress'));
const TrendCharts = lazy(() => import('./modules/dashboard/pages/TrendCharts'));
const CampaignBreakdown = lazy(() => import('./modules/dashboard/pages/CampaignBreakdown'));
const Settings = lazy(() => import('./modules/settings/pages/Settings'));
// TEMPORARY admin-only diagnostics page (its own lazy chunk, like every
// other feature page — see the route map below).
const PerformanceDiagnostics = lazy(() => import('./modules/settings/pages/PerformanceDiagnostics'));

/**
 * Compact content-level fallback for the lazy route pages. Intentionally
 * small (no spinner choreography, no full-screen takeover): it renders in
 * the `<main>` area below the sticky header, so the app shell stays
 * usable while the route chunk loads.
 */
function RouteFallback() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading page">
      <div className="h-9 w-60 bg-stone-100 rounded-[10px] animate-pulse" />
      <div className="h-44 bg-stone-100 rounded-[12px] animate-pulse" />
      <div className="h-28 bg-stone-100 rounded-[12px] animate-pulse" />
    </div>
  );
}

/**
 * One Suspense boundary per route page: suspends only the content area.
 * The boundary is wrapped in ChunkErrorBoundary so that a lazy import
 * failing AFTER a deployment (stale hashed chunk → rejection) recovers
 * with one guarded reload instead of unmounting the app — see
 * modules/shared/components/ChunkErrorBoundary.tsx.
 */
function LazyPage({ page }: { page: React.ReactElement }) {
  return (
    <ChunkErrorBoundary>
      <Suspense fallback={<RouteFallback />}>{page}</Suspense>
    </ChunkErrorBoundary>
  );
}

const router = createBrowserRouter([
  {
    path: '/login',
    element: <Login />,
  },
  {
    path: '/',
    element: <ProtectedRoute><FeatureGate route="/"><LazyPage page={<Dashboard />} /></FeatureGate></ProtectedRoute>,
  },
  {
    path: '/leads/new',
    element: <ProtectedRoute><FeatureGate route="/leads/new"><LazyPage page={<LeadGenerate />} /></FeatureGate></ProtectedRoute>,  },
  {
    path: '/leads',
    element: <ProtectedRoute><FeatureGate route="/leads"><LazyPage page={<LeadList />} /></FeatureGate></ProtectedRoute>,  },
  {
    path: '/leads/upload',
    element: <ProtectedRoute><FeatureGate route="/leads/upload"><LazyPage page={<LeadUpload />} /></FeatureGate></ProtectedRoute>,  },
  {
    path: '/leads/all',
    element: <ProtectedRoute><FeatureGate route="/leads/all"><LazyPage page={<AllLeads />} /></FeatureGate></ProtectedRoute>,  },
  {
    path: '/follow-up',
    element: <ProtectedRoute><FeatureGate route="/follow-up"><LazyPage page={<FollowUpStrategy />} /></FeatureGate></ProtectedRoute>,  },
  {
    path: '/task-calendar',
    element: <ProtectedRoute><FeatureGate route="/task-calendar"><LazyPage page={<TaskCalendar />} /></FeatureGate></ProtectedRoute>,  },
  {
    path: '/activities',
    element: <ProtectedRoute><FeatureGate route="/activities"><LazyPage page={<Activities />} /></FeatureGate></ProtectedRoute>,  },
  {
    path: '/workbench',
    element: <ProtectedRoute><FeatureGate route="/workbench"><LazyPage page={<DailyWorkbench />} /></FeatureGate></ProtectedRoute>,  },
  {
    path: '/leads/:id',
    element: <ProtectedRoute><FeatureGate route="/leads/:id"><LazyPage page={<Lead360 />} /></FeatureGate></ProtectedRoute>,  },
  {
    path: '/users',
    element: <ProtectedRoute><FeatureGate route="/users"><LazyPage page={<UserManagement />} /></FeatureGate></ProtectedRoute>,  },
  {
    path: '/team',
    element: <ProtectedRoute><FeatureGate route="/team"><LazyPage page={<TeamHierarchy />} /></FeatureGate></ProtectedRoute>,  },
  {
    path: '/execution-intelligence',
    element: <ProtectedRoute><FeatureGate route="/execution-intelligence"><LazyPage page={<ExecutionIntelligence />} /></FeatureGate></ProtectedRoute>,  },
  {
    path: '/ncp-progress',
    element: <ProtectedRoute><FeatureGate route="/ncp-progress"><LazyPage page={<NcpProgress />} /></FeatureGate></ProtectedRoute>,  },
  {
    path: '/trend-charts',
    element: <ProtectedRoute><FeatureGate route="/trend-charts"><LazyPage page={<TrendCharts />} /></FeatureGate></ProtectedRoute>,  },
  {
    path: '/campaign-breakdown',
    element: <ProtectedRoute><FeatureGate route="/campaign-breakdown"><LazyPage page={<CampaignBreakdown />} /></FeatureGate></ProtectedRoute>,  },
  {
    path: '/settings',
    element: <ProtectedRoute><FeatureGate route="/settings"><LazyPage page={<Settings />} /></FeatureGate></ProtectedRoute>,  },
  {
    // TEMPORARY admin-only mobile diagnostics. Still behind the standard
    // ProtectedRoute gate, plus the ADMIN/SUPERADMIN-only AdminRoute gate
    // (sidebar entry is also admin-only). Client-side only — no new
    // server endpoint exists for this feature.
    path: '/settings/performance-diagnostics',
    element: <ProtectedRoute><FeatureGate route="/settings/performance-diagnostics"><LazyPage page={<AdminRoute><PerformanceDiagnostics /></AdminRoute>} /></FeatureGate></ProtectedRoute>,
  },
  {
    path: '*',
    element: <Navigate to="/" replace />
  }
]);

export default function App() {
  // 15-minute idle tracker (it defers itself until auth initialization
  // settles, so a stale localStorage timestamp can never race the startup
  // session validation into a premature logout).
  useSessionTimeout();

  React.useEffect(() => {
    // Deterministic auth initialization: wait for the persisted snapshot to
    // hydrate, confirm the persisted token with PostgreSQL/Supabase, then
    // release the protected routes. Guarded so React StrictMode's double
    // effect run performs exactly one validation request.
    //
    // It never rejects, so `void` cannot create an unhandled rejection.
    void initializeAuthSession();
  }, []);

  return (
    <>
      <RouterProvider router={router} />
      <Toaster position="top-right" richColors expand={true} />
    </>
  );
}
