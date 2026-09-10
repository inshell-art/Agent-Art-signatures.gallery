import { describe, expect, it } from "vitest";
import { LocalMintRuntime } from "./mintRuntime.js";

describe("serialized local mint durability boundary", () => {
  it("serializes mutations and persists before releasing each result", async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = new LocalMintRuntime({ assertOwnership() {}, async persist() { events.push("persist"); } });
    const first = runtime.run(async () => { events.push("first"); await gate; return 1; });
    const second = runtime.run(() => { events.push("second"); return 2; });
    await Promise.resolve();
    expect(events).toEqual(["first"]);
    release();
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(events).toEqual(["first", "persist", "second", "persist"]);
    await runtime.drain();
  });

  it("checkpoints inside an operation without a reentrant queue deadlock", async () => {
    const events: string[] = [];
    const runtime = new LocalMintRuntime({ assertOwnership() {}, async persist() { events.push("persist"); } });
    await runtime.run(async () => {
      events.push("prepared");
      await runtime.checkpoint();
      events.push("signed");
      await runtime.checkpoint();
    });
    expect(events).toEqual(["prepared", "persist", "signed", "persist", "persist"]);
    await expect(runtime.checkpoint()).rejects.toThrow("serialized operation boundary");
  });

  it("saves mutated failure states but continues after ordinary application errors", async () => {
    let saves = 0;
    const runtime = new LocalMintRuntime({ assertOwnership() {}, async persist() { saves += 1; } });
    await expect(runtime.run(() => { throw new Error("invalid wallet proof"); })).rejects.toThrow("invalid wallet proof");
    await expect(runtime.run(() => "next attempt")).resolves.toBe("next attempt");
    expect(saves).toBe(2);
  });

  it("never releases a success after failed persistence and refuses subsequent work", async () => {
    let calls = 0;
    const runtime = new LocalMintRuntime({ assertOwnership() {}, async persist() { throw new Error("database offline"); } });
    await expect(runtime.run(() => "secret attestation")).rejects.toThrow("database offline");
    await expect(runtime.run(() => { calls += 1; })).rejects.toThrow("restart is required");
    expect(calls).toBe(0);
  });

  it("fails before mutations when writer ownership is lost", async () => {
    let calls = 0;
    const runtime = new LocalMintRuntime({ assertOwnership() { throw new Error("lock lost"); }, async persist() {} });
    await expect(runtime.run(() => { calls += 1; })).rejects.toThrow("lock lost");
    await expect(runtime.run(() => { calls += 1; })).rejects.toThrow("restart is required");
    expect(calls).toBe(0);
  });
});
