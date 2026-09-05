import { query } from "../connection";

export interface HierarchyRecord {
    id: string;
    user_id: string;
    manager_id: string | null;
    level: number;
    path: string | null;
    created_at: Date;
    updated_at: Date;
}

class HierarchyRepository {

    async getAll(): Promise<HierarchyRecord[]> {

        const result = await query<HierarchyRecord>(
            `
            SELECT *
            FROM hierarchies
            ORDER BY level ASC
            `
        );

        return result.rows;
    }

    async findByUser(userId: string): Promise<HierarchyRecord | null> {

        const result = await query<HierarchyRecord>(
            `
            SELECT *
            FROM hierarchies
            WHERE user_id = $1
            LIMIT 1
            `,
            [userId]
        );

        return result.rows[0] ?? null;
    }

    async findChildren(managerId: string): Promise<HierarchyRecord[]> {

        const result = await query<HierarchyRecord>(
            `
            SELECT *
            FROM hierarchies
            WHERE manager_id = $1
            ORDER BY level ASC
            `,
            [managerId]
        );

        return result.rows;
    }

    async create(data: Partial<HierarchyRecord>): Promise<HierarchyRecord> {

        const result = await query<HierarchyRecord>(
            `
            INSERT INTO hierarchies
            (
                user_id,
                manager_id,
                level,
                path
            )
            VALUES
            (
                $1,$2,$3,$4
            )
            RETURNING *
            `,
            [
                data.user_id,
                data.manager_id,
                data.level,
                data.path
            ]
        );

        return result.rows[0];
    }

    async update(
        id: string,
        data: Partial<HierarchyRecord>
    ): Promise<HierarchyRecord | null> {

        const result = await query<HierarchyRecord>(
            `
            UPDATE hierarchies
            SET
                manager_id = $1,
                level = $2,
                path = $3,
                updated_at = NOW()
            WHERE id = $4
            RETURNING *
            `,
            [
                data.manager_id,
                data.level,
                data.path,
                id
            ]
        );

        return result.rows[0] ?? null;
    }

    async delete(id: string): Promise<void> {

        await query(
            `
            DELETE FROM hierarchies
            WHERE id = $1
            `,
            [id]
        );

    }

}

export default new HierarchyRepository();