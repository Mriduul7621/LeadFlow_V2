import { randomUUID } from "node:crypto";
import { query } from "../connection.js";

/**
 * Seeds default workflow rules (only when the table is empty).
 * Defaults are deliberately permissive: only the two requirement rules
 * that encode long-standing informal business rules (Loss Reason when a
 * lead is lost, Meeting Type when a meeting is fixed).
 */
const DEFAULT_RULES: Array<{
  status: string;
  requiresLossReason?: boolean;
  requiresMeetingType?: boolean;
}> = [
  { status: "Not Interested", requiresLossReason: true },
  { status: "Meeting Fixed", requiresMeetingType: true },
];

export async function seedWorkflow(): Promise<void> {
  const result = await query<{ count: number }>("SELECT COUNT(*)::int AS count FROM workflow_rules");
  const count = result.rows[0]?.count ?? 0;
  if (count > 0) {
    console.log(`ℹ️ Workflow rules already present (${count}). Skipping seed.`);
    return;
  }

  for (const rule of DEFAULT_RULES) {
    await query(
      `INSERT INTO workflow_rules
         (id, status, allowed_next_statuses, requires_loss_reason, requires_meeting_type,
          requires_followup_type, requires_note, is_system, created_at, updated_at)
       VALUES ($1, $2, NULL, $3, $4, FALSE, FALSE, TRUE, NOW(), NOW())
       ON CONFLICT (status) DO NOTHING`,
      // id supplied from app code: the legacy bootstrap shape of
      // workflow_rules (id VARCHAR PRIMARY KEY) has no DB default.
      [randomUUID(), rule.status, !!rule.requiresLossReason, !!rule.requiresMeetingType]
    );
  }
  console.log(`✅ Workflow seed completed (${DEFAULT_RULES.length} default rules).`);
}
