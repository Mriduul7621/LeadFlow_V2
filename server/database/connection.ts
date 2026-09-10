import { Pool, QueryResult, QueryResultRow } from "pg";

let pool: Pool | null = null;
let pglitePool: any = null;

export function isDatabaseConfigured(): boolean {
    return Boolean(process.env.DATABASE_URL);
}

function isPGliteUrl(url: string | undefined): boolean {
    if (!url) return false;
    return url.startsWith("pglite://");
}

export function getPool(): Pool {
    if (pool) {
        return pool;
    }
    if (pglitePool) {
        return pglitePool as unknown as Pool;
    }

    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
        throw new Error("DATABASE_URL environment variable is missing.");
    }

    if (isPGliteUrl(connectionString)) {
        if (!pglitePool) {
            throw new Error("PGlite pool not initialized. Call _setTestPoolForTest() in tests.");
        }
        return pglitePool as unknown as Pool;
    }

    const sslDisabled =
        /[?&]sslmode=disable\b/i.test(connectionString) ||
        String(process.env.PGSSL || "").toLowerCase() === "disable";

    pool = new Pool({
        connectionString,
        ssl: sslDisabled ? false : { rejectUnauthorized: false },
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

export async function query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: any[] = []
): Promise<QueryResult<T>> {
    const db = getPool();
    return db.query<T>(sql, params);
}

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

export async function closePool(): Promise<void> {
    if (pool) {
        try {
            await pool.end();
            console.log("✅ PostgreSQL Pool Closed");
            pool = null;
        } catch (error) {
            console.error("❌ Failed to close PostgreSQL Pool");
            console.error(error);
        }
        return;
    }

    if (pglitePool) {
        try {
            await pglitePool.end();
            console.log("✅ PGlite Pool Closed");
        } catch (error) {
            console.error("❌ Failed to close PGlite Pool");
            console.error(error);
        }
        pglitePool = null;
    }
}

export function _resetPoolsForTest(): void {
    pool = null;
    pglitePool = null;
}

export function _setTestPoolForTest(testPool: any): void {
    pglitePool = testPool;
}
