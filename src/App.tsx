import React from 'react';
import { 
  createBrowserRouter, 
  RouterProvider, 
  Navigate 
} from 'react-router-dom';
import AppLayout from './layouts/AppLayout';
import Dashboard from './pages/Dashboard';
import FollowUpStrategy from './pages/FollowUpStrategy';
import LeadGenerate from './pages/LeadGenerate';
import LeadList from './pages/LeadList';
import LeadUpload from './pages/LeadUpload';
import AllLeads from './pages/AllLeads';
import Login from './pages/Login';
import Settings from './pages/Settings';
import TeamHierarchy from './pages/TeamHierarchy';
import UserManagement from './pages/UserManagement';
import ExecutionIntelligence from './pages/ExecutionIntelligence';
import NcpProgress from './pages/NcpProgress';
import TrendCharts from './pages/TrendCharts';
import CampaignBreakdown from './pages/CampaignBreakdown';
import TaskCalendar from './pages/TaskCalendar';
import Lead360 from './pages/Lead360';
import Activities from './pages/Activities';
import { useAuthStore } from './store/authStore';
import { Toaster } from 'sonner';
import { userService } from './services/userService';
import { syncService } from './services/syncService';
import { useSessionTimeout } from './hooks/useSessionTimeout';

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { isAuthenticated, isInitialized } = useAuthStore();
  
  if (!isInitialized) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="w-10 h-10 border-4 border-slate-100 border-t-[#978C21] rounded-full animate-spin"></div>
      </div>
    );
  }
  
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <AppLayout>{children}</AppLayout>;
};

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
  const { setInitialized, login, logout } = useAuthStore();

  // Run the 15-minute idle inactivity tracker
  useSessionTimeout();

  React.useEffect(() => {
    // 1. Trigger background data synchronization if authenticated
    const state = useAuthStore.getState();
    if (state.isAuthenticated && state.user) {
      syncService.syncToDatabase();
    }

    // 2. Manage authentication state changes
    setInitialized(true);
  }, []);

  return (
    <>
      <RouterProvider router={router} />
      <Toaster position="top-right" richColors expand={true} />
    </>
  );
}
