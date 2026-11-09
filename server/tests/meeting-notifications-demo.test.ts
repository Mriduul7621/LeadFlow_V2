import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fallbackStore } from '../fallbackStore.js';
import {
  notifyMeetingInvites,
  notifyMeetingRsvp,
  notifyMeetingClosed,
  runMeetingReminders,
} from '../services/MeetingNotificationService.js';

/**
 * Demo-mode (fallbackStore) mirror of the PR E meeting notifications.
 * This file never sets DATABASE_URL, so the services run their
 * in-memory paths — the same paths the scheduled-activity route
 * handlers take when no database is configured.
 */

const ORG = { id: 'demo-org', employeeId: 'ORG1', fullName: 'Organiser One', name: 'Organiser One', email: 'org@demo.test', role: 'EMPLOYEE', status: 'Active' };
const ATT = { id: 'demo-att', employeeId: 'ATT1', fullName: 'Attendee One', name: 'Attendee One', email: 'att@demo.test', role: 'EMPLOYEE', status: 'Active' };
const ATT2 = { id: 'demo-att2', employeeId: 'ATT2', fullName: 'Attendee Two', name: 'Attendee Two', email: 'att2@demo.test', role: 'EMPLOYEE', status: 'Active' };
const ASG = { id: 'demo-asg', employeeId: 'ASG1', fullName: 'Assignee One', name: 'Assignee One', email: 'asg@demo.test', role: 'EMPLOYEE', status: 'Active' };

const ACTIVITY = {
  id: 'demo-act-1',
  title: 'Demo Sync',
  activityType: 'meeting',
  scheduledAt: '2027-03-10T10:00:00.000Z',
  leadCustomerName: null,
  createdBy: ORG.id,
};

function notifications(): any[] {
  return (fallbackStore as any).notifications || [];
}

function forUser(userId: string, eventType?: string): any[] {
  return notifications().filter(
    (n: any) => n.userId === userId && (!eventType || n.eventType === eventType)
  );
}

describe('Meeting notifications — demo mode (PR E)', () => {
  beforeEach(() => {
    (fallbackStore as any).users = [ORG, ATT, ATT2, ASG];
    (fallbackStore as any).notifications = [];
    (fallbackStore as any).scheduledActivities = [];
    (fallbackStore as any).pushSubscriptions = [];
  });

  it('invite fan-out writes deduped demo notifications and never notifies the organiser', async () => {
    const attendees = [
      { userId: ATT.id, employeeId: ATT.employeeId },
      { userId: ORG.id, employeeId: ORG.employeeId },
    ];
    const first = await notifyMeetingInvites({ activity: ACTIVITY, organiserId: ORG.id, attendees });
    assert.equal(first.created, 1);
    assert.equal(forUser(ATT.id, 'meeting-invited').length, 1);
    assert.match(forUser(ATT.id)[0].message, /^You are invited: Demo Sync — /);
    assert.equal(forUser(ORG.id).length, 0, 'organiser listed as attendee is still not notified');

    const replay = await notifyMeetingInvites({ activity: ACTIVITY, organiserId: ORG.id, attendees });
    assert.equal(replay.created, 0, 'replay dedupes on the idempotency key');
    assert.equal(forUser(ATT.id, 'meeting-invited').length, 1);
  });

  it('RSVP fan-out notifies the organiser once per distinct response', async () => {
    const first = await notifyMeetingRsvp({
      activity: ACTIVITY,
      responder: { userId: ATT.id, name: 'Attendee One' },
      response: 'accepted',
    });
    assert.equal(first.created, 1);
    const rsvps = forUser(ORG.id, 'meeting-rsvp');
    assert.equal(rsvps.length, 1);
    assert.equal(rsvps[0].message, 'Attendee One accepted: Demo Sync');

    const again = await notifyMeetingRsvp({
      activity: ACTIVITY,
      responder: { userId: ATT.id, name: 'Attendee One' },
      response: 'accepted',
    });
    assert.equal(again.created, 0, 'same answer re-sent dedupes');

    const flipped = await notifyMeetingRsvp({
      activity: ACTIVITY,
      responder: { userId: ATT.id, name: 'Attendee One' },
      response: 'declined',
    });
    assert.equal(flipped.created, 1, 'a flipped answer notifies again');
    assert.equal(forUser(ORG.id, 'meeting-rsvp').length, 2);
  });

  it('closed fan-out (cancelled) reaches attendees only', async () => {
    const result = await notifyMeetingClosed({
      activity: ACTIVITY,
      organiserId: ORG.id,
      attendees: [
        { userId: ATT.id, employeeId: ATT.employeeId },
        { userId: ORG.id, employeeId: ORG.employeeId },
      ],
      kind: 'cancelled',
    });
    assert.equal(result.created, 1);
    assert.equal(forUser(ATT.id, 'meeting-cancelled').length, 1);
    assert.match(forUser(ATT.id)[0].message, /^Meeting cancelled: Demo Sync/);
    assert.equal(forUser(ORG.id).length, 0);
  });

  it('reminder runner scans demo entries: organiser + assignee + non-declined attendees, deduped on re-run', async () => {
    const now = new Date();
    (fallbackStore as any).scheduledActivities = [
      {
        id: 'demo-rem-1',
        activityType: 'meeting',
        title: 'Demo Reminder',
        status: 'scheduled',
        reminderMinutes: 30,
        scheduledAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
        created_by: ORG.id,
        assigned_to: ASG.id,
        attendees: [
          { userId: ATT.id, response: 'declined' },
          { userId: ATT2.id, response: 'pending' },
        ],
      },
      {
        id: 'demo-rem-2',
        activityType: 'meeting',
        title: 'No Reminder Set',
        status: 'scheduled',
        reminderMinutes: null,
        scheduledAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
        created_by: ORG.id,
        assigned_to: ORG.id,
        attendees: [{ userId: ATT.id, response: 'pending' }],
      },
      {
        id: 'demo-rem-3',
        activityType: 'meeting',
        title: 'Cancelled Demo',
        status: 'cancelled',
        reminderMinutes: 30,
        scheduledAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
        created_by: ORG.id,
        assigned_to: ORG.id,
        attendees: [{ userId: ATT.id, response: 'pending' }],
      },
    ];

    const run1 = await runMeetingReminders(now);
    assert.equal(run1.scanned, 1, 'only the due, scheduled, reminder-bearing entry');
    assert.equal(run1.recipients, 3, 'organiser + assignee + pending attendee');
    assert.equal(run1.notified, 3);
    assert.equal(forUser(ORG.id, 'meeting-reminder').length, 1);
    assert.equal(forUser(ASG.id, 'meeting-reminder').length, 1);
    assert.equal(forUser(ATT2.id, 'meeting-reminder').length, 1);
    assert.equal(forUser(ATT.id, 'meeting-reminder').length, 0, 'declined attendee is skipped');

    const run2 = await runMeetingReminders(now);
    assert.equal(run2.notified, 0, 'second run dedupes');
    assert.equal(run2.deduped, 3);
  });
});
