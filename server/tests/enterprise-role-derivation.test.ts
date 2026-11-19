/**
 * enterprise-role-derivation.test.ts
 * ------------------------------------------------------------------
 * The derived enterprise workspace role (Enterprise Preview
 * redesign, 2026-11-19): deriveEnterpriseRole is pure, so every
 * branch is pinned here without a React tree.
 *
 * Derivation order (src/layouts/enterpriseRole.ts):
 *   1. ADMIN / SUPERADMIN role                    -> admin
 *   2. data visibility FullTeam / Organization    -> manager
 *   3. overview scope 'Organization'              -> manager
 *   4. >= 1 direct report (the UM-1 tree fact)    -> teamLead
 *   5. everyone else                              -> agent
 *
 * There is no role switcher anywhere: the caller sees exactly the
 * one workspace this derivation returns.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveEnterpriseRole,
  ENTERPRISE_ROLE_LABELS,
  ENTERPRISE_ROLE_SUBTITLES,
  type EnterpriseRoleInput,
} from '../../src/layouts/enterpriseRole';

const base = (over: Partial<EnterpriseRoleInput>): EnterpriseRoleInput => ({
  userRole: 'RO',
  overviewScope: 'Own',
  hasDirectReports: false,
  dataVisibility: null,
  ...over,
});

describe('deriveEnterpriseRole — the admin bypass', () => {
  it('ADMIN is admin whatever the scope, reports or visibility say', () => {
    assert.equal(
      deriveEnterpriseRole(base({ userRole: 'ADMIN', overviewScope: 'Organization', hasDirectReports: true, dataVisibility: 'FullTeam' })),
      'admin'
    );
    assert.equal(
      deriveEnterpriseRole(base({ userRole: 'ADMIN', overviewScope: 'Own', hasDirectReports: false, dataVisibility: null })),
      'admin',
      'an admin with no reports and no matrix yet is still admin'
    );
  });

  it('SUPERADMIN is admin too', () => {
    assert.equal(deriveEnterpriseRole(base({ userRole: 'SUPERADMIN' })), 'admin');
  });

  it('the role code matches case-insensitively, with whitespace tolerated', () => {
    assert.equal(deriveEnterpriseRole(base({ userRole: 'admin' })), 'admin');
    assert.equal(deriveEnterpriseRole(base({ userRole: '  SuperAdmin ' })), 'admin');
  });

  it('a null or missing role code never crashes and never grants admin', () => {
    assert.equal(deriveEnterpriseRole(base({ userRole: null })), 'agent');
    assert.equal(deriveEnterpriseRole(base({ userRole: undefined })), 'agent');
    assert.equal(deriveEnterpriseRole(base({ userRole: '' })), 'agent');
  });
});

describe('deriveEnterpriseRole — the manager arms', () => {
  it('a no-reports FullTeam manager is a manager (the matrix arm)', () => {
    // The case the scope alone cannot catch: a department manager
    // whose overview scope is 'Team' but who oversees full teams.
    assert.equal(
      deriveEnterpriseRole(base({ userRole: 'MANAGER', overviewScope: 'Team', hasDirectReports: false, dataVisibility: 'FullTeam' })),
      'manager'
    );
  });

  it('Organization data visibility is a manager, even with no reports', () => {
    assert.equal(
      deriveEnterpriseRole(base({ userRole: 'BH', overviewScope: 'Team', hasDirectReports: false, dataVisibility: 'Organization' })),
      'manager'
    );
  });

  it('Organization overview scope is a manager before the matrix loads', () => {
    // The matrix has not landed yet (dataVisibility null): an
    // Organization scope means sees-everyone, which only
    // managers/executives hold.
    assert.equal(
      deriveEnterpriseRole(base({ userRole: 'BH', overviewScope: 'Organization', hasDirectReports: false, dataVisibility: null })),
      'manager'
    );
    assert.equal(
      deriveEnterpriseRole(base({ userRole: 'BH', overviewScope: 'Organization', hasDirectReports: false, dataVisibility: undefined })),
      'manager'
    );
  });

  it('the visibility arm beats the reports arm (a FullTeam manager with reports is still a manager)', () => {
    assert.equal(
      deriveEnterpriseRole(base({ userRole: 'MANAGER', overviewScope: 'Team', hasDirectReports: true, dataVisibility: 'FullTeam' })),
      'manager'
    );
  });

  it('the admin arm beats the manager arms', () => {
    assert.equal(
      deriveEnterpriseRole(base({ userRole: 'ADMIN', overviewScope: 'Organization', hasDirectReports: true, dataVisibility: 'Organization' })),
      'admin'
    );
  });
});

describe('deriveEnterpriseRole — team lead vs agent', () => {
  it('a DownTeam supervisor WITH reports is a teamLead (RM is the first-line supervisor)', () => {
    assert.equal(
      deriveEnterpriseRole(base({ userRole: 'RM', overviewScope: 'Team', hasDirectReports: true, dataVisibility: 'DownTeam' })),
      'teamLead'
    );
    assert.equal(
      deriveEnterpriseRole(base({ userRole: 'TEAM_LEAD', overviewScope: 'Team', hasDirectReports: true, dataVisibility: 'DownTeam' })),
      'teamLead'
    );
  });

  it('a DownTeam role WITHOUT reports is an agent (no subordinates, effective scope just themself)', () => {
    assert.equal(
      deriveEnterpriseRole(base({ userRole: 'RM', overviewScope: 'Team', hasDirectReports: false, dataVisibility: 'DownTeam' })),
      'agent'
    );
  });

  it('reports alone make a teamLead, even with Own visibility and an empty scope', () => {
    // The UM-1 tree floor: a role whose stored scope is 'Own' still
    // sees its reporting subtree when it has one.
    assert.equal(
      deriveEnterpriseRole(base({ userRole: 'RO', overviewScope: '', hasDirectReports: true, dataVisibility: 'Own' })),
      'teamLead'
    );
  });

  it('empty scope + no reports is an agent', () => {
    assert.equal(
      deriveEnterpriseRole(base({ userRole: 'RO', overviewScope: '', hasDirectReports: false, dataVisibility: null })),
      'agent'
    );
  });

  it('Own scope + no reports is an agent (the plain leaf member)', () => {
    assert.equal(
      deriveEnterpriseRole(base({ userRole: 'RO', overviewScope: 'Own', hasDirectReports: false, dataVisibility: 'Own' })),
      'agent'
    );
    assert.equal(
      deriveEnterpriseRole(base({ userRole: 'EMPLOYEE', overviewScope: 'Own', hasDirectReports: false, dataVisibility: null })),
      'agent'
    );
  });

  it('Team scope alone (no reports, no manager visibility) is an agent', () => {
    assert.equal(
      deriveEnterpriseRole(base({ userRole: 'RO', overviewScope: 'Team', hasDirectReports: false, dataVisibility: null })),
      'agent'
    );
  });
});

describe('deriveEnterpriseRole — labels and subtitles', () => {
  it('every role has the sample\'s exact label', () => {
    assert.deepEqual(ENTERPRISE_ROLE_LABELS, {
      admin: 'Admin',
      manager: 'Manager',
      teamLead: 'Team Lead',
      agent: 'Agent',
    });
  });

  it('every role has a non-empty subtitle', () => {
    for (const role of ['admin', 'manager', 'teamLead', 'agent'] as const) {
      assert.ok(
        typeof ENTERPRISE_ROLE_SUBTITLES[role] === 'string' && ENTERPRISE_ROLE_SUBTITLES[role].length > 0,
        `${role} has a subtitle`
      );
    }
    assert.equal(
      ENTERPRISE_ROLE_SUBTITLES.agent,
      'Your daily priorities, follow-ups and the next best action for every lead.'
    );
  });
});
