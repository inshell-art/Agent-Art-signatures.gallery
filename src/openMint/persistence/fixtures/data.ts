import { randomUUID } from "node:crypto";
import { assessmentDigest, type Assessment, type NativeMbtiAssessment, type UnsignedAssessment } from "../../assessment.js";
import type { ProviderLeg, ProviderReceipt } from "../../assessmentOperations.js";
import { POLICY_VERSION, RENDERER_VERSION } from "../../identity.js";
import type { XIdentitySnapshot } from "../../xIdentity.js";
import type { PersistenceNamespace } from "../repository.js";

export const namespace = (): PersistenceNamespace => ({ id: randomUUID(), profile: "local-fixture", provenance: "development-fixture", policyVersion: POLICY_VERSION });
export const bytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
export const identity = (handle = "alice"): XIdentitySnapshot => ({ canonicalHandle: handle, username: handle,
  userId: "123", verifiedAt: "2026-09-20T00:00:00.000Z", provenance: "development-fixture", freshness: "verified-at-preparation" });
export function assessment(handle = "alice", changes: Partial<Omit<NativeMbtiAssessment, "digest">> = {}): Assessment {
  const value: UnsignedAssessment = { id: randomUUID(), handle, mbti: "INTJ", policyVersion: POLICY_VERSION,
    rendererVersion: RENDERER_VERSION, model: "development-fixture-v1", providerResponseId: "development-fixture:1",
    sourceUrls: [], createdAt: "2026-09-20T00:00:00.000Z", provenance: "development-fixture", xIdentity: identity(handle), ...changes };
  return { ...value, digest: assessmentDigest(value) };
}
export const receipt = (leg: ProviderLeg, amount?: string): ProviderReceipt => ({ leg, startedAt: 1, completedAt: 2,
  category: "success", usageStatus: "missing", cost: amount === undefined
    ? { status: "unknown", currency: "USD", scale: 10 } : { status: "actual", currency: "USD", scale: 10, amount } });
