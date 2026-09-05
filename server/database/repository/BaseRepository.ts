import { query } from "../connection";
import { QueryResultRow } from "pg";

export default abstract class BaseRepository<T extends QueryResultRow> {

    protected readonly tableName: string;

    constructor(tableName: string) {
        this.tableName = tableName;
    }

    async findAll(
        orderBy: string = "created_at DESC"
    ): Promise<T[]> {

        const result = await query<T>(
            `
            SELECT *
            FROM ${this.tableName}
            ORDER BY ${orderBy}
            `
        );

        return result.rows;
    }

    async findById(id: string): Promise<T | null> {

        const result = await query<T>(
            `
            SELECT *
            FROM ${this.tableName}
            WHERE id = $1
            LIMIT 1
            `,
            [id]
        );

        return result.rows[0] ?? null;
    }

    async delete(id: string): Promise<void> {

        await query(
            `
            DELETE FROM ${this.tableName}
            WHERE id = $1
            `,
            [id]
        );

    }

    async count(): Promise<number> {

        const result = await query<{ total: string }>(
            `
            SELECT COUNT(*) AS total
            FROM ${this.tableName}
            `
        );

        return Number(result.rows[0].total);

    }

    async exists(id: string): Promise<boolean> {

        const result = await query(
            `
            SELECT 1
            FROM ${this.tableName}
            WHERE id = $1
            LIMIT 1
            `,
            [id]
        );

        return result.rowCount > 0;

    }

}