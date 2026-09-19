import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { AssessmentCoordinator, type AssessmentRepository } from "./assessment.js";
import { AssessmentOperations, type AssessmentAttempt, type AssessmentOperationsOptions } from "./assessmentOperations.js";
import { FileAssessmentRepository, MemoryAssessmentRepository } from "./assessmentStore.js";
import { GrokAssessmentProvider } from "./grok.js";
import type { OpenMintNetwork } from "./network.js";
import { generationPolicy, GROK_PILOT_PROFILE } from "./providerProfile.js";
import { WalletSessions, type SiteSession } from "./security.js";
import { OpenMintService } from "./service.js";
import { FileKeyValueStore, MemoryKeyValueStore, type KeyValueStore } from "./storage.js";
import { XApiIdentityResolver } from "./xIdentity.js";

// Keep the production SVG and metadata commitment path. Renderer-specific tests own PNG pixels.
vi.mock("../v1/renderer.js", async importOriginal => {
  const original = await importOriginal<typeof import("../v1/renderer.js")>();
  return { ...original, renderCardPng: vi.fn(async (svg: Uint8Array) => Buffer.from(`test-raster:${original.sha256Hex(svg)}`)) };
});

const NOW = Date.parse("2026-09-19T12:00:00.000Z");
const WALLET = getAddress(`0x${"1".repeat(40)}`);
const CONTRACT = getAddress(`0x${"3".repeat(40)}`);
const APPROVED_POLICY = { OPEN_MINT_GENERATION_ENABLED: "1", OPEN_MINT_PILOT_APPROVED: "1", OPEN_MINT_PILOT_HANDLE: "alice",
  OPEN_MINT_RESERVATION_USD_TICKS: "10000000000", OPEN_MINT_EXPOSURE_USD_TICKS: "10000000000" };
const paths: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
interface RecordedEvent { kind: "write" | "x-fetch" | "grok-fetch" | "assessment-published"; key?: string; value?: unknown }
function responseBody(answer: Record<string, unknown> = { kind: "accepted", handle: "alice", mbti: "INTJ", reason: null, xUserId: "1234" }) {
  return {
    id: "response-mocked-assessment", model: GROK_PILOT_PROFILE.model, status: "completed",
    citations: ["https://x.com/ALIce/status/123"],
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, cost_in_usd_ticks: "200000000", num_server_side_tools_used: 1 },
    output: [{ type: "x_search_call", status: "completed" }, { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(answer) }] }],
  };
}
function setup(options: {
  store?: KeyValueStore;
  repository?: AssessmentRepository;
  useDefaultOperations?: boolean;
  credentials?: boolean;
  enabled?: boolean | (() => boolean);
  policy?: Partial<AssessmentOperationsOptions>;
  now?: number;
  response?: unknown;
  xResponse?: unknown;
  afterX?: () => void;
} = {}) {
  let now = options.now ?? NOW;
  const events: RecordedEvent[] = [];
  const underlyingStore = options.store ?? new MemoryKeyValueStore();
  const store: KeyValueStore = {
    get: key => underlyingStore.get(key), entries: prefix => underlyingStore.entries(prefix),
    put: async (key, value) => { await underlyingStore.put(key, value); events.push({ kind: "write", key, value: structuredClone(value) }); },
  };
  const underlyingRepository = options.repository ?? new MemoryAssessmentRepository();
  const repository: AssessmentRepository = {
    get: handle => underlyingRepository.get(handle),
    putIfAbsent: async assessment => { const saved = await underlyingRepository.putIfAbsent(assessment); events.push({ kind: "assessment-published", value: saved }); return saved; },
  };
  const xFetch = vi.fn(async () => {
    events.push({ kind: "x-fetch" }); options.afterX?.();
    return new Response(JSON.stringify(options.xResponse ?? { data: { id: "1234", username: "ALIce" } }), { headers: { "x-request-id": "x-request-mock" } });
  });
  const grokFetch = vi.fn(async () => {
    events.push({ kind: "grok-fetch" });
    return new Response(JSON.stringify(options.response ?? responseBody()), { headers: { "x-request-id": "grok-request-mock" } });
  });
  const provider = options.credentials === false ? undefined : new GrokAssessmentProvider({ apiKey: "mock-xai-test-key", profile: GROK_PILOT_PROFILE, fetch: x => grokFetch() });
  const identityResolver = options.credentials === false ? undefined : new XApiIdentityResolver({ bearerToken: "mock-x-test-token", fetch: x => xFetch(), now: () => new Date(now) });
  const assessments = new AssessmentCoordinator({ provider, identityResolver, expectedProvenance: "grok", repository, now: () => new Date(now) });
  const operations = options.useDefaultOperations ? undefined : new AssessmentOperations({ store, generationEnabled: options.enabled ?? true, now: () => now,
    allowedHandle: "alice", reservationUsdTicks: "10000000000", maxExposureUsdTicks: "10000000000", ...options.policy });
  const network: OpenMintNetwork = {
    chainId: 31337, address: CONTRACT, authorizer: CONTRACT,
    now: vi.fn(async () => Math.floor(now / 1000)),
    state: vi.fn(async () => ({ state: "unminted" as const })),
    walletContext: vi.fn(async (recipient?: Address) => ({ chainId: "0x7a69" as const, contract: CONTRACT, blockNumber: "0xa" as const,
      blockHash: `0x${"b".repeat(64)}` as Hex, ...(recipient ? { nonce: "0x1" as const } : {}) })),
    sign: vi.fn(async () => `0x${"1".repeat(130)}` as Hex),
    transaction: vi.fn(async (_handle, authorization) => ({ from: authorization.recipient, to: CONTRACT, data: "0x1234" as const, value: "0x0" as const, chainId: "0x7a69" as const })),
  };
  const sessions = new WalletSessions("https://signatures.example", 31337, () => now);
  const connectedSession = () => {
    const session = sessions.session().session;
    session.wallet = WALLET; session.walletProof = { wallet: WALLET, expiresAt: now + 600_000 };
    return session;
  };
  const session = connectedSession();
  const service = new OpenMintService({ assessments, operations, store, fixture: false, origin: sessions.origin, network, now: () => now, assessmentProfileVersion: GROK_PILOT_PROFILE.id });
  const request = async (handle = "alice", target: SiteSession = session) => {
    const result = await service.request(handle, target); await service.idle(); return service.getRequest(result.code);
  };
  return { service, operations: service.operations, assessments, store, underlyingStore, repository, underlyingRepository, events,
    xFetch, grokFetch, network, session, connectedSession, request, setNow: (value: number) => { now = value; } };
}
function eventIndex(events: RecordedEvent[], predicate: (event: RecordedEvent) => boolean) {
  const index = events.findIndex(predicate); expect(index).toBeGreaterThanOrEqual(0); return index;
}

