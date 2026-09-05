import { Pool, QueryResult, QueryResultRow } from "pg";

let pool: Pool | null = null;

export function isDatabaseConfigured(): boolean {
    return Boolean(process.env.DATABASE_URL);
}

/**
 * Returns singleton PostgreSQL connection pool.
 */
export function getPool(): Pool {

    if (pool) {
        return pool;
    }

    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
        throw new Error("DATABASE_URL environment variable is missing.");
    }

    pool = new Pool({
        connectionString,

        ssl: {
            rejectUnauthorized: false,
        },

        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        allowExitOnIdle: false,
    });

    pool.on("connect", () => {
        console.log("✅ PostgreSQL Client Connected");
    });

    pool.on("error", (err) => {
        console.error("❌ PostgreSQL Pool Error");
        console.error(err);
    });

    console.log("🚀 PostgreSQL Connection Pool Initialized");

    return pool;
}

/**
 * Execute SQL Query
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: any[] = []
): Promise<QueryResult<T>> {

    const db = getPool();

    return db.query<T>(sql, params);

}

/**
 * Database Health Check
 */
export async function checkDatabaseHealth(): Promise<boolean> {

    try {

        await query("SELECT 1");

        return true;

    } catch (error) {

        console.error("❌ Database Health Check Failed");
        console.error(error);

        return false;

    }

}

/**
 * Gracefully Close Pool
 */
export async function closePool(): Promise<void> {

    if (!pool) {
        return;
    }

    try {

        await pool.end();

        console.log("✅ PostgreSQL Pool Closed");

        pool = null;

    } catch (error) {

        console.error("❌ Failed to close PostgreSQL Pool");
        console.error(error);

    }

}