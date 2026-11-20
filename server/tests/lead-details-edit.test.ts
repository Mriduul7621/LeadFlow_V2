/**
 * lead-details-edit.test.ts
 * ------------------------------------------------------------------
 * Lead360's Edit button used to send the user home: it navigated to
 * /leads/:id/edit, but no such route existed, so the catch-all
 * `path: '*'` redirected to "/". The fix adds the route and teaches
 * LeadGenerate (the Add Lead form) an edit mode — load the lead,
 * pre-fill every input field, save through the EXISTING server
 * upsert (leadService.updateLead → POST /api/leads), back to Lead360.
 *
 * Pattern ported from the superseded PR #158 onto current main.
 * #158's diff is pre-enterprise and must never be merged.
 *
 * Two halves, mirroring the repo's test style:
 *   1. Behavioural checks on the imported route/grant/heading tables.
 *   2. Source guards on the form, the Lead360 buttons, the lead list
 *      (FIX-1c must stay untouched) and the server upsert's authz.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  FEATURE_ROUTES,
} from '../../src/layouts/featureRouteAccess';
import {
  rolesWithDefaultGrant,
} from '../../src/modules/shared/access/roleGrantDefaults';
import {
  ENTERPRISE_PAGE_DESCRIPTIONS,
  enterpriseHeadingForPath,
} from '../../src/layouts/enterpriseNav';

const ROOT = process.cwd();

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

/** Every input field the Add Lead form collects (its defaultValues). */
const FORM_FIELDS = [
  'prospectName', 'mobile', 'email', 'profession', 'occupation',
  'priority', 'maritalStatus', 'noOfChildren', 'division', 'district',
  'thana', 'source', 'productName', 'campaignName',
  'residenceAddress', 'officeAddress', 'otherInfo', 'familyMember',
  'customFields',
];

/** Fields the edit save must NEVER touch (status / assignment / system). */
const FORBIDDEN_EDIT_FIELDS = [
  'assignedTo', 'currentStatus', 'creationDate', 'statusHistory',
  'assignmentHistory', 'documents', 'leadQuality', 'projectedNCP',
  'collectedNCP',
];

describe('Lead details edit — route and gates', () => {
  it('App.tsx declares /leads/:id/edit rendering LeadGenerate, before /leads/:id', () => {
    const app = read('src/App.tsx');
    const editIdx = app.indexOf("path: '/leads/:id/edit'");
    assert.ok(editIdx !== -1, 'the /leads/:id/edit route must exist');
    const detailIdx = app.indexOf("path: '/leads/:id'");
    assert.ok(editIdx < detailIdx, 'the edit route must be declared before /leads/:id');
    const block = app.slice(editIdx, editIdx + 400);
    assert.ok(block.includes('<LeadGenerate />'), 'the edit route renders the Add Lead form');
    assert.ok(
      block.includes('FeatureGate route="/leads/:id/edit"'),
      'the edit route is wrapped in the FeatureGate for its own route key',
    );
  });

  it('featureRouteAccess maps /leads/:id/edit to the Lead Workspace for every role', () => {
    const entry = FEATURE_ROUTES['/leads/:id/edit'];
    assert.ok(entry, 'a /leads/:id/edit entry must exist');
    assert.equal(entry.path, '/leads');
    // EVERYONE at the route level, like /leads/:id/update — the
    // page gates on leads.edit and the server re-checks it.
    assert.deepEqual(entry.roles, FEATURE_ROUTES['/leads/:id/update'].roles);
  });

  it('the edit page has a proper heading and description (never a raw path)', () => {
    const heading = enterpriseHeadingForPath('agent', '/leads/:id/edit');
    assert.equal(heading.title, 'Edit lead');
    assert.ok(heading.sub.length > 0, 'the edit heading needs a subtitle');
    assert.equal(
      ENTERPRISE_PAGE_DESCRIPTIONS['Edit lead'],
      heading.sub,
      'the subtitle comes from the shared description table',
    );
  });
});

