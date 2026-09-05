import { Lead } from '../../shared/types';
import { getLeadStatusMeta } from '../../workflow/utils/leadStatusMeta';

/**
 * activityEngine.ts
 * ------------------------------------------------------------------
 * Derives a categorized "activity" list from each lead's pending
 * follow-up/call/meeting dates - there's no separate Activity/Task
 * entity in the data model, so this computes activities on the fly
 * from fields that already exist on Lead (nextFollowUpDate,
 * nextCallDate, meetingDate) plus its current status.
 *
 * Honest scope note: only Today / Tomorrow / Upcoming / Overdue /
 * Missed / Completed are implemented with real, meaningful data.
 * "Cancelled" isn't modeled anywhere yet (there's no lead-closure-
 * without-resolution concept in the pipeline), and "Escalated" needs
 * the Notification Engine's escalation chain (Phase 5) to mean
 * anything real - both are left for a later phase rather than being
 * faked here.
 */

export type ActivityCategory = 'Today' | 'Tomorrow' | 'Upcoming' | 'Overdue' | 'Missed' | 'Completed';

export interface Activity {
  id: string;
  leadId: string;
  prospectName: string;
  type: 'Follow-up' | 'Call' | 'Meeting';
  dueDate: string;
  assignedTo?: string;
  status: string;
  category: ActivityCategory;
}

const MISSED_THRESHOLD_DAYS = 3;

function daysBetween(a: Date, b: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((a.getTime() - b.getTime()) / msPerDay);
}

function categorize(dueDateStr: string, isTerminal: boolean): ActivityCategory {
  if (isTerminal) return 'Completed';

  const due = new Date(dueDateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);

  const diff = daysBetween(due, today); // positive = future, negative = past

  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff > 1) return 'Upcoming';
  // diff < 0 -> past due
  if (Math.abs(diff) >= MISSED_THRESHOLD_DAYS) return 'Missed';
  return 'Overdue';
}

/** Builds the full categorized activity list from a set of (already visibility-scoped) leads. */
export function buildActivities(leads: Lead[]): Activity[] {
  const activities: Activity[] = [];

  for (const lead of leads) {
    const meta = getLeadStatusMeta(lead.currentStatus);

    if (lead.nextFollowUpDate) {
      activities.push({
        id: `${lead.id}_followup`,
        leadId: lead.id,
        prospectName: lead.prospectName,
        type: 'Follow-up',
        dueDate: lead.nextFollowUpDate,
        assignedTo: lead.assignedTo,
        status: lead.currentStatus,
        category: categorize(lead.nextFollowUpDate, meta.isTerminal),
      });
    }
    if (lead.nextCallDate) {
      activities.push({
        id: `${lead.id}_call`,
        leadId: lead.id,
        prospectName: lead.prospectName,
        type: 'Call',
        dueDate: lead.nextCallDate,
        assignedTo: lead.assignedTo,
        status: lead.currentStatus,
        category: categorize(lead.nextCallDate, meta.isTerminal),
      });
    }
    if (lead.meetingDate) {
      activities.push({
        id: `${lead.id}_meeting`,
        leadId: lead.id,
        prospectName: lead.prospectName,
        type: 'Meeting',
        dueDate: lead.meetingDate,
        assignedTo: lead.assignedTo,
        status: lead.currentStatus,
        category: categorize(lead.meetingDate, meta.isTerminal),
      });
    }
  }

  return activities.sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
}

export function groupByCategory(activities: Activity[]): Record<ActivityCategory, Activity[]> {
  const groups: Record<ActivityCategory, Activity[]> = {
    Today: [], Tomorrow: [], Upcoming: [], Overdue: [], Missed: [], Completed: [],
  };
  for (const a of activities) {
    groups[a.category].push(a);
  }
  return groups;
}
