import { PGlite } from '@electric-sql/pglite';

let pgliteInstance: PGlite | null = null;

class PGliteClient {
  constructor(private db: PGlite) {}
  async query(sql: string, params?: any[]) {
    const res = await this.db.query(sql, params);
    // pg returns rowCount, rows
    return {
      rows: res.rows,
      rowCount: (res as any).affectedRows ?? res.rows?.length ?? 0,
      command: (res as any).command,
    };
  }
  release() {}
}

class PGlitePool {
  private db: PGlite;
  constructor(db: PGlite) {
    this.db = db;
  }
  async query(sql: string, params?: any[]) {
    const res = await this.db.query(sql, params);
    return {
      rows: res.rows,
      rowCount: (res as any).affectedRows ?? res.rows?.length ?? 0,
      command: (res as any).command,
    };
  }
  async connect() {
    return new PGliteClient(this.db);
  }
  on(_event: string, _handler: any) {}
  async end() {
    // PGlite doesn't need explicit close for in-memory, but we can clear
    try {
      await this.db.close();
    } catch {}
    pgliteInstance = null;
  }
}

export function getPGliteInstance(): PGlite {
  if (!pgliteInstance) {
    // Use memory by default, or file path if specified after pglite://
    pgliteInstance = new PGlite();
  }
  return pgliteInstance;
}

export function createPGlitePool(): any {
  const db = getPGliteInstance();
  return new PGlitePool(db) as any;
}

export function resetPGlite() {
  pgliteInstance = null;
}
