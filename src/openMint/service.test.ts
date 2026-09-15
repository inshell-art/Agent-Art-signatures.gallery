import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";
import { assessmentDigest, AssessmentCoordinator, type AssessmentProvider, type AssessmentRepository, type LegacyAssessment } from "./assessment.js";
import { FileAssessmentRepository, MemoryAssessmentRepository } from "./assessmentStore.js";
import { DevelopmentAssessmentProvider } from "./grok.js";
import { handleDigest, LEGACY_MAPPING_VERSION, LEGACY_RENDERER_VERSION, RENDERER_VERSION, seedForMbti } from "./identity.js";
import { openMintTokenURIHash, type OpenMintAuthorization } from "./authorization.js";
import { OpenMintService, type MintState, type SignatureArtifact, type SignatureRequest } from "./service.js";
import { opaqueCode, WalletSessions, type SiteSession } from "./security.js";
import { FileKeyValueStore, MemoryKeyValueStore, type KeyValueStore } from "./storage.js";
import type { OpenMintNetwork } from "./network.js";
import { formalSignatureRenderer } from "../v1/renderer.js";
import { renderSignatureSvg } from "../algorithmV2/index.js";

// Service tests exercise real locked SVG rendering and byte commitments. Raster rendering
// is covered by the renderer suite; substituting deterministic bytes keeps race tests fast.
vi.mock("../v1/renderer.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../v1/renderer.js")>();
  return { ...original, renderCardPng: vi.fn(async (svg: Uint8Array) => Buffer.from(`test-raster:${original.sha256Hex(svg)}`)) };
});

const NOW = 1_800_000_000_000;
const WALLET = getAddress(`0x${"1".repeat(40)}`);
const OTHER_WALLET = getAddress(`0x${"2".repeat(40)}`);
const CONTRACT = getAddress(`0x${"3".repeat(40)}`);
const TX_HASH = `0x${"a".repeat(64)}` as Hex;
const paths: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });

function setup(options: { network?: boolean; provider?: AssessmentProvider; repository?: AssessmentRepository; store?: KeyValueStore; fixture?: boolean; limit?: number } = {}) {
  let now = NOW;
  const sessions = new WalletSessions("https://signatures.example", 31337, () => now);
  const connectedSession = (wallet = WALLET) => {
    const session = sessions.session().session;
    session.wallet = wallet; session.walletProof = { wallet, expiresAt: now + 600_000 };
    return session;
  };
  const session = connectedSession();
  const source = options.provider ?? new DevelopmentAssessmentProvider();
  const repository = options.repository ?? new MemoryAssessmentRepository();
  const assessments = new AssessmentCoordinator({ provider: source, repository, now: () => new Date(now) });
  const store = options.store ?? new MemoryKeyValueStore();
  const network: OpenMintNetwork = {
    chainId: 31337, address: CONTRACT, authorizer: CONTRACT,
    now: vi.fn(async () => Math.floor(now / 1000)),
    walletContext: vi.fn(async (recipient?: Address) => ({ chainId: "0x7a69" as const, contract: CONTRACT, blockNumber: "0xa" as const, blockHash: `0x${"b".repeat(64)}` as Hex, ...(recipient ? { nonce: "0x1" as const } : {}) })),
    state: vi.fn(async () => ({ state: "unminted" as const })),
    sign: vi.fn(async () => `0x${"1".repeat(130)}` as Hex),
    transaction: vi.fn(async (_handle: string, a: OpenMintAuthorization) => ({ from: a.recipient, to: CONTRACT, data: "0x1234" as const, value: "0x0" as const, chainId: "0x7a69" as const })),
  };
  const service = new OpenMintService({ assessments, store, origin: sessions.origin, network: options.network === false ? undefined : network, fixture: options.fixture ?? true, now: () => now, dailyAssessmentLimit: options.limit });
  const prove = (code?: string, target = session, wallet = WALLET) => { target.wallet = wallet; target.walletProof = { wallet, code, expiresAt: now + 600_000 }; };
  const ready = async (handle = "alice", target = session) => {
    const requested = await service.request(handle, target); await service.idle();
    const request = await service.getRequest(requested.code);
    expect(request.status).toBe("ready");
    return request;
  };
  const minted = async (handle: string, state: "minted" | "pending" = "minted", wallet: Address = WALLET): Promise<MintState> => {
    const artifact = (await service.artifact(handle))!;
    return { state, wallet, tokenId: BigInt(handleDigest(handle)).toString(), transactionHash: TX_HASH, assessmentDigest: artifact.assessment.digest, artifactDigest: artifact.digest, tokenURIHash: openMintTokenURIHash(artifact.tokenURI) };
  };
  return { service, sessions, session, connectedSession, source, assessments, repository, network, store, ready, prove, minted, setNow: (value: number) => { now = value; } };
}
async function expectCode(promise: Promise<unknown>, code: string) { await expect(promise).rejects.toMatchObject({ code }); }

