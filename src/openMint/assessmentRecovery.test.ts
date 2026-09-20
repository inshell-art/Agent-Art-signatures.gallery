import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AssessmentOperations, validateAssessmentRecoveryCommand, type AssessmentAttempt, type AssessmentOperationsOptions, type AssessmentRecoveryCommand, type ProviderReceipt } from "./assessmentOperations.js";
import { FileKeyValueStore, MemoryKeyValueStore } from "./storage.js";

const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const X_REJECTION: ProviderReceipt = { leg: "x-identity", startedAt: NOW, completedAt: NOW + 662, category: "http-error", httpStatus: 402,
  usageStatus: "missing", cost: { status: "unknown", currency: "USD", scale: 10 } };
const PREFIXES = ["attempt:", "receipt:", "budget:", "recovery:", "recoverylink:", "recoveryattempt:", "recoveryhead:"];
async function snapshot(store: MemoryKeyValueStore) { return (await Promise.all(PREFIXES.map(prefix => store.entries(prefix)))).flat(); }
async function setup(overrides: Partial<AssessmentOperationsOptions> = {}) {
  const store = new MemoryKeyValueStore();
  let now = NOW;
  const options: AssessmentOperationsOptions = { store, generationEnabled: true, allowedHandle: "alice", now: () => now, ...overrides };
  const ops = new AssessmentOperations(options), source = await ops.admit("alice", "profile-v1"), execution = await ops.execution("alice");
  await execution.beforeDispatch("x-identity"); await execution.recordReceipt(X_REJECTION);
  now += 1000; await ops.fail("alice", "identity", source.id);
  const command: AssessmentRecoveryCommand = { version: 1, sourceAttemptId: source.id, idempotencyKey: "recovery-review-1", operatorReference: "operator-7",
    approvalReference: "approval-new-attempt-2", rejectionEvidenceReference: "incident-x-http-402", billing: { actualCostUsdTicks: "0", evidenceReference: "invoice-review-88" },
    profileVersion: "profile-v1", reservationUsdTicks: "10000000000" };
  return { ops, store, source, execution, options, command, setNow: (value: number) => { now = value; } };
}

