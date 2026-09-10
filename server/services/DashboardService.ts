/**
 * DashboardService — metrics are computed in production.routes GET /api/dashboard
 * (aggregate SQL + shared visibility / businessTime helpers). This module
 * documents the contract for consumers and tests.
 */
export type DashboardFollowUpCounts = {
  overdue: number;
  today: number;
  upcoming: number;
  all: number;
};

export type DashboardMetricsContract = {
  timezone: 'Asia/Dhaka' | string;
  totalLeads: number;
  statusCounts: Record<string, number>;
  projected: number;
  collected: number;
  sumAssured: number;
  conversionRate: string;
  followUpCounts: DashboardFollowUpCounts;
};