describe("real-mode assessment operations integration without paid calls", () => {
  it("keeps real generation disabled by default even with both configured transports", async () => {
    const runtime = setup({ useDefaultOperations: true });
    await expect(runtime.service.request("alice", runtime.session)).rejects.toMatchObject({ code: "GENERATION_DISABLED" });
    expect(runtime.xFetch).not.toHaveBeenCalled(); expect(runtime.grokFetch).not.toHaveBeenCalled();
    expect(await runtime.store.entries("budget:")).toEqual([]);
    expect(await runtime.store.entries("attempt:")).toEqual([]);
    expect(await runtime.store.entries("request:")).toEqual([]);
  });

  it("orders durable markers, receipts, canonical publication and artifact preparation around the direct adapters", async () => {
    const runtime = setup(); const request = await runtime.request("@aLIce");
    expect(request.status).toBe("ready");
    const attempt = await runtime.operations.get("alice") as AssessmentAttempt;
    const report = await runtime.operations.report(attempt.id);
    expect(attempt).toMatchObject({ admittedAt: NOW, profileVersion: GROK_PILOT_PROFILE.id, outcome: "accepted", artifact: "prepared", reconciliation: "operator-review", identity: { username: "ALIce", userId: "1234" } });
    expect(report).toMatchObject({ accounting: "unresolved", exposureUsdTicks: "10000000000", automaticRetryAllowed: false });
    expect(report!.receipts).toMatchObject([
      { leg: "x-identity", category: "success", httpStatus: 200, requestId: "x-request-mock", usageStatus: "missing", cost: { status: "unknown" } },
      { leg: "grok", category: "success", responseId: "response-mocked-assessment", model: GROK_PILOT_PROFILE.model, usage: { costInUsdTicks: "200000000" }, cost: { status: "actual", amount: "200000000" } },
    ]);
    const positions = [
      eventIndex(runtime.events, event => event.key === "budget:paid_v1"),
      eventIndex(runtime.events, event => event.key === "attempt:alice"),
      eventIndex(runtime.events, event => !!event.key?.startsWith("request:")),
      eventIndex(runtime.events, event => event.key === "attempt:alice" && (event.value as AssessmentAttempt).phases.xDispatchedAt !== undefined),
      eventIndex(runtime.events, event => event.kind === "x-fetch"),
      eventIndex(runtime.events, event => event.key === `receipt:${attempt.id}_x`),
      eventIndex(runtime.events, event => event.key === "attempt:alice" && (event.value as AssessmentAttempt).phases.xVerifiedAt !== undefined),
      eventIndex(runtime.events, event => event.key === "attempt:alice" && (event.value as AssessmentAttempt).phases.grokDispatchedAt !== undefined),
      eventIndex(runtime.events, event => event.kind === "grok-fetch"),
      eventIndex(runtime.events, event => event.key === `receipt:${attempt.id}_grok`),
      eventIndex(runtime.events, event => event.key === "attempt:alice" && (event.value as AssessmentAttempt).outcome === "accepted"),
      eventIndex(runtime.events, event => event.kind === "assessment-published"),
      eventIndex(runtime.events, event => event.key === "attempt:alice" && !!(event.value as AssessmentAttempt).acceptedAssessment),
      eventIndex(runtime.events, event => event.key === "artifact:alice"),
    ];
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(positions).size).toBe(positions.length);
    const artifact = (await runtime.service.artifact("alice"))!;
    expect(artifact.assessment.id).toBe(attempt.acceptedAssessment!.id);
    expect(artifact.renderHandle).toBe("ALIce");
    const metadata = (await runtime.service.asset(artifact.metadataSha256, "json"))!.toString();
    for (const privateField of [attempt.id, "mock-xai-test-key", "mock-x-test-token", "x-request-mock", "costInUsdTicks", "reconciliation"]) expect(metadata).not.toContain(privateField);
    await runtime.service.authorize(request.code, true, runtime.session);
    expect(runtime.network.sign).toHaveBeenCalledTimes(1);
    expect(runtime.xFetch).toHaveBeenCalledTimes(1); expect(runtime.grokFetch).toHaveBeenCalledTimes(1);
  });

  it("reuses exact saved bytes after kill activation, new sessions, expiry, restart and credential removal", async () => {
    const path = await mkdtemp(join(tmpdir(), "sg-service-ops-reuse-")); paths.push(path);
    let enabled = true;
    const runtime = setup({ store: await FileKeyValueStore.create(join(path, "records")), repository: new FileAssessmentRepository(join(path, "assessments")), enabled: () => enabled });
    const first = await runtime.request(); const artifact = (await runtime.service.artifact("alice"))!;
    const before = await readFile(join(path, "assessments", "alice.json"), "utf8");
    const assets = await Promise.all([[artifact.svgSha256, "svg"], [artifact.pngSha256, "png"], [artifact.metadataSha256, "json"]].map(([hash, extension]) => runtime.service.asset(hash, extension)));
    enabled = false;
    expect((await runtime.request("ALICE")).code).toBe(first.code);
    expect((await runtime.request("@Alice", runtime.connectedSession())).assessmentId).toBe(first.assessmentId);
    const restarted = setup({ store: await FileKeyValueStore.create(join(path, "records")), repository: new FileAssessmentRepository(join(path, "assessments")), credentials: false, enabled: false, now: first.expiresAt + 1 });
    await restarted.service.recoverInterruptedRequests();
    const recovered = await restarted.request("@aLiCe");
    expect(recovered.status).toBe("ready"); expect(recovered.assessmentId).toBe(first.assessmentId);
    expect(await restarted.service.artifact("alice")).toEqual(artifact);
    expect(await readFile(join(path, "assessments", "alice.json"), "utf8")).toBe(before);
    const recoveredAssets = await Promise.all([[artifact.svgSha256, "svg"], [artifact.pngSha256, "png"], [artifact.metadataSha256, "json"]].map(([hash, extension]) => restarted.service.asset(hash, extension)));
    expect(recoveredAssets).toEqual(assets);
    await restarted.service.authorize(recovered.code, true, restarted.session);
    expect(restarted.network.sign).toHaveBeenCalledTimes(1);
    expect(restarted.xFetch).not.toHaveBeenCalled(); expect(restarted.grokFetch).not.toHaveBeenCalled();
    expect(runtime.xFetch).toHaveBeenCalledTimes(1); expect(runtime.grokFetch).toHaveBeenCalledTimes(1);
  });

  it("allows saved-result authorization with unknown X cost while blocking another paid handle", async () => {
    const runtime = setup({ policy: { allowedHandle: undefined, maxTotalAttempts: 3, dailyLimit: 3, maxExposureUsdTicks: "30000000000" } });
    const first = await runtime.request(); expect(first.status).toBe("ready");
    await expect(runtime.service.request("bob", runtime.session)).rejects.toMatchObject({ code: "ASSESSMENT_ACCOUNTING_UNKNOWN" });
    const reused = await runtime.request("ALICE", runtime.connectedSession());
    expect(reused.assessmentId).toBe(first.assessmentId);
    await runtime.service.authorize(first.code, true, runtime.session);
    expect(runtime.network.sign).toHaveBeenCalledTimes(1);
    expect(runtime.xFetch).toHaveBeenCalledTimes(1); expect(runtime.grokFetch).toHaveBeenCalledTimes(1);
  });

  it("stops Grok if the generation switch changes after X dispatch", async () => {
    let enabled = true;
    const runtime = setup({ enabled: () => enabled, afterX: () => { enabled = false; } });
    const request = await runtime.request(); expect(request.status).toBe("failed");
    expect(runtime.xFetch).toHaveBeenCalledTimes(1); expect(runtime.grokFetch).not.toHaveBeenCalled();
    expect(await runtime.repository.get("alice")).toBeUndefined(); expect(await runtime.service.artifact("alice")).toBeUndefined();
    const attempt = await runtime.operations.get("alice") as AssessmentAttempt;
    expect(attempt.phases.grokDispatchedAt).toBeUndefined();
    expect(await runtime.operations.report(attempt.id)).toMatchObject({ accounting: "unresolved", exposureUsdTicks: "10000000000" });
    enabled = true;
    await expect(runtime.service.request("ALICE", runtime.session)).rejects.toMatchObject({ code: "ASSESSMENT_RETRY_BLOCKED" });
  });

  it("enforces pricing expiry again between X and Grok while retaining the spent attempt", async () => {
    const expiresAt = Date.parse(GROK_PILOT_PROFILE.pricingChangesAt);
    let policyTime = expiresAt - 1;
    const runtime = setup({ now: policyTime, enabled: () => generationPolicy(false, APPROVED_POLICY, new Date(policyTime)).enabled,
      afterX: () => { policyTime = expiresAt; } });
    expect((await runtime.request()).status).toBe("failed");
    expect(runtime.xFetch).toHaveBeenCalledTimes(1); expect(runtime.grokFetch).not.toHaveBeenCalled();
    const attempt = await runtime.operations.get("alice") as AssessmentAttempt;
    expect(attempt.phases.grokDispatchedAt).toBeUndefined();
    expect(await runtime.operations.report(attempt.id)).toMatchObject({ accounting: "unresolved", exposureUsdTicks: "10000000000" });
    await expect(runtime.service.request("ALICE", runtime.connectedSession())).rejects.toMatchObject({ code: "ASSESSMENT_RETRY_BLOCKED" });
  });

  it("keeps accepted-result reuse and authorization available after pricing expiry and key removal", async () => {
    const expiresAt = Date.parse(GROK_PILOT_PROFILE.pricingChangesAt);
    let policyTime = expiresAt - 1;
    const runtime = setup({ now: policyTime, enabled: () => generationPolicy(false, APPROVED_POLICY, new Date(policyTime)).enabled });
    const first = await runtime.request(); expect(first.status).toBe("ready");
    const artifact = await runtime.service.artifact("alice");
    policyTime = expiresAt + 1;
    const restarted = setup({ store: runtime.underlyingStore, repository: runtime.underlyingRepository, credentials: false, now: policyTime,
      enabled: () => generationPolicy(false, APPROVED_POLICY, new Date(policyTime)).enabled });
    await restarted.service.recoverInterruptedRequests();
    const reused = await restarted.request("ALICE");
    expect(reused).toMatchObject({ status: "ready", assessmentId: first.assessmentId });
    expect(await restarted.service.artifact("alice")).toEqual(artifact);
    await restarted.service.authorize(reused.code, true, restarted.session);
    expect(restarted.network.sign).toHaveBeenCalledTimes(1);
    expect(restarted.xFetch).not.toHaveBeenCalled(); expect(restarted.grokFetch).not.toHaveBeenCalled();
  });

  it("records charged abstention without creating an assessment, artifact or authority", async () => {
    const runtime = setup({ response: responseBody({ kind: "abstained", handle: "alice", xUserId: "1234", mbti: null, reason: "insufficient-evidence" }) });
    const request = await runtime.request();
    expect(request).toMatchObject({ status: "failed", errorCategory: "assessment-abstained" });
    expect(await runtime.repository.get("alice")).toBeUndefined();
    expect(await runtime.store.entries("artifact:")).toEqual([]); expect(await runtime.store.entries("asset:")).toEqual([]);
    const attempt = await runtime.operations.get("alice") as AssessmentAttempt;
    expect(attempt).toMatchObject({ outcome: "abstained", abstentionReason: "insufficient-evidence" });
    expect((await runtime.operations.report(attempt.id))!.receipts[1]).toMatchObject({ cost: { status: "actual", amount: "200000000" } });
    await expect(runtime.service.authorize(request.code, true, runtime.session)).rejects.toMatchObject({ code: "NOT_READY" });
    await expect(runtime.service.request("ALICE", runtime.connectedSession())).rejects.toMatchObject({ code: "ASSESSMENT_RETRY_BLOCKED" });
    expect(runtime.network.sign).not.toHaveBeenCalled(); expect(runtime.grokFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["invalid-mbti", "wrong-subject", "missing-search"])("records semantic invalidity %s independently from transport and spend", async alteration => {
    const body = responseBody();
    if (alteration === "missing-search") body.output = body.output.filter(item => item.type !== "x_search_call");
    else body.output[1].content![0].text = JSON.stringify({ kind: "accepted", handle: "alice", mbti: alteration === "invalid-mbti" ? "XXXX" : "INTJ", reason: null, xUserId: alteration === "wrong-subject" ? "9876" : "1234" });
    const runtime = setup({ response: body }); const request = await runtime.request();
    expect(request.status).toBe("failed");
    const attempt = await runtime.operations.get("alice") as AssessmentAttempt;
    expect(attempt).toMatchObject({ outcome: "invalid", reconciliation: "operator-review" });
    expect((await runtime.operations.report(attempt.id))!.receipts[1]).toMatchObject({ category: "success", cost: { status: "actual", amount: "200000000" } });
    expect(await runtime.repository.get("alice")).toBeUndefined(); expect(await runtime.service.artifact("alice")).toBeUndefined();
    await expect(runtime.service.authorize(request.code, true, runtime.session)).rejects.toMatchObject({ code: "NOT_READY" });
    expect(runtime.network.sign).not.toHaveBeenCalled();
  });

  it.each(["reservation", "attempt", "request", "x-marker", "grok-marker"])("does not dispatch the next provider when durable %s writing fails", async boundary => {
    const runtime = setup(); const original = runtime.store.put.bind(runtime.store); let injected = false;
    vi.spyOn(runtime.store, "put").mockImplementation(async (key, value) => {
      const attempt = value as AssessmentAttempt;
      const target = boundary === "reservation" ? key === "budget:paid_v1"
        : boundary === "request" ? key.startsWith("request:")
          : key === "attempt:alice" && (boundary === "attempt" || (boundary === "x-marker" ? attempt.phases.xDispatchedAt !== undefined : attempt.phases.grokDispatchedAt !== undefined));
      if (!injected && target) { injected = true; throw new Error("injected private disk failure"); }
      await original(key, value);
    });
    if (["reservation", "attempt"].includes(boundary)) await expect(runtime.service.request("alice", runtime.session)).rejects.toMatchObject({ name: "AssessmentPersistenceError", message: "Assessment operational persistence failed." });
    else if (boundary === "request") await expect(runtime.service.request("alice", runtime.session)).rejects.toThrow("injected private disk failure");
    else expect((await runtime.request()).status).toBe("failed");
    await runtime.service.idle(); expect(injected).toBe(true);
    expect(runtime.xFetch).toHaveBeenCalledTimes(boundary === "grok-marker" ? 1 : 0); expect(runtime.grokFetch).not.toHaveBeenCalled();
    expect(await runtime.repository.get("alice")).toBeUndefined(); expect(await runtime.service.artifact("alice")).toBeUndefined();
    if (boundary === "x-marker" || boundary === "grok-marker") {
      expect(await runtime.operations.get("alice")).toMatchObject({ failureCategory: "storage", outcome: boundary === "x-marker" ? "failed-before-dispatch" : "failed-after-response" });
      await expect(runtime.service.request("ALICE", runtime.connectedSession())).rejects.toMatchObject({ code: "ASSESSMENT_RETRY_BLOCKED" });
    }
  });

  it.each(["x-receipt", "grok-receipt", "semantic-outcome", "accepted-link", "artifact", "request-ready"])("never repeats paid work after %s write failure and a file-store restart", async boundary => {
    const path = await mkdtemp(join(tmpdir(), "sg-service-ops-fault-")); paths.push(path);
    const runtime = setup({ store: await FileKeyValueStore.create(join(path, "records")), repository: new FileAssessmentRepository(join(path, "assessments")) });
    const original = runtime.store.put.bind(runtime.store); let injected = false;
    vi.spyOn(runtime.store, "put").mockImplementation(async (key, value) => {
      const attempt = value as AssessmentAttempt;
      const target = boundary === "x-receipt" ? /^receipt:.*_x$/.test(key)
        : boundary === "grok-receipt" ? /^receipt:.*_grok$/.test(key)
          : boundary === "semantic-outcome" ? key === "attempt:alice" && attempt.outcome === "accepted"
            : boundary === "accepted-link" ? key === "attempt:alice" && !!attempt.acceptedAssessment
              : boundary === "artifact" ? key === "artifact:alice"
                : key.startsWith("request:") && (value as { status?: string }).status === "ready";
      if (!injected && target) { injected = true; throw new Error("injected private disk failure"); }
      await original(key, value);
    });
    const failed = await runtime.request(); expect(failed.status).toBe("failed"); expect(injected).toBe(true);
    expect(failed.error).not.toContain("private disk");
    if (["x-receipt", "grok-receipt", "semantic-outcome", "accepted-link"].includes(boundary)) {
      expect(await runtime.operations.get("alice")).toMatchObject({ failureCategory: "storage" });
    }
    const saved = await runtime.repository.get("alice");
    const restarted = setup({ store: await FileKeyValueStore.create(join(path, "records")), repository: new FileAssessmentRepository(join(path, "assessments")) });
    await restarted.service.recoverInterruptedRequests();
    if (["accepted-link", "artifact", "request-ready"].includes(boundary)) {
      expect(saved).toBeDefined();
      const recovered = await restarted.request("ALICE");
      expect(recovered).toMatchObject({ status: "ready", assessmentId: saved!.id });
      expect((await restarted.service.artifact("alice"))!.assessment).toEqual(saved);
      expect(await restarted.operations.get("alice")).toMatchObject({ outcome: "accepted", acceptedAssessment: { id: saved!.id, digest: saved!.digest }, artifact: "prepared" });
    } else {
      expect(saved).toBeUndefined();
      await expect(restarted.service.request("ALICE", restarted.session)).rejects.toMatchObject({ code: "ASSESSMENT_RETRY_BLOCKED" });
      expect(await restarted.service.artifact("alice")).toBeUndefined();
    }
    expect(runtime.xFetch).toHaveBeenCalledTimes(1); expect(runtime.grokFetch).toHaveBeenCalledTimes(boundary === "x-receipt" ? 0 : 1);
    expect(restarted.xFetch).not.toHaveBeenCalled(); expect(restarted.grokFetch).not.toHaveBeenCalled();
  });

  it("blocks replay when canonical assessment publication fails after the paid response", async () => {
    const memory = new MemoryAssessmentRepository();
    const repository: AssessmentRepository = { get: handle => memory.get(handle), putIfAbsent: async () => { throw new Error("assessment publication disk failure"); } };
    const runtime = setup({ repository }); const request = await runtime.request();
    expect(request.status).toBe("failed"); expect(await runtime.service.artifact("alice")).toBeUndefined();
    expect(await runtime.operations.get("alice")).toMatchObject({ outcome: "accepted", failureCategory: "storage", reconciliation: "operator-review" });
    const restarted = setup({ store: runtime.underlyingStore, repository: memory });
    await restarted.service.recoverInterruptedRequests();
    await expect(restarted.service.request("ALICE", restarted.session)).rejects.toMatchObject({ code: "ASSESSMENT_RETRY_BLOCKED" });
    expect(runtime.grokFetch).toHaveBeenCalledTimes(1); expect(restarted.xFetch).not.toHaveBeenCalled(); expect(restarted.grokFetch).not.toHaveBeenCalled();
  });
});
