import { apiRequest } from '../../shared/api/http';
import { coalesceGet } from '../../shared/api/coalesce';

/**
 * teamTreeService.ts — one reader for GET /api/team/tree
 * (role-dashboard redesign, Phase 1, 2026-11-17).
 * ------------------------------------------------------------------
 * The member home needs the caller's own tree row (converted-this-
 * month, from converted_at) and the manager home needs the tree
 * roots with their subtree rollups (pipeline value, team
 * comparison). Both read the same endpoint the /team page reads;
 * concurrent identical reads share one round-trip (PR #29
 * coalescing). The tree is operational data, never reference data:
 * it is NOT session-cached (same rule as the dashboard and the
 * follow-up queue).
 *
 * The shape below is the structural subset the homes need; the
 * server returns the full TeamPerson rows (see TeamOverview.tsx).
 */

export interface WorkspaceTreePerson {
  userId: string;
  employeeId: string;
  name: string;
  designation: string | null;
  roleName: string | null;
  department: string | null;
  managerEmployeeId: string | null;
  tier: 'manager' | 'teamLead' | 'teamMember';
  directReports: number;
  openLeads: number;
  convertedLeads: number;
  dueToday: number;
  isSelf: boolean;
  childrenIds: string[];
  overdue: number;
  convertedThisMonth: number;
  pipelineValue: number;
  subtree: {
    people: number;
    openLeads: number;
    dueToday: number;
    overdue: number;
    converted: number;
    convertedThisMonth: number;
    pipelineValue: number;
  };
  subtreeStatusCounts: Record<string, number>;
}

export interface TeamTreeResult {
  success: boolean;
  scope: string;
  people: WorkspaceTreePerson[];
  rootIds: string[];
}

export async function loadTeamTree(): Promise<TeamTreeResult> {
  const data = await coalesceGet('/api/team/tree', () => apiRequest<TeamTreeResult>('/api/team/tree'));
  return {
    success: data?.success ?? false,
    scope: data?.scope ?? '',
    people: Array.isArray(data?.people) ? data.people : [],
    rootIds: Array.isArray(data?.rootIds) ? data.rootIds : [],
  };
}

/** The caller's own row in a tree payload, if they are in it. */
export function selfTreeRow(tree: TeamTreeResult | null): WorkspaceTreePerson | null {
  if (!tree) return null;
  return tree.people.find(p => p.isSelf) ?? null;
}

/** The tree roots (the caller's visible top-level people), in payload order. */
export function treeRoots(tree: TeamTreeResult | null): WorkspaceTreePerson[] {
  if (!tree) return [];
  const byId = new Map(tree.people.map(p => [p.userId, p]));
  return tree.rootIds
    .map(id => byId.get(id))
    .filter((p): p is WorkspaceTreePerson => Boolean(p));
}

/** Whole-visible-set pipeline value: the roots' subtree rollups summed. */
export function totalPipelineValue(tree: TeamTreeResult | null): number {
  return treeRoots(tree).reduce((sum, root) => sum + (Number(root.subtree?.pipelineValue) || 0), 0);
}