describe("request ownership and immutable assessment workflow", () => {
  it.each(["anonymous", "address only", "expired proof", "expired session", "changed address", "request-scoped proof"])("rejects %s before spending assessment credits", async mode => {
    const runtime = setup();
    const assess = vi.spyOn(runtime.source, "assess");
    if (mode === "anonymous") { delete runtime.session.wallet; delete runtime.session.walletProof; }
    if (mode === "address only") delete runtime.session.walletProof;
    if (mode === "expired proof") runtime.session.walletProof!.expiresAt = NOW;
    if (mode === "expired session") runtime.session.expiresAt = NOW;
    if (mode === "changed address") runtime.session.wallet = OTHER_WALLET;
    if (mode === "request-scoped proof") runtime.prove(opaqueCode());
    await expectCode(runtime.service.request("alice", runtime.session), "WALLET_PROOF_REQUIRED");
    expect(runtime.network.state).not.toHaveBeenCalled();
    expect(assess).not.toHaveBeenCalled();
    expect(await runtime.store.entries("budget:")).toEqual([]);
  });

  it("checks network configuration and liveness before assessment admission", async () => {
    const runtime = setup({ network: false });
    const assess = vi.spyOn(runtime.source, "assess");
    await expectCode(runtime.service.request("alice", runtime.session), "MINT_UNAVAILABLE");
    runtime.service.options.network = runtime.network;
    vi.mocked(runtime.network.state).mockRejectedValueOnce(new Error("RPC unavailable"));
    await expectCode(runtime.service.request("alice", runtime.session), "CHAIN_UNAVAILABLE");
    vi.mocked(runtime.network.now).mockResolvedValueOnce(NOW / 1000 + 61);
    await expectCode(runtime.service.request("alice", runtime.session), "CHAIN_CLOCK");
    runtime.network.preflight = vi.fn(async () => { throw new Error("Minting is paused or wallet has code"); });
    await expectCode(runtime.service.request("alice", runtime.session), "CHAIN_UNAVAILABLE");
    expect(runtime.network.preflight).toHaveBeenCalledWith(WALLET);
    expect(assess).not.toHaveBeenCalled();
    expect(await runtime.store.entries("budget:")).toEqual([]);
  });

  it("detects an already minted or pending handle before checking assessment configuration", async () => {
    const runtime = setup(); await runtime.ready();
    const assess = vi.spyOn(runtime.source, "assess");
    runtime.service.options.assessments = undefined;
    vi.mocked(runtime.network.state).mockResolvedValue(await runtime.minted("alice"));
    await expectCode(runtime.service.request("ALICE", runtime.session), "ALREADY_MINTED");
    vi.mocked(runtime.network.state).mockResolvedValue(await runtime.minted("alice", "pending"));
    await expectCode(runtime.service.request("ALICE", runtime.session), "MINT_PENDING");
    expect(assess).not.toHaveBeenCalled();
  });

  it("binds mint preparation to its wallet but lets another verified wallet reuse the canonical result", async () => {
    const runtime = setup(); const request = await runtime.ready();
    const assess = vi.spyOn(runtime.source, "assess");
    expect(request.wallet).toBe(WALLET);
    expect(await runtime.service.walletProved(request.code, runtime.session)).toBe(true);
    runtime.prove(undefined, runtime.session, OTHER_WALLET);
    expect(await runtime.service.walletProved(request.code, runtime.session)).toBe(false);
    await expectCode(runtime.service.sessionRequest(request.code, runtime.session), "REQUEST_WALLET_MISMATCH");
    const second = await runtime.ready("ALICE");
    expect(second.wallet).toBe(OTHER_WALLET);
    expect(second.assessmentId).toBe(request.assessmentId);
    expect(assess).not.toHaveBeenCalled();
    runtime.setNow(second.expiresAt);
    expect(await runtime.service.sessionRequest(second.code, runtime.session)).toEqual(second);
    await expectCode(runtime.service.ownedRequest(second.code, runtime.session), "REQUEST_EXPIRED");
    runtime.sessions.logout(runtime.session);
    expect(await runtime.service.walletProved(second.code, runtime.session)).toBe(false);
    await expectCode(runtime.service.sessionRequest(second.code, runtime.session), "REQUEST_WALLET_MISMATCH");
  });

  it("permits any verified wallet to request any handle without X identity, then reuses its saved artwork", async () => {
    const runtime = setup();
    const first = await runtime.ready("@SomeOtherUser");
    expect(first.handle).toBe("someotheruser");
    expect(first.requestedHandle).toBe("SomeOtherUser");
    expect(first.owner).not.toBe(runtime.session.id);
    const originalArtifact = await runtime.service.artifact(first.handle);
    expect(originalArtifact?.renderHandle).toBe("SomeOtherUser");
    expect(await runtime.service.request("SOMEOTHERUSER", runtime.session)).toEqual(first);
    const other = runtime.connectedSession();
    const next = await runtime.ready("someotheruser", other);
    expect(next.code).not.toBe(first.code);
    expect(next.assessmentId).toBe(first.assessmentId);
    expect(await runtime.service.artifact(first.handle)).toEqual(originalArtifact);
    expect(runtime.service.canMint(first, runtime.session)).toBe(true);
    expect(runtime.service.canMint(first, other)).toBe(false);
    expect(await runtime.service.walletProved(first.code, runtime.session)).toBe(true);
    await expectCode(runtime.service.ownedRequest(first.code, other), "REQUEST_SESSION_MISMATCH");
    runtime.setNow(first.expiresAt);
    expect(runtime.service.canMint(first, runtime.session)).toBe(false);
    await expectCode(runtime.service.ownedRequest(first.code, runtime.session), "REQUEST_EXPIRED");
  });

  it("rejects malformed handles and unavailable assessment configuration", async () => {
    const runtime = setup();
    for (const value of [undefined, {}, { handle: "alice", mbti: "INTJ" }, "a".repeat(16), "alice/bob"]) await expectCode(runtime.service.request(value, runtime.session), "INVALID_HANDLE");
    runtime.service.options.assessments = undefined;
    await expectCode(runtime.service.request("alice", runtime.session), "GROK_NOT_CONFIGURED");
  });

  it("deduplicates request creation while provider work is still pending", async () => {
    let finish!: () => void;
    const base = new DevelopmentAssessmentProvider();
    const source: AssessmentProvider = { ...base, provenance: base.provenance, model: base.model, assess: vi.fn(async (handle) => { await new Promise<void>(resolve => { finish = resolve; }); return base.assess(handle); }) };
    const runtime = setup({ provider: source, limit: 1 });
    const first = await runtime.service.request("alice", runtime.session);
    expect(runtime.service.canMint(first, runtime.session)).toBe(false);
    expect((await runtime.service.request("@ALICE", runtime.session)).code).toBe(first.code);
    const joining = await runtime.service.request("alice", runtime.connectedSession());
    expect(joining.code).not.toBe(first.code);
    expect((await runtime.store.entries<number>("budget:"))[0][1]).toBe(1);
    finish(); await runtime.service.idle();
    expect(source.assess).toHaveBeenCalledTimes(1);
    expect((await runtime.service.getRequest(first.code)).status).toBe("ready");
  });

  it("enforces daily generation budget while allowing cached results", async () => {
    const runtime = setup({ limit: 1 });
    await runtime.ready("alice");
    await expectCode(runtime.service.request("bob", runtime.session), "ASSESSMENT_LIMIT");
    await runtime.ready("alice", runtime.connectedSession());
    expect((await runtime.store.entries<number>("budget:"))[0][1]).toBe(1);
  });

  it("limits active requests per browser session", async () => {
    const runtime = setup(); const first = await runtime.ready();
    for (let i = 0; i < 9; i++) await runtime.store.put(`request:${opaqueCode()}`, { ...first, handle: `person${i}` });
    await expectCode(runtime.service.request("another", runtime.session), "REQUEST_LIMIT");
  });

  it("fails provider errors safely and recovers interrupted jobs after restart", async () => {
    const base = new DevelopmentAssessmentProvider();
    const source: AssessmentProvider = { provenance: base.provenance, model: base.model, assess: async () => { throw new Error("secret API key raw response"); } };
    const runtime = setup({ provider: source });
    const request = await runtime.service.request("alice", runtime.session); await runtime.service.idle();
    const failed = await runtime.service.getRequest(request.code);
    expect(failed.status).toBe("failed"); expect(failed.error).not.toContain("secret");
    await expectCode(runtime.service.request("alice", runtime.session), "ASSESSMENT_RETRY_BLOCKED");
    await runtime.store.put(`request:${request.code}`, { ...request, status: "pending" });
    await runtime.service.recoverInterruptedRequests();
    expect((await runtime.service.getRequest(request.code)).error).toContain("interrupted");
    await expectCode(runtime.service.request("alice", runtime.connectedSession()), "ASSESSMENT_RETRY_BLOCKED");
  });

  it.each(["budget", "attempt", "request"])("never invokes the provider before durable %s admission succeeds", async prefix => {
    const runtime = setup();
    const assess = vi.spyOn(runtime.source, "assess");
    const put = runtime.store.put.bind(runtime.store);
    vi.spyOn(runtime.store, "put").mockImplementation(async (key, value) => {
      if (key.startsWith(`${prefix}:`)) throw new Error("disk full");
      return put(key, value);
    });
    await expect(runtime.service.request("alice", runtime.session)).rejects.toThrow("disk full");
    expect(assess).not.toHaveBeenCalled();
  });

  it("does not repeat an uncertain paid attempt when both terminal status writes fail, including after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sg-open-attempt-test-")); paths.push(directory);
    const store = await FileKeyValueStore.create(join(directory, "state"));
    const source: AssessmentProvider = { provenance: "development-fixture", model: "development-fixture-v1", assess: vi.fn(async () => { throw new Error("transport failed after dispatch"); }) };
    const runtime = setup({ store, provider: source, limit: 1 });
    const put = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementation(async (key, value) => {
      if (value && typeof value === "object" && "status" in value && value.status === "failed") throw new Error("terminal write failed");
      return put(key, value);
    });
    const request = await runtime.service.request("alice", runtime.session); await runtime.service.idle();
    expect((await runtime.service.getRequest(request.code)).status).toBe("pending");
    expect((await store.get<{ status: string }>("attempt:alice"))?.status).toBe("started");
    await expectCode(runtime.service.request("ALICE", runtime.connectedSession()), "ASSESSMENT_RETRY_BLOCKED");
    const restarted = new OpenMintService({ ...runtime.service.options, store: await FileKeyValueStore.create(join(directory, "state")), assessments: new AssessmentCoordinator({ provider: source, repository: new MemoryAssessmentRepository() }) });
    await restarted.recoverInterruptedRequests();
    expect((await restarted.getRequest(request.code)).error).toContain("will not be retried automatically");
    await expectCode(restarted.request("alice", runtime.connectedSession()), "ASSESSMENT_RETRY_BLOCKED");
    expect(source.assess).toHaveBeenCalledTimes(1);
    expect((await store.entries<number>("budget:"))[0][1]).toBe(1);
  });

  it("reuses a durable assessment after request completion writes fail instead of rerolling or leaving it stuck", async () => {
    const runtime = setup();
    const assess = vi.spyOn(runtime.source, "assess");
    const put = runtime.store.put.bind(runtime.store);
    const failure = vi.spyOn(runtime.store, "put").mockImplementation(async (key, value) => {
      if (key.startsWith("request:") && value && typeof value === "object" && "status" in value && value.status !== "pending") throw new Error("terminal write failed");
      return put(key, value);
    });
    const request = await runtime.service.request("alice", runtime.session); await runtime.service.idle();
    expect((await runtime.service.getRequest(request.code)).status).toBe("pending");
    failure.mockRestore();
    const resumed = await runtime.ready("alice");
    expect(resumed.code).toBe(request.code);
    expect(assess).toHaveBeenCalledTimes(1);
    expect((await runtime.store.entries<number>("budget:"))[0][1]).toBe(1);
  });

  it("rechecks wallet freshness after admission IO and before dispatch", async () => {
    const runtime = setup();
    const assess = vi.spyOn(runtime.source, "assess");
    const put = runtime.store.put.bind(runtime.store);
    vi.spyOn(runtime.store, "put").mockImplementation(async (key, value) => {
      await put(key, value);
      if (key.startsWith("request:")) runtime.sessions.logout(runtime.session);
    });
    await expectCode(runtime.service.request("alice", runtime.session), "WALLET_PROOF_REQUIRED");
    expect(assess).not.toHaveBeenCalled();
  });

  it("validates opaque code and saved request integrity", async () => {
    const runtime = setup();
    await expectCode(runtime.service.getRequest("bad"), "NOT_FOUND");
    await expectCode(runtime.service.getRequest(opaqueCode()), "NOT_FOUND");
    const request = await runtime.ready();
    for (const change of [{ code: opaqueCode() }, { handle: "ALICE" }, { requestedHandle: "bob" }, { requestedHandle: "@alice" }, { owner: "forged" }, { status: "done" }, { createdAt: 1.2 }, { expiresAt: request.expiresAt + 1 }]) {
      await runtime.store.put(`request:${request.code}`, { ...request, ...change });
      await expect(runtime.service.getRequest(request.code)).rejects.toThrow("Corrupt");
    }
  });
});

