import { query } from "../connection";

/**
 * Seeds the metadata engine defaults (era-B `metadata_types` + `options`
 * tables) only when they are empty, mirroring the defaults the UI has
 * always shipped with. Existing rows are never touched.
 *
 * NOTE: type keys use the exact case the UI queries at runtime
 * (FollowUpStatus, Profession, Occupation, Source, Product, Campaign,
 * MeetingType, LossReason, FollowUpType, Priority, MaritalStatus, Area).
 */

interface DefaultOption {
  type: string; // stored in options.field_key
  value: string; // stored in options.option_value
  label?: string; // stored in options.option_label
  meta?: Record<string, unknown>;
}

const DEFAULT_TYPES: Array<{ key: string; label: string; description: string; isSystem: boolean }> = [
  { key: "Profession", label: "Profession", description: "Prospect profession list", isSystem: false },
  { key: "Occupation", label: "Occupation", description: "Prospect occupation list", isSystem: false },
  { key: "Source", label: "Lead Source", description: "Where the lead originated from", isSystem: false },
  { key: "Campaign", label: "Campaign", description: "Marketing / acquisition campaigns", isSystem: false },
  { key: "Product", label: "Product", description: "Insurance / financial products sold", isSystem: false },
  { key: "FollowUpStatus", label: "Lead Status", description: "Pipeline stages a lead moves through", isSystem: true },
  { key: "MeetingType", label: "Meeting Type", description: "Type of client meeting", isSystem: false },
  { key: "LossReason", label: "Loss Reason", description: "Why a lead was marked as lost / not interested", isSystem: false },
  { key: "FollowUpType", label: "Follow-up Type", description: "Call / SMS / Visit / Email etc.", isSystem: false },
  { key: "Priority", label: "Priority", description: "Lead priority level", isSystem: false },
  { key: "Area", label: "Area", description: "Geographic area list", isSystem: false },
  { key: "MaritalStatus", label: "Marital Status", description: "Prospect marital status", isSystem: false },
];

