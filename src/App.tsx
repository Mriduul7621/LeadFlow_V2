import React from 'react';
import { 
  createBrowserRouter, 
  RouterProvider, 
  Navigate 
} from 'react-router-dom';
import Dashboard from './modules/dashboard/pages/Dashboard';
import FollowUpStrategy from './modules/leads/pages/FollowUpStrategy';
import LeadGenerate from './modules/leads/pages/LeadGenerate';
import LeadList from './modules/leads/pages/LeadList';
import LeadUpload from './modules/leads/pages/LeadUpload';
import AllLeads from './modules/leads/pages/AllLeads';
import Login from './modules/auth/pages/Login';
import Settings from './modules/settings/pages/Settings';
import TeamHierarchy from './modules/hierarchy/pages/TeamHierarchy';
import UserManagement from './modules/users/pages/UserManagement';
import ExecutionIntelligence from './modules/dashboard/pages/ExecutionIntelligence';
import NcpProgress from './modules/dashboard/pages/NcpProgress';
import TrendCharts from './modules/dashboard/pages/TrendCharts';
import CampaignBreakdown from './modules/dashboard/pages/CampaignBreakdown';
import TaskCalendar from './modules/auth/pages/TaskCalendar';
import Lead360 from './modules/leads/pages/Lead360';
import Activities from './modules/leads/pages/Activities';
import DailyWorkbench from './modules/workbench/pages/DailyWorkbench';
import ProtectedRoute from './modules/auth/components/ProtectedRoute';
import { initializeAuthSession } from './modules/auth/services/authFlow';
import { Toaster } from 'sonner';
import { useSessionTimeout } from './modules/shared/hooks/useSessionTimeout';

const router = createBrowserRouter([
  {
    path: '/login',
    element: <Login />,
  },
  {
    path: '/',
    element: <ProtectedRoute><Dashboard /></ProtectedRoute>,
  },
  {
    path: '/leads/new',
    element: <ProtectedRoute><LeadGenerate /></ProtectedRoute>,
  },
  {
    path: '/leads',
    element: <ProtectedRoute><LeadList /></ProtectedRoute>,
  },
  {
    path: '/leads/upload',
    element: <ProtectedRoute><LeadUpload /></ProtectedRoute>,
  },
  {
    path: '/leads/all',
    element: <ProtectedRoute><AllLeads /></ProtectedRoute>,
  },
  {
    path: '/follow-up',
    element: <ProtectedRoute><FollowUpStrategy /></ProtectedRoute>,
  },
  {
    path: '/task-calendar',
    element: <ProtectedRoute><TaskCalendar /></ProtectedRoute>,
  },
  {
    path: '/activities',
    element: <ProtectedRoute><Activities /></ProtectedRoute>,
  },
  {
    path: '/workbench',
    element: <ProtectedRoute><DailyWorkbench /></ProtectedRoute>,
  },
  {
    path: '/leads/:id',
    element: <ProtectedRoute><Lead360 /></ProtectedRoute>,
  },
  {
    path: '/users',
    element: <ProtectedRoute><UserManagement /></ProtectedRoute>,
  },
  {
    path: '/team',
    element: <ProtectedRoute><TeamHierarchy /></ProtectedRoute>,
  },
  {
    path: '/execution-intelligence',
    element: <ProtectedRoute><ExecutionIntelligence /></ProtectedRoute>,
  },
  {
    path: '/ncp-progress',
    element: <ProtectedRoute><NcpProgress /></ProtectedRoute>,
  },
  {
    path: '/trend-charts',
    element: <ProtectedRoute><TrendCharts /></ProtectedRoute>,
  },
  {
    path: '/campaign-breakdown',
    element: <ProtectedRoute><CampaignBreakdown /></ProtectedRoute>,
  },
  {
    path: '/settings',
    element: <ProtectedRoute><Settings /></ProtectedRoute>,
  },
  {
    path: '*',
    element: <Navigate to="/" replace />,
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