describe("artifact and chain commitments", () => {
  it("keeps v1 cached artwork, pending authorizations and minted gallery commitments unchanged on a v2 service restart", async () => {
    const repository = new MemoryAssessmentRepository();
    const unsigned: Omit<LegacyAssessment, "digest"> = {
      id: "00000000-0000-4000-8000-000000000001", handle: "alice", mbti: "INTJ", seed: seedForMbti("INTJ"),
      rendererVersion: LEGACY_RENDERER_VERSION, mappingVersion: LEGACY_MAPPING_VERSION, policyVersion: "grok-x-search-v1",
      model: "development-fixture-v1", providerResponseId: "development-fixture:legacy", sourceUrls: [],
      createdAt: "2026-09-15T00:00:00.000Z", provenance: "development-fixture",
    };
    const legacy = { ...unsigned, digest: assessmentDigest(unsigned) };
    await repository.putIfAbsent(legacy);
    const runtime = setup({ repository });
    const assess = vi.spyOn(runtime.source, "assess");
    const request = await runtime.ready("Alice");
    const artifact = (await runtime.service.artifact("alice"))!;
    expect(artifact.assessment).toEqual(legacy);
    const svg = await runtime.service.asset(artifact.svgSha256, "svg");
    expect(svg).toEqual(Buffer.from(formalSignatureRenderer.render({ handle: "Alice", gr0kRaw: 1, gr0kScale: 1, rendererVersion: LEGACY_RENDERER_VERSION }).svgUtf8));
    const metadataBytes = (await runtime.service.asset(artifact.metadataSha256, "json"))!;
    const metadata = JSON.parse(metadataBytes.toString());
    expect(metadata.renderer).toEqual({ version: LEGACY_RENDERER_VERSION, handle: "Alice", mappingVersion: LEGACY_MAPPING_VERSION, gr0k: 1, svgSha256: artifact.svgSha256, pngSha256: artifact.pngSha256 });
    runtime.prove(request.code);
    const authorization = await runtime.service.authorize(request.code, true, runtime.session);
    const originalIssuance = await runtime.store.get("issuance:alice");
    const restarted = new OpenMintService({ ...runtime.service.options, assessments: new AssessmentCoordinator({ provider: runtime.source, repository }) });
    expect(await restarted.authorize(request.code, true, runtime.session)).toEqual(authorization);
    expect(await runtime.store.get("issuance:alice")).toEqual(originalIssuance);
    expect(runtime.network.sign).toHaveBeenCalledTimes(1);
    expect(await restarted.artifact("ALICE")).toEqual(artifact);
    expect(await restarted.asset(artifact.metadataSha256, "json")).toEqual(metadataBytes);
    vi.mocked(runtime.network.state).mockResolvedValue(await runtime.minted("alice", "pending"));
    expect((await restarted.state("Alice")).state).toBe("pending");
    vi.mocked(runtime.network.state).mockResolvedValue(await runtime.minted("alice"));
    expect(await restarted.gallery()).toEqual([{ artifact, mint: await runtime.minted("alice") }]);
    expect(assess).not.toHaveBeenCalled();
    expect(await repository.get("alice")).toEqual(legacy);
  });

  it("renders the exact first spelling while all case variants reuse one frozen artwork and mint identity", async () => {
    const runtime = setup();
    const assess = vi.spyOn(runtime.source, "assess");
    const request = await runtime.ready("@Alice_Bob_Key");
    const artifact = (await runtime.service.artifact("alice_bob_key"))!;
    expect(artifact.renderHandle).toBe("Alice_Bob_Key");
    expect(artifact.assessment.handle).toBe("alice_bob_key");
    const svg = await runtime.service.asset(artifact.svgSha256, "svg");
    expect(artifact.assessment.rendererVersion).toBe(RENDERER_VERSION);
    expect(svg).toEqual(Buffer.from(renderSignatureSvg("Alice_Bob_Key", artifact.assessment.mbti)));
    expect(svg).not.toEqual(Buffer.from(renderSignatureSvg("alice_bob_key", artifact.assessment.mbti)));
    const metadata = JSON.parse((await runtime.service.asset(artifact.metadataSha256, "json"))!.toString());
    expect(metadata.name).toBe(`@Alice_Bob_Key · ${artifact.assessment.mbti}`);
    expect(metadata.attributes[0]).toEqual({ trait_type: "Handle", value: "Alice_Bob_Key" });
    expect(metadata.renderer.handle).toBe("Alice_Bob_Key");
    const other = await runtime.ready("ALICE_BOB_KEY", runtime.connectedSession());
    expect(other.handle).toBe(request.handle);
    expect(other.requestedHandle).toBe("ALICE_BOB_KEY");
    expect(await runtime.service.artifact("ALICE_BOB_KEY")).toEqual(artifact);
    expect(assess).toHaveBeenCalledTimes(1);
    runtime.prove(request.code);
    await runtime.service.authorize(request.code, true, runtime.session);
    expect(vi.mocked(runtime.network.sign).mock.calls[0][0].handleKey).toBe(handleDigest("alice_bob_key"));
  });

  it("retains legacy saved requests and lowercase artifacts without rewriting their commitments", async () => {
    const runtime = setup(); const request = await runtime.ready("alice");
    const { requestedHandle: _requestCase, ...oldRequest } = request;
    await runtime.store.put(`request:${request.code}`, oldRequest);
    expect(await runtime.service.getRequest(request.code)).toEqual(oldRequest);
    const { renderHandle: _renderCase, digest: _digest, ...oldUnsigned } = (await runtime.service.artifact("alice"))!;
    const oldArtifact = { ...oldUnsigned, digest: keccak256(stringToHex(JSON.stringify(oldUnsigned))) };
    await runtime.store.put("artifact:alice", oldArtifact);
    await runtime.ready("ALICE", runtime.connectedSession());
    expect(await runtime.service.artifact("ALICE")).toEqual(oldArtifact);
    expect(await runtime.store.get("artifact:alice")).toEqual(oldArtifact);
  });

  it("builds byte-verified metadata with native MBTI provenance and no synthetic seed adapter", async () => {
    const runtime = setup(); const request = await runtime.ready();
    const artifact = (await runtime.service.artifact(request.handle))!;
    const metadata = JSON.parse((await runtime.service.asset(artifact.metadataSha256, "json"))!.toString());
    expect(metadata.attributes).toEqual([{ trait_type: "Handle", value: "alice" }, { trait_type: "MBTI", value: artifact.assessment.mbti }]);
    expect(metadata.renderer).toEqual({ version: RENDERER_VERSION, handle: "alice", mbti: artifact.assessment.mbti, svgSha256: artifact.svgSha256, pngSha256: artifact.pngSha256 });
    expect(metadata.assessment).not.toHaveProperty("seed");
    expect(metadata.assessment).not.toHaveProperty("mappingVersion");
    expect(metadata.assessment.digest).toBe(artifact.assessment.digest);
    expect(metadata.description).toContain("Development fixture");
    expect(await runtime.service.artifact("missing")).toBeUndefined();
    expect(await runtime.service.asset("bad", "svg")).toBeUndefined();
    expect(await runtime.service.asset(artifact.svgSha256, "exe")).toBeUndefined();
    expect(await runtime.service.asset(artifact.svgSha256, "json")).toBeUndefined();
    expect(await runtime.service.asset("0".repeat(64), "svg")).toBeUndefined();
  });

  it("rejects MBTI, artifact digest and immutable content corruption", async () => {
    const runtime = setup(); await runtime.ready();
    const artifact = (await runtime.service.artifact("alice"))!;
    await runtime.store.put("artifact:alice", { ...artifact, assessment: { ...artifact.assessment, mbti: "XXXX" } });
    await expect(runtime.service.artifact("alice")).rejects.toThrow();
    await runtime.store.put("artifact:alice", { ...artifact, digest: TX_HASH });
    await expect(runtime.service.artifact("alice")).rejects.toThrow("commitment");
    await runtime.store.put("artifact:alice", { ...artifact, renderHandle: "ALICE" });
    await expect(runtime.service.artifact("alice")).rejects.toThrow("commitment");
    await runtime.store.put("artifact:alice", artifact);
    await runtime.store.put(`asset:${artifact.svgSha256}`, { extension: "svg", base64: Buffer.from("forged").toString("base64") });
    await expect(runtime.service.artifact("alice")).rejects.toThrow("bytes");
  });

  it("checks artifact handle, provenance, hash syntax, bytes presence and token URI even with recomputed digest", async () => {
    const runtime = setup(); await runtime.ready();
    const artifact = (await runtime.service.artifact("alice"))!;
    await runtime.store.put("artifact:bob", artifact);
    await expect(runtime.service.artifact("bob")).rejects.toThrow("provenance");
    runtime.service.options.fixture = false;
    await expect(runtime.service.artifact("alice")).rejects.toThrow("provenance");
    runtime.service.options.fixture = true;
    for (const changes of [{ renderHandle: "bob" }, { renderHandle: "@alice" }, { svgSha256: "invalid" }, { pngSha256: "0".repeat(64) }, { tokenURI: "https://evil.example/wrong" }]) {
      const { digest: _old, ...unsigned } = { ...artifact, ...changes };
      await runtime.store.put("artifact:alice", { ...unsigned, digest: keccak256(stringToHex(JSON.stringify(unsigned))) });
      await expect(runtime.service.artifact("alice")).rejects.toThrow();
    }
  });

  it("filters the gallery exclusively by verified minted chain state and current wallet", async () => {
    const runtime = setup(); await runtime.ready("alice"); await runtime.ready("bob");
    const aliceState = await runtime.minted("alice"), bobState = await runtime.minted("bob", "pending", OTHER_WALLET);
    vi.mocked(runtime.network.state).mockImplementation(async handle => handle === "alice" ? aliceState : bobState);
    expect((await runtime.service.gallery()).map(item => item.artifact.assessment.handle)).toEqual(["alice"]);
    expect(await runtime.service.gallery(OTHER_WALLET)).toEqual([]);
    expect(await runtime.service.gallery(WALLET)).toHaveLength(1);
    expect((await runtime.service.state("bob")).state).toBe("pending");
    vi.mocked(runtime.network.state).mockResolvedValue({ ...aliceState, artifactDigest: TX_HASH });
    await expect(runtime.service.state("alice")).rejects.toThrow("commitment mismatch");
    await expect(runtime.service.state("missing")).rejects.toThrow("commitment mismatch");
    runtime.service.options.network = undefined;
    expect(await runtime.service.state("alice")).toEqual({ state: "unminted" });
  });

  it("treats a reported transaction hash as an untrusted hint, never as minted state", async () => {
    const runtime = setup(); const request = await runtime.ready();
    await expectCode(runtime.service.report(request.code, TX_HASH, runtime.sessions.session().session), "REQUEST_SESSION_MISMATCH");
    for (const value of [null, "", "0x1", {}, "not-a-hash"]) await expectCode(runtime.service.report(request.code, value, runtime.session), "INVALID_TRANSACTION");
    await runtime.service.report(request.code, TX_HASH.toUpperCase().replace("0X", "0x"), runtime.session);
    expect(await runtime.store.get(`hint:${request.code}`)).toEqual({ transactionHash: TX_HASH });
    expect(await runtime.service.state("alice")).toEqual({ state: "unminted" });
    expect(await runtime.service.gallery()).toEqual([]);
  });
});

