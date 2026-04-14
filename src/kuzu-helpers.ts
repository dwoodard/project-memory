import type kuzu from "kuzu";

type Connection = InstanceType<typeof kuzu.Connection>;
type Database = InstanceType<typeof kuzu.Database>;
type QueryResult = InstanceType<typeof kuzu.QueryResult>;
type PreparedStatement = InstanceType<typeof kuzu.PreparedStatement>;

/**
 * Legacy escape helper (kept for backwards compatibility with existing code).
 * Prefer using prepared statements with parameters instead.
 * @deprecated Use prepared statements with parameters instead
 */
export function escape(s: string): string {
  return (s ?? "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Legacy queryAll helper (kept for backwards compatibility).
 * Prefer using queryBuilder for new code.
 * @deprecated Use queryBuilder pattern instead
 */
export async function queryAll(
  conn: Connection,
  cypher: string
): Promise<Record<string, unknown>[]> {
  const result = await conn.query(cypher);
  const qr = Array.isArray(result) ? result[0] : result;
  return (qr as QueryResult).getAll();
}

// ── Prepared Statement Cache ────────────────────────────────────────────────
// Cache prepared statements to avoid re-parsing the same queries

const _stmtCache = new Map<string, PreparedStatement>();

async function getCachedStmt(
  conn: Connection,
  cypher: string
): Promise<PreparedStatement> {
  if (_stmtCache.has(cypher)) {
    return _stmtCache.get(cypher)!;
  }
  const stmt = await conn.prepare(cypher);
  _stmtCache.set(cypher, stmt);
  return stmt;
}

// ── Query Builder ───────────────────────────────────────────────────────────
// Type-safe, parameter-based query execution

export interface QueryOptions {
  timeout?: number; // ms
  maxThreads?: number;
  progressCallback?: (pipelineProgress: number, finished: number, total: number) => void;
}

/**
 * Execute a query with parameters instead of string interpolation.
 * Automatically uses prepared statements and caches them.
 *
 * @example
 * const results = await queryBuilder(conn)
 *   .cypher("MATCH (m:Memory {id: $id}) RETURN m")
 *   .params({ id: memoryId })
 *   .all();
 */
export function queryBuilder(conn: Connection) {
  return new QueryBuilder(conn);
}

export class QueryBuilder {
  private _cypher = "";
  private _params: Record<string, unknown> = {};
  private _opts: QueryOptions = {};

  constructor(private conn: Connection) {}

  /**
   * Set the Cypher query. Use $paramName for parameters.
   */
  cypher(statement: string): this {
    this._cypher = statement;
    return this;
  }

  /**
   * Set query parameters (values to substitute for $paramName placeholders).
   */
  params(params: Record<string, unknown>): this {
    this._params = params;
    return this;
  }

  /**
   * Add a single parameter.
   */
  param(name: string, value: unknown): this {
    this._params[name] = value;
    return this;
  }

  /**
   * Set query timeout in milliseconds.
   */
  timeout(ms: number): this {
    this._opts.timeout = ms;
    return this;
  }

  /**
   * Set max threads for execution.
   */
  maxThreads(n: number): this {
    this._opts.maxThreads = n;
    return this;
  }

  /**
   * Set progress callback.
   */
  progress(
    cb: (pipelineProgress: number, finished: number, total: number) => void
  ): this {
    this._opts.progressCallback = cb;
    return this;
  }

  /**
   * Apply timeout and thread settings to connection.
   */
  private applySettings(): void {
    if (this._opts.timeout) {
      this.conn.setQueryTimeout(this._opts.timeout);
    }
    if (this._opts.maxThreads) {
      this.conn.setMaxNumThreadForExec(this._opts.maxThreads);
    }
  }

  /**
   * Execute and return all rows at once.
   */
  async all(): Promise<Record<string, unknown>[]> {
    this.applySettings();
    const stmt = await getCachedStmt(this.conn, this._cypher);
    const result = await this.conn.execute(
      stmt,
      this._params as any,
      this._opts.progressCallback
    );
    const qr = Array.isArray(result) ? result[0] : result;
    return (qr as QueryResult).getAll();
  }

  /**
   * Execute and return all rows synchronously.
   */
  allSync(): Record<string, unknown>[] {
    this.applySettings();
    const stmt = this.conn.prepareSync(this._cypher);
    const result = this.conn.executeSync(stmt, this._params as any);
    const qr = Array.isArray(result) ? result[0] : result;
    return (qr as QueryResult).getAllSync();
  }

  /**
   * Stream results row-by-row (async iterator).
   * Useful for large result sets to avoid loading everything into memory.
   *
   * @example
   * for await (const row of builder.stream()) {
   *   console.log(row);
   * }
   */
  async *stream(): AsyncGenerator<Record<string, unknown>> {
    this.applySettings();
    const stmt = await getCachedStmt(this.conn, this._cypher);
    const result = await this.conn.execute(
      stmt,
      this._params as any,
      this._opts.progressCallback
    );
    const qr = Array.isArray(result) ? result[0] : result;

    qr.resetIterator();
    while (qr.hasNext()) {
      const row = await qr.getNext();
      if (row !== null) yield row;
    }
  }

  /**
   * Get the first row or undefined.
   */
  async one(): Promise<Record<string, unknown> | undefined> {
    this.applySettings();
    const stmt = await getCachedStmt(this.conn, this._cypher);
    const result = await this.conn.execute(stmt, this._params as any);
    const qr = Array.isArray(result) ? result[0] : result;

    qr.resetIterator();
    const first = await qr.getNext();
    return first ?? undefined;
  }

  /**
   * Get the first row synchronously.
   */
  oneSync(): Record<string, unknown> | undefined {
    this.applySettings();
    const stmt = this.conn.prepareSync(this._cypher);
    const result = this.conn.executeSync(stmt, this._params as any);
    const qr = Array.isArray(result) ? result[0] : result;

    qr.resetIterator();
    const first = qr.getNextSync();
    return first ?? undefined;
  }

  /**
   * Execute query and return count of affected rows.
   * Useful for mutations (CREATE, DELETE, SET).
   */
  async count(): Promise<number> {
    this.applySettings();
    const stmt = await getCachedStmt(this.conn, this._cypher);
    const result = await this.conn.execute(stmt, this._params as any);
    const qr = Array.isArray(result) ? result[0] : result;
    return qr.getNumTuples();
  }

  /**
   * Get column metadata.
   */
  async columns(): Promise<{ names: string[]; types: string[] }> {
    this.applySettings();
    const stmt = await getCachedStmt(this.conn, this._cypher);
    const result = await this.conn.execute(stmt, this._params as any);
    const qr = Array.isArray(result) ? result[0] : result;

    const names = await qr.getColumnNames();
    const types = await qr.getColumnDataTypes();
    return { names, types };
  }

  /**
   * Get just the column names.
   */
  async columnNames(): Promise<string[]> {
    this.applySettings();
    const stmt = await getCachedStmt(this.conn, this._cypher);
    const result = await this.conn.execute(stmt, this._params as any);
    const qr = Array.isArray(result) ? result[0] : result;
    return qr.getColumnNames();
  }
}