describe("explicit operator recovery", () => {
  it("previews without writes or generation permission and requires the exact reviewed digest", async () => {
    const { store, command, options } = await setup();
    const disabled = new AssessmentOperations({ ...options, generationEnabled: false }), before = await snapshot(store);
    const preview = await disabled.previewRecovery(command);
    expect(preview).toMatchObject({ handle: "alice", command, sourceReceipt: X_REJECTION, additionalAttempts: 1, totalReservationsAfter: 2,
      exposureAfterUsdTicks: "10000000000", dispatchAllowed: false });
    expect(await snapshot(store)).toEqual(before);
    await expect(disabled.stageRecovery(command, "a".repeat(64))).rejects.toMatchObject({ code: "ASSESSMENT_RECOVERY_REVIEW_REQUIRED" });
    await expect(disabled.stageRecovery(command, "")).rejects.toMatchObject({ code: "ASSESSMENT_RECOVERY_REVIEW_REQUIRED" });
    expect(await snapshot(store)).toEqual(before);
  });

  it("stages one linked admission while retaining original attempt, receipt, reservation and honest provider accounting", async () => {
    const { store, source, options, command } = await setup();
    const before = await snapshot(store), disabled = new AssessmentOperations({ ...options, generationEnabled: false });
    const preview = await disabled.previewRecovery(command), result = await disabled.stageRecovery(command, preview.reviewDigest);
    expect(result).toMatchObject({ sourceAttemptId: source.id, status: "staged", dispatchAllowed: false });
    expect(result.attemptId).not.toBe(source.id);
    for (const [key, value] of before) if (!key.startsWith("budget:")) expect(await store.get(key)).toEqual(value);
    const budget = await store.get<{ reservations: unknown[] }>("budget:paid_v1");
    expect(budget!.reservations).toHaveLength(2);
    expect(budget!.reservations[0]).toEqual((before.find(([key]) => key === "budget:paid_v1")![1] as { reservations: unknown[] }).reservations[0]);
    expect(await store.get("budget:2026-09-20")).toBe(2);
    expect(await disabled.report(source.id)).toMatchObject({ attempt: { id: source.id, outcome: "failed-after-response" }, receipts: [X_REJECTION],
      accounting: "unresolved", exposureUsdTicks: "10000000000", operatorReconciliation: { recoveryId: result.recoveryId, billing: command.billing } });
    expect(await disabled.report(result.attemptId)).toMatchObject({ attempt: { id: result.attemptId, recovery: { sourceAttemptId: source.id } }, recovery: result });
    expect(await disabled.stagedRecovery("alice", "profile-v1")).toMatchObject({ id: result.attemptId, phases: {}, outcome: "pending" });
    await expect(disabled.stagedRecovery("alice", "profile-v1", true)).rejects.toMatchObject({ code: "GENERATION_DISABLED" });
    expect(await disabled.get("alice")).toMatchObject({ outcome: "pending", phases: {} });
    const saved = await snapshot(store);
    expect(await disabled.stageRecovery(command, preview.reviewDigest)).toEqual(result);
    expect(await disabled.previewRecovery(command)).toEqual(preview);
    expect(await snapshot(store)).toEqual(saved);
  });

  it("binds idempotency to all evidence and never grants another recovery or a chained retry", async () => {
    const { ops, store, command } = await setup(), preview = await ops.previewRecovery(command);
    const result = await ops.stageRecovery(command, preview.reviewDigest), before = await snapshot(store);
    await expect(ops.stageRecovery({ ...command, approvalReference: "changed-approval" }, preview.reviewDigest)).rejects.toMatchObject({ code: "ASSESSMENT_RECOVERY_CONFLICT" });
    await expect(ops.previewRecovery({ ...command, billing: { ...command.billing, evidenceReference: "changed-invoice" } })).rejects.toMatchObject({ code: "ASSESSMENT_RECOVERY_CONFLICT" });
    await expect(ops.previewRecovery({ ...command, idempotencyKey: "second-grant" })).rejects.toMatchObject({ code: "ASSESSMENT_RECOVERY_CONFLICT" });
    await expect(ops.previewRecovery({ ...command, sourceAttemptId: result.attemptId, idempotencyKey: "chain-grant" })).rejects.toMatchObject({ code: "ASSESSMENT_RECOVERY_NOT_ELIGIBLE" });
    await expect(ops.admit("alice", "profile-v1")).rejects.toMatchObject({ code: "ASSESSMENT_RETRY_BLOCKED" });
    expect(await snapshot(store)).toEqual(before);
  });

  it("fences old callbacks and requires current profile, allowlist and generation policy for the replacement", async () => {
    const { ops, store, source, execution: old, options, command } = await setup(), preview = await ops.previewRecovery(command);
    const result = await ops.stageRecovery(command, preview.reviewDigest), saved = await snapshot(store);
    await expect(old.recordReceipt(X_REJECTION)).rejects.toMatchObject({ code: "ASSESSMENT_OPERATIONS_STATE" });
    await expect(old.beforeDispatch("grok")).rejects.toMatchObject({ code: "ASSESSMENT_OPERATIONS_STATE" });
    await expect(ops.execution("alice", source.id)).rejects.toMatchObject({ code: "ASSESSMENT_OPERATIONS_STATE" });
    await expect(ops.fail("alice", "provider", source.id)).rejects.toMatchObject({ code: "ASSESSMENT_OPERATIONS_STATE" });
    await expect(ops.artifactOutcome("alice", "failed", source.id)).rejects.toMatchObject({ code: "ASSESSMENT_OPERATIONS_STATE" });
    await expect(ops.stagedRecovery("alice", "changed-profile", true)).rejects.toMatchObject({ code: "ASSESSMENT_RECOVERY_NOT_ELIGIBLE" });
    const wrongHandle = new AssessmentOperations({ ...options, allowedHandle: "bob" });
    await expect(wrongHandle.stagedRecovery("alice", "profile-v1", true)).rejects.toThrow();
    await expect((await wrongHandle.execution("alice", result.attemptId)).beforeDispatch("x-identity")).rejects.toMatchObject({ code: "HANDLE_NOT_ALLOWED" });
    const disabled = new AssessmentOperations({ ...options, generationEnabled: false });
    await expect((await disabled.execution("alice", result.attemptId)).beforeDispatch("x-identity")).rejects.toMatchObject({ code: "GENERATION_DISABLED" });
    const lowerExposure = new AssessmentOperations({ ...options, maxExposureUsdTicks: "1" });
    await expect(lowerExposure.stagedRecovery("alice", "profile-v1", true)).rejects.toMatchObject({ code: "ASSESSMENT_EXPOSURE_LIMIT" });
    await expect((await lowerExposure.execution("alice", result.attemptId)).beforeDispatch("x-identity")).rejects.toMatchObject({ code: "ASSESSMENT_EXPOSURE_LIMIT" });
    expect(await snapshot(store)).toEqual(saved);
    const current = await ops.execution("alice", result.attemptId);
    await current.beforeDispatch("x-identity");
    expect(await ops.stagedRecovery("alice", "profile-v1", true)).toBeUndefined();
    await expect(current.beforeDispatch("x-identity")).rejects.toThrow();
    const afterDispatch = await snapshot(store);
    expect(await ops.stageRecovery(command, preview.reviewDigest)).toEqual(result);
    expect(await snapshot(store)).toEqual(afterDispatch);
  });

  it("requires explicit reconciled billing evidence including an affirmative zero, and respects exposure", async () => {
    const { ops, store, command, options } = await setup();
    for (const changed of [{ ...command, billing: undefined }, { ...command, billing: { actualCostUsdTicks: "0" } },
      { ...command, billing: { actualCostUsdTicks: "unknown", evidenceReference: "invoice" } }, { ...command, approvalReference: "" },
      { ...command, operatorReference: "" }, { ...command, rejectionEvidenceReference: "" }]) {
      await expect(ops.previewRecovery(changed as AssessmentRecoveryCommand)).rejects.toThrow();
    }
    await expect(ops.previewRecovery({ ...command, billing: { ...command.billing, actualCostUsdTicks: "1" } })).rejects.toMatchObject({ code: "ASSESSMENT_EXPOSURE_LIMIT" });
    const higherExposure = new AssessmentOperations({ ...options, maxExposureUsdTicks: "10000000001" });
    const priced = { ...command, billing: { ...command.billing, actualCostUsdTicks: "1" } };
    expect(await higherExposure.previewRecovery(priced)).toMatchObject({ exposureAfterUsdTicks: "10000000001" });
    expect(await store.entries("recovery:")).toEqual([]);
  });

  it.each(["pending", "uncertain", "no-receipt", "grok-receipt", "grok-dispatched", "verified", "wrong-http", "wrong-category", "legacy", "accepted", "actual-cost-conflict", "receipt-after-failure"])("rejects ineligible %s evidence without writes", async kind => {
    const { ops, store, source, command } = await setup();
    const attempt = await store.get<AssessmentAttempt>("attempt:alice");
    if (kind === "pending") { attempt!.outcome = "pending"; delete attempt!.phases.failedAt; }
    if (kind === "uncertain") attempt!.outcome = "uncertain-after-dispatch";
    if (kind === "grok-dispatched") attempt!.phases.grokDispatchedAt = NOW + 700;
    if (kind === "verified") attempt!.phases.xVerifiedAt = NOW + 700;
    if (kind === "accepted") { attempt!.outcome = "accepted"; attempt!.phases.grokDispatchedAt = NOW + 700; attempt!.phases.outcomeAt = NOW + 800; }
    if (kind === "legacy") await store.put("attempt:alice", { handle: "alice", createdAt: NOW, status: "failed" });
    else await store.put("attempt:alice", attempt);
    if (kind === "no-receipt") {
      const get = store.get.bind(store);
      vi.spyOn(store, "get").mockImplementation(async key => key === `receipt:${source.id}_x` ? undefined : get(key));
    }
    if (kind === "grok-receipt") await store.put(`receipt:${source.id}_grok`, { version: 1, attemptId: source.id, receipt: { ...X_REJECTION, leg: "grok" } });
    if (["wrong-http", "wrong-category", "actual-cost-conflict", "receipt-after-failure"].includes(kind)) await store.put(`receipt:${source.id}_x`, { version: 1, attemptId: source.id,
      receipt: { ...X_REJECTION, ...(kind === "wrong-http" ? { httpStatus: 429 } : kind === "wrong-category" ? { category: "timeout" } : kind === "actual-cost-conflict" ? { cost: { status: "actual", amount: "1", currency: "USD", scale: 10 } } : { completedAt: NOW + 1001 }) } });
    const before = await snapshot(store);
    await expect(ops.previewRecovery(command)).rejects.toThrow();
    expect(await snapshot(store)).toEqual(before);
  });

  it("rejects changed review state, model/reservation changes, fixtures and broader multi-attempt stores", async () => {
    const { ops, store, command, options, setNow } = await setup(), preview = await ops.previewRecovery(command);
    await expect(ops.previewRecovery({ ...command, profileVersion: "another-model" })).rejects.toThrow();
    await expect(ops.previewRecovery({ ...command, reservationUsdTicks: "20000000000" })).rejects.toThrow();
    await expect(new AssessmentOperations({ ...options, accountingRequired: false }).previewRecovery(command)).rejects.toThrow();
    await expect(new AssessmentOperations({ ...options, allowedHandle: "bob" }).previewRecovery(command)).rejects.toThrow();
    setNow(NOW + 86_400_000);
    await expect(ops.stageRecovery(command, preview.reviewDigest)).rejects.toMatchObject({ code: "ASSESSMENT_RECOVERY_REVIEW_REQUIRED" });
    await store.put("attempt:bob", { handle: "bob", createdAt: NOW, status: "failed" });
    await expect(ops.previewRecovery(command)).rejects.toMatchObject({ code: "ASSESSMENT_RECOVERY_NOT_ELIGIBLE" });
    expect(await store.entries("recovery:")).toEqual([]);
  });

  it("does not free an unapproved handle or reset existing admission limits", async () => {
    const { ops, store, command, options } = await setup(), preview = await ops.previewRecovery(command);
    await ops.stageRecovery(command, preview.reviewDigest);
    await expect(new AssessmentOperations({ ...options, allowedHandle: undefined }).admit("bob", "profile-v1")).rejects.toMatchObject({ code: "ASSESSMENT_LIMIT" });
    expect(await store.get("budget:2026-09-20")).toBe(2);
  });
});

