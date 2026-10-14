import { Pool, QueryResult, QueryResultRow } from "pg";

import { instrumentPoolForObservability } from "../observability/dbTiming.js";
import { getRequestContext, nowMs } from "../observability/context.js";

let pool: Pool | null = null;
let pglitePool: any = null;

/**
 * Connection-string precedence (first non-empty wins).
 *
 * DATABASE_URL is the explicit, documented variable and always wins when
 * set. POSTGRES_URL / POSTGRES_PRISMA_URL are the variables Vercel's
 * Supabase integration injects; POSTGRES_URL points at the **pooled**
 * endpoint (PgBouncer), which is the correct endpoint for serverless
 * functions: a direct connection needs a full TCP+TLS+auth handshake per
 * instance AND consumes one of the database's hard connection slots for
 * the lifetime of that instance.
 */
const CONNECTION_STRING_VARS = [
    "DATABASE_URL",
    "POSTGRES_URL",
    "POSTGRES_PRISMA_URL",
] as const;

export function resolveConnectionString(env: NodeJS.ProcessEnv = process.env): string | undefined {
    for (const name of CONNECTION_STRING_VARS) {
        const value = env[name];
        if (value && String(value).trim()) return String(value).trim();
    }
    return undefined;
}

export function isDatabaseConfigured(): boolean {
    return Boolean(resolveConnectionString());
}

/** True when this process runs as an ephemeral serverless function. */
export function isServerlessRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(
        env.VERCEL ||
        env.VERCEL_ENV ||
        env.AWS_LAMBDA_FUNCTION_NAME ||
        env.NETLIFY ||
        env.CF_PAGES
    );
}

/**
 * Pool sizing. A serverless instance only ever serves a handful of
 * concurrent requests, and the dashboard alone fans out 4 parallel
 * queries — so 6 is enough headroom while keeping the total number of
 * database connections (instances × max) far below any provider limit.
 * Long-lived servers keep the historical 20.
 *
 * Override with PG_POOL_MAX when a deployment needs a different shape.
 */
export function resolvePoolMax(env: NodeJS.ProcessEnv = process.env): number {
    const configured = Number(env.PG_POOL_MAX);
    if (Number.isFinite(configured) && configured > 0) return Math.min(Math.floor(configured), 100);
    return isServerlessRuntime(env) ? 6 : 20;
}

/**
 * Warn once when a serverless runtime is pointed at a Supabase DIRECT
 * database host (db.<ref>.supabase.co) instead of the pooler. This is a
 * configuration smell that shows up as slow first queries and pool
 * checkout waits, not as an error — so it must be visible in the logs.
 */
let warnedAboutDirectHost = false;
export function warnIfDirectHostOnServerless(connectionString: string, env: NodeJS.ProcessEnv = process.env): void {
    if (warnedAboutDirectHost) return;
    if (!isServerlessRuntime(env)) return;
    if (!/supabase\.(co|com)/i.test(connectionString)) return;
    if (/:6543\b/.test(connectionString) || /pooler\.supabase\.com/i.test(connectionString)) return;
    warnedAboutDirectHost = true;
    console.warn(
        "[db] Serverless runtime is using a DIRECT Postgres endpoint. " +
        "Use the Supabase connection pooler (port 6543 / *.pooler.supabase.com) for " +
        "serverless: direct connections cost a full handshake per instance and exhaust " +
        "the database connection limit. See docs/PERFORMANCE_FINAL_FIX.md."
    );
}

/**
 * Attribute time spent waiting for a pooled client to the request that
 * waited (distinct from query execution time). Without this, queueing
 * behind a saturated pool looks like slow SQL.
 *
 * node-postgres' `pool.query()` acquires its client through
 * `pool.connect()`, so wrapping the instance method covers both styles.
 * Idempotent per pool; never logs SQL or credentials.
 */
const ACQUIRE_INSTRUMENTED = Symbol.for("leadflow.dbAcquireInstrumented");
function instrumentPoolAcquireWait(target: any): void {
    if (!target || target[ACQUIRE_INSTRUMENTED]) return;
    try {
        Object.defineProperty(target, ACQUIRE_INSTRUMENTED, { value: true, enumerable: false });
    } catch {
        return;
    }
    const originalConnect = target.connect.bind(target);
    target.connect = function instrumentedConnect(...args: any[]): any {
        const startedAt = nowMs();
        const settle = () => {
            const ctx = getRequestContext();
            if (!ctx) return;
            ctx.dbAcquireDurationMs = (ctx.dbAcquireDurationMs || 0) + Math.max(0, nowMs() - startedAt);
            const waiting = Number(target.waitingCount) || 0;
            ctx.dbPoolWaitingCount = Math.max(ctx.dbPoolWaitingCount || 0, waiting);
        };
        const last = args[args.length - 1];
        if (typeof last === "function") {
            args[args.length - 1] = (...callbackArgs: any[]) => {
                settle();
                last(...callbackArgs);
            };
            return originalConnect(...args);
        }
        try {
            return Promise.resolve(originalConnect(...args)).then(
                (client: any) => { settle(); return client; },
                (error: any) => { settle(); throw error; }
            );
        } catch (error) {
            settle();
            throw error;
        }
    };
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

    const connectionString = resolveConnectionString();

    if (!connectionString) {
        throw new Error(
            "Database connection string is missing. Set DATABASE_URL (or POSTGRES_URL / POSTGRES_PRISMA_URL)."
        );
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

    const serverless = isServerlessRuntime();
    warnIfDirectHostOnServerless(connectionString);

    // Optional statement timeout (opt-in): a query that never returns must
    // not pin a pooled client forever. Left unset by default so no provider
    // (e.g. a transaction-mode pooler) has to support startup `options`.
    const timeoutMs = Number(process.env.PG_STATEMENT_TIMEOUT_MS);
    const usesStatementTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;

    pool = new Pool({
        connectionString,
        ssl: sslDisabled ? false : { rejectUnauthorized: false },
        max: resolvePoolMax(),
        // Serverless instances are short-lived: hold idle sockets briefly,
        // then let the pool (and the database) reclaim the connection.
        idleTimeoutMillis: serverless ? 10000 : 30000,
        connectionTimeoutMillis: 15000,
        // Detect dead sockets instead of handing a corpse to a query.
        keepAlive: true,
        application_name: "leadflow",
        ...(usesStatementTimeout
            ? { options: `-c statement_timeout=${Math.floor(timeoutMs)}` }
            : {}),
    });

    pool.on("connect", () => {
        console.log("✅ PostgreSQL Client Connected");
    });

    pool.on("error", (err) => {
        console.error("❌ PostgreSQL Pool Error");
        console.error(err);
    });

    console.log(
        `🚀 PostgreSQL Connection Pool Initialized (max=${resolvePoolMax()}, ${serverless ? "serverless" : "long-lived"})`
    );

    instrumentPoolForObservability(pool);
    instrumentPoolAcquireWait(pool);

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
