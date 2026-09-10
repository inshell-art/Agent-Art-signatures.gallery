import { describe, expect, it } from "vitest";
import { CLAIM_ON_RETURN_INTENT, MemoryAuthState } from "./authState.js";

describe("MemoryAuthState", () => {
  it("consumes claim feedback once, for the exact signature and session, within five minutes", () => {
    const auth = new MemoryAuthState();
    const session = auth.getOrCreateSession(null).session;
    session.identity = { xUserId: "1", username: "alice", handleNormalized: "alice", authenticatedAt: new Date() };
    const other = auth.getOrCreateSession(null).session;
    auth.setClaimNotice(session, "signature-a");
    expect(auth.takeClaimNotice(other, "signature-a")).toBe(false);
    expect(auth.takeClaimNotice(session, "signature-b")).toBe(false);
    expect(auth.takeClaimNotice(session, "signature-a")).toBe(true);
    expect(auth.takeClaimNotice(session, "signature-a")).toBe(false);
    auth.setClaimNotice(session, "signature-a", new Date(0));
    expect(auth.takeClaimNotice(session, "signature-a", new Date(5 * 60_000))).toBe(false);
    expect(session.claimNotice).toBeUndefined();
  });
  it("binds combined consent only to claim flows and never upgrades a legacy form", () => {
    const auth = new MemoryAuthState();
    const session = auth.getOrCreateSession(null).session;
    const input = { handleAtClaim: "Alice", handleNormalized: "alice", gr0kRaw: 50, rendererVersion: "test", previewSvgSha256: "a".repeat(64) };
    const consent = { ...input, claimIntent: CLAIM_ON_RETURN_INTENT } as const;
    expect(auth.startFlow(session, "claim", consent, "verifier").flow).toMatchObject(consent);
    expect(auth.startFlow(session, "claim", input, "verifier").flow.claimIntent).toBeUndefined();
    expect(auth.startFlow(session, "account_login", consent, "verifier").flow.claimIntent).toBeUndefined();
  });
  it("binds one-time OAuth state to the originating session", () => {
    const auth = new MemoryAuthState();
    const a = auth.getOrCreateSession(null).session;
    const b = auth.getOrCreateSession(null).session;
    const { state } = auth.startFlow(a, "account_login", null, "verifier");
    expect(auth.beginCallback(b, state)).toBeNull();
    expect(auth.beginCallback(a, state)?.status).toBe("processing");
    expect(auth.beginCallback(a, state)).toBeNull();
  });

  it("rejects callback replay and rotates the session on authentication", () => {
    const auth = new MemoryAuthState();
    const session = auth.getOrCreateSession(null).session;
    const { state } = auth.startFlow(session, "account_login", null, "verifier");
    const flow = auth.beginCallback(session, state)!;
    expect(flow.status).toBe("processing");
    expect(auth.beginCallback(session, state)).toBeNull();
    const rotated = auth.authenticate(flow, { xUserId: "1", username: "alice", handleNormalized: "alice", authenticatedAt: new Date() }, session);
    expect(rotated.id).not.toBe(session.id);
    expect(auth.getSession(session.id)).toBeNull();
  });
});
