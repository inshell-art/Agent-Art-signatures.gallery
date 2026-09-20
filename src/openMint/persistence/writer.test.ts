import { EventEmitter } from "node:events";
import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import { ExclusiveWriter, PersistenceConflictError, WriterUnavailableError, type OwnershipConnection } from "./writer.js";

class Connection extends EventEmitter implements OwnershipConnection {
  queries: string[] = [];
  ended = 0;
  acquired = true;
  version = 1;
  epoch = "1";
  held = true;
  durable = true;
  fsync = "on";
  synchronousCommit = "on";
  fault?: (sql: string) => void | Promise<void>;
  async connect(): Promise<void> {}
  async query<R extends QueryResultRow>(sql: string): Promise<QueryResult<R>> {
    this.queries.push(sql);
    await this.fault?.(sql);
    const rows = sql.includes("pg_try_advisory_lock") ? [{ acquired: this.acquired }]
      : sql.includes("schema_version") ? [{ version: this.version }]
      : sql.includes("writer_epoch") ? [{ epoch: this.epoch, held: this.held, durable: this.durable }]
      : sql.includes("AS synchronous_commit") ? [{ fsync: this.fsync, synchronous_commit: this.synchronousCommit }] : [];
    return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] } as unknown as QueryResult<R>;
  }
  async end(): Promise<void> { this.ended++; this.emit("end"); }
}

