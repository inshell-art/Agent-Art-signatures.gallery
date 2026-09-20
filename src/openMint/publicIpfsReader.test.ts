import { performance } from "node:perf_hooks";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { preparePublicArtifact, type PreparedPublicArtifact } from "./publicArtifacts.js";
import { syntheticPublicAssessment } from "./fixtures/publicAssessment.js";
import { createPublicIpfsReader } from "./publicIpfsReader.js";

describe("independent bounded IPFS gateway reader (no external network)", () => {
  let artifact: PreparedPublicArtifact;
  beforeAll(async () => { artifact = await preparePublicArtifact({ assessment: syntheticPublicAssessment(), origin: "https://gallery.example" }); });
  const config = () => ({ id: "gateway-b", gatewayOrigin: "https://gateway.example", timeoutMs: 1000,
    fetchFn: vi.fn(async (_url: string, _init: RequestInit) => new Response(Uint8Array.from(artifact.svg.bytes))) });
  const options = () => ({ signal: new AbortController().signal, maxBytes: 8 * 1024 * 1024 });
  it("GETs only the configured canonical CID with no credentials and verifies retrieved bytes", async () => {
    const input = config(), reader = createPublicIpfsReader(input);
    expect(await reader.retrieve(artifact.svg.object, options())).toEqual(artifact.svg.bytes);
    expect(input.fetchFn).toHaveBeenCalledWith(`https://gateway.example/ipfs/${artifact.svg.object.cid}`, expect.objectContaining({ method: "GET", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" }));
    expect(input.fetchFn).toHaveBeenCalledTimes(1);
  });
  it.each([0, -1, 60_001, NaN, 1.5])("rejects deadline %s", timeoutMs => {
    expect(() => createPublicIpfsReader({ ...config(), timeoutMs })).toThrow("configuration");
  });
  it.each(["http://gateway.example", "https://127.0.0.1", "https://gateway.example/path", "https://a:b@gateway.example"])("rejects unsafe origin %s", gatewayOrigin => {
    expect(() => createPublicIpfsReader({ ...config(), gatewayOrigin })).toThrow("origin");
  });
  it.each([0, -1, 8 * 1024 * 1024 + 1, NaN, 1.2])("rejects invalid byte bound %s", async maxBytes => {
    const input = config(); await expect(createPublicIpfsReader(input).retrieve(artifact.svg.object, { ...options(), maxBytes })).rejects.toThrow("bounds");
    expect(input.fetchFn).not.toHaveBeenCalled();
  });
  it("rejects a different URI or too-small expected limit before fetch", async () => {
    const input = config(), reader = createPublicIpfsReader(input);
    await expect(reader.retrieve({ ...artifact.svg.object, uri: "https://untrusted.example" }, options())).rejects.toThrow("bounds");
    await expect(reader.retrieve(artifact.svg.object, { ...options(), maxBytes: 1 })).rejects.toThrow("bounds");
    expect(input.fetchFn).not.toHaveBeenCalled();
  });
  it.each([301, 404, 500])("does not retry HTTP %s", async status => {
    const input = config(); input.fetchFn.mockResolvedValue(new Response("error", { status }));
    await expect(createPublicIpfsReader(input).retrieve(artifact.svg.object, options())).rejects.toThrow("exact object");
    expect(input.fetchFn).toHaveBeenCalledTimes(1);
  });
  it.each(["0", "999999999999999999999999", "1", "01", "-1"])("rejects content length %s", async length => {
    const input = config(); input.fetchFn.mockResolvedValue(new Response(Uint8Array.from(artifact.svg.bytes), { headers: { "content-length": length } }));
    await expect(createPublicIpfsReader(input).retrieve(artifact.svg.object, options())).rejects.toThrow("length mismatch");
  });
  it("accepts an exact content length and streamed chunks", async () => {
    const input = config(); input.fetchFn.mockResolvedValue(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(artifact.svg.bytes.slice(0, 4)); controller.enqueue(artifact.svg.bytes.slice(4)); controller.close();
    } }), { headers: { "content-length": String(artifact.svg.bytes.length) } }));
    expect(await createPublicIpfsReader(input).retrieve(artifact.svg.object, options())).toEqual(artifact.svg.bytes);
  });
  it("bounds a stream that emits only empty chunks instead of making progress", async () => {
    const input = config(), cancel = vi.fn();
    input.fetchFn.mockResolvedValue(new Response(new ReadableStream({ pull(controller) {
      controller.enqueue(new Uint8Array());
    }, cancel })));
    await expect(createPublicIpfsReader(input).retrieve(artifact.svg.object, options())).rejects.toThrow("no progress");
    expect(cancel).toHaveBeenCalled();
  });
  it("accepts a bounded empty chunk followed by the exact object bytes", async () => {
    const input = config();
    input.fetchFn.mockResolvedValue(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array()); controller.enqueue(artifact.svg.bytes); controller.close();
    } })));
    expect(await createPublicIpfsReader(input).retrieve(artifact.svg.object, options())).toEqual(artifact.svg.bytes);
  });
  it.each(["oversized", "short", "corrupt"])("rejects %s bytes", async kind => {
    const input = config(), bytes = kind === "oversized" ? new Uint8Array(artifact.svg.bytes.length + 1) : kind === "short" ? artifact.svg.bytes.slice(1) : Uint8Array.from(artifact.svg.bytes);
    if (kind === "corrupt") bytes[0] ^= 1;
    input.fetchFn.mockResolvedValue(new Response(Uint8Array.from(bytes)));
    await expect(createPublicIpfsReader(input).retrieve(artifact.svg.object, options())).rejects.toThrow();
  });
  it.each(["redirected", "url", "body"])("rejects invalid response %s", async property => {
    const input = config(), response = new Response(Uint8Array.from(artifact.svg.bytes));
    Object.defineProperty(response, property, { value: property === "redirected" ? true : property === "url" ? "https://other.example/object" : null });
    input.fetchFn.mockResolvedValue(response);
    await expect(createPublicIpfsReader(input).retrieve(artifact.svg.object, options())).rejects.toThrow("exact object");
  });
  it("propagates transport failure without retry", async () => {
    const input = config(); input.fetchFn.mockRejectedValue(new Error("unavailable"));
    await expect(createPublicIpfsReader(input).retrieve(artifact.svg.object, options())).rejects.toThrow("unavailable");
    expect(input.fetchFn).toHaveBeenCalledTimes(1);
  });
  it("rejects already aborted work without fetch", async () => {
    const input = config(), controller = new AbortController(); controller.abort();
    await expect(createPublicIpfsReader(input).retrieve(artifact.svg.object, { ...options(), signal: controller.signal })).rejects.toThrow("cancelled");
    expect(input.fetchFn).not.toHaveBeenCalled();
  });
  it("bounds stalled response headers even when fetch ignores cancellation", async () => {
    const input = { ...config(), timeoutMs: 10 }; input.fetchFn.mockImplementation(() => new Promise(() => {}));
    await expect(createPublicIpfsReader(input).retrieve(artifact.svg.object, options())).rejects.toThrow("timed out");
    expect(input.fetchFn).toHaveBeenCalledTimes(1);
  });
  it("cancels a stalled body read on external abort", async () => {
    const input = config(), cancel = vi.fn();
    input.fetchFn.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const controller = new AbortController(), pending = createPublicIpfsReader(input).retrieve(artifact.svg.object, { ...options(), signal: controller.signal });
    await vi.waitFor(() => expect(input.fetchFn).toHaveBeenCalled()); await Promise.resolve(); controller.abort();
    await expect(pending).rejects.toThrow("cancelled"); expect(cancel).toHaveBeenCalled();
  });
  it("bounds a stalled body read by deadline", async () => {
    const input = { ...config(), timeoutMs: 10 }, cancel = vi.fn(); input.fetchFn.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    await expect(createPublicIpfsReader(input).retrieve(artifact.svg.object, options())).rejects.toThrow("timed out"); expect(cancel).toHaveBeenCalled();
  });
  it("rejects elapsed-time overflow even when no timer callback could run", async () => {
    const input = { ...config(), timeoutMs: 1 }; let now = 0;
    const cancel = vi.fn(), clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    input.fetchFn.mockImplementation(async () => { now = 2; return new Response(new ReadableStream({ cancel })); });
    try { await expect(createPublicIpfsReader(input).retrieve(artifact.svg.object, options())).rejects.toThrow("timed out"); }
    finally { clock.mockRestore(); }
    expect(cancel).toHaveBeenCalled();
  });
  it("snapshots descriptor and configuration across awaits", async () => {
    const input = config(), reader = createPublicIpfsReader(input), object = { ...artifact.svg.object };
    const pending = reader.retrieve(object, options()); object.sha256 = "changed"; input.gatewayOrigin = "https://changed.example"; input.timeoutMs = 0;
    expect(await pending).toEqual(artifact.svg.bytes); expect(input.fetchFn.mock.calls[0][0]).toContain("https://gateway.example/");
  });
  it("cancels a late response body without consuming it after timeout", async () => {
    const input = { ...config(), timeoutMs: 10 }; let release!: (response: Response) => void;
    input.fetchFn.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    await expect(createPublicIpfsReader(input).retrieve(artifact.svg.object, options())).rejects.toThrow("timed out");
    const cancel = vi.fn(); release(new Response(new ReadableStream({ cancel })));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
  });
  it("cancels rejected response bodies and tolerates cancellation failure", async () => {
    const input = config(), cancel = vi.fn(() => { throw new Error("already disconnected"); });
    input.fetchFn.mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 500 }));
    await expect(createPublicIpfsReader(input).retrieve(artifact.svg.object, options())).rejects.toThrow("exact object");
    expect(cancel).toHaveBeenCalled();
  });
});
