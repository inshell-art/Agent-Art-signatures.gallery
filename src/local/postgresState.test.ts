import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import type { Pool } from "pg";

import { MemoryMintStore } from "../v2/memoryStore.js";
import type { WalletBinding } from "../v2/model.js";
import { LocalPostgresState } from "./postgresState.js";
import type { IndexerState } from "../v2/indexer/types.js";

describe("local rehearsal mint snapshots", () => {
  it("round-trips the reference model without aliasing dates or bigints", () => {
    const original = new MemoryMintStore();
    const binding: WalletBinding = {
      walletBindingId: `0x${"11".repeat(32)}`,
      xUserId: "123",
      publicAccountId: `xa1_${"a".repeat(26)}`,
      chainId: 31337n,
      address: `0x${"22".repeat(20)}`,
      siweMessage: "local rehearsal",
      walletProof: `0x${"33".repeat(65)}`,
      verificationScheme: "fixture_seed",
      verificationBlockNumber: 7n,
      verificationBlockHash: `0x${"44".repeat(32)}`,
      provedAt: new Date("2026-09-05T00:00:00.000Z"),
      status: "active",
      version: 1,
    };
    original.seedBinding(binding);

    const restored = MemoryMintStore.fromSnapshot(original.exportSnapshot());
    const actual = restored.getActiveBinding("123", 31337n);
    expect(actual).toMatchObject({ chainId: 31337n, verificationBlockNumber: 7n });
    expect(actual?.provedAt).toEqual(binding.provedAt);
    expect(actual).not.toBe(binding);
  });

  it("round-trips bigint, Date, and NUL-delimited map keys through a JSONB-shaped pool", async () => {
    let jsonb: unknown = null;
    const pool = {
      async query(sql: string, values: unknown[]) {
        if (sql.includes("INSERT INTO")) {
          jsonb = JSON.parse(String(values[1]));
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: jsonb === null ? 0 : 1, rows: jsonb === null ? [] : [{ payload: jsonb }] };
      },
    } as unknown as Pool;
    const durable = new LocalPostgresState(pool);
    const original = new MemoryMintStore();
    original.seedBinding({
      walletBindingId: `0x${"55".repeat(32)}`,
      xUserId: "123",
      publicAccountId: `xa1_${"b".repeat(26)}`,
      chainId: 31337n,
      address: `0x${"66".repeat(20)}`,
      siweMessage: "local rehearsal",
      walletProof: `0x${"77".repeat(65)}`,
      verificationScheme: "fixture_seed",
      verificationBlockNumber: 9n,
      verificationBlockHash: `0x${"88".repeat(32)}`,
      provedAt: new Date("2026-09-05T01:02:03.000Z"),
      status: "active",
      version: 1,
    });

    await durable.saveMintStore(original);
    expect(JSON.stringify(jsonb)).not.toContain("\\u0000");
    const restored = await durable.loadMintStore();
    expect(restored.getActiveBinding("123", 31337n)).toMatchObject({
      chainId: 31337n,
      verificationBlockNumber: 9n,
      provedAt: new Date("2026-09-05T01:02:03.000Z"),
    });
  });
});

describe("atomic local runtime persistence and writer ownership", () => {
  function database(options: { lockAvailable?: boolean; failSecondInsert?: boolean } = {}) {
    const statements: string[] = [];
    const committed = new Map<string, unknown>();
    let staged: Map<string, unknown> | null = null;
    let released = false;
    const client = Object.assign(new EventEmitter(), {
      async query(sql: string, values?: unknown[]) {
        statements.push(sql);
        if (sql.includes("pg_try_advisory_lock")) return { rowCount: 1, rows: [{ acquired: options.lockAvailable !== false }] };
        if (sql === "BEGIN") staged = new Map(committed);
        if (sql === "ROLLBACK") staged = null;
        if (sql === "COMMIT") {
          for (const [key, value] of staged!) committed.set(key, value);
          staged = null;
        }
        if (sql.includes("INSERT INTO")) {
          if (options.failSecondInsert && values![0] === "indexer") throw new Error("indexer insert failed");
          staged!.set(String(values![0]), JSON.parse(String(values![1])));
        }
        return { rowCount: 1, rows: [] };
      },
      release() { released = true; },
    });
    const pool = { async connect() { return client; } } as unknown as Pool;
    return { durable: new LocalPostgresState(pool), client, committed, statements, wasReleased: () => released };
  }

  const indexer = { schemaVersion: 1, health: "running" } as unknown as IndexerState;

  it("requires ownership, saves both snapshots in one transaction, and releases the lease", async () => {
    const db = database();
    await expect(db.durable.saveRuntime(new MemoryMintStore(), indexer)).rejects.toThrow("exclusive database writer");
    const release = await db.durable.acquireExclusiveWriter();
    await db.durable.saveRuntime(new MemoryMintStore(), indexer);
    expect([...db.committed.keys()]).toEqual(["mint-store", "indexer"]);
    expect(db.statements.filter((sql) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))).toEqual(["BEGIN", "COMMIT"]);
    await release();
    expect(db.wasReleased()).toBe(true);
    expect(() => db.durable.assertExclusiveWriter()).toThrow("exclusive database writer");
  });

  it("refuses another process instead of silently overwriting its snapshot", async () => {
    const db = database({ lockAvailable: false });
    await expect(db.durable.acquireExclusiveWriter()).rejects.toThrow("Another process owns");
    expect(db.wasReleased()).toBe(true);
    expect(db.committed.size).toBe(0);
  });

  it("rolls back both snapshots and poisons the writer on persistence failure", async () => {
    const db = database({ failSecondInsert: true });
    const release = await db.durable.acquireExclusiveWriter();
    await expect(db.durable.saveRuntime(new MemoryMintStore(), indexer)).rejects.toThrow("indexer insert failed");
    expect(db.committed.size).toBe(0);
    expect(db.statements).toContain("ROLLBACK");
    expect(db.statements).not.toContain("COMMIT");
    await expect(db.durable.saveRuntime(new MemoryMintStore(), indexer)).rejects.toThrow("ownership was lost");
    await release();
  });

  it("halts if the connection that holds the advisory lock fails", async () => {
    const db = database();
    const release = await db.durable.acquireExclusiveWriter();
    db.client.emit("error", new Error("server closed the socket"));
    expect(() => db.durable.assertExclusiveWriter()).toThrow("ownership was lost");
    await expect(db.durable.saveRuntime(new MemoryMintStore(), indexer)).rejects.toThrow("ownership was lost");
    expect(db.committed.size).toBe(0);
    await release();
  });
});
