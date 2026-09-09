import { query } from "../connection";

/**
 * Seeds the default system form-field configuration (only when the
 * form_fields table is empty). Mirrors the fields the Lead Generate
 * form has always shipped with, marked is_system so admins cannot
 * delete them - only their mandatory/visible/order can be changed.
 */
const DEFAULT_FIELDS: Array<{
  key: string;
  label: string;
  type: string;
  section: string;
  mandatory: boolean;
  metadataType?: string;
  order: number;
}> = [
  { key: "prospectName", label: "Prospect Name", type: "text", section: "Identity", mandatory: true, order: 1 },
  { key: "mobile", label: "Mobile Number", type: "text", section: "Identity", mandatory: true, order: 2 },
  { key: "profession", label: "Profession", type: "dropdown", section: "Identity", mandatory: true, metadataType: "Profession", order: 3 },
  { key: "occupation", label: "Occupation", type: "dropdown", section: "Identity", mandatory: false, metadataType: "Occupation", order: 4 },
  { key: "priority", label: "Priority", type: "dropdown", section: "Identity", mandatory: false, metadataType: "Priority", order: 5 },
  { key: "maritalStatus", label: "Marital Status", type: "dropdown", section: "Identity", mandatory: true, metadataType: "MaritalStatus", order: 6 },
  { key: "noOfChildren", label: "Number of Children", type: "text", section: "Identity", mandatory: false, order: 7 },
  { key: "familyMember", label: "Family Members", type: "text", section: "Identity", mandatory: false, order: 8 },
  { key: "division", label: "Division", type: "dropdown", section: "Location", mandatory: true, order: 1 },
  { key: "district", label: "District", type: "dropdown", section: "Location", mandatory: true, order: 2 },
  { key: "thana", label: "Thana / Upazila", type: "dropdown", section: "Location", mandatory: true, order: 3 },
  { key: "residenceAddress", label: "Residence Address", type: "textarea", section: "Location", mandatory: false, order: 4 },
  { key: "officeAddress", label: "Office Address", type: "textarea", section: "Location", mandatory: false, order: 5 },
  { key: "source", label: "Lead Source", type: "dropdown", section: "Business", mandatory: true, metadataType: "Source", order: 1 },
  { key: "productName", label: "Product", type: "dropdown", section: "Business", mandatory: true, metadataType: "Product", order: 2 },
  { key: "campaignName", label: "Campaign", type: "dropdown", section: "Business", mandatory: true, metadataType: "Campaign", order: 3 },
  { key: "otherInfo", label: "Other Information", type: "textarea", section: "Business", mandatory: false, order: 4 },
];

export async function seedFormBuilder(): Promise<void> {
  const result = await query<{ count: number }>("SELECT COUNT(*)::int AS count FROM form_fields");
  const count = result.rows[0]?.count ?? 0;
  if (count > 0) {
    console.log(`ℹ️ Form fields already present (${count}). Skipping seed.`);
    return;
  }

  for (const field of DEFAULT_FIELDS) {
    await query(
      `INSERT INTO form_fields
         (field_key, label, field_type, section, is_mandatory, is_visible, sort_order,
          metadata_type_key, placeholder, is_system, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7, NULL, TRUE, NOW(), NOW())
       ON CONFLICT (field_key) DO NOTHING`,
      [field.key, field.label, field.type, field.section, field.mandatory, field.order, field.metadataType || null]
    );
  }
  console.log(`✅ Form Builder seed completed (${DEFAULT_FIELDS.length} system fields).`);
}
