import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_STATUS_DICTIONARY } from '../routes/leadImport.js';

const root = path.resolve(process.cwd());
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8').replaceAll('\r\n', '\n');

/**
 * Guards for the dynamic Update Lead flow.
 * The business rules below are exactly the ones the product owner
 * specified for agent lead tracking — they must not be lost in a refactor.
 */

test('A. LeadUpdate exists, is lazy-routed, and is feature-gated', () => {
  const app = read('src/App.tsx');
  assert.ok(app.includes("./modules/leads/pages/LeadUpdate"), 'LeadUpdate is imported lazily');
  assert.ok(app.includes("path: '/leads/:id/update'"), 'the /leads/:id/update route is registered');
  assert.ok(app.includes('route="/leads/:id/update"'), 'the route passes through FeatureGate');
  const access = read('src/layouts/featureRouteAccess.ts');
  assert.ok(access.includes("/leads/:id/update"), 'featureRouteAccess knows the route (inherits /leads access)');
});

test('B. Interested forces a Next Action, mapped to a canonical status', () => {
  const page = read('src/modules/leads/pages/LeadUpdate.tsx');
  assert.ok(/status === 'Interested'/.test(page), 'the Next Action section renders for Interested');
  assert.ok(page.includes("'Need Follow-Up'"), 'Need Follow-Up is one of the next actions');
  assert.ok(page.includes("'Meeting Fixed'"), 'Meeting Fixed is one of the next actions');
  assert.ok(page.includes("'Proposal Sent'"), 'Proposal Sent is one of the next actions');
  assert.ok(page.includes("'Follow-up Set'"), 'Need Follow-Up maps to the canonical dictionary status Follow-up Set');
  const fn = page.slice(page.indexOf('function statusForNextAction'));
  assert.ok(fn.includes('FOLLOW_UP_SET'), 'statusForNextAction implements the mapping');
});

test('C. conditional fields follow the specified business rules', () => {
  const page = read('src/modules/leads/pages/LeadUpdate.tsx');
  assert.ok(/effectiveStatus === FOLLOW_UP_SET/.test(page), 'Follow-up Set requires a follow-up date');
  assert.ok(/effectiveStatus === MEETING_FIXED/.test(page), 'Meeting Fixed requires a meeting date');
  assert.ok(/effectiveStatus === PROPOSAL_SENT/.test(page), 'Proposal Sent shows proposal fields');
  assert.ok(/effectiveStatus === 'Converted'/.test(page), 'Converted shows conversion fields');
  assert.ok(/effectiveStatus === NOT_INTERESTED/.test(page), 'Not Interested requires a loss reason');
  assert.ok(page.includes('datetime-local'), 'date & time pickers are date+time, not date-only');
  // Proposal captures product + sum assured + PROJECTED FYCP
  assert.ok(page.includes("t('updProjectedFYCP')"), 'projected FYCP field exists');
  // Converted captures product + sum assured + COLLECTED FYCP
  assert.ok(page.includes("t('updCollectedFYCP')"), 'collected FYCP field exists');
  // Remarks are always part of the form
  assert.ok(page.includes("t('remarks')"), 'remarks are always present');
});

test('D. submission is server-authoritative and meetings mirror to the calendar', () => {
  const page = read('src/modules/leads/pages/LeadUpdate.tsx');
  assert.ok(page.includes('leadService.updateLeadStatus('), 'status update goes through the server-authoritative service');
  assert.ok(page.includes("scheduledActivityService.create("), 'Meeting Fixed also creates a scheduled calendar activity');
  assert.ok(page.includes("activityType: 'meeting'"), 'the calendar entry is a meeting');
  const svc = read('src/modules/leads/services/leadService.ts');
  assert.ok(/api\/leads\/\$\{encodeURIComponent\(leadId\)\}\/follow-up/.test(svc) || svc.includes('/follow-up'), 'the service posts to the server follow-up endpoint');
});

test('E. statuses are dictionary-driven, and Proposal Sent exists in the dictionary', () => {
  const page = read('src/modules/leads/pages/LeadUpdate.tsx');
  assert.ok(page.includes('preloadLeadStatuses()'), 'the form reads the canonical status list (never hardcoded)');
  const migration = read('server/database/migrations/043_proposal_sent_status.ts');
  const rename = read('server/database/migrations/044_rename_untouched_status.ts');
  assert.ok(migration.includes("FollowUpStatus") && migration.includes("Proposal Sent"), 'migration 043 inserts the Proposal Sent option');
  for (const st of ['Interested', 'Follow-up Set', 'Meeting Fixed', 'Proposal Sent', 'Converted', 'Not Interested']) {
    assert.ok(migration.includes(`"${st}"`), `migration 043 covers the canonical status ${st}`);
  }
  // The first pipeline stage is created by 043 and renamed to "New" by 044 —
  // the taxonomy must be covered by the migration pair, not by either alone.
  assert.ok(rename.includes('FollowUpStatus'), 'migration 044 targets the status dictionary');
  assert.ok(rename.includes("'New'"), 'migration 044 lands on the canonical first stage New');
  assert.ok(DEFAULT_STATUS_DICTIONARY[0] === 'New', 'the default dictionary starts at New');
  assert.ok(/WHERE NOT EXISTS/.test(migration), 'the migration is idempotent per status');
  const registry = read('server/database/runMigrations.ts');
  assert.ok(registry.includes('043_proposal_sent_status'), 'migration 043 is registered in the migration list');
  const seed = read('server/database/seeds/metadata.seed.ts');
  assert.ok(seed.includes('Proposal Sent'), 'fresh deployments seed Proposal Sent too');
});

test('F. Lead360 exposes the Update action next to Edit (desktop + mobile)', () => {
  const l360 = read('src/modules/leads/pages/Lead360.tsx');
  const occurrences = l360.split('/update`').length - 1;
  assert.ok(occurrences >= 2, 'Update button exists on both the desktop header and the mobile header');
  assert.ok(l360.includes('Target'), 'the Update action uses the target/status-track icon');
});
