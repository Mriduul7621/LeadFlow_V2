import BaseRepository from "./BaseRepository";
import { query } from "../connection";

export interface RoleRecord {

    id: string;

    role_code: string;

    role_name: string;

    description: string | null;

    hierarchy_level: number;

    is_active: boolean;

    created_at: Date;

    updated_at: Date;

}

class RoleRepository extends BaseRepository<RoleRecord> {

    constructor() {

        super("roles");

    }

    async findByCode(
        roleCode: string
    ): Promise<RoleRecord | null> {

        const result = await query<RoleRecord>(
            `
            SELECT *
            FROM roles
            WHERE role_code = $1
            LIMIT 1
            `,
            [roleCode]
        );

        return result.rows[0] ?? null;

    }

    async create(
        data: Partial<RoleRecord>
    ): Promise<RoleRecord> {

        const result = await query<RoleRecord>(
            `
            INSERT INTO roles
            (
                role_code,
                role_name,
                description,
                hierarchy_level,
                is_active
            )
            VALUES
            (
                $1,$2,$3,$4,$5
            )
            RETURNING *
            `,
            [
                data.role_code,
                data.role_name,
                data.description ?? null,
                data.hierarchy_level ?? 1,
                data.is_active ?? true
            ]
        );

        return result.rows[0];

    }

    async update(
        id: string,
        data: Partial<RoleRecord>
    ): Promise<RoleRecord | null> {

        const result = await query<RoleRecord>(
            `
            UPDATE roles
            SET
                role_code = $1,
                role_name = $2,
                description = $3,
                hierarchy_level = $4,
                is_active = $5,
                updated_at = NOW()
            WHERE id = $6
            RETURNING *
            `,
            [
                data.role_code,
                data.role_name,
                data.description ?? null,
                data.hierarchy_level,
                data.is_active,
                id
            ]
        );

        return result.rows[0] ?? null;

    }

}

export default new RoleRepository();