import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireProcessLock, FileKeyValueStore, MemoryKeyValueStore, SerialKeys } from "./storage.js";

const paths: string[] = [];
async function temporary() { const path = await mkdtemp(join(tmpdir(), "sg-open-store-test-")); paths.push(path); return path; }
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("open mint stores", () => {
  it("memory snapshots isolate callers from stored objects", async () => {
    const store = new MemoryKeyValueStore();
    expect(await store.get("request:missing")).toBeUndefined();
    const input = { nested: { status: "pending" } };
    await store.put("request:a", input); input.nested.status = "forged";
    const first = await store.get<typeof input>("request:a"); first!.nested.status = "forged again";
    const entries = await store.entries<typeof input>("request:"); entries[0][1].nested.status = "forged third";
    await store.put("budget:2027-01-01", 1);
    expect(await store.get("request:a")).toEqual({ nested: { status: "pending" } });
    expect(await store.entries("request:")).toHaveLength(1);
  });

  it("file values survive restart, atomically replace and enumerate only requested keys", async () => {
    const path = await temporary();
    const store = await FileKeyValueStore.create(path);
    expect(await store.get("request:missing")).toBeUndefined();
    await store.put("request:two", { nested: { count: 2 } });
    await store.put("request:one", { nested: { count: 1 } });
    await store.put("budget:2027-01-01", 4);
    await store.put("request:one", { nested: { count: 3 } });
    const restarted = await FileKeyValueStore.create(path);
    expect(await restarted.get("request:one")).toEqual({ nested: { count: 3 } });
    expect((await restarted.entries("request:")).map(([key]) => key)).toEqual(["request:one", "request:two"]);
    expect((await readdir(path)).some(name => name.endsWith(".tmp"))).toBe(false);
    expect(JSON.parse(await readFile(store.path("request:one"), "utf8"))).toEqual({ nested: { count: 3 } });
  });

  it("rejects key traversal, malformed prefixes and corrupted disk JSON", async () => {
    const store = await FileKeyValueStore.create(await temporary());
    for (const key of ["", "request:../secret", "../../etc", "request:a/b", "request:", "request:a:b", `request:${"x".repeat(101)}`]) {
      expect(() => store.path(key)).toThrow("Invalid storage key");
      await expect(store.put(key, {})).rejects.toThrow();
      await expect(store.get(key)).rejects.toThrow();
    }
    for (const prefix of ["", "../", "request:a", "REQUEST:"]) await expect(store.entries(prefix)).rejects.toThrow("Invalid storage prefix");
    await writeFile(store.path("request:bad"), "{");
    await expect(store.get("request:bad")).rejects.toThrow();
    await expect(store.entries("request:")).rejects.toThrow();
  });

  it("permits only one process writer until explicit idempotent release", async () => {
    const path = await temporary();
    const release = await acquireProcessLock(path);
    expect(await readFile(join(path, "writer.lock"), "utf8")).toBe(String(process.pid));
    await expect(acquireProcessLock(path)).rejects.toMatchObject({ code: "EEXIST" });
    await release(); await release();
    const secondRelease = await acquireProcessLock(path); await secondRelease();
    await writeFile(join(path, "writer.lock"), "unknown-old-process");
    await expect(acquireProcessLock(path)).rejects.toMatchObject({ code: "EEXIST" });
  });
});

describe("per-key serialization", () => {
  it("serializes the same key while unrelated keys continue", async () => {
    const serial = new SerialKeys();
    const events: string[] = [];
    let release!: () => void;
    const first = serial.run("alice", async () => { events.push("first-start"); await new Promise<void>(resolve => { release = resolve; }); events.push("first-end"); return 1; });
    const second = serial.run("alice", async () => { events.push("second"); return 2; });
    const other = serial.run("bob", async () => { events.push("other"); return 3; });
    expect(await other).toBe(3);
    expect(events).toEqual(["first-start", "other"]);
    release(); expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(events).toEqual(["first-start", "other", "first-end", "second"]);
  });

  it("recovers a key after rejected work and cleans its queue", async () => {
    const serial = new SerialKeys();
    const failed = serial.run("alice", async () => { throw new Error("expected failure"); });
    const next = serial.run("alice", async () => "next");
    await expect(failed).rejects.toThrow("expected failure");
    expect(await next).toBe("next");
    expect(await serial.run("alice", async () => "fresh")).toBe("fresh");
  });
});