const DEFAULT_OPTIONS: DefaultOption[] = [
  // Lead status pipeline (must stay ordered - kanban columns rely on it)
  { type: "FollowUpStatus", value: "Untouched", meta: { color: "slate", isWon: false, isLost: false, isTerminal: false } },
  { type: "FollowUpStatus", value: "Contacted", meta: { color: "blue", isWon: false, isLost: false, isTerminal: false } },
  { type: "FollowUpStatus", value: "No Response", meta: { color: "amber", isWon: false, isLost: false, isTerminal: false } },
  { type: "FollowUpStatus", value: "Busy", meta: { color: "orange", isWon: false, isLost: false, isTerminal: false } },
  { type: "FollowUpStatus", value: "Interested", meta: { color: "teal", isWon: false, isLost: false, isTerminal: false } },
  { type: "FollowUpStatus", value: "Follow-up Set", meta: { color: "indigo", isWon: false, isLost: false, isTerminal: false } },
  { type: "FollowUpStatus", value: "Meeting Fixed", meta: { color: "purple", isWon: false, isLost: false, isTerminal: false } },
  { type: "FollowUpStatus", value: "Meeting Completed", meta: { color: "violet", isWon: false, isLost: false, isTerminal: false } },
  { type: "FollowUpStatus", value: "Pipeline Locked", meta: { color: "yellow", isWon: false, isLost: false, isTerminal: false } },
  { type: "FollowUpStatus", value: "Converted", meta: { color: "green", isWon: true, isLost: false, isTerminal: true } },
  { type: "FollowUpStatus", value: "Not Interested", meta: { color: "red", isWon: false, isLost: true, isTerminal: true } },

  { type: "Profession", value: "Service Holder" },
  { type: "Profession", value: "Businessman" },
  { type: "Profession", value: "Doctor" },
  { type: "Profession", value: "Engineer" },
  { type: "Profession", value: "Teacher" },
  { type: "Profession", value: "Housewife" },
  { type: "Profession", value: "Student" },
  { type: "Profession", value: "Farmer" },
  { type: "Profession", value: "Banker" },
  { type: "Profession", value: "Other" },

  { type: "Occupation", value: "Service Holder" },
  { type: "Occupation", value: "Businessman" },
  { type: "Occupation", value: "Doctor" },
  { type: "Occupation", value: "Engineer" },
  { type: "Occupation", value: "Teacher" },
  { type: "Occupation", value: "Housewife" },
  { type: "Occupation", value: "Student" },
  { type: "Occupation", value: "Other" },

  { type: "Source", value: "Facebook" },
  { type: "Source", value: "Referral" },
  { type: "Source", value: "Cold Call" },
  { type: "Source", value: "Walk-in" },
  { type: "Source", value: "Campaign" },
  { type: "Source", value: "Database" },
  { type: "Source", value: "Other" },

  { type: "Priority", value: "NORMAL", label: "Normal" },
  { type: "Priority", value: "HIGH", label: "High" },
  { type: "Priority", value: "URGENT", label: "Urgent" },

  { type: "MaritalStatus", value: "Single" },
  { type: "MaritalStatus", value: "Married" },
  { type: "MaritalStatus", value: "Divorced" },
  { type: "MaritalStatus", value: "Widowed" },

  { type: "Area", value: "Urban" },
  { type: "Area", value: "Semi-Urban" },
  { type: "Area", value: "Rural" },

  { type: "MeetingType", value: "Home Visit" },
  { type: "MeetingType", value: "Office Visit" },
  { type: "MeetingType", value: "Video Call" },
  { type: "MeetingType", value: "Phone Call" },
  { type: "MeetingType", value: "Café Meeting" },

  { type: "LossReason", value: "High Premium" },
  { type: "LossReason", value: "Already Insured" },
  { type: "LossReason", value: "Not Interested" },
  { type: "LossReason", value: "No Response" },
  { type: "LossReason", value: "Family Objection" },
  { type: "LossReason", value: "Other" },

  { type: "FollowUpType", value: "Call" },
  { type: "FollowUpType", value: "SMS" },
  { type: "FollowUpType", value: "Email" },
  { type: "FollowUpType", value: "Visit" },
];

export async function seedMetadata(): Promise<void> {
  const typeCount = await query<{ count: number }>("SELECT COUNT(*)::int AS count FROM metadata_types");
  const optionCount = await query<{ count: number }>("SELECT COUNT(*)::int AS count FROM options");

  if ((typeCount.rows[0]?.count ?? 0) === 0) {
    for (let i = 0; i < DEFAULT_TYPES.length; i++) {
      const type = DEFAULT_TYPES[i];
      await query(
        `INSERT INTO metadata_types (key, label, description, is_system, sort_order, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (key) DO NOTHING`,
        [type.key, type.label, type.description, type.isSystem, i + 1]
      );
    }
    console.log(`🌱 Metadata types seed completed (${DEFAULT_TYPES.length} types).`);
  } else {
    console.log(`ℹ️ Metadata types already present. Skipping type seed.`);
  }

  if ((optionCount.rows[0]?.count ?? 0) === 0) {
    for (let i = 0; i < DEFAULT_OPTIONS.length; i++) {
      const option = DEFAULT_OPTIONS[i];
      await query(
        `INSERT INTO options (field_key, option_value, option_label, sort_order, is_default, is_active, meta, created_at, updated_at)
         VALUES ($1, $2, COALESCE($3, $2), $4, FALSE, TRUE, COALESCE($5::jsonb, '{}'::jsonb), NOW(), NOW())
         ON CONFLICT (field_key, option_value) DO NOTHING`,
        [option.type, option.value, option.label || null, i + 1, JSON.stringify(option.meta || {})]
      );
    }
    console.log(`🌱 Options seed completed (${DEFAULT_OPTIONS.length} options).`);
  } else {
    console.log(`ℹ️ Options already present. Skipping options seed.`);
  }
}