describe("recovery durable ordering", () => {
  it("retains byte-identical source evidence and the same staged identity through a file-store restart", async () => {
    const { store, options, source, command } = await setup(), path = await mkdtemp(join(tmpdir(), "sg-recovery-test-"));
    try {
      const files = await FileKeyValueStore.create(path);
      for (const [key, value] of await snapshot(store)) await files.put(key, value);
      const originalAttempt = await readFile(files.path("attempt:alice"), "utf8"), originalReceipt = await readFile(files.path(`receipt:${source.id}_x`), "utf8");
      const ops = new AssessmentOperations({ ...options, store: files, generationEnabled: false }), preview = await ops.previewRecovery(command);
      const result = await ops.stageRecovery(command, preview.reviewDigest);
      const restarted = new AssessmentOperations({ ...options, store: await FileKeyValueStore.create(path), generationEnabled: false });
      expect(await restarted.stageRecovery(command, preview.reviewDigest)).toEqual(result);
      expect(await restarted.stagedRecovery("alice", "profile-v1")).toMatchObject({ id: result.attemptId });
      expect(await readFile(files.path("attempt:alice"), "utf8")).toBe(originalAttempt);
      expect(await readFile(files.path(`receipt:${source.id}_x`), "utf8")).toBe(originalReceipt);
    } finally { await rm(path, { recursive: true, force: true }); }
  });

  it.each(Array.from({ length: 12 }, (_, index) => ({ failAt: Math.floor(index / 2) + 1, acknowledged: index % 2 === 0 })))(
    "resumes fail-closed without a duplicate allowance at write $failAt, failure before write=$acknowledged", async ({ failAt, acknowledged }) => {
      const { ops, store, source, command, options } = await setup(), preview = await ops.previewRecovery(command);
      const originalAttempt = await store.get("attempt:alice"), originalReceipt = await store.get(`receipt:${source.id}_x`);
      const originalPut = store.put.bind(store); let writes = 0;
      const spy = vi.spyOn(store, "put").mockImplementation(async (key, value) => {
        writes++;
        if (writes === failAt && acknowledged) throw new Error("injected write failure");
        await originalPut(key, value);
        if (writes === failAt) throw new Error("injected acknowledgement loss");
      });
      await expect(ops.stageRecovery(command, preview.reviewDigest)).rejects.toMatchObject({ name: "AssessmentPersistenceError" });
      spy.mockRestore();
      const restarted = new AssessmentOperations({ ...options, generationEnabled: false });
      const stagedBefore = await restarted.stagedRecovery("alice", "profile-v1");
      if (failAt !== 6 || acknowledged) expect(stagedBefore).toBeUndefined();
      else expect(stagedBefore).toMatchObject({ phases: {}, outcome: "pending" });
      const result = await restarted.stageRecovery(command, preview.reviewDigest), after = await snapshot(store);
      expect(await restarted.stageRecovery(command, preview.reviewDigest)).toEqual(result);
      expect(await snapshot(store)).toEqual(after);
      expect(await store.entries("recovery:")).toHaveLength(1);
      expect(await store.entries("recoveryattempt:")).toHaveLength(1);
      expect((await store.get<{ reservations: unknown[] }>("budget:paid_v1"))!.reservations).toHaveLength(2);
      expect(await store.get("budget:2026-09-20")).toBe(2);
      expect(await store.get("attempt:alice")).toEqual(originalAttempt);
      expect(await store.get(`receipt:${source.id}_x`)).toEqual(originalReceipt);
      expect(await restarted.stagedRecovery("alice", "profile-v1")).toMatchObject({ id: result.attemptId, phases: {} });
    });

  it("coalesces simultaneous identical commands and rejects simultaneous conflicting approvals", async () => {
    const { ops, store, command } = await setup(), preview = await ops.previewRecovery(command);
    const results = await Promise.all([ops.stageRecovery(command, preview.reviewDigest), ops.stageRecovery(command, preview.reviewDigest)]);
    expect(results[0]).toEqual(results[1]);
    await expect(ops.stageRecovery({ ...command, operatorReference: "another-operator" }, preview.reviewDigest)).rejects.toMatchObject({ code: "ASSESSMENT_RECOVERY_CONFLICT" });
    expect((await store.get<{ reservations: unknown[] }>("budget:paid_v1"))!.reservations).toHaveLength(2);
  });

  it("blocks corrupted audit, missing reservation and changed source evidence before dispatch", async () => {
    for (const kind of ["audit", "reservation", "source", "head", "attempt"] as const) {
      const { ops, store, command } = await setup(), preview = await ops.previewRecovery(command), result = await ops.stageRecovery(command, preview.reviewDigest);
      if (kind === "audit") {
        const audit = await store.get<Record<string, unknown>>(`recovery:${result.recoveryId}`);
        await store.put(`recovery:${result.recoveryId}`, { ...audit, sourceDigest: "a".repeat(64) });
      } else if (kind === "reservation") {
        const budget = await store.get<{ version: 1; reservations: unknown[] }>("budget:paid_v1");
        await store.put("budget:paid_v1", { ...budget, reservations: budget!.reservations.slice(0, 1) });
      } else if (kind === "source") {
        const source = await store.get<AssessmentAttempt>("attempt:alice");
        await store.put("attempt:alice", { ...source, failureCategory: "provider" });
      } else if (kind === "head") await store.put("recoveryhead:alice", { recoveryId: result.recoveryId, sourceAttemptId: result.attemptId });
      else {
        const attempt = await store.get<AssessmentAttempt>(`recoveryattempt:${result.attemptId}`);
        await store.put(`recoveryattempt:${result.attemptId}`, { ...attempt, profileVersion: "changed" });
      }
      await expect(ops.stagedRecovery("alice", "profile-v1", true)).rejects.toThrow();
      await expect(ops.execution("alice", result.attemptId)).rejects.toThrow();
    }
  });
});

describe("bounded recovery command schema", () => {
  it("rejects raw payloads, ambiguous billing, unknown fields and unsafe references", async () => {
    const { command } = await setup();
    expect(validateAssessmentRecoveryCommand(command)).toEqual(command);
    for (const value of [null, [], "raw", { ...command, version: 2 }, { ...command, sourceAttemptId: "legacy-unknown" },
      { ...command, idempotencyKey: "secret\nraw" }, { ...command, operatorReference: "a".repeat(257) }, { ...command, reservationUsdTicks: "0" },
      { ...command, billing: { ...command.billing, actualCostUsdTicks: "00" } }, { ...command, billing: { ...command.billing, providerRawBody: "secret" } },
      { ...command, providerRawBody: "secret" }]) expect(() => validateAssessmentRecoveryCommand(value)).toThrow();
  });
});
