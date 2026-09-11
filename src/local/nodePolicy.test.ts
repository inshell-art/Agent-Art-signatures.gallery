import { afterEach, describe, expect, it, vi } from "vitest";
import { http } from "viem";
import { createLocalChainRpc } from "./chainReconciler.js";
import { LOCAL_ANVIL_PERSISTENCE_ARGS, LOCAL_NODE_LIFECYCLE_TIMEOUT_MS, LOCAL_RPC_HTTP_OPTIONS, LOCAL_RPC_TIMEOUT_MS, waitForLocalNode } from "./nodePolicy.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("snapshot-aware local node policy", () => {
  it("dumps current state on an interval and never every historical snapshot", () => {
    // Dumping historical snapshots grew the file until each rewrite outlasted
    // the interval and the node stopped answering RPC.
    expect(LOCAL_ANVIL_PERSISTENCE_ARGS).toEqual(["--state-interval", "60"]);
    expect(LOCAL_ANVIL_PERSISTENCE_ARGS).not.toContain("--preserve-historical-states");
    expect(LOCAL_RPC_TIMEOUT_MS).toBe(30_000);
  });

  it("allows an indexer RPC to complete after the old five-second limit", async () => {
    vi.useFakeTimers();
    const fetchRpc = vi.fn(async (_url: unknown, options: RequestInit) => {
      expect(options.redirect).toBe("error");
      await new Promise(resolve => setTimeout(resolve, 6_000));
      expect(options.signal!.aborted).toBe(false);
      return Response.json({ jsonrpc: "2.0", id: 1, result: "0x7a69" });
    });
    vi.stubGlobal("fetch", fetchRpc);
    let completed = false;
    const result = createLocalChainRpc("http://127.0.0.1:18545").chainId().then(value => { completed = true; return value; });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    await expect(result).resolves.toBe(31337n);
    expect(fetchRpc).toHaveBeenCalledOnce();
  });

  it("still times out and aborts stalled reads without automatic retries", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchRpc = vi.fn((_url: unknown, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = options.signal!;
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchRpc);
    const result = createLocalChainRpc("http://127.0.0.1:18545").chainId().catch(error => error);
    await vi.advanceTimersByTimeAsync(LOCAL_RPC_TIMEOUT_MS - 1);
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal!.aborted).toBe(true);
    expect(await result).toMatchObject({ name: "TimeoutError" });
    expect(fetchRpc).toHaveBeenCalledOnce();
  });

  it("does not retry an uncertain transaction submission", async () => {
    const fetchRpc = vi.fn(async () => { throw new TypeError("Connection lost"); });
    const transport = http("http://127.0.0.1:18545", { ...LOCAL_RPC_HTTP_OPTIONS, fetchFn: fetchRpc })({});
    await expect(transport.request({ method: "eth_sendRawTransaction", params: ["0x1234"] })).rejects.toThrow();
    expect(fetchRpc).toHaveBeenCalledOnce();
  });

  it("waits for a slow snapshot load/save instead of using the old five-second shutdown limit", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    let completed = false;
    const wait = waitForLocalNode(() => Date.now() - started >= 25_000, "Not stopped").then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    await wait;
    expect(completed).toBe(true);
  });

  it("fails closed at the lifecycle deadline without invoking recovery or reset", async () => {
    vi.useFakeTimers();
    const probe = vi.fn(() => false);
    const wait = waitForLocalNode(probe, "Preserve the existing state").catch(error => error);
    await vi.advanceTimersByTimeAsync(LOCAL_NODE_LIFECYCLE_TIMEOUT_MS);
    expect(await wait).toMatchObject({ message: "Preserve the existing state" });
    expect(probe).toHaveBeenCalledTimes(LOCAL_NODE_LIFECYCLE_TIMEOUT_MS / 250);
  });

  it("does not swallow a process ownership failure", async () => {
    await expect(waitForLocalNode(() => { throw new Error("Owned process exited"); }, "Not ready")).rejects.toThrow("Owned process exited");
  });
});
