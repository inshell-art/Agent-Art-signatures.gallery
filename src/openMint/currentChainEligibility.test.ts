import { decodeFunctionData, encodeFunctionResult, keccak256, numberToHex, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { createCurrentChainEligibility } from "./currentChainEligibility.js";
import { PUBLIC_CHAIN_READ_ABI, readPublicChainEligibility, type PublicChainGateConfig } from "./publicChain.js";
import type { PublicChainRpc } from "./publicChainRpc.js";

const hash = (byte: string): Hex => `0x${byte.repeat(32)}`;
const runtime = "0x6000", now = Date.parse("2026-09-20T00:00:00Z"), recipient = "0x3333333333333333333333333333333333333333" as const;
const config: PublicChainGateConfig = { namespaceId: "local-observation", deploymentId: "local-deployment", chainId: 31337n,
  genesisHash: hash("01"), deploymentBlock: { number: 2n, hash: hash("02") }, contract: "0x1111111111111111111111111111111111111111",
  runtimeCodeHash: keccak256(runtime), authorizer: "0x2222222222222222222222222222222222222222",
  maxBlockAgeMs: 120000, maxFutureSkewMs: 5000, evidenceTtlMs: 10000, observationTimeoutMs: 1000 };
const input = { handle: "alice", recipient, nonce: hash("33") };
function harness() {
  const c = structuredClone(config);
  const heads = [{ number: "0xa", hash: hash("10") }, { number: "0xa", hash: hash("10") }];
  const request = (index: number) => vi.fn<PublicChainRpc["request"]>(async (method, params) => {
    if (method === "eth_chainId") return "0x7a69";
    if (method === "eth_getBlockByNumber") {
      if (params[0] === "latest") return structuredClone(heads[index]);
      const number = BigInt(params[0] as string);
      return { number: numberToHex(number), hash: number === 0n ? c.genesisHash : number === 2n ? c.deploymentBlock.hash : number === 9n ? hash("09") : hash("10"),
        timestamp: numberToHex(BigInt(now / 1000)) };
    }
    if (method === "eth_getCode") return params[0] === c.contract ? runtime : "0x";
    const name = decodeFunctionData({ abi: PUBLIC_CHAIN_READ_ABI, data: (params[0] as { data: Hex }).data }).functionName;
    const result = name === "eip712Domain" ? ["0x0f", "SignaturesOpenMint", "1", c.chainId, c.contract, hash("00"), []]
      : name === "trustedAuthorizer" ? c.authorizer : false;
    return encodeFunctionResult({ abi: PUBLIC_CHAIN_READ_ABI, functionName: name, result } as Parameters<typeof encodeFunctionResult>[0]);
  });
  const rpcs = [{ id: "mock-one", request: request(0) }, { id: "mock-two", request: request(1) }] as const;
  return { c, heads, rpcs, options: { config: c, rpcs, maxHeadLag: 1n } };
}

describe("backend-owned current eligibility observation", () => {
  it("obtains two current heads, then verifies exact canonical state and produces an opaque witness", async () => {
    const h = harness(), observe = createCurrentChainEligibility(h.options, () => now);
    const witness = await observe(input, new AbortController().signal);
    expect(JSON.stringify(witness)).toBe("{}");
    expect(readPublicChainEligibility(witness, { namespaceId: config.namespaceId, deploymentId: config.deploymentId, ...input, now })).toMatchObject({
      block: { number: 10n, hash: hash("10") }, sources: ["mock-one", "mock-two"], handle: "alice", nonce: input.nonce,
    });
    for (const rpc of h.rpcs) {
      expect(rpc.request.mock.calls.filter(([method, params]) => method === "eth_getBlockByNumber" && params[0] === "latest")).toHaveLength(1);
      for (const [method, params, signal] of rpc.request.mock.calls) {
        if (method === "eth_call" || method === "eth_getCode") expect(params[1]).toEqual({ blockHash: hash("10"), requireCanonical: true });
        expect(signal.aborted).toBe(true);
      }
    }
  });
  it("allows only an explicit bounded head skew, and has both sources verify the lower exact hash", async () => {
    const h = harness(); h.heads[0] = { number: "0x9", hash: hash("09") };
    const witness = await createCurrentChainEligibility(h.options, () => now)(input, new AbortController().signal);
    expect(readPublicChainEligibility(witness, { namespaceId: config.namespaceId, deploymentId: config.deploymentId, ...input, now }).block.number).toBe(9n);
    for (const rpc of h.rpcs) expect(rpc.request.mock.calls.some(([method, params]) => method === "eth_getBlockByNumber" && params[0] === "0x9")).toBe(true);
    await expect(createCurrentChainEligibility({ ...h.options, maxHeadLag: 0n }, () => now)(input, new AbortController().signal)).rejects.toThrow("failed closed");
  });
  it.each([
    [{ number: "0xa", hash: hash("11") }, { number: "0xa", hash: hash("10") }],
    [{ number: "0x8", hash: hash("08") }, { number: "0xa", hash: hash("10") }],
    [{ number: "0x1", hash: hash("01") }, { number: "0x2", hash: hash("02") }],
  ])("rejects disagreement, excessive skew or a head before deployment", async (a, b) => {
    const h = harness(); h.heads[0] = a; h.heads[1] = b;
    await expect(createCurrentChainEligibility(h.options, () => now)(input, new AbortController().signal)).rejects.toThrow("failed closed");
    for (const rpc of h.rpcs) expect(rpc.request).toHaveBeenCalledOnce();
  });
  it.each([null, [], {}, { number: "0x00", hash: hash("10") }, { number: "0xA", hash: hash("10") },
    { number: -1, hash: hash("10") }, { number: `0x${"1".repeat(65)}`, hash: hash("10") }, { number: "0xa", hash: hash("00") }, { number: "0xa", hash: "bad" },
  ])("rejects malformed/unavailable head %j without falling back", async bad => {
    const h = harness(); h.rpcs[0].request.mockResolvedValueOnce(bad);
    await expect(createCurrentChainEligibility(h.options, () => now)(input, new AbortController().signal)).rejects.toThrow("failed closed");
    for (const rpc of h.rpcs) expect(rpc.request).toHaveBeenCalledOnce();
  });
  it("rejects a canonicality change between head selection and state observation", async () => {
    const h = harness(), original = h.rpcs[1].request.getMockImplementation()!;
    h.rpcs[1].request.mockImplementation(async (method, params, signal) => {
      if (method === "eth_getBlockByNumber" && params[0] === "0xa") return { number: "0xa", hash: hash("11"), timestamp: numberToHex(BigInt(now / 1000)) };
      return original(method, params, signal);
    });
    await expect(createCurrentChainEligibility(h.options, () => now)(input, new AbortController().signal)).rejects.toThrow("failed closed");
  });
  it("rejects already-cancelled input before any RPC request", async () => {
    const h = harness(), abort = new AbortController(); abort.abort();
    await expect(createCurrentChainEligibility(h.options)(input, abort.signal)).rejects.toThrow("cancelled");
    expect(h.rpcs[0].request).not.toHaveBeenCalled();
  });
  it("cancels a hung head call and never begins verification when it resolves late", async () => {
    const h = harness(), abort = new AbortController(); let release!: (value: unknown) => void;
    h.rpcs[0].request.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const result = createCurrentChainEligibility(h.options, () => now)(input, abort.signal);
    abort.abort(); await expect(result).rejects.toThrow("failed closed");
    release(h.heads[0]); await Promise.resolve(); await Promise.resolve();
    expect(h.rpcs[0].request.mock.calls[0][2].aborted).toBe(true);
    for (const rpc of h.rpcs) expect(rpc.request).toHaveBeenCalledOnce();
  });
  it("cancels the inner pinned observation too, not just current-head selection", async () => {
    const h = harness(), abort = new AbortController();
    const original = h.rpcs[0].request.getMockImplementation()!;
    let reached!: () => void; const started = new Promise<void>(resolve => { reached = resolve; });
    h.rpcs[0].request.mockImplementation((method, params, signal) => {
      if (method === "eth_call") { reached(); return new Promise(() => {}); }
      return original(method, params, signal);
    });
    const result = createCurrentChainEligibility(h.options, () => now)(input, abort.signal);
    await started; abort.abort(); await expect(result).rejects.toThrow("failed closed");
    for (const rpc of h.rpcs) for (const call of rpc.request.mock.calls) expect(call[2].aborted).toBe(true);
  });
  it("bounds the entire head-plus-verification operation and redacts provider errors", async () => {
    const h = harness(); h.c.observationTimeoutMs = 10;
    h.rpcs[0].request.mockImplementationOnce(() => new Promise(() => {}));
    await expect(createCurrentChainEligibility(h.options, () => now)(input, new AbortController().signal)).rejects.toThrow("failed closed");
    h.rpcs[0].request.mockRejectedValueOnce(new Error("https://rpc.example/credential-secret"));
    await expect(createCurrentChainEligibility(h.options, () => now)(input, new AbortController().signal)).rejects.toThrow(/^Current chain eligibility failed closed\.$/);
  });
  it("enforces monotonic deadlines when resolved callbacks starve timers", async () => {
    const h = harness(); h.c.observationTimeoutMs = 1;
    h.rpcs[0].request.mockImplementationOnce(async () => {
      const start = performance.now(); while (performance.now() - start < 5) { /* intentional deadline starvation */ }
      return h.heads[0];
    });
    await expect(createCurrentChainEligibility(h.options, () => now)(input, new AbortController().signal)).rejects.toThrow("failed closed");
    expect(h.rpcs[0].request).toHaveBeenCalledOnce();
  });
  it("snapshots configuration and callback bindings, including the caller input before awaiting", async () => {
    const h = harness(), observe = createCurrentChainEligibility(h.options, () => now), mutableInput = { ...input };
    const pending = observe(mutableInput, new AbortController().signal);
    mutableInput.handle = "bob"; h.options.maxHeadLag = 64n; h.c.observationTimeoutMs = 0;
    (h.rpcs[0] as { request: PublicChainRpc["request"] }).request = () => { throw new Error("mutated callback"); };
    const witness = await pending;
    expect(readPublicChainEligibility(witness, { namespaceId: config.namespaceId, deploymentId: config.deploymentId, ...input, now }).handle).toBe("alice");
  });
  it.each([-1n, 65n, 1, undefined])("rejects an invalid/implicit maximum head lag %s", value => {
    const h = harness(); expect(() => createCurrentChainEligibility({ ...h.options, maxHeadLag: value as bigint })).toThrow("lag");
  });
  it("rejects duplicate RPC identities and invalid handles", async () => {
    const h = harness(); expect(() => createCurrentChainEligibility({ ...h.options, rpcs: [h.rpcs[0], h.rpcs[0]] })).toThrow("distinct");
    expect(() => createCurrentChainEligibility({ ...h.options, rpcs: [h.rpcs[0], { ...h.rpcs[1], id: h.rpcs[0].id }] })).toThrow("distinct");
    await expect(createCurrentChainEligibility(h.options)({ ...input, handle: "not a handle" }, new AbortController().signal)).rejects.toThrow();
    expect(h.rpcs[0].request).not.toHaveBeenCalled();
  });
});
