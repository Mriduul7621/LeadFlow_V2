import { parseTimestampAsUtc } from '../utils/businessTime.js';

let pgliteInstance: any = null;
let pglitePool: any = null;

// Same stored-timestamp convention as the real pg pool
// (database/connection.ts): TIMESTAMP values (OID 1114) hold UTC
// wall time and must be parsed AS UTC, not in the process timezone —
// otherwise a test/dev process running in Asia/Dhaka reads every
// timestamp 6 hours early.
const PGLITE_OPTIONS = {
  parsers: { 1114: (value: string) => parseTimestampAsUtc(value) },
};

class PGliteClient {
  private db: any;
  constructor(db: any) {
    this.db = db;
  }
  async query(sql: string, params?: any[]) {
    const res = await this.db.query(sql, params);
    return {
      rows: (res as any).rows,
      rowCount: (res as any).affectedRows ?? (res as any).rows?.length ?? 0,
    };
  }
  release() {}
}

class PGlitePool {
  private db: any;
  constructor(db: any) {
    this.db = db;
  }
  async query(sql: string, params?: any[]) {
    const res = await this.db.query(sql, params);
    return {
      rows: (res as any).rows,
      rowCount: (res as any).affectedRows ?? (res as any).rows?.length ?? 0,
    };
  }
  async connect() {
    return new PGliteClient(this.db);
  }
  on(_event: string, _handler: any) {}
  async end() {
    try {
      await this.db.close();
    } catch {}
    pgliteInstance = null;
    pglitePool = null;
  }
}

export async function getPGliteInstanceAsync(): Promise<any> {
  if (!pgliteInstance) {
    const { PGlite } = await import('@electric-sql/pglite');
    pgliteInstance = new PGlite(PGLITE_OPTIONS);
  }
  return pgliteInstance;
}

export function getPGliteInstance(): any {
  if (!pgliteInstance) {
    throw new Error('PGlite instance not initialized. Call getPGliteInstanceAsync() first.');
  }
  return pgliteInstance;
}

export async function createPGlitePoolAsync(): Promise<any> {
  if (!pgliteInstance) {
    const { PGlite } = await import('@electric-sql/pglite');
    pgliteInstance = new PGlite(PGLITE_OPTIONS);
  }
  if (!pglitePool) {
    pglitePool = new PGlitePool(pgliteInstance);
  }
  return pglitePool;
}

export function createPGlitePool(): any {
  if (!pgliteInstance || !pglitePool) {
    throw new Error('PGlite pool not initialized. Call createPGlitePoolAsync() first.');
  }
  return pglitePool;
}

export function resetPGlite() {
  pgliteInstance = null;
  pglitePool = null;
}
