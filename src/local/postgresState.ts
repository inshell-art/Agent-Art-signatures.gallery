import type { Pool, PoolClient } from "pg";

import { MemoryMintStore, type MemoryMintStoreSnapshot } from "../v2/memoryStore.js";
import type { IndexerState } from "../v2/indexer/types.js";

type TaggedJson =
  | null
  | boolean
  | number
  | string
  | TaggedJson[]
  | { [key: string]: TaggedJson };

export function encode(value: unknown): TaggedJson {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  // Memory-store composite keys intentionally contain NUL delimiters, but
  // PostgreSQL jsonb rejects the JSON `\u0000` escape. Preserve those strings
  // losslessly as tagged base64 rather than changing store semantics.
  if (typeof value === "string") {
    return value.includes("\u0000")
      ? { __sg_type: "utf8-base64", value: Buffer.from(value, "utf8").toString("base64") }
      : value;
  }
  if (typeof value === "bigint") return { __sg_type: "bigint", value: value.toString() };
  if (value instanceof Date) return { __sg_type: "date", value: value.toISOString() };
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encode(entry)]));
  }
  throw new Error(`Unsupported local snapshot value: ${typeof value}`);
}

export function decode(value: TaggedJson): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    if (value.__sg_type === "bigint" && typeof value.value === "string") return BigInt(value.value);
    if (value.__sg_type === "date" && typeof value.value === "string") {
      const date = new Date(value.value);
      if (Number.isNaN(date.getTime())) throw new Error("Invalid date in local snapshot.");
      return date;
    }
    if (value.__sg_type === "utf8-base64" && typeof value.value === "string") {
      return Buffer.from(value.value, "base64").toString("utf8");
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decode(entry)]));
  }
  return value;
}

export class LocalPostgresState {
  private writer: PoolClient | null = null;
  private writerFailure: Error | null = null;
  constructor(private readonly pool: Pool) {}

  /** Session-scoped ownership is held on the same connection used for commits. */
  async acquireExclusiveWriter(): Promise<() => Promise<void>> {
    if (this.writer || this.writerFailure) throw new Error("Local rehearsal writer was already acquired or failed.");
    const client = await this.pool.connect();
    try {
      // Constant namespace scoped to this database, not an arbitrary user key.
      const result = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(1936152941, 2) AS acquired");
      if (result.rows[0]?.acquired !== true) throw new Error("Another process owns the local rehearsal mint state. Stop it before starting a writer.");
    } catch (error) {
      client.release();
      throw error;
    }
    this.writer = client;
    const onFailure = (error?: Error) => {
      this.writerFailure ??= error ?? new Error("The local rehearsal database ownership connection closed.");
    };
    client.on("error", onFailure);
    client.on("end", onFailure);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        if (!this.writerFailure) await client.query("SELECT pg_advisory_unlock(1936152941, 2)");
      } catch (error) {
        this.writerFailure ??= error instanceof Error ? error : new Error(String(error));
        throw error;
      } finally {
        this.writer = null;
        client.off("error", onFailure);
        client.off("end", onFailure);
        client.release(this.writerFailure ?? undefined);
      }
    };
  }

  assertExclusiveWriter(): void {
    if (this.writerFailure) throw new Error("Local rehearsal database ownership was lost; restart is required.", { cause: this.writerFailure });
    if (!this.writer) throw new Error("Local rehearsal mutations require an exclusive database writer.");
  }

  /** Commit the mint projection and its indexing cursor as one recovery unit. */
  async saveRuntime(store: MemoryMintStore, indexer: IndexerState): Promise<void> {
    this.assertExclusiveWriter();
    const client = this.writer!;
    // Capture both synchronously, before any await gives another caller a turn.
    const values = [
      ["mint-store", JSON.stringify(encode(store.exportSnapshot()))],
      ["indexer", JSON.stringify(encode(indexer))],
    ];
    try {
      await client.query("BEGIN");
      for (const value of values) {
        await client.query(
          `INSERT INTO local_rehearsal.state_snapshots (snapshot_name, payload, updated_at)
           VALUES ($1, $2::jsonb, now())
           ON CONFLICT (snapshot_name) DO UPDATE
           SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
          value,
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Connection loss already makes ownership unusable. */ }
      // Even a commit whose reply was lost must not be retried from live state.
      this.writerFailure ??= error instanceof Error ? error : new Error(String(error));
      throw error;
    }
    this.assertExclusiveWriter();
  }

  async saveSnapshot(name: string, value: unknown): Promise<void> {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw new Error("Invalid local snapshot name.");
    const payload = JSON.stringify(encode(value));
    await this.pool.query(
      `INSERT INTO local_rehearsal.state_snapshots (snapshot_name, payload, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (snapshot_name) DO UPDATE
       SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [name, payload],
    );
  }

  async loadSnapshot<T>(name: string): Promise<T | null> {
    const result = await this.pool.query<{ payload: TaggedJson }>(
      "SELECT payload FROM local_rehearsal.state_snapshots WHERE snapshot_name = $1",
      [name],
    );
    return result.rowCount === 1 ? decode(result.rows[0]!.payload) as T : null;
  }

  async saveMintStore(store: MemoryMintStore): Promise<void> {
    await this.saveSnapshot("mint-store", store.exportSnapshot());
  }

  async loadMintStore(): Promise<MemoryMintStore> {
    const snapshot = await this.loadSnapshot<MemoryMintStoreSnapshot>("mint-store");
    return snapshot ? MemoryMintStore.fromSnapshot(snapshot) : new MemoryMintStore();
  }

  /** One SQL statement reads a consistent pair even while the server commits. */
  async loadRuntime(): Promise<{ mintStore: MemoryMintStore; indexer: IndexerState | null }> {
    const result = await this.pool.query<{ snapshot_name: string; payload: TaggedJson }>(
      "SELECT snapshot_name, payload FROM local_rehearsal.state_snapshots WHERE snapshot_name IN ('mint-store', 'indexer')",
    );
    const values = new Map(result.rows.map((row) => [row.snapshot_name, decode(row.payload)]));
    const snapshot = values.get("mint-store") as MemoryMintStoreSnapshot | undefined;
    return {
      mintStore: snapshot ? MemoryMintStore.fromSnapshot(snapshot) : new MemoryMintStore(),
      indexer: values.get("indexer") as IndexerState | undefined ?? null,
    };
  }

  async saveIndexer(state: IndexerState): Promise<void> {
    await this.saveSnapshot("indexer", state);
  }

  async loadIndexer(): Promise<IndexerState | null> {
    return this.loadSnapshot<IndexerState>("indexer");
  }
}
