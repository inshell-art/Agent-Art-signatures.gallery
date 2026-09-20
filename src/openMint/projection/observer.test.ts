import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { projectionRpcFixture, testHash } from "../fixtures/projectionRpc.js";
import { createProjectionObserver, readProjectionObservation, type ProjectionChainCursor } from "./observer.js";

const empty: ProjectionChainCursor = { head: null, promoted: null, tail: [] };
const signal = () => new AbortController().signal;
describe("two-source bounded canonical inclusion/finality acquisition", () => {
  it("verifies saved mint evidence, successful receipts and hash-pinned logs without promoting inclusion", async () => {
    const f = await projectionRpcFixture(), witness = await createProjectionObserver(f.options)(empty, signal());
    const e = readProjectionObservation(witness, f.options.deployment, Date.now());
    expect(e.batch?.blocks.map(b => b.number)).toEqual(["10", "11", "12"]);
    expect(e.batch?.blocks[1].events[1]).toMatchObject({ kind: "OpenSignatureMinted", mbti: "INTJ", handle: "alice_bob_key" });
    expect(e.promotion).toBeUndefined(); expect(e.halt).toBeUndefined(); expect(Object.isFrozen(e.batch!.blocks[1].events)).toBe(true);
    expect(f.calls.filter(c => c.method === "eth_getTransactionReceipt")).toHaveLength(2);
    for (const c of f.calls.filter(c => c.method === "eth_getLogs")) expect(c.params[0]).toMatchObject({ blockHash: expect.any(String), topics: expect.any(Array) });
    for (const c of f.calls.filter(c => c.method === "eth_call" || c.method === "eth_getCode")) expect(c.params[1]).toMatchObject({ blockHash: expect.any(String), requireCanonical: true });
    expect(f.calls.every(c => c.signal.aborted)).toBe(true);
    expect(() => readProjectionObservation(JSON.parse(JSON.stringify(witness)), f.options.deployment, Date.now())).toThrow();
    expect(() => readProjectionObservation(witness, { ...f.options.deployment, manifestHash: testHash(222) }, Date.now())).toThrow();
    for (const t of [e.observedAt - 1, e.validUntil, NaN]) expect(() => readProjectionObservation(witness, f.options.deployment, t)).toThrow();
  });
  it("promotes only the lesser finalized boundary and supports finality advancement behind an unchanged tip", async () => {
    const f = await projectionRpcFixture(); f.setFinalized(11);
    f.mutate((r, c) => c.source === 1 && c.method === "eth_getBlockByNumber" && c.params[0] === "finalized" ? f.header(12) : r);
    const observe = createProjectionObserver(f.options), witness = await observe(empty, signal());
    expect(readProjectionObservation(witness, f.options.deployment, Date.now()).promotion).toEqual({ number: "11", hash: testHash(11) });
    const tail = [10, 11, 12].map(n => ({ number: String(n), hash: testHash(n) }));
    const second = await observe({ head: tail[2], promoted: tail[0], tail }, signal());
    const e = readProjectionObservation(second, f.options.deployment, Date.now());
    expect(e.batch!.blocks.map(b => b.number)).toEqual(["12"]); expect(e.promotion!.number).toBe("11");
  });
  it("bounds backfill to 32 blocks and clamps promotion to acquired history", async () => {
    const f = await projectionRpcFixture(); f.setHead(70); f.setFinalized(65);
    const e = readProjectionObservation(await createProjectionObserver(f.options)(empty, signal()), f.options.deployment, Date.now());
    expect(e.batch!.blocks).toHaveLength(32); expect(e.promotion!.number).toBe("41");
    expect(f.calls.length).toBeLessThan(500);
  });
  it("finds a shallow common ancestor, without changing original mint authority", async () => {
    const f = await projectionRpcFixture(); f.fork(11); f.setFinalized(10);
    const tail = [10, 11, 12].map(n => ({ number: String(n), hash: testHash(n) }));
    const e = readProjectionObservation(await createProjectionObserver(f.options)({ head: tail[2], promoted: tail[0], tail }, signal()), f.options.deployment, Date.now());
    expect(e.batch!.blocks.map(b => b.number)).toEqual(["11", "12"]); expect(e.batch!.blocks.every(b => !b.events.length)).toBe(true);
  });
  it("issues a bounded safety-halt witness for a finalized contradiction", async () => {
    const f = await projectionRpcFixture(); f.fork(11); f.setFinalized(12);
    const tail = [10, 11, 12].map(n => ({ number: String(n), hash: testHash(n) }));
    const e = readProjectionObservation(await createProjectionObserver(f.options)({ head: tail[2], promoted: tail[1], tail }, signal()), f.options.deployment, Date.now());
    expect(e.halt).toBe("finality-contradiction"); expect(e.batch).toBeUndefined();
  });
  it("halts when no common ancestor exists within the configured rollback bound", async () => {
    const f = await projectionRpcFixture(); f.setHead(20); f.fork(14);
    const tail = [15, 16, 17, 18, 19, 20].map(n => ({ number: String(n), hash: testHash(n) }));
    const e = readProjectionObservation(await createProjectionObserver(f.options)({ head: tail[5], promoted: null, tail }, signal()), f.options.deployment, Date.now());
    expect(e.halt).toBe("rollback-bound-exceeded");
  });
  it.each([
    ["wrong chain", "eth_chainId", () => "0x1"],
    ["runtime changed", "eth_getCode", () => "0x6002"],
    ["empty runtime", "eth_getCode", () => "0x"],
    ["malformed call", "eth_call", () => "0x"],
    ["log omission", "eth_getLogs", () => []],
    ["log removed", "eth_getLogs", (r: any) => r.map((l: any) => ({ ...l, removed: true }))],
    ["log transaction index", "eth_getLogs", (r: any) => r.map((l: any) => ({ ...l, transactionIndex: "0x1" }))],
    ["receipt missing", "eth_getTransactionReceipt", () => null],
    ["receipt reverted", "eth_getTransactionReceipt", (r: any) => ({ ...r, status: "0x0" })],
    ["receipt block", "eth_getTransactionReceipt", (r: any) => ({ ...r, blockHash: testHash(777) })],
    ["receipt transaction", "eth_getTransactionReceipt", (r: any) => ({ ...r, transactionHash: testHash(777) })],
    ["receipt index", "eth_getTransactionReceipt", (r: any) => ({ ...r, transactionIndex: "0x1" })],
    ["receipt logs missing", "eth_getTransactionReceipt", (r: any) => ({ ...r, logs: [] })],
    ["receipt oversized", "eth_getTransactionReceipt", (r: any) => ({ ...r, logs: Array(1025).fill({}) })],
  ] as const)("fails closed: %s", async (_name, method, mutate) => {
    const f = await projectionRpcFixture();
    f.mutate((r, c) => c.source === 1 && c.method === method ? mutate(r) : r);
    await expect(createProjectionObserver(f.options)(empty, signal())).rejects.toThrow("unavailable");
  });
  it.each([
    { number: "0x01" }, { hash: testHash(0) }, { parentHash: "0x12" }, { transactions: [testHash(1), testHash(1)] },
    { transactions: Array(4097).fill(testHash(1)) }, { timestamp: "0x" }, { transactions: null }, { timestamp: "0xffffffffffffffff" },
  ])("rejects malformed header case %#", async change => {
    const f = await projectionRpcFixture(); f.mutate((r, c) => c.method === "eth_getBlockByNumber" ? { ...(r as object), ...change } : r);
    await expect(createProjectionObserver(f.options)(empty, signal())).rejects.toThrow();
  });
  it.each(["latest", "finalized"])("rejects incompatible %s heads, without height search or single-source fallback", async tag => {
    const f = await projectionRpcFixture(); f.mutate((r, c) => c.method === "eth_getBlockByNumber" && c.source === 1 && c.params[0] === tag ? f.header(20) : r);
    await expect(createProjectionObserver(f.options)(empty, signal())).rejects.toThrow();
  });
  it("requires consistent transactions, logs and receipts even when both providers tell the same lie", async () => {
    const f = await projectionRpcFixture(); f.mutate((r, c) => c.method === "eth_getBlockByNumber" && (r as any).number === "0xb" ? { ...(r as object), transactions: [] } : r);
    await expect(createProjectionObserver(f.options)(empty, signal())).rejects.toThrow();
  });
  it.each(["receipt omission", "receipt extra", "receipt height", "parent", "timestamp", "reordered logs", "duplicate logs", "oversized logs"])("refuses mutually agreed but inconsistent %s", async mode => {
    const f = await projectionRpcFixture();
    f.mutate((raw, c) => {
      const r = raw as any;
      if (c.method === "eth_getTransactionReceipt") {
        if (mode === "receipt omission") return { ...r, logs: r.logs.slice(1) };
        if (mode === "receipt extra") return { ...r, logs: [...r.logs, r.logs[0]] };
        if (mode === "receipt height") return { ...r, blockNumber: "0xc" };
      }
      if (c.method === "eth_getBlockByNumber" && r.number === "0xb") {
        if (mode === "parent") return { ...r, parentHash: testHash(99) };
        if (mode === "timestamp") return { ...r, timestamp: f.header(1).timestamp };
      }
      if (c.method === "eth_getLogs" && r.length) {
        if (mode === "reordered logs") return [...r].reverse();
        if (mode === "duplicate logs") return [r[0], r[0]];
        if (mode === "oversized logs") return Array(129).fill(r[0]);
      }
      return raw;
    });
    await expect(createProjectionObserver(f.options)(empty, signal())).rejects.toThrow();
  });
  it("accepts unrelated receipt logs without treating them as OpenSignatures events", async () => {
    const f = await projectionRpcFixture();
    f.mutate((r, c) => c.method === "eth_getTransactionReceipt" ? { ...(r as any), logs: [{ address: "0xother", topics: [] }, ...(r as any).logs] } : r);
    await expect(createProjectionObserver(f.options)(empty, signal())).resolves.toBeDefined();
  });
  it("uses the slower canonical latest head within the explicit lag limit", async () => {
    const f = await projectionRpcFixture();
    f.mutate((r, c) => c.source === 1 && c.method === "eth_getBlockByNumber" && c.params[0] === "latest" ? f.header(13) : r);
    const e = readProjectionObservation(await createProjectionObserver(f.options)(empty, signal()), f.options.deployment, Date.now());
    expect(e.head.number).toBe("12");
  });
  it.each(["regressed latest", "regressed finalized"])("does not reinterpret %s as a reorg or unminted handle", async mode => {
    const f = await projectionRpcFixture(), tail = [10, 11, 12].map(n => ({ number: String(n), hash: testHash(n) }));
    if (mode === "regressed latest") f.setHead(11);
    await expect(createProjectionObserver(f.options)({ head: tail[2], promoted: tail[0], tail }, signal())).rejects.toThrow();
  });
  it("rechecks headers after private evidence resolution", async () => {
    const f = await projectionRpcFixture(); const original = f.options.resolveMint;
    f.options.resolveMint = async (...args) => { const e = await original(...args); f.fork(11); return e; };
    await expect(createProjectionObserver(f.options)(empty, signal())).rejects.toThrow();
  });
  it("rejects a missing durable signature or changed artifact", async () => {
    const f = await projectionRpcFixture(); f.options.resolveMint = async () => undefined;
    await expect(createProjectionObserver(f.options)(empty, signal())).rejects.toThrow();
  });
  it.each(["hung", "cancel", "pre-cancel", "late", "microtasks"])("bounds %s provider behavior and redacts failures", async mode => {
    const f = await projectionRpcFixture(), parent = new AbortController(); f.options.config.observationTimeoutMs = 10;
    f.mutate(async r => {
      if (mode === "hung" || mode === "cancel") return new Promise(() => {});
      if (mode === "late") await new Promise(resolve => setTimeout(resolve, 30));
      if (mode === "microtasks") { const end = performance.now() + 15; while (performance.now() < end) await Promise.resolve(); }
      return r;
    });
    if (mode === "pre-cancel") parent.abort();
    if (mode === "cancel") setTimeout(() => parent.abort(), 2);
    await expect(createProjectionObserver(f.options)(empty, parent.signal)).rejects.toThrow("unavailable");
    expect(f.calls.every(c => c.signal.aborted)).toBe(true);
  });
  it.each([-1, 65, NaN, 1.5])("rejects invalid explicit head-lag policy %s", async maxHeadLag => {
    const f = await projectionRpcFixture(); expect(() => createProjectionObserver({ ...f.options, maxHeadLag })).toThrow();
  });
  it.each([-1, 129, NaN])("rejects invalid finalized-lag policy %s", async maxFinalizedLag => {
    const f = await projectionRpcFixture(); expect(() => createProjectionObserver({ ...f.options, maxFinalizedLag })).toThrow();
  });
  it.each([0, 3_600_001, NaN])("rejects invalid finalized-age policy %s", async maxFinalizedAgeMs => {
    const f = await projectionRpcFixture(); expect(() => createProjectionObserver({ ...f.options, maxFinalizedAgeMs })).toThrow();
  });
  it.each([
    { head: null, promoted: { number: "10", hash: testHash(10) }, tail: [] },
    { head: { number: "12", hash: testHash(12) }, promoted: null, tail: [] },
    { head: { number: "9", hash: testHash(9) }, promoted: null, tail: [] },
  ])("rejects invalid durable cursor %j", async c => {
    const f = await projectionRpcFixture(); await expect(createProjectionObserver(f.options)(c, signal())).rejects.toThrow(); expect(f.calls).toHaveLength(0);
  });
  it("snapshots configuration and cursor before async reads", async () => {
    const f = await projectionRpcFixture(), observe = createProjectionObserver(f.options), c = structuredClone(empty);
    const promise = observe(c, signal()); f.options.config.contract = "0x0000000000000000000000000000000000000099"; Object.assign(c, { tail: [{ number: "10", hash: testHash(99) }] });
    await expect(promise).resolves.toBeDefined();
  });
  it.each(["stale head", "stale finalized", "future", "backwards clock"])("rejects %s", async mode => {
    const f = await projectionRpcFixture();
    if (mode === "stale head") f.options.config.maxBlockAgeMs = 1;
    if (mode === "stale finalized") f.options.maxFinalizedAgeMs = 1;
    const clock = mode === "backwards clock" ? vi.fn().mockReturnValueOnce(Date.now()).mockReturnValue(Date.now() - 10) : () => mode === "future" ? 0 : Date.now();
    await expect(createProjectionObserver(f.options, clock)(empty, signal())).rejects.toThrow();
  });
});
