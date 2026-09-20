import { assessmentDigest, validateAssessment, type Assessment, type UnsignedAssessment } from "../assessment.js";
import { POLICY_VERSION, RENDERER_VERSION } from "../identity.js";

/** Synthetic unit-test record; not a real provider result or a publishable live assessment. */
export function syntheticPublicAssessment(): Assessment {
  const value: UnsignedAssessment = { id: "11111111-1111-4111-8111-111111111111", handle: "alice_bob_key", mbti: "INTJ",
    rendererVersion: RENDERER_VERSION, policyVersion: POLICY_VERSION, model: "grok-4.3", providerResponseId: "private-response-id",
    sourceUrls: ["https://example.com/private-reference?token=secret", "https://x.com/Alice_Bob_Key/status/123?tracking=private#fragment"],
    createdAt: "2026-09-20T00:00:00.000Z", provenance: "grok",
    xIdentity: { canonicalHandle: "alice_bob_key", username: "Alice_Bob_Key", userId: "123", verifiedAt: "2026-09-20T00:00:00.000Z", provenance: "x-api", freshness: "verified-at-preparation" } };
  return validateAssessment({ ...value, digest: assessmentDigest(value) });
}
