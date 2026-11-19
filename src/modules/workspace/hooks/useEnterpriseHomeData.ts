import { useCallback, useEffect, useState } from 'react';
import { useAuthStore } from '../../auth/store/authStore';
import { useCallerTeam, type CallerTeamState } from '../../team/hooks/useCallerTeam';
import { dashboardService, type DashboardMetrics } from '../../dashboard/services/dashboardService';
import { leadService, type FollowUpQueueItem } from '../../leads/services/leadService';
import { metadataService } from '../../metadata/services/metadataService';
import { userService } from '../../users/services/userService';
import type { DropdownOption, User } from '../../shared/types';
import {
  markCriticalStartupSettled,
  waitForCriticalStartup,
} from '../../shared/api/startupPriority';
import { isForbiddenError } from '../../shared/api/forbidden';
import { buildNext7Days, type DayBucket } from '../utils/enterpriseData';

/**
 * useEnterpriseHomeData — the shared data load for the four
 * enterprise role homes (Enterprise Preview redesign, 2026-11-19).
 * ------------------------------------------------------------------
 * One hook, one loading pattern, four homes: the scoped team
 * overview (KPIs), the dashboard metrics (conversion, NCP, team
 * stats, status counts), the follow-up queue buckets (attention
 * lists + the 7-day chart), and the FollowUpStatus dictionary
 * (terminal flags for the pipeline bottleneck). Admin homes pass
 * `withUsers` for the roster read behind the Active users KPI.
 *
 * Startup sequencing mirrors the old Dashboard: GET /api/dashboard
 * is the session's critical request — it releases the startup gate
 * in `finally` (success or failure) and every deferred read waits
 * for it, so the home never competes with itself on a slow
 * connection. The queue reads are three bounded bucket reads
 * (overdue / today / upcoming, 50 each) — never one bucket=all
 * read, which would truncate.
 *
 * Nothing here invents a number: every figure the homes show comes
 * from one of these server payloads.
 */

export interface EnterpriseHomeData {
  callerTeam: CallerTeamState;
  metrics: DashboardMetrics | null;
  metricsLoading: boolean;
  metricsError: string | null;
  forbidden: boolean;
  queueLoading: boolean;
  overdueItems: FollowUpQueueItem[];
  todayItems: FollowUpQueueItem[];
  upcomingItems: FollowUpQueueItem[];
  overdueTotal: number;
  todayTotal: number;
  chartDays: DayBucket[];
  chartTruncated: boolean;
  statusOptions: DropdownOption[];
  users: User[] | null;
  usersLoading: boolean;
  refresh: () => void;
}

export function useEnterpriseHomeData(options?: { withUsers?: boolean }): EnterpriseHomeData {
  const user = useAuthStore(state => state.user);
  const callerTeam = useCallerTeam();

  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const [queueLoading, setQueueLoading] = useState(true);
  const [overdueItems, setOverdueItems] = useState<FollowUpQueueItem[]>([]);
  const [todayItems, setTodayItems] = useState<FollowUpQueueItem[]>([]);
  const [upcomingItems, setUpcomingItems] = useState<FollowUpQueueItem[]>([]);
  const [overdueTotal, setOverdueTotal] = useState(0);
  const [todayTotal, setTodayTotal] = useState(0);
  const [chartDays, setChartDays] = useState<DayBucket[]>(() => buildNext7Days([]));
  const [chartTruncated, setChartTruncated] = useState(false);
  const [statusOptions, setStatusOptions] = useState<DropdownOption[]>([]);

  const [users, setUsers] = useState<User[] | null>(null);
  const [usersLoading, setUsersLoading] = useState(Boolean(options?.withUsers));

  const [reloadTick, setReloadTick] = useState(0);
  const refresh = useCallback(() => {
    callerTeam.refresh();
    setReloadTick(tick => tick + 1);
  }, [callerTeam]);

  const loadDashboardData = useCallback(async () => {
    if (!user) {
      markCriticalStartupSettled();
      setMetricsLoading(false);
      return;
    }
    setMetricsLoading(true);
    setMetricsError(null);
    setForbidden(false);
    try {
      const data = await dashboardService.getDashboard({ period: 'ALL' });
      setMetrics(data);
    } catch (err) {
      setMetrics(null);
      if (isForbiddenError(err)) {
        setForbidden(true);
      } else {
        setMetricsError('Dashboard data could not be loaded.');
      }
    } finally {
      setMetricsLoading(false);
      // STARTUP_CRITICAL = GET /api/dashboard — release Tier 2/3
      // waiters whether the KPI read succeeded or failed so they
      // cannot hang.
      markCriticalStartupSettled();
    }
  }, [user]);

  const loadQueue = useCallback(async () => {
    if (!user) {
      setQueueLoading(false);
      return;
    }
    setQueueLoading(true);
    try {
      await waitForCriticalStartup();
      const [overdueRes, todayRes, upcomingRes, options] = await Promise.all([
        leadService.getFollowUpQueue({ bucket: 'overdue', limit: 50 }),
        leadService.getFollowUpQueue({ bucket: 'today', limit: 50 }),
        leadService.getFollowUpQueue({ bucket: 'upcoming', limit: 50 }),
        metadataService.getAllValues('FollowUpStatus'),
      ]);
      const overdue = overdueRes.items ?? [];
      const today = todayRes.items ?? [];
      const upcoming = upcomingRes.items ?? [];
      setOverdueItems(overdue);
      setTodayItems(today);
      setUpcomingItems(upcoming);
      setOverdueTotal(overdueRes.counts?.overdue ?? overdue.length);
      setTodayTotal(todayRes.counts?.today ?? today.length);
      setChartDays(buildNext7Days([...today, ...upcoming]));
      const fetched = today.length + upcoming.length;
      const available = (todayRes.pagination?.total ?? 0) + (upcomingRes.pagination?.total ?? 0);
      setChartTruncated(available > fetched);
      setStatusOptions(options ?? []);
    } catch {
      setOverdueItems([]);
      setTodayItems([]);
      setUpcomingItems([]);
      setOverdueTotal(0);
      setTodayTotal(0);
      setChartDays(buildNext7Days([]));
      setChartTruncated(false);
      setStatusOptions([]);
    } finally {
      setQueueLoading(false);
    }
  }, [user]);

  const loadUsers = useCallback(async () => {
    if (!user || !options?.withUsers) {
      setUsersLoading(false);
      return;
    }
    setUsersLoading(true);
    try {
      await waitForCriticalStartup();
      const roster = await userService.getAllUsers();
      setUsers(roster ?? []);
    } catch {
      setUsers([]);
    } finally {
      setUsersLoading(false);
    }
  }, [user, options?.withUsers]);

  useEffect(() => {
    void loadDashboardData();
  }, [loadDashboardData, reloadTick]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue, reloadTick]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers, reloadTick]);

  return {
    callerTeam,
    metrics,
    metricsLoading,
    metricsError,
    forbidden,
    queueLoading,
    overdueItems,
    todayItems,
    upcomingItems,
    overdueTotal,
    todayTotal,
    chartDays,
    chartTruncated,
    statusOptions,
    users,
    usersLoading,
    refresh,
  };
}
