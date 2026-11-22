/**
 * organogramBoard.ts — board-view derivation for /team/organogram.
 * ------------------------------------------------------------------
 * The Organogram page (Mahadi-approved sample, 2026-11-21) shows the
 * viewing user's reporting world as a board, not as the old recursive
 * tree:
 *
 *   · CHAIN — one full-width row per ancestor, root (CEO) first down
 *     to the viewer themself, each with its downline + team counts.
 *   · BRANCH — the viewer's direct reports as centred cards.
 *   · LEAF ROW — the direct reports' reports (grandchildren) as small
 *     cards in one flat row.
 *   · SUMMARY — "N people in your downline • N teams • 1 reporting
 *     line each" + the tap hint.
 *
 * Everything here is pure: it derives the view from the organogram
 * nodes the server returns (`GET /api/organogram`, derived from
 * users.manager_id) plus the viewer's employee id. No demo data —
 * the sample's names never appear here or on the page.
 *
 * COUNT DEFINITIONS (documented because the board's numbers are
 * illustrative demo data, not computed from its visible tree):
 *
 *   · people — every descendant of the person (the whole downline,
 *     not just the visible rows).
 *   · teams — the number of FRONT-LINE teams in the downline: a
 *     descendant counts as one team when they have at least one
 *     direct report and NONE of those reports has reports of their
 *     own (in this sales org those are the Unit Managers heading
 *     FA teams). Level-agnostic, so a shallower branch (a BM with
 *     direct FA reports) still counts its own team instead of 0.
 *
 * VIEWER NOT IN THE TREE (e.g. an ADMIN viewer — the API excludes
 * ADMIN/SUPERADMIN rows): the view anchors at the FIRST ROOT and the
 * summary shows that subtree's totals. For a single-root org that
 * is the whole organisation, which is the admin's remit.
 */

/** The fields the board needs from one organogram node. */
export interface OrganogramBoardNodeInput {
  employeeId: string;
  name: string;
  /** Role code (roles.role_code, e.g. 'BE'). */
  roleId: string;
  /** Role name (roles.role_name, e.g. 'Business Executive'). */
  roleName: string;
  /** Free-text designation (fallback label source). */
  designation: string;
  /** Company ladder level (1 = CEO; 0 = unknown, e.g. demo mode). */
  level: number;
  managerEmployeeId: string | null;
  isActive: boolean;
}

/** One person as the board renders them. */
export interface BoardPerson {
  employeeId: string;
  name: string;
  initials: string;
  /** Uppercase board label, e.g. 'CHIEF EXECUTIVE OFFICER', 'BE • RBM'. */
  roleLabel: string;
  level: number;
  /** True for the CEO row (blue styling in the sample). */
  isCeo: boolean;
  /** True when the person has at least one direct report. */
  hasReports: boolean;
  /** Total descendants (the whole downline). */
  downline: number;
  /** Front-line teams in the downline (see the header comment). */
  teams: number;
  isActive: boolean;
}

export interface OrganogramBoardView {
  /** Ancestor chain, root first, viewer last. */
  chain: BoardPerson[];
  /** The viewer's direct reports. */
  branch: BoardPerson[];
  /** The direct reports' reports, in branch order. */
  leafRow: BoardPerson[];
  /** The anchor person (the viewer, or the first root when the viewer
   *  is not in the tree). */
  viewer: BoardPerson | null;
  viewerDownline: number;
  viewerTeams: number;
  /** Every node in the tree (for the empty-state check). */
  totalPeople: number;
  /** True when the tree has no nodes at all. */
  empty: boolean;
  /** False when the viewer was not found in the tree. */
  viewerInTree: boolean;
}