describe("mint authorization policy and race handling", () => {
  it("reserves durable exact commitments before signing and deduplicates repeated authorization", async () => {
    const runtime = setup(); const request = await runtime.ready("anyhandle"); runtime.prove(request.code);
    vi.mocked(runtime.network.sign).mockImplementation(async a => {
      const reserved = await runtime.store.get<{ authorization: Record<string, unknown>; signature?: Hex }>("issuance:anyhandle");
      expect(reserved?.signature).toBeUndefined();
      expect(reserved?.authorization.nonce).toBe(a.nonce);
      expect(reserved?.authorization.recipient).toBe(WALLET);
      return `0x${"1".repeat(130)}`;
    });
    const [one, two] = await Promise.all([runtime.service.authorize(request.code, true, runtime.session), runtime.service.authorize(request.code, true, runtime.session)]);
    expect(one).toEqual(two);
    expect(runtime.network.sign).toHaveBeenCalledTimes(1);
    expect(one.transaction.from).toBe(WALLET);
    expect(one.transaction.value).toBe("0x0");
    const a = vi.mocked(runtime.network.sign).mock.calls[0][0];
    const artifact = (await runtime.service.artifact("anyhandle"))!;
    expect(a.handleKey).toBe(handleDigest("anyhandle"));
    expect(a.assessmentDigest).toBe(artifact.assessment.digest);
    expect(a.artifactDigest).toBe(artifact.digest);
    expect(a.tokenURIHash).toBe(openMintTokenURIHash(artifact.tokenURI));
    expect(a.deadline - a.issuedAt).toBe(600n);
  });

  it("refreshes the Ethereum transaction nonce while keeping the signed mint authorization unchanged", async () => {
    const runtime = setup(); const request = await runtime.ready(); runtime.prove(request.code);
    const first = await runtime.service.authorize(request.code, true, runtime.session);
    expect(first.transaction.nonce).toBe("0x1");
    expect(first.network.nonce).toBe(first.transaction.nonce);
    const context = { ...first.network, nonce: "0x2" as Hex };
    vi.mocked(runtime.network.walletContext!).mockResolvedValue(context);
    const second = await runtime.service.authorize(request.code, true, runtime.session);
    expect(second.transaction.nonce).toBe("0x2");
    expect(second.transaction.data).toBe(first.transaction.data);
    expect(runtime.network.walletContext).toHaveBeenLastCalledWith(WALLET);
    expect(runtime.network.sign).toHaveBeenCalledTimes(1);
  });

  it.each(["missing adapter", "unavailable RPC", "missing nonce", "wallet changed"])("fails closed when the final wallet context has %s", async reason => {
    const runtime = setup(); const request = await runtime.ready(); runtime.prove(request.code);
    if (reason === "missing adapter") runtime.network.walletContext = undefined;
    else if (reason === "unavailable RPC") vi.mocked(runtime.network.walletContext!).mockRejectedValue(new Error("RPC unavailable"));
    else vi.mocked(runtime.network.walletContext!).mockImplementation(async () => {
      if (reason === "wallet changed") runtime.session.wallet = OTHER_WALLET;
      return { chainId: "0x7a69", contract: CONTRACT, blockNumber: "0xa", blockHash: TX_HASH, ...(reason === "wallet changed" ? { nonce: "0x1" as Hex } : {}) };
    });
    await expectCode(runtime.service.authorize(request.code, true, runtime.session), reason === "wallet changed" ? "WALLET_CHANGED" : "MINT_NETWORK_UNAVAILABLE");
  });

  it("requires explicit consent, matching fresh wallet proof and available network", async () => {
    const runtime = setup(); const request = await runtime.ready();
    for (const consent of [false, "true", undefined, 1]) await expectCode(runtime.service.authorize(request.code, consent, runtime.session), "CONSENT_REQUIRED");
    delete runtime.session.walletProof;
    await expectCode(runtime.service.authorize(request.code, true, runtime.session), "WALLET_PROOF_REQUIRED");
    runtime.prove(opaqueCode());
    expect(runtime.service.walletVerified(runtime.session)).toBe(false);
    await expectCode(runtime.service.authorize(request.code, true, runtime.session), "WALLET_PROOF_REQUIRED");
    runtime.prove(request.code);
    expect(await runtime.service.walletProved(request.code, runtime.session)).toBe(true);
    expect(runtime.service.walletVerified(runtime.session)).toBe(false);
    runtime.service.options.network = undefined;
    await expectCode(runtime.service.authorize(request.code, true, runtime.session), "MINT_UNAVAILABLE");
    runtime.session.expiresAt = NOW;
    expect(await runtime.service.walletProved(request.code, runtime.session)).toBe(false);
  });

  it("rejects pending/forged readiness and mismatched assessment identity", async () => {
    const runtime = setup(); const request = await runtime.ready(); runtime.prove(request.code);
    await runtime.store.put(`request:${request.code}`, { ...request, status: "pending" });
    await expectCode(runtime.service.authorize(request.code, true, runtime.session), "NOT_READY");
    await runtime.store.put(`request:${request.code}`, { ...request, assessmentId: "forged" });
    await expect(runtime.service.authorize(request.code, true, runtime.session)).rejects.toThrow("Trusted assessment");
    expect(runtime.network.sign).not.toHaveBeenCalled();
  });

  it("fails chain errors, clock drift, pending and already-minted handles before signing", async () => {
    const runtime = setup(); const request = await runtime.ready(); runtime.prove(request.code);
    vi.mocked(runtime.network.now).mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(runtime.service.authorize(request.code, true, runtime.session)).rejects.toThrow("RPC unavailable");
    vi.mocked(runtime.network.now).mockResolvedValueOnce(Math.floor(NOW / 1000) + 61);
    await expectCode(runtime.service.authorize(request.code, true, runtime.session), "CHAIN_CLOCK");
    for (const state of ["pending", "minted"] as const) {
      vi.mocked(runtime.network.state).mockResolvedValue(await runtime.minted("alice", state));
      await expectCode(runtime.service.authorize(request.code, true, runtime.session), "ALREADY_MINTED");
    }
    expect(runtime.network.sign).not.toHaveBeenCalled();
  });

  it("will not issue for a different browser or wallet until the existing reservation expires", async () => {
    const runtime = setup(); const first = await runtime.ready(); runtime.prove(first.code);
    await runtime.service.authorize(first.code, true, runtime.session);
    const secondSession = runtime.connectedSession(OTHER_WALLET);
    const second = await runtime.ready("alice", secondSession); runtime.prove(second.code, secondSession, OTHER_WALLET);
    await expectCode(runtime.service.authorize(second.code, true, secondSession), "MINT_RESERVED");
    runtime.prove(first.code, runtime.session, OTHER_WALLET);
    await expectCode(runtime.service.authorize(first.code, true, runtime.session), "REQUEST_WALLET_MISMATCH");
    expect(runtime.network.sign).toHaveBeenCalledTimes(1);
    runtime.setNow(NOW + 601_000); runtime.prove(second.code, secondSession, OTHER_WALLET);
    expect((await runtime.service.authorize(second.code, true, secondSession)).transaction.from).toBe(OTHER_WALLET);
    expect(runtime.network.sign).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the remaining request window is too short", async () => {
    const runtime = setup(); const request = await runtime.ready();
    runtime.setNow(request.expiresAt - 15_000); runtime.prove(request.code);
    await expectCode(runtime.service.authorize(request.code, true, runtime.session), "REQUEST_EXPIRED");
    expect(runtime.network.sign).not.toHaveBeenCalled();
  });

  it("does not sign when reservation persistence fails", async () => {
    const runtime = setup(); const request = await runtime.ready(); runtime.prove(request.code);
    const original = runtime.store.put.bind(runtime.store);
    vi.spyOn(runtime.store, "put").mockImplementation(async (key, value) => { if (key.startsWith("issuance:")) throw new Error("disk full"); return original(key, value); });
    await expect(runtime.service.authorize(request.code, true, runtime.session)).rejects.toThrow("disk full");
    expect(runtime.network.sign).not.toHaveBeenCalled();
    expect(runtime.network.transaction).not.toHaveBeenCalled();
  });

  it("retains the reservation after signer failure and reuses its exact nonce", async () => {
    const runtime = setup(); const request = await runtime.ready(); runtime.prove(request.code);
    vi.mocked(runtime.network.sign).mockRejectedValueOnce(new Error("signing unavailable"));
    await expect(runtime.service.authorize(request.code, true, runtime.session)).rejects.toThrow("signing unavailable");
    const reserved = await runtime.store.get<{ authorization: { nonce: Hex } }>("issuance:alice");
    await runtime.service.authorize(request.code, true, runtime.session);
    expect(vi.mocked(runtime.network.sign).mock.calls[1][0].nonce).toBe(reserved!.authorization.nonce);
  });

  it("rejects stored issuance commitment tampering before transaction construction", async () => {
    const runtime = setup(); const request = await runtime.ready(); runtime.prove(request.code);
    await runtime.service.authorize(request.code, true, runtime.session);
    const original = (await runtime.store.get<Record<string, any>>("issuance:alice"))!;
    for (const field of ["handleKey", "assessmentDigest", "artifactDigest", "tokenURIHash"]) {
      await runtime.store.put("issuance:alice", { ...original, authorization: { ...original.authorization, [field]: TX_HASH } });
      await expect(runtime.service.authorize(request.code, true, runtime.session)).rejects.toThrow("commitment mismatch");
    }
    await runtime.store.put("issuance:alice", { ...original, tokenURI: "https://evil.example" });
    await expect(runtime.service.authorize(request.code, true, runtime.session)).rejects.toThrow("commitment mismatch");
  });

  it.each(["wallet", "logout", "session expiry"])("withholds transaction when %s changes during signing", async change => {
    const runtime = setup(); const request = await runtime.ready(); runtime.prove(request.code);
    vi.mocked(runtime.network.sign).mockImplementation(async () => {
      if (change === "wallet") runtime.session.wallet = OTHER_WALLET;
      if (change === "logout") runtime.sessions.logout(runtime.session);
      if (change === "session expiry") runtime.session.expiresAt = NOW;
      return `0x${"1".repeat(130)}`;
    });
    await expectCode(runtime.service.authorize(request.code, true, runtime.session), "WALLET_CHANGED");
  });

  it("preserves signed issuance and canonical assessment across durable service restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sg-open-service-test-")); paths.push(directory);
    const store = await FileKeyValueStore.create(join(directory, "state"));
    const runtime = setup({ store });
    const repository = new FileAssessmentRepository(join(directory, "assessments"));
    runtime.service.options.assessments = new AssessmentCoordinator({ provider: new DevelopmentAssessmentProvider(), repository });
    const request = await runtime.ready(); runtime.prove(request.code);
    const first = await runtime.service.authorize(request.code, true, runtime.session);
    const restarted = new OpenMintService({ ...runtime.service.options, store: await FileKeyValueStore.create(join(directory, "state")), assessments: new AssessmentCoordinator({ provider: new DevelopmentAssessmentProvider(), repository: new FileAssessmentRepository(join(directory, "assessments")) }) });
    expect(await restarted.authorize(request.code, true, runtime.session)).toEqual(first);
    expect(runtime.network.sign).toHaveBeenCalledTimes(1);
    expect((await restarted.artifact("alice"))!.assessment.id).toBe(request.assessmentId);
  });
});
