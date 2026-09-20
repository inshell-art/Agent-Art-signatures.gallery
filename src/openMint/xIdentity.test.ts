import { afterEach, describe, expect, it, vi } from "vitest";
import { DevelopmentXIdentityResolver, validateXIdentity, XApiIdentityResolver, XIdentityResponseInvalidError, X_IDENTITY_MAX_RESPONSE_BYTES, X_USER_LOOKUP_ENDPOINT } from "./xIdentity.js";
import type { AssessmentExecution, ProviderReceipt } from "./assessmentOperations.js";

const NOW = new Date("2026-09-16T00:00:00.000Z");
const valid = { data: { id: "123456789", username: "Alice_Bob_Key", name: "Ignored display name" } };
const transport = (payload: unknown = valid) => vi.fn(async () => new Response(JSON.stringify(payload))) as unknown as typeof fetch;
function executionRecorder() {
  const receipts: ProviderReceipt[] = [];
  const execution: AssessmentExecution = { attemptId: "attempt-test", beforeDispatch: vi.fn(async () => {}),
    recordReceipt: vi.fn(async receipt => { receipts.push(receipt); }), identityVerified: vi.fn(async () => {}),
    recordOutcome: vi.fn(async () => {}), assessmentPersisted: vi.fn(async () => {}) };
  return { execution, receipts };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("authoritative X username lookup", () => {
  it("uses the fixed official endpoint and server bearer token, preserving only X-returned spelling", async () => {
    const fetch = transport();
    const resolver = new XApiIdentityResolver({ bearerToken: "mock-server-token", fetch, now: () => NOW });
    const identity = await resolver.resolve("@ALICE_BOB_KEY");
    expect(identity).toEqual({ canonicalHandle: "alice_bob_key", username: "Alice_Bob_Key", userId: "123456789", verifiedAt: NOW.toISOString(), provenance: "x-api", freshness: "verified-at-preparation" });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(fetch).toHaveBeenCalledWith(`${X_USER_LOOKUP_ENDPOINT}alice_bob_key`, expect.objectContaining({ method: "GET", redirect: "error", headers: { Authorization: "Bearer mock-server-token", Accept: "application/json" } }));
    expect(JSON.stringify(identity)).not.toContain("mock-server-token");
  });

  it.each([
    null, [], {}, { errors: [{ title: "Not Found" }] }, { ...valid, errors: [] },
    { data: { id: "123", username: "other" } }, { data: { id: "123", username: "@Alice_Bob_Key" } },
    { data: { id: "", username: "Alice_Bob_Key" } }, { data: { id: 123, username: "Alice_Bob_Key" } },
    { data: { id: "0", username: "Alice_Bob_Key" } }, { data: { id: "01", username: "Alice_Bob_Key" } },
    { data: { id: "1".repeat(21), username: "Alice_Bob_Key" } },
  ])("fails closed for missing, ambiguous or mismatched users: %j", async payload => {
    const fetch = transport(payload);
    await expect(new XApiIdentityResolver({ bearerToken: "mock-token", fetch }).resolve("alice_bob_key")).rejects.toThrow(XIdentityResponseInvalidError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 404, 429, 500])("does not retry HTTP %s or expose provider error bodies", async status => {
    const fetch = vi.fn(async () => new Response("private response content", { status })) as unknown as typeof globalThis.fetch;
    await expect(new XApiIdentityResolver({ bearerToken: "mock-token", fetch }).resolve("alice")).rejects.toThrow(`HTTP ${status}`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("redacts network error details, refuses malformed handles before transport and never falls back", async () => {
    const fetch = vi.fn(async () => { throw new Error("private credential details"); }) as unknown as typeof globalThis.fetch;
    const resolver = new XApiIdentityResolver({ bearerToken: "mock-token", fetch });
    await expect(resolver.resolve("alice")).rejects.toThrow("X username verification transport failed.");
    await expect(resolver.resolve("alice/../../bob")).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    () => new Response("bad json"), () => new Response(null),
    () => new Response("x".repeat(X_IDENTITY_MAX_RESPONSE_BYTES + 1)),
    () => new Response("{}", { headers: { "content-length": String(X_IDENTITY_MAX_RESPONSE_BYTES + 1) } }),
    () => new Response("{}", { headers: { "content-length": "invalid" } }),
    () => new Response(new Uint8Array([0xff])),
  ])("bounds and validates response bodies", async response => {
    const fetch = vi.fn(async () => response()) as unknown as typeof globalThis.fetch;
    await expect(new XApiIdentityResolver({ bearerToken: "mock-token", fetch }).resolve("alice")).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts stalled requests and bounds the entire body read", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response(new ReadableStream())) as unknown as typeof globalThis.fetch;
    const pending = new XApiIdentityResolver({ bearerToken: "mock-token", fetch, timeoutMs: 25 }).resolve("alice");
    const failure = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(25); await failure;
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["", " ", "token\nvalue", "token value", undefined, 123])("rejects unsafe token configuration: %j", bearerToken => {
    expect(() => new XApiIdentityResolver({ bearerToken: bearerToken as string })).toThrow("bearer token");
  });
  it.each([0, -1, 1.5, 60_001, NaN])("rejects invalid timeout %s", timeoutMs => {
    expect(() => new XApiIdentityResolver({ bearerToken: "mock-token", timeoutMs })).toThrow("timeout");
  });
  it("keeps explicit fixture identities visibly simulated and validates saved snapshots", async () => {
    expect((await new DevelopmentXIdentityResolver().resolve("alice")).verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const identity = await new DevelopmentXIdentityResolver({ alice: "ALIce" }, () => NOW).resolve("@Alice");
    expect(identity).toMatchObject({ username: "ALIce", provenance: "development-fixture" });
    for (const change of [{ canonicalHandle: "ALICE" }, { username: "Bob" }, { verifiedAt: "yesterday" }, { verifiedAt: "2026-09-16T00:00:00Z" }, { provenance: "client" }, { freshness: "live" }, { extra: true }]) {
      expect(() => validateXIdentity({ ...identity, ...change }, "alice")).toThrow();
    }
  });

  it.each([valid, { data: { id: "123", username: "wrong" } }])("persists one unknown-cost X receipt before semantic validation for %j", async payload => {
    const { execution, receipts } = executionRecorder();
    const resolver = new XApiIdentityResolver({ bearerToken: "private-token", fetch: transport(payload) });
    if (payload === valid) await resolver.resolve("alice_bob_key", execution);
    else await expect(resolver.resolve("alice_bob_key", execution)).rejects.toThrow(XIdentityResponseInvalidError);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ leg: "x-identity", category: "success", httpStatus: 200, usageStatus: "missing", cost: { status: "unknown", currency: "USD", scale: 10 } });
    expect(JSON.stringify(receipts)).not.toMatch(/private-token|Ignored display name|Alice_Bob_Key/);
    expect(execution.beforeDispatch).not.toHaveBeenCalled();
  });

  it("cannot return an identity when receipt persistence fails", async () => {
    const { execution } = executionRecorder();
    vi.mocked(execution.recordReceipt).mockRejectedValue(new Error("receipt unavailable"));
    const fetch = transport();
    await expect(new XApiIdentityResolver({ bearerToken: "token", fetch }).resolve("alice_bob_key", execution)).rejects.toThrow("receipt unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(execution.recordReceipt).toHaveBeenCalledTimes(1);
  });
  it.each(["transport", "body", "receipt"])("does not label %s failure as a semantic invalidity", async failure => {
    const { execution } = executionRecorder();
    if (failure === "receipt") vi.mocked(execution.recordReceipt).mockRejectedValue(new Error("receipt unavailable"));
    const fetch = failure === "transport" ? vi.fn(async () => { throw new Error("transport failed"); }) as typeof globalThis.fetch
      : failure === "body" ? vi.fn(async () => new Response("bad JSON")) as typeof globalThis.fetch : transport();
    await expect(new XApiIdentityResolver({ bearerToken: "mock-token", fetch }).resolve("alice_bob_key", execution)).rejects.not.toBeInstanceOf(XIdentityResponseInvalidError);
  });

  it.each([
    ["http-error", () => new Response('{"error":"private details"}', { status: 403 })],
    ["invalid-body", () => new Response('{"data":')],
    ["oversized-body", () => new Response("{}", { headers: { "content-length": String(X_IDENTITY_MAX_RESPONSE_BYTES + 1) } })],
  ] as const)("records %s without fabricated costs", async (category, response) => {
    const { execution, receipts } = executionRecorder();
    const fetch = vi.fn(async () => response()) as unknown as typeof globalThis.fetch;
    await expect(new XApiIdentityResolver({ bearerToken: "token", fetch }).resolve("alice", execution)).rejects.toThrow();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ category, cost: { status: "unknown" } });
    expect(JSON.stringify(receipts)).not.toContain("private details");
  });

  it("records transport uncertainty and ignores a late completed lookup after timeout", async () => {
    vi.useFakeTimers();
    const { execution, receipts } = executionRecorder();
    let respond!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { respond = resolve; })) as unknown as typeof globalThis.fetch;
    const pending = new XApiIdentityResolver({ bearerToken: "token", fetch, timeoutMs: 25 }).resolve("alice_bob_key", execution);
    const failure = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(25); await failure;
    expect(receipts[0]).toMatchObject({ category: "timeout", cost: { status: "unknown" } });
    respond(new Response(JSON.stringify(valid)));
    await vi.advanceTimersByTimeAsync(1);
    expect(execution.recordReceipt).toHaveBeenCalledTimes(1);
    expect(receipts[0]).not.toHaveProperty("httpStatus");
  });
});
