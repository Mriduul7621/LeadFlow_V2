import BaseRepository from "./BaseRepository.js";
import { query } from "../connection.js";

export interface DepartmentRecord {

    id: string;

    department_code: string;

    department_name: string;

    description: string | null;

    is_active: boolean;

    created_at: Date;

    updated_at: Date;

}

class DepartmentRepository extends BaseRepository<DepartmentRecord> {

    constructor() {

        super("departments");

    }

    async findByCode(
        departmentCode: string
    ): Promise<DepartmentRecord | null> {

        const result = await query<DepartmentRecord>(
            `
            SELECT *
            FROM departments
            WHERE department_code = $1
            LIMIT 1
            `,
            [departmentCode]
        );

        return result.rows[0] ?? null;

    }

    async create(
        data: Partial<DepartmentRecord>
    ): Promise<DepartmentRecord> {

        const result = await query<DepartmentRecord>(
            `
            INSERT INTO departments
            (
                department_code,
                department_name,
                description,
                is_active
            )
            VALUES
            (
                $1,$2,$3,$4
            )
            RETURNING *
            `,
            [
                data.department_code,
                data.department_name,
                data.description ?? null,
                data.is_active ?? true
            ]
        );

        return result.rows[0];

    }

    async update(
        id: string,
        data: Partial<DepartmentRecord>
    ): Promise<DepartmentRecord | null> {

        const result = await query<DepartmentRecord>(
            `
            UPDATE departments
            SET
                department_code = $1,
                department_name = $2,
                description = $3,
                is_active = $4,
                updated_at = NOW()
            WHERE id = $5
            RETURNING *
            `,
            [
                data.department_code,
                data.department_name,
                data.description ?? null,
                data.is_active,
                id
            ]
        );

        return result.rows[0] ?? null;

    }

}

export default new DepartmentRepository();