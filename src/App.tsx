import React, { Suspense, lazy } from 'react';
import {
  createBrowserRouter,
  RouterProvider,
  Navigate
} from 'react-router-dom';
import Login from './modules/auth/pages/Login';
import ProtectedRoute from './modules/auth/components/ProtectedRoute';
import AdminRoute from './modules/auth/components/AdminRoute';
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
    element: <ProtectedRoute><LazyPage page={<Dashboard />} /></ProtectedRoute>,
  },
  {
    path: '/leads/new',
    element: <ProtectedRoute><LazyPage page={<LeadGenerate />} /></ProtectedRoute>,
  },
  {
    path: '/leads',
    element: <ProtectedRoute><LazyPage page={<LeadList />} /></ProtectedRoute>,
  },
  {
    path: '/leads/upload',
    element: <ProtectedRoute><LazyPage page={<LeadUpload />} /></ProtectedRoute>,
  },
  {
    path: '/leads/all',
    element: <ProtectedRoute><LazyPage page={<AllLeads />} /></ProtectedRoute>,
  },
  {
    path: '/follow-up',
    element: <ProtectedRoute><LazyPage page={<FollowUpStrategy />} /></ProtectedRoute>,
  },
  {
    path: '/task-calendar',
    element: <ProtectedRoute><LazyPage page={<TaskCalendar />} /></ProtectedRoute>,
  },
  {
    path: '/activities',
    element: <ProtectedRoute><LazyPage page={<Activities />} /></ProtectedRoute>,
  },
  {
    path: '/workbench',
    element: <ProtectedRoute><LazyPage page={<DailyWorkbench />} /></ProtectedRoute>,
  },
  {
    path: '/leads/:id',
    element: <ProtectedRoute><LazyPage page={<Lead360 />} /></ProtectedRoute>,
  },
  {
    path: '/users',
    element: <ProtectedRoute><LazyPage page={<UserManagement />} /></ProtectedRoute>,
  },
  {
    path: '/team',
    element: <ProtectedRoute><LazyPage page={<TeamHierarchy />} /></ProtectedRoute>,
  },
  {
    path: '/execution-intelligence',
    element: <ProtectedRoute><LazyPage page={<ExecutionIntelligence />} /></ProtectedRoute>,
  },
  {
    path: '/ncp-progress',
    element: <ProtectedRoute><LazyPage page={<NcpProgress />} /></ProtectedRoute>,
  },
  {
    path: '/trend-charts',
    element: <ProtectedRoute><LazyPage page={<TrendCharts />} /></ProtectedRoute>,
  },
  {
    path: '/campaign-breakdown',
    element: <ProtectedRoute><LazyPage page={<CampaignBreakdown />} /></ProtectedRoute>,
  },
  {
    path: '/settings',
    element: <ProtectedRoute><LazyPage page={<Settings />} /></ProtectedRoute>,
  },
  {
    // TEMPORARY admin-only mobile diagnostics. Still behind the standard
    // ProtectedRoute gate, plus the ADMIN/SUPERADMIN-only AdminRoute gate
    // (sidebar entry is also admin-only). Client-side only — no new
    // server endpoint exists for this feature.
    path: '/settings/performance-diagnostics',
    element: <ProtectedRoute><LazyPage page={<AdminRoute><PerformanceDiagnostics /></AdminRoute>} /></ProtectedRoute>,
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
