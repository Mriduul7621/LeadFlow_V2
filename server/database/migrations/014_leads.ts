import { query } from "../connection.js";

export async function up(): Promise<void> {

    await query(`

        CREATE TABLE IF NOT EXISTS leads (

            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

            lead_code VARCHAR(50) UNIQUE,

            /* =========================
               CUSTOMER INFORMATION
            ========================== */

            customer_name VARCHAR(255) NOT NULL,

            mobile VARCHAR(30) NOT NULL,

            alternate_mobile VARCHAR(30),

            email VARCHAR(255),

            date_of_birth DATE,

            gender VARCHAR(50),

            marital_status VARCHAR(50),

            occupation VARCHAR(150),

            education VARCHAR(150),

            monthly_income NUMERIC(14,2),

            /* =========================
               ADDRESS INFORMATION
            ========================== */

            address TEXT,

            area VARCHAR(150),

            district VARCHAR(100),

            division VARCHAR(100),

            postal_code VARCHAR(20),

            /* =========================
               LEAD INFORMATION
            ========================== */

            source VARCHAR(100),

            priority VARCHAR(30) NOT NULL DEFAULT 'NORMAL',

            product_id UUID,

            campaign_id UUID,

            status_id UUID,

            /* =========================
               BUSINESS INFORMATION
            ========================== */

            expected_premium NUMERIC(14,2),

            expected_value NUMERIC(14,2),

            policy_term INTEGER,

            notes TEXT,

            /* =========================
               ASSIGNMENT
            ========================== */

            assigned_to UUID,

            assigned_by UUID,

            assigned_at TIMESTAMP,

            previous_assigned_to UUID,

            /* =========================
               FOLLOW-UP
            ========================== */

            last_contacted_at TIMESTAMP,

            next_follow_up_at TIMESTAMP,

            next_action VARCHAR(255),

            follow_up_count INTEGER NOT NULL DEFAULT 0,

            /* =========================
               CONVERSION
            ========================== */

            converted_at TIMESTAMP,

            lost_at TIMESTAMP,

            lost_reason TEXT,

            /* =========================
               DYNAMIC DATA
            ========================== */

            custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,

            tags JSONB NOT NULL DEFAULT '[]'::jsonb,

            /* =========================
               AUDIT INFORMATION
            ========================== */

            created_by UUID,

            updated_by UUID,

            created_at TIMESTAMP NOT NULL DEFAULT NOW(),

            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),

            /* =========================
               SOFT DELETE
            ========================== */

            is_deleted BOOLEAN NOT NULL DEFAULT FALSE,

            deleted_at TIMESTAMP,

            deleted_by UUID,

            /* =========================
               FOREIGN KEYS
            ========================== */

            CONSTRAINT fk_lead_product
                FOREIGN KEY (product_id)
                REFERENCES products(id)
                ON DELETE SET NULL,

            CONSTRAINT fk_lead_campaign
                FOREIGN KEY (campaign_id)
                REFERENCES campaigns(id)
                ON DELETE SET NULL,

            CONSTRAINT fk_lead_status
                FOREIGN KEY (status_id)
                REFERENCES lead_status(id)
                ON DELETE SET NULL,

            CONSTRAINT fk_lead_assigned_to
                FOREIGN KEY (assigned_to)
                REFERENCES users(id)
                ON DELETE SET NULL,

            CONSTRAINT fk_lead_assigned_by
                FOREIGN KEY (assigned_by)
                REFERENCES users(id)
                ON DELETE SET NULL,

            CONSTRAINT fk_lead_previous_assigned_to
                FOREIGN KEY (previous_assigned_to)
                REFERENCES users(id)
                ON DELETE SET NULL,

            CONSTRAINT fk_lead_created_by
                FOREIGN KEY (created_by)
                REFERENCES users(id)
                ON DELETE SET NULL,

            CONSTRAINT fk_lead_updated_by
                FOREIGN KEY (updated_by)
                REFERENCES users(id)
                ON DELETE SET NULL,

            CONSTRAINT fk_lead_deleted_by
                FOREIGN KEY (deleted_by)
                REFERENCES users(id)
                ON DELETE SET NULL,

            CONSTRAINT chk_lead_follow_up_count
                CHECK (follow_up_count >= 0),

            CONSTRAINT chk_lead_policy_term
                CHECK (policy_term IS NULL OR policy_term > 0),

            CONSTRAINT chk_lead_expected_premium
                CHECK (
                    expected_premium IS NULL
                    OR expected_premium >= 0
                ),

            CONSTRAINT chk_lead_expected_value
                CHECK (
                    expected_value IS NULL
                    OR expected_value >= 0
                )

        );

    `);

    /* =========================
       CORE INDEXES
    ========================== */

    await query(`
        CREATE INDEX IF NOT EXISTS idx_leads_code
        ON leads(lead_code);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_leads_mobile
        ON leads(mobile);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_leads_email
        ON leads(email);
    `);

    /* =========================
       RELATION INDEXES
    ========================== */

    await query(`
        CREATE INDEX IF NOT EXISTS idx_leads_product
        ON leads(product_id);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_leads_campaign
        ON leads(campaign_id);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_leads_status
        ON leads(status_id);
    `);

    /* =========================
       ASSIGNMENT INDEXES
    ========================== */

    await query(`
        CREATE INDEX IF NOT EXISTS idx_leads_assigned_to
        ON leads(assigned_to);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_leads_assigned_by
        ON leads(assigned_by);
    `);

    /* =========================
       BUSINESS INDEXES
    ========================== */

    await query(`
        CREATE INDEX IF NOT EXISTS idx_leads_source
        ON leads(source);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_leads_priority
        ON leads(priority);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_leads_district
        ON leads(district);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_leads_division
        ON leads(division);
    `);

    /* =========================
       FOLLOW-UP INDEXES
    ========================== */

    await query(`
        CREATE INDEX IF NOT EXISTS idx_leads_next_follow_up
        ON leads(next_follow_up_at);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_leads_last_contacted
        ON leads(last_contacted_at);
    `);

    /* =========================
       AUDIT INDEXES
    ========================== */

    await query(`
        CREATE INDEX IF NOT EXISTS idx_leads_created_by
        ON leads(created_by);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_leads_created_at
        ON leads(created_at DESC);
    `);

    /* =========================
       SOFT DELETE INDEX
    ========================== */

    await query(`
        CREATE INDEX IF NOT EXISTS idx_leads_deleted
        ON leads(is_deleted);
    `);

    /* =========================
       COMMON DASHBOARD QUERY
    ========================== */

    await query(`
        CREATE INDEX IF NOT EXISTS idx_leads_assignment_status
        ON leads(assigned_to, status_id)
        WHERE is_deleted = FALSE;
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_leads_followup_active
        ON leads(next_follow_up_at)
        WHERE is_deleted = FALSE;
    `);

    /* =========================
       JSON SEARCH
    ========================== */

    await query(`
        CREATE INDEX IF NOT EXISTS idx_leads_custom_fields
        ON leads
        USING GIN(custom_fields);
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_leads_tags
        ON leads
        USING GIN(tags);
    `);

}


export async function down(): Promise<void> {

    await query(`
        DROP TABLE IF EXISTS leads CASCADE;
    `);

}