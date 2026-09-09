import { query } from "../database/connection.js";

export interface AuditEvent {
    actorUserId?: string | null;
    targetUserId?: string | null;
    actionCode: string;
    entityType: string;
    entityId?: string | null;
    metadata?: Record<string, unknown>;
    ipAddress?: string | null;
    userAgent?: string | null;
}

class AuditService {

    async record(event: AuditEvent): Promise<void> {

        await query(
            `
            INSERT INTO audit_logs (
                actor_user_id,
                target_user_id,
                action_code,
                entity_type,
                entity_id,
                metadata,
                ip_address,
                user_agent
            )
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
            `,
            [
                event.actorUserId || null,
                event.targetUserId || null,
                event.actionCode,
                event.entityType,
                event.entityId || null,
                JSON.stringify(event.metadata || {}),
                event.ipAddress || null,
                event.userAgent || null,
            ]
        );

    }

}

export default new AuditService();
