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

/**
 * Returns singleton PostgreSQL connection pool.
 * Supports pglite://memory for isolated test databases (test-only, no prod impact).
 */
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
        // For pglite:// URLs, we expect test setup to have called _setTestPoolForTest
        // with a pre-created PGlite pool. If not, throw helpful error.
        if (!pglitePool) {
            throw new Error("PGlite pool not initialized. Call _setTestPoolForTest() in tests or set up PGlite instance.");
        }
        return pglitePool as unknown as Pool;
    }

    // Allow local/dev databases without SSL via ?sslmode=disable or PGSSL=disable;
    // hosted providers (Neon/Supabase/Render) keep the default relaxed SSL.
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
        // Also reset singleton
        try {
            const { resetPGlite } = await import("./pglitePool.js");
            (resetPGlite as any)();
        } catch {}
    }
}

/**
 * Test-only: Reset pools (for isolated tests)
 */
export function _resetPoolsForTest(): void {
    pool = null;
    pglitePool = null;
}

/**
 * Test-only: Inject a PGlite pool for isolated tests.
 * This does NOT affect production behavior when DATABASE_URL is a real postgres URL.
 */
export function _setTestPoolForTest(testPool: any): void {
    pglitePool = testPool;
}