describe('Lead details edit — LeadGenerate edit mode', () => {
  const form = read('src/modules/leads/pages/LeadGenerate.tsx');

  it('detects edit mode from the route param', () => {
    assert.ok(form.includes("const { id: editLeadId } = useParams<{ id: string }>();"));
    assert.ok(form.includes('const isEditMode = Boolean(editLeadId);'));
  });

  it('gates edit mode on the same grant as Lead360\u2019s Edit button', () => {
    assert.ok(form.includes("canAccess('lead_tracking', 'edit')"));
    assert.ok(form.includes('const mayUseForm = isEditMode ? mayEditLead : mayCreateLead;'));
    assert.ok(form.includes('if (!mayUseForm) {'));
    assert.ok(
      form.includes("Strict Security Level: Feature {isEditMode ? 'lead_tracking.edit' : 'lead_generate.create'} Required"),
      'the AccessDenied footer names the grant actually required',
    );
  });

  it('loads the lead through the service that 404s out-of-scope leads', () => {
    assert.ok(form.includes('leadService.getLead(editLeadId)'));
    assert.ok(
      form.includes('Lead not found. It may have been deleted, or it is outside your scope.'),
      'a missing / out-of-scope lead shows a not-found state, never a blank form',
    );
  });

  it('pre-fills EVERY form field from the loaded lead', () => {
    const resetIdx = form.indexOf('    reset({\n      prospectName: editLead.prospectName');
    assert.ok(resetIdx !== -1, 'the edit pre-fill reset must exist');
    const resetBlock = form.slice(resetIdx, form.indexOf('    });', resetIdx));
    for (const field of FORM_FIELDS) {
      assert.ok(
        resetBlock.includes(`${field}:`) || resetBlock.includes(`\n      ${field},`),
        `the pre-fill must set ${field}`,
      );
    }
    // Thana prefers the stored value and falls back to parsing the
    // "thana, district, division" area string.
    assert.ok(form.includes("String(editLead.thana || '') || (areaParts.length >= 3 ? areaParts[0] : '')"));
  });

  it('saves through the existing updateLead upsert, customer info only', () => {
    const updateIdx = form.indexOf('await leadService.updateLead(editLeadId, {');
    assert.ok(updateIdx !== -1, 'the edit save must call leadService.updateLead');
    const payload = form.slice(updateIdx, form.indexOf('});', updateIdx));
    for (const field of FORM_FIELDS) {
      assert.ok(payload.includes(`${field}:`), `the edit payload must carry ${field}`);
    }
    for (const field of FORBIDDEN_EDIT_FIELDS) {
      assert.ok(
        !payload.includes(`${field}:`),
        `the edit payload must never touch ${field} (status/assignment/system)`,
      );
    }
  });

  it('returns to Lead360 after save, and Cancel returns there too', () => {
    const saves = form.match(/navigate\(`\/leads\/\$\{encodeURIComponent\(editLeadId!?\)\}`\)/g) || [];
    assert.ok(
      saves.length >= 2,
      `save and Cancel must both navigate back to /leads/:id (found ${saves.length})`,
    );
    assert.ok(!form.includes("navigate('/')"), 'the form must never navigate home');
  });

  it('hides Assign-to in edit mode and opens More details by default', () => {
    assert.ok(
      form.includes('{!isEditMode && assignOptions.length > 0 && ('),
      'the Assign-to dropdown must not appear in edit mode (Reassign owns assignment)',
    );
    assert.ok(
      form.includes('const [showMoreDetails, setShowMoreDetails] = useState(isEditMode);'),
      'edit mode opens More details so the pre-filled fields are visible at once',
    );
  });

  it('shows the edit heading and Save changes label in edit mode', () => {
    assert.ok(form.includes("path={isEditMode ? '/leads/:id/edit' : '/leads/new'}"));
    assert.ok(form.includes("{isEditMode ? 'Edit lead' : 'New lead'}"));
    assert.ok(form.includes("(isEditMode ? 'Save changes' : 'Save lead')"));
  });
});

describe('Lead details edit — Lead360 buttons and the lead list', () => {
  it('BOTH Lead360 Edit buttons (desktop + mobile) navigate to /leads/:id/edit', () => {
    const lead360 = read('src/modules/leads/pages/Lead360.tsx');
    const edits = lead360.match(/navigate\(`\/leads\/\$\{encodeURIComponent\(lead\.id\)\}\/edit`\)/g) || [];
    assert.equal(edits.length, 2, `Lead360 must have exactly two Edit navigations (found ${edits.length})`);
  });

  it('the lead list Edit action still opens Lead360 (FIX-1c, untouched)', () => {
    const list = read('src/modules/leads/pages/LeadList.tsx');
    assert.ok(!list.includes('/edit'), 'the lead list must not navigate to any /edit route');
    assert.ok(
      list.includes("navigate(`/leads/${encodeURIComponent(leadId)}`, { replace: true })"),
      'the list row action still opens Lead360',
    );
  });
});

describe('Lead details edit — server enforcement', () => {
  it('POST /api/leads requires leads.edit + visibility for an existing lead', () => {
    const routes = read('server/routes/production/leads.routes.ts');
    assert.ok(
      routes.includes("hasPermissionCode(caller, 'leads.edit')"),
      'the upsert must check leads.edit before updating an existing lead',
    );
    assert.ok(
      routes.includes('isLeadAccessible(existingLead, visibility, caller)'),
      'the upsert must check the ONE lead-visibility predicate before updating',
    );
  });

  it('leadService.updateLead preserves assignment when the caller does not reassign', () => {
    const service = read('src/modules/leads/services/leadService.ts');
    assert.ok(
      service.includes('_preserveAssignment: fields.assignedTo === undefined'),
      'a demographic edit must not turn a NULL owner into the caller',
    );
    assert.ok(
      service.includes("apiRequest<Lead>('/api/leads', {\n      method: 'POST'"),
      'updateLead posts the merged record to the existing upsert endpoint',
    );
  });

  it('leads.edit defaults: field, team-lead and manager roles can edit; executives cannot', () => {
    const editors = rolesWithDefaultGrant('leads.edit');
    for (const role of ['EMPLOYEE', 'SBE', 'BE', 'RO', 'TEAM_LEAD', 'BDM', 'ASM', 'MANAGER', 'SM', 'RM']) {
      assert.ok(editors.includes(role), `${role} must hold leads.edit by default`);
    }
    for (const role of ['CEO', 'BH']) {
      assert.ok(!editors.includes(role), `${role} must NOT hold leads.edit by default (read-only executive)`);
    }
  });
});
