import { describe, expect, it } from "vitest";
import { MemoryAuthState, type BrowserSession } from "./authState.js";
import { consumeActionApproval, hasActionApproval, requireSessionIdentity, SESSION_IDLE_TTL_MS } from "./authPolicy.js";
import type { SensitiveActionIntent } from "./types.js";

const now = new Date("2026-09-10T12:00:00.000Z");
const link: SensitiveActionIntent = { kind: "wallet_link", chainId: "31337", previousBindingId: null };
const revoke: SensitiveActionIntent = { kind: "wallet_revoke", chainId: "31337", previousBindingId: "binding-a" };
const withdraw: SensitiveActionIntent = { kind: "claim_withdraw", signatureId: "signature-a", claimInstanceId: "claim-a" };
const mint: SensitiveActionIntent = { kind: "mint_recipient", signatureId: "signature-a", claimInstanceId: "claim-a", chainId: "31337", previousBindingId: null };

function sessionWithApproval(intent: SensitiveActionIntent = link): BrowserSession {
  const session = new MemoryAuthState().getOrCreateSession(null, now).session;
  session.identity = { xUserId: "1", username: "Alice", handleNormalized: "alice", authenticatedAt: now };
  session.actionApproval = {
    intent, sessionId: session.id, xUserId: "1", confirmedAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
  };
  return session;
}

describe("app session policy", () => {
  it("accepts a signed-in identity older than fifteen minutes or X's access token lifetime", () => {
    const session = sessionWithApproval();
    session.identity!.authenticatedAt = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
    expect(requireSessionIdentity(session, "1", now)).toBe(session.identity);
  });

  it("retains the seven-day idle expiry rather than imposing an identity-age timeout", () => {
    const session = sessionWithApproval();
    session.lastSeenAt = new Date(now.getTime() - SESSION_IDLE_TTL_MS);
    expect(requireSessionIdentity(session, "1", now)).toBe(session.identity);
    session.lastSeenAt = new Date(session.lastSeenAt.getTime() - 1);
    expect(() => requireSessionIdentity(session, "1", now)).toThrow(expect.objectContaining({ code: "AUTH_REQUIRED" }));
  });

  it("keeps stable-X-ID ownership checks when a handle changes", () => {
    const session = sessionWithApproval();
    session.identity!.username = "AliceRenamed";
    expect(requireSessionIdentity(session, "1", now)).toBe(session.identity);
    expect(() => requireSessionIdentity(session, "2", now)).toThrow(expect.objectContaining({ code: "NOT_CLAIMANT" }));
  });

  it.each(["missing_identity", "invalid_identity_date", "future_identity_date", "invalid_session_date", "future_session_date", "invalid_now"])("rejects %s as an invalid session", condition => {
    const session = sessionWithApproval();
    let at = now;
    if (condition === "missing_identity") session.identity = null;
    if (condition === "invalid_identity_date") session.identity!.authenticatedAt = new Date(NaN);
    if (condition === "future_identity_date") session.identity!.authenticatedAt = new Date(now.getTime() + 1);
    if (condition === "invalid_session_date") session.lastSeenAt = new Date(NaN);
    if (condition === "future_session_date") session.lastSeenAt = new Date(now.getTime() + 1);
    if (condition === "invalid_now") at = new Date(NaN);
    expect(() => requireSessionIdentity(session, undefined, at)).toThrow(expect.objectContaining({ code: "AUTH_REQUIRED" }));
    expect(hasActionApproval(session, link, at)).toBe(false);
  });
});

describe("one-time X action approval", () => {
  it.each([link, revoke, withdraw, mint])("consumes an exact $kind approval once", intent => {
    const session = sessionWithApproval(intent);
    expect(hasActionApproval(session, intent, now)).toBe(true);
    expect(() => consumeActionApproval(session, intent, now)).not.toThrow();
    expect(session.actionApproval).toBeUndefined();
    expect(() => consumeActionApproval(session, intent, now)).toThrow(expect.objectContaining({ code: "X_ACTION_CONFIRMATION_REQUIRED" }));
  });

  it.each([
    { label: "other chain", granted: link, attempted: { ...link, chainId: "1" } },
    { label: "changed wallet", granted: link, attempted: { ...link, previousBindingId: "binding-b" } },
    { label: "link instead of revoke", granted: revoke, attempted: { ...revoke, kind: "wallet_link" } },
    { label: "revoke instead of link", granted: { ...link, previousBindingId: "binding-a" }, attempted: revoke },
    { label: "other binding", granted: revoke, attempted: { ...revoke, previousBindingId: "binding-b" } },
    { label: "other signature", granted: withdraw, attempted: { ...withdraw, signatureId: "signature-b" } },
    { label: "replacement claim", granted: withdraw, attempted: { ...withdraw, claimInstanceId: "claim-b" } },
    { label: "different action", granted: withdraw, attempted: link },
    { label: "mint instead of link", granted: link, attempted: mint },
    { label: "link instead of mint", granted: mint, attempted: link },
    { label: "another mint signature", granted: mint, attempted: { ...mint, signatureId: "signature-b" } },
    { label: "replaced mint claim", granted: mint, attempted: { ...mint, claimInstanceId: "claim-b" } },
    { label: "mint chain", granted: mint, attempted: { ...mint, chainId: "1" } },
    { label: "mint prior recipient", granted: mint, attempted: { ...mint, previousBindingId: "binding-b" } },
  ] satisfies { label: string; granted: SensitiveActionIntent; attempted: SensitiveActionIntent }[])("rejects $label without consuming the legitimate scope", ({ granted, attempted }) => {
    const session = sessionWithApproval(granted);
    expect(hasActionApproval(session, attempted, now)).toBe(false);
    expect(() => consumeActionApproval(session, attempted, now)).toThrow(expect.objectContaining({ code: "X_ACTION_CONFIRMATION_REQUIRED" }));
    expect(hasActionApproval(session, granted, now)).toBe(true);
  });

  it.each(["other_session", "other_account", "expired", "invalid_expiry", "invalid_confirmation", "future_confirmation"])("rejects %s approval", condition => {
    const session = sessionWithApproval();
    const approval = session.actionApproval!;
    if (condition === "other_session") approval.sessionId = "other-session";
    if (condition === "other_account") approval.xUserId = "2";
    if (condition === "expired") approval.expiresAt = now;
    if (condition === "invalid_expiry") approval.expiresAt = new Date(NaN);
    if (condition === "invalid_confirmation") approval.confirmedAt = new Date(NaN);
    if (condition === "future_confirmation") approval.confirmedAt = new Date(now.getTime() + 1);
    expect(hasActionApproval(session, link, now)).toBe(false);
    expect(() => consumeActionApproval(session, link, now)).toThrow(expect.objectContaining({ code: "X_ACTION_CONFIRMATION_REQUIRED" }));
  });
});