describe("pinned open-mint writer", () => {
  it("requires fsync and durable commits while preserving remote_apply", async () => {
    const unsafe = new Connection(); unsafe.fsync = "off";
    await expect(ExclusiveWriter.acquire(() => unsafe)).rejects.toMatchObject({ cause: "PostgreSQL fsync must be enabled for durable dispatch fences." });
    for (const value of ["off", "on", "remote_apply"]) {
      const connection = new Connection(); connection.synchronousCommit = value;
      const writer = await ExclusiveWriter.acquire(() => connection);
      expect(connection.queries.includes("SET synchronous_commit = 'on'")).toBe(value !== "remote_apply");
      connection.durable = false;
      await expect(writer.transaction(async () => {})).rejects.toThrow(WriterUnavailableError);
      await writer.close();
    }
  });
  it("refuses a second owner immediately and closes only its own connection", async () => {
    const connection = new Connection(); connection.acquired = false;
    await expect(ExclusiveWriter.acquire(() => connection)).rejects.toBeInstanceOf(WriterUnavailableError);
    expect(connection.ended).toBe(1);
    expect(connection.queries).toHaveLength(1);
  });
  it("rejects unsupported schemas without entering runtime", async () => {
    const connection = new Connection(); connection.version = 2;
    await expect(ExclusiveWriter.acquire(() => connection)).rejects.toBeInstanceOf(PersistenceConflictError);
    expect(connection.ended).toBe(1);
  });
  it("requires a durable, valid startup epoch", async () => {
    const connection = new Connection(); connection.epoch = "0";
    await expect(ExclusiveWriter.acquire(() => connection)).rejects.toBeInstanceOf(PersistenceConflictError);
    expect(connection.ended).toBe(1);
  });
  it("does not recover startup from an ambiguous commit", async () => {
    const connection = new Connection(); connection.fault = sql => { if (sql === "COMMIT") throw new Error("reply lost"); };
    await expect(ExclusiveWriter.acquire(() => connection)).rejects.toThrow("reply lost");
    expect(connection.ended).toBe(1);
    expect(connection.queries.filter(sql => sql === "COMMIT")).toHaveLength(1);
  });
  it("captures connection loss during startup before publishing ownership", async () => {
    const connection = new Connection(); connection.fault = sql => { if (sql === "COMMIT") connection.emit("end"); };
    await expect(ExclusiveWriter.acquire(() => connection)).rejects.toBeInstanceOf(WriterUnavailableError);
    expect(connection.ended).toBe(1);
  });
  it.each(["error", "end"] as const)("fails closed immediately on %s", async event => {
    const connection = new Connection(), writer = await ExclusiveWriter.acquire(() => connection);
    connection.emit(event, new Error("ownership gone"));
    expect(() => writer.assertHealthy()).toThrow(WriterUnavailableError);
    const count = connection.queries.length;
    await expect(writer.transaction(async () => 1)).rejects.toThrow(WriterUnavailableError);
    expect(connection.queries).toHaveLength(count);
    await writer.close();
  });
  it.each(["epoch", "lock"])("refuses a stale %s before calling repository work", async failure => {
    const connection = new Connection(), writer = await ExclusiveWriter.acquire(() => connection);
    if (failure === "epoch") connection.epoch = "2"; else connection.held = false;
    let invoked = false;
    await expect(writer.transaction(async () => { invoked = true; })).rejects.toThrow(WriterUnavailableError);
    expect(invoked).toBe(false);
    expect(connection.queries.at(-1)).toBe("ROLLBACK");
    await writer.close();
  });
  it("serializes concurrent transactions and keeps a clean rollback usable", async () => {
    const connection = new Connection(), writer = await ExclusiveWriter.acquire(() => connection);
    connection.queries = [];
    let active = 0, maximum = 0;
    const work = () => writer.transaction(async tx => {
      active++; maximum = Math.max(active, maximum);
      await tx.query("WORK"); active--;
    });
    await Promise.all(Array.from({ length: 8 }, work));
    expect(maximum).toBe(1);
    expect(connection.queries.filter(sql => sql === "BEGIN")).toHaveLength(8);
    await expect(writer.transaction(async () => { throw new PersistenceConflictError("duplicate"); })).rejects.toThrow("duplicate");
    await expect(writer.transaction(async () => 42)).resolves.toBe(42);
    await writer.close();
  });
  it("never returns a result after an ambiguous commit or runs queued work", async () => {
    const connection = new Connection(), writer = await ExclusiveWriter.acquire(() => connection);
    connection.fault = sql => { if (sql === "COMMIT") throw new Error("commit reply lost"); };
    const results = await Promise.allSettled([writer.transaction(async () => "unsafe result"), writer.transaction(async () => "queued")]);
    expect(results.every(result => result.status === "rejected" && result.reason instanceof WriterUnavailableError)).toBe(true);
    expect(connection.queries.filter(sql => sql === "ROLLBACK")).toHaveLength(0);
    await writer.close();
  });
  it("loses ownership if BEGIN or ROLLBACK cannot be acknowledged", async () => {
    for (const command of ["BEGIN", "ROLLBACK"]) {
      const connection = new Connection(), writer = await ExclusiveWriter.acquire(() => connection);
      connection.fault = sql => { if (sql === command) throw new Error("broken connection"); };
      await expect(writer.transaction(async () => { throw new Error("operation failed"); })).rejects.toThrow(WriterUnavailableError);
      expect(() => writer.assertHealthy()).toThrow(WriterUnavailableError);
      await writer.close();
    }
  });
  it("checks loss during work and again after successful COMMIT reply", async () => {
    for (const boundary of ["work", "commit"]) {
      const connection = new Connection(), writer = await ExclusiveWriter.acquire(() => connection);
      if (boundary === "commit") connection.fault = sql => { if (sql === "COMMIT") connection.emit("end"); };
      await expect(writer.transaction(async () => { if (boundary === "work") connection.emit("end"); return "result"; })).rejects.toThrow(WriterUnavailableError);
      await writer.close();
    }
  });
  it("drains close idempotently and refuses queued/new operations", async () => {
    const connection = new Connection(), writer = await ExclusiveWriter.acquire(() => connection);
    let release!: () => void;
    const work = writer.transaction(async () => { await new Promise<void>(resolve => { release = resolve; }); });
    while (!release) await Promise.resolve();
    const queued = writer.transaction(async () => 2);
    const closing = writer.close();
    expect(writer.close()).toBe(closing);
    release();
    await expect(work).rejects.toThrow(WriterUnavailableError);
    await expect(queued).rejects.toThrow(WriterUnavailableError);
    await closing;
    expect(connection.ended).toBe(1);
    await expect(writer.transaction(async () => 3)).rejects.toThrow(WriterUnavailableError);
  });
});
