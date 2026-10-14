import { Pool, QueryResult, QueryResultRow } from "pg";

import { instrumentPoolForObservability } from "../observability/dbTiming.js";
import { getRequestContext, nowMs } from "../observability/context.js";

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
        // Idempotent per-request DB timing hook (no SQL/params; see
        // observability/dbTiming.ts and docs/PRODUCTION_OBSERVABILITY.md).
        instrumentPoolForObservability(pool);
        return pool;
    }
    if (pglitePool) {
        instrumentPoolForObservability(pglitePool);
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
        instrumentPoolForObservability(pglitePool);
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

    // Measure pool checkout wait separately from query duration. pg Pool.query()
    // obtains a client through connect(), so this reveals queue/connection waits
    // that otherwise look like slow SQL. Never log SQL, parameters, or credentials.
    const originalConnect = pool.connect.bind(pool);
    (pool as any).connect = function instrumentedConnect(...args: any[]): any {
        const startedAt = nowMs();
        const finish = () => {
            const ctx = getRequestContext();
            if (!ctx) return;
            ctx.dbAcquireDurationMs += Math.max(0, nowMs() - startedAt);
            ctx.dbPoolWaitingCount = Math.max(ctx.dbPoolWaitingCount, Number((pool as any).waitingCount) || 0);
        };
        const last = args[args.length - 1];
        if (typeof last === "function") {
            args[args.length - 1] = (...callbackArgs: any[]) => {
                finish();
                last(...callbackArgs);
            };
            return originalConnect(...args);
        }
        try {
            return Promise.resolve(originalConnect(...args)).then(
                (client) => { finish(); return client; },
                (error) => { finish(); throw error; }
            );
        } catch (error) {
            finish();
            throw error;
        }
    };

    pool.on("connect", () => {
        console.log("✅ PostgreSQL Client Connected");
    });

    pool.on("error", (err) => {
        console.error("❌ PostgreSQL Pool Error");
        console.error(err);
    });

    console.log("🚀 PostgreSQL Connection Pool Initialized");

    instrumentPoolForObservability(pool);

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
