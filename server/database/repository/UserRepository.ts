import BaseRepository from "./BaseRepository";
import { query } from "../connection";

export interface UserRecord {

    id: string;

    employee_id: string;

    full_name: string;

    email: string;

    phone: string | null;

    password: string;

    role_id: string;

    department_id: string | null;

    team_id: string | null;

    manager_id: string | null;

    designation: string | null;

    joining_date: Date | null;

    profile_photo: string | null;

    last_login: Date | null;

    is_active: boolean;

    created_at: Date;

    updated_at: Date;

}

export interface UserWithRole extends UserRecord {

    role_code: string;

    role_name: string;

    hierarchy_level: number;

}

class UserRepository extends BaseRepository<UserRecord> {

    constructor() {

        super("users");

    }

    async findById(id: string): Promise<UserWithRole | null> {

        const result = await query<UserWithRole>(
            `
            SELECT

                u.*,

                r.role_code,

                r.role_name,

                r.hierarchy_level

            FROM users u

            INNER JOIN roles r
                ON r.id = u.role_id

            WHERE u.id = $1

            LIMIT 1
            `,
            [id]
        );

        return result.rows[0] ?? null;

    }

    async findByEmployeeId(
        employeeId: string
    ): Promise<UserWithRole | null> {

        const result = await query<UserWithRole>(
            `
            SELECT

                u.*,

                r.role_code,

                r.role_name,

                r.hierarchy_level

            FROM users u

            INNER JOIN roles r
                ON r.id = u.role_id

            WHERE u.employee_id = $1

            LIMIT 1
            `,
            [employeeId]
        );

        return result.rows[0] ?? null;

    }

    async findByEmail(
        email: string
    ): Promise<UserWithRole | null> {

        const result = await query<UserWithRole>(
            `
            SELECT

                u.*,

                r.role_code,

                r.role_name,

                r.hierarchy_level

            FROM users u

            INNER JOIN roles r
                ON r.id = u.role_id

            WHERE u.email = $1

            LIMIT 1
            `,
            [email]
        );

        return result.rows[0] ?? null;

    }

    async getAll(): Promise<UserWithRole[]> {

        const result = await query<UserWithRole>(
            `
            SELECT

                u.*,

                r.role_code,

                r.role_name,

                r.hierarchy_level

            FROM users u

            INNER JOIN roles r
                ON r.id = u.role_id

            ORDER BY u.created_at DESC
            `
        );

        return result.rows;

    }

    async create(
        data: Partial<UserRecord>
    ): Promise<UserRecord> {

        const result = await query<UserRecord>(
            `
            INSERT INTO users
            (
                employee_id,
                full_name,
                email,
                phone,
                password,
                role_id,
                department_id,
                team_id,
                manager_id,
                designation,
                joining_date,
                profile_photo,
                is_active
            )
            VALUES
            (
                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
            )
            RETURNING *
            `,
            [
                data.employee_id,
                data.full_name,
                data.email,
                data.phone,
                data.password,
                data.role_id,
                data.department_id,
                data.team_id,
                data.manager_id,
                data.designation,
                data.joining_date,
                data.profile_photo,
                data.is_active ?? true
            ]
        );

        return result.rows[0];

    }

    async update(
        id: string,
        data: Partial<UserRecord>
    ): Promise<UserRecord | null> {

        const result = await query<UserRecord>(
            `
            UPDATE users
            SET

                full_name = $1,

                email = $2,

                phone = $3,

                role_id = $4,

                department_id = $5,

                team_id = $6,

                manager_id = $7,

                designation = $8,

                joining_date = $9,

                profile_photo = $10,

                is_active = $11,

                updated_at = NOW()

            WHERE id = $12

            RETURNING *
            `,
            [
                data.full_name,
                data.email,
                data.phone,
                data.role_id,
                data.department_id,
                data.team_id,
                data.manager_id,
                data.designation,
                data.joining_date,
                data.profile_photo,
                data.is_active,
                id
            ]
        );

        return result.rows[0] ?? null;

    }

    async updatePassword(
        id: string,
        password: string
    ): Promise<void> {

        await query(
            `
            UPDATE users

            SET

                password = $1,

                updated_at = NOW()

            WHERE id = $2
            `,
            [
                password,
                id
            ]
        );

    }

    async updateLastLogin(
        id: string
    ): Promise<void> {

        await query(
            `
            UPDATE users

            SET

                last_login = NOW()

            WHERE id = $1
            `,
            [id]
        );

    }

}

export default new UserRepository();