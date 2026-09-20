import type { QueryResult, QueryResultRow } from "pg";

/** A NEW dedicated Client, never an already-connected client or pool member. */
export interface OwnershipConnection {
  connect(): Promise<unknown>;
  query<R extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<R>>;
  on(event: "error" | "end", listener: (error?: Error) => void): unknown;
  end(): Promise<void>;
}
export type OwnershipConnectionFactory = () => OwnershipConnection;
export const WRITER_LOCK = [1936152941, 17] as const;
export class WriterUnavailableError extends Error {
  constructor(cause?: unknown) { super("Open-mint writer unavailable; explicit restart/recovery is required.", { cause }); }
}
export class PersistenceConflictError extends Error {}

/** Serializes every transaction on the connection that owns the session lock.
 * No automatic reconnect, retry, pool release, or external I/O callback exists.
 */
export class ExclusiveWriter {
  readonly #connection: OwnershipConnection;
  #failure?: unknown;
  #closing = false;
  #queue: Promise<unknown> = Promise.resolve();
  #close?: Promise<void>;
  private constructor(connection: OwnershipConnection, readonly epoch: string) { this.#connection = connection; }

  static async acquire(factory: OwnershipConnectionFactory): Promise<ExclusiveWriter> {
    const connection = factory();
    let writer: ExclusiveWriter | undefined;
    let failure: unknown;
    const lost = (error?: Error) => {
      failure ??= error ?? new WriterUnavailableError();
      if (writer) writer.#failure ??= failure;
    };
    connection.on("error", lost);
    connection.on("end", lost);
    try {
      await connection.connect();
      const lock = await connection.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS acquired", [...WRITER_LOCK]);
      if (lock.rows[0]?.acquired !== true) throw new WriterUnavailableError("Another process owns this database.");
      await connection.query("SET statement_timeout = '5s'; SET lock_timeout = '1s'; SET idle_in_transaction_session_timeout = '5s'");
      const durability = (await connection.query<{ fsync: string; synchronous_commit: string }>("SELECT current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS synchronous_commit")).rows[0];
      if (durability?.fsync !== "on") throw new WriterUnavailableError("PostgreSQL fsync must be enabled for durable dispatch fences.");
      if (durability.synchronous_commit !== "remote_apply") await connection.query("SET synchronous_commit = 'on'");
      await connection.query("BEGIN");
      const version = await connection.query<{ version: number }>("SELECT version FROM open_mint.schema_version");
      if (version.rows.length !== 1 || version.rows[0]?.version !== 1) throw new PersistenceConflictError("Unsupported open-mint schema.");
      const epoch = await connection.query<{ epoch: string }>("UPDATE open_mint.writer_epoch SET epoch = epoch + 1 WHERE singleton = true RETURNING epoch::text");
      if (!/^[1-9][0-9]*$/.test(epoch.rows[0]?.epoch ?? "")) throw new PersistenceConflictError("Missing writer epoch.");
      await connection.query("COMMIT");
      if (failure) throw failure;
      writer = new ExclusiveWriter(connection, epoch.rows[0]!.epoch);
      return writer;
    } catch (error) {
      // Closing the dedicated session releases its lock and rolls back any open
      // transaction. A lost COMMIT reply is never replayed on this connection.
      await connection.end().catch(() => undefined);
      throw error;
    }
  }

  assertHealthy(): void {
    if (this.#failure || this.#closing) throw new WriterUnavailableError(this.#failure);
  }

  /** Internal repository boundary. Work must contain database queries only. */
  transaction<T>(work: (connection: Pick<OwnershipConnection, "query">) => Promise<T>): Promise<T> {
    try { this.assertHealthy(); } catch (error) { return Promise.reject(error); }
    const transaction = this.#queue.then(async () => {
      this.assertHealthy();
      let began = false;
      let committing = false;
      try {
        await this.#connection.query("BEGIN");
        began = true;
        const owner = await this.#connection.query<{ epoch: string; held: boolean; durable: boolean }>(`SELECT epoch::text,
          current_setting('fsync') = 'on' AND current_setting('synchronous_commit') IN ('on', 'remote_apply') AS durable,
          EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()
            AND classid = $1::oid AND objid = $2::oid AND objsubid = 2 AND granted) AS held
          FROM open_mint.writer_epoch WHERE singleton = true FOR UPDATE`, [...WRITER_LOCK]);
        if (owner.rows[0]?.epoch !== this.epoch || owner.rows[0]?.held !== true || owner.rows[0]?.durable !== true) {
          this.#failure = new WriterUnavailableError();
          throw this.#failure;
        }
        const result = await work(this.#connection);
        this.assertHealthy();
        committing = true;
        await this.#connection.query("COMMIT");
        this.assertHealthy();
        return result;
      } catch (error) {
        if (committing || !began) this.#failure ??= error;
        if (began && !committing) {
          try { await this.#connection.query("ROLLBACK"); }
          catch (rollbackError) { this.#failure ??= rollbackError; }
        }
        if (this.#failure) throw new WriterUnavailableError(this.#failure);
        throw error;
      }
    });
    this.#queue = transaction.catch(() => undefined);
    return transaction;
  }

  /** Reject new and queued work immediately; finish/rollback the bounded active
   * transaction, then close the actual owner session. Calling twice is safe. */
  close(): Promise<void> {
    this.#closing = true;
    return this.#close ??= this.#queue.then(() => this.#connection.end());
  }
}