/** Collapse a role code or name to one lookup key. */
function normalizeKey(value: string): string {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Board role labels, keyed by normalized code-or-name. BE is now
 * called RBM, and the board shows both ("BE • RBM").
 */
const ROLE_LABELS: Record<string, string> = {
  CEO: 'CHIEF EXECUTIVE OFFICER',
  CHIEFEXECUTIVEOFFICER: 'CHIEF EXECUTIVE OFFICER',
  HEAD: 'HEAD OF DEPARTMENT',
  HEADOFDEPARTMENT: 'HEAD OF DEPARTMENT',
  HOD: 'HEAD OF DEPARTMENT',
  BE: 'BE • RBM',
  RBM: 'BE • RBM',
  BUSINESSEXECUTIVE: 'BE • RBM',
  GM: 'GENERAL MANAGER',
  GENERALMANAGER: 'GENERAL MANAGER',
  DGM: 'DEPUTY GENERAL MANAGER',
  DEPUTYGENERALMANAGER: 'DEPUTY GENERAL MANAGER',
  AGM: 'ASST. GENERAL MANAGER',
  ASSISTANTGENERALMANAGER: 'ASST. GENERAL MANAGER',
  ASSTGENERALMANAGER: 'ASST. GENERAL MANAGER',
  BM: 'BRANCH MANAGER',
  BRANCHMANAGER: 'BRANCH MANAGER',
  UM: 'UNIT MANAGER',
  UNITMANAGER: 'UNIT MANAGER',
  FA: 'FA',
  FIELDASSOCIATE: 'FA',
  RO: 'RO',
  RELATIONSHIPOFFICER: 'RO',
  MANAGER: 'MANAGER',
  TEAMLEAD: 'TEAM LEAD',
  EMPLOYEE: 'EMPLOYEE',
  SM: 'SALES MANAGER',
  SALESMANAGER: 'SALES MANAGER',
  BDM: 'BUSINESS DEVELOPMENT MANAGER',
  BUSINESSDEVELOPMENTMANAGER: 'BUSINESS DEVELOPMENT MANAGER',
  SBE: 'SENIOR BUSINESS EXECUTIVE',
  SENIORBUSINESSEXECUTIVE: 'SENIOR BUSINESS EXECUTIVE',
  ADMIN: 'ADMINISTRATOR',
  ADMINISTRATOR: 'ADMINISTRATOR',
  SUPERADMIN: 'SUPER ADMIN',
};

/**
 * The board label for one person: the role code first, then the role
 * name, then the designation; anything unknown renders uppercased
 * as-is rather than inventing a label.
 */
export function organogramRoleLabel(
  roleId: string,
  roleName: string,
  designation: string,
): string {
  for (const candidate of [roleId, roleName, designation]) {
    const hit = ROLE_LABELS[normalizeKey(candidate)];
    if (hit) return hit;
  }
  const raw = String(roleName || designation || '').trim();
  return raw ? raw.toUpperCase() : 'EMPLOYEE';
}

/** "Arif Hossain" → "AH"; "Sabbir" → "S"; "" → "?". */
export function personInitials(name: string): string {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function formatPeopleCount(n: number): string {
  return n === 1 ? '1 person' : `${n} people`;
}

export function formatTeamCount(n: number): string {
  return n === 1 ? '1 team' : `${n} teams`;
}

type ChildrenMap = Map<string, OrganogramBoardNodeInput[]>;

function buildChildren(nodes: OrganogramBoardNodeInput[]): ChildrenMap {
  const children: ChildrenMap = new Map();
  for (const node of nodes) {
    if (!node.managerEmployeeId) continue;
    const list = children.get(node.managerEmployeeId) ?? [];
    list.push(node);
    children.set(node.managerEmployeeId, list);
  }
  return children;
}

/** Every descendant of one person (cycle-safe: a corrupt manager
 *  link can never loop forever). */
function descendantsOf(
  employeeId: string,
  children: ChildrenMap,
): OrganogramBoardNodeInput[] {
  const out: OrganogramBoardNodeInput[] = [];
  const seen = new Set<string>([employeeId]);
  const stack = [...(children.get(employeeId) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (seen.has(next.employeeId)) continue;
    seen.add(next.employeeId);
    out.push(next);
    stack.push(...(children.get(next.employeeId) ?? []));
  }
  return out;
}

/** Front-line teams below one person: descendants with at least one
 *  direct report, none of whose reports has reports of their own. */
function frontlineTeamsOf(employeeId: string, children: ChildrenMap): number {
  let teams = 0;
  for (const person of descendantsOf(employeeId, children)) {
    const reports = children.get(person.employeeId) ?? [];
    if (reports.length === 0) continue;
    const anyReportHasReports = reports.some(
      (r) => (children.get(r.employeeId) ?? []).length > 0,
    );
    if (!anyReportHasReports) teams += 1;
  }
  return teams;
}

/** Level order, then name; unknown levels (0) sort last. */
function byLevelThenName(
  a: OrganogramBoardNodeInput,
  b: OrganogramBoardNodeInput,
): number {
  const levelA = a.level > 0 ? a.level : 999;
  const levelB = b.level > 0 ? b.level : 999;
  if (levelA !== levelB) return levelA - levelB;
  return String(a.name || '').localeCompare(String(b.name || ''));
}

function toBoardPerson(
  node: OrganogramBoardNodeInput,
  children: ChildrenMap,
): BoardPerson {
  const roleLabel = organogramRoleLabel(node.roleId, node.roleName, node.designation);
  const reports = children.get(node.employeeId) ?? [];
  return {
    employeeId: node.employeeId,
    name: node.name,
    initials: personInitials(node.name),
    roleLabel,
    level: node.level,
    isCeo: roleLabel === 'CHIEF EXECUTIVE OFFICER',
    hasReports: reports.length > 0,
    downline: descendantsOf(node.employeeId, children).length,
    teams: frontlineTeamsOf(node.employeeId, children),
    isActive: node.isActive,
  };
}

export function buildOrganogramBoardView(
  nodes: OrganogramBoardNodeInput[],
  viewerEmployeeId: string,
): OrganogramBoardView {
  const emptyView: OrganogramBoardView = {
    chain: [],
    branch: [],
    leafRow: [],
    viewer: null,
    viewerDownline: 0,
    viewerTeams: 0,
    totalPeople: nodes.length,
    empty: nodes.length === 0,
    viewerInTree: false,
  };
  if (nodes.length === 0) return emptyView;

  const byId = new Map(nodes.map((n) => [n.employeeId, n]));
  const children = buildChildren(nodes);

  let viewer = viewerEmployeeId ? byId.get(viewerEmployeeId) : undefined;
  const viewerInTree = Boolean(viewer);
  if (!viewer) {
    // The viewer is not in the tree (an ADMIN viewer — the API
    // excludes ADMIN/SUPERADMIN rows): anchor at the first root.
    viewer = nodes.find((n) => !n.managerEmployeeId || !byId.has(n.managerEmployeeId));
    if (!viewer) return emptyView;
  }

  // The ancestor chain, root first — cycle-safe like the counts.
  const chainNodes: OrganogramBoardNodeInput[] = [];
  const seen = new Set<string>();
  let current: OrganogramBoardNodeInput | undefined = viewer;
  while (current && !seen.has(current.employeeId)) {
    seen.add(current.employeeId);
    chainNodes.unshift(current);
    current = current.managerEmployeeId
      ? byId.get(current.managerEmployeeId)
      : undefined;
  }

  const branchNodes = [...(children.get(viewer.employeeId) ?? [])].sort(byLevelThenName);
  const leafNodes = branchNodes.flatMap((p) =>
    [...(children.get(p.employeeId) ?? [])].sort(byLevelThenName),
  );

  const viewerPerson = toBoardPerson(viewer, children);
  return {
    chain: chainNodes.map((n) => toBoardPerson(n, children)),
    branch: branchNodes.map((n) => toBoardPerson(n, children)),
    leafRow: leafNodes.map((n) => toBoardPerson(n, children)),
    viewer: viewerPerson,
    viewerDownline: viewerPerson.downline,
    viewerTeams: viewerPerson.teams,
    totalPeople: nodes.length,
    empty: false,
    viewerInTree,
  };
}
