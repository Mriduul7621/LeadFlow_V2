import BaseRepository from "./BaseRepository.js";
import { query } from "../connection.js";

export interface TeamRecord {

    id: string;

    team_code: string;

    team_name: string;

    department_id: string;

    description: string | null;

    is_active: boolean;

    created_at: Date;

    updated_at: Date;

}

class TeamRepository extends BaseRepository<TeamRecord> {

    constructor() {

        super("teams");

    }

    async findByCode(
        teamCode: string
    ): Promise<TeamRecord | null> {

        const result = await query<TeamRecord>(
            `
            SELECT *
            FROM teams
            WHERE team_code = $1
            LIMIT 1
            `,
            [teamCode]
        );

        return result.rows[0] ?? null;

    }

    async findByDepartment(
        departmentId: string
    ): Promise<TeamRecord[]> {

        const result = await query<TeamRecord>(
            `
            SELECT *
            FROM teams
            WHERE department_id = $1
            ORDER BY team_name
            `,
            [departmentId]
        );

        return result.rows;

    }

    async create(
        data: Partial<TeamRecord>
    ): Promise<TeamRecord> {

        const result = await query<TeamRecord>(
            `
            INSERT INTO teams
            (
                team_code,
                team_name,
                department_id,
                description,
                is_active
            )
            VALUES
            (
                $1,$2,$3,$4,$5
            )
            RETURNING *
            `,
            [
                data.team_code,
                data.team_name,
                data.department_id,
                data.description ?? null,
                data.is_active ?? true
            ]
        );

        return result.rows[0];

    }

    async update(
        id: string,
        data: Partial<TeamRecord>
    ): Promise<TeamRecord | null> {

        const result = await query<TeamRecord>(
            `
            UPDATE teams
            SET
                team_code = $1,
                team_name = $2,
                department_id = $3,
                description = $4,
                is_active = $5,
                updated_at = NOW()
            WHERE id = $6
            RETURNING *
            `,
            [
                data.team_code,
                data.team_name,
                data.department_id,
                data.description ?? null,
                data.is_active,
                id
            ]
        );

        return result.rows[0] ?? null;

    }

}

export default new TeamRepository();