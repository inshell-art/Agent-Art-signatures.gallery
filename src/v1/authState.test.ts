import { describe, expect, it } from "vitest";
import { CLAIM_ON_RETURN_INTENT, MemoryAuthState } from "./authState.js";
import { hasActionApproval, requireSessionIdentity, SESSION_IDLE_TTL_MS } from "./authPolicy.js";
import type { SensitiveActionIntent } from "./types.js";

const actionNow = new Date("2026-09-10T12:00:00.000Z");
const actionIdentity = { xUserId: "1", username: "Alice", handleNormalized: "alice", authenticatedAt: actionNow };
const walletIntent: SensitiveActionIntent = { kind: "wallet_link", chainId: "31337", previousBindingId: null };

function actionFlow() {
  const auth = new MemoryAuthState();
  const session = auth.getOrCreateSession(null, actionNow).session;
  session.identity = { ...actionIdentity };
  const { flow, state } = auth.startFlow(session, "sensitive_action", null, "verifier", actionNow);
  flow.actionIntent = { ...walletIntent };
  flow.actionXUserId = actionIdentity.xUserId;
  return { auth, session, flow, state };
}

describe("MemoryAuthState", () => {
  it("keeps mint preparation independent of claim toast expiry and destroys it on logout", () => {
    const { auth, session } = actionFlow();
    session.mintRecipient = { signatureId: "work", claimInstanceId: "claim", sessionId: session.id, xUserId: "1",
      walletBindingId: "binding", address: "recipient", chainId: "31337", provedAt: actionNow,
      expiresAt: new Date(actionNow.getTime() + 15 * 60_000) };
    const draft = session.mintRecipient;
    auth.setClaimNotice(session, "work", actionNow);
    expect(auth.takeClaimNotice(session, "work", new Date(actionNow.getTime() + 5 * 60_000))).toBe(false);
    expect(session.mintRecipient).toBe(draft);
    auth.logout(session.id);
    expect(session.mintRecipient).toBeUndefined();
  });
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

  it("issues an exact action approval on the rotated session within the original OAuth deadline", () => {
    const { auth, session, flow, state } = actionFlow();
    auth.beginCallback(session, state, actionNow);
    const callbackAt = new Date(actionNow.getTime() + 4 * 60_000);
    const rotated = auth.authenticate(flow, { ...actionIdentity, authenticatedAt: callbackAt }, session, callbackAt);
    expect(rotated.actionApproval).toEqual({
      intent: walletIntent, sessionId: rotated.id, xUserId: "1", confirmedAt: callbackAt,
      expiresAt: new Date(actionNow.getTime() + 15 * 60_000),
    });
    expect(hasActionApproval(rotated, walletIntent, callbackAt)).toBe(true);
    expect(session.identity).toBeNull();
    expect(session.actionApproval).toBeUndefined();
    expect(flow.status).toBe("completed");
    expect(auth.beginCallback(rotated, state, callbackAt)).toBeNull();
    expect(() => auth.authenticate(flow, actionIdentity, rotated, callbackAt)).toThrow();
    flow.actionIntent = { ...walletIntent, chainId: "1" };
    flow.expiresAt.setTime(actionNow.getTime());
    expect(hasActionApproval(rotated, walletIntent, callbackAt)).toBe(true);
  });

  it("rejects a different X account before rotating or replacing the signed-in identity", () => {
    const { auth, session, flow } = actionFlow();
    expect(() => auth.authenticate(flow, { ...actionIdentity, xUserId: "2" }, session, actionNow))
      .toThrow(expect.objectContaining({ code: "NOT_CLAIMANT" }));
    expect(auth.getSession(session.id, actionNow)).toBe(session);
    expect(session.identity!.xUserId).toBe("1");
    expect(session.actionApproval).toBeUndefined();
    expect(flow.status).toBe("failed");
    expect(flow.pkceVerifier).toBe("");
  });

  it("allows handle changes on an action callback when the stable X account still matches", () => {
    const { auth, session, flow } = actionFlow();
    const rotated = auth.authenticate(flow, { ...actionIdentity, username: "NewAlice", handleNormalized: "newalice" }, session, actionNow);
    expect(rotated.identity!.username).toBe("NewAlice");
    expect(hasActionApproval(rotated, walletIntent, actionNow)).toBe(true);
  });

  it("accepts initial wallet-link sign-in without an existing identity but not anonymous withdrawal", () => {
    const { auth, session, flow } = actionFlow();
    session.identity = null;
    delete flow.actionXUserId;
    const rotated = auth.authenticate(flow, actionIdentity, session, actionNow);
    expect(hasActionApproval(rotated, walletIntent, actionNow)).toBe(true);
    const other = actionFlow();
    other.session.identity = null;
    delete other.flow.actionXUserId;
    other.flow.actionIntent = { kind: "claim_withdraw", signatureId: "signature-a", claimInstanceId: "claim-a" };
    expect(() => other.auth.authenticate(other.flow, actionIdentity, other.session, actionNow)).toThrow();
  });

  it("rejects an action callback without a bound target", () => {
    const { auth, session, flow } = actionFlow();
    delete flow.actionIntent;
    expect(() => auth.authenticate(flow, actionIdentity, session, actionNow)).toThrow();
    expect(session.actionApproval).toBeUndefined();
  });

  it.each(["account_login", "claim"] as const)("never grants action consent from an ordinary %s flow", purpose => {
    const { auth, session } = actionFlow();
    const { flow } = auth.startFlow(session, purpose, null, "verifier", actionNow);
    flow.actionIntent = walletIntent;
    flow.actionXUserId = actionIdentity.xUserId;
    const rotated = auth.authenticate(flow, actionIdentity, session, actionNow);
    expect(rotated.actionApproval).toBeUndefined();
  });

  it.each(["logout", "rotate", "expire_get", "expire_create"])("invalidates held identity and approval references on %s", event => {
    const { auth, session, flow } = actionFlow();
    const rotated = auth.authenticate(flow, actionIdentity, session, actionNow);
    if (event === "logout") auth.logout(rotated.id);
    if (event === "rotate") {
      const next = auth.startFlow(rotated, "account_login", null, "verifier", actionNow).flow;
      const signedIn = auth.authenticate(next, actionIdentity, rotated, actionNow);
      expect(signedIn.actionApproval).toBeUndefined();
    }
    const expiredAt = new Date(actionNow.getTime() + SESSION_IDLE_TTL_MS + 1);
    if (event === "expire_get") expect(auth.getSession(rotated.id, expiredAt)).toBeNull();
    if (event === "expire_create") expect(auth.getOrCreateSession(rotated.id, expiredAt).created).toBe(true);
    expect(rotated.identity).toBeNull();
    expect(rotated.actionApproval).toBeUndefined();
    expect(() => requireSessionIdentity(rotated, undefined, actionNow)).toThrow(expect.objectContaining({ code: "AUTH_REQUIRED" }));
  });

  it.each(["logout", "rotate", "wrong_session", "flow_expired", "invalid_identity", "future_identity"])("rejects a late or invalid callback after %s", event => {
    const { auth, session, flow, state } = actionFlow();
    auth.beginCallback(session, state, actionNow);
    let callbackSession = session;
    let callbackAt = actionNow;
    const identity = { ...actionIdentity };
    if (event === "logout") auth.logout(session.id);
    if (event === "rotate") {
      const otherFlow = auth.startFlow(session, "account_login", null, "verifier", actionNow).flow;
      auth.authenticate(otherFlow, identity, session, actionNow);
    }
    if (event === "wrong_session") callbackSession = auth.getOrCreateSession(null, actionNow).session;
    if (event === "flow_expired") callbackAt = flow.expiresAt;
    if (event === "invalid_identity") identity.authenticatedAt = new Date(NaN);
    if (event === "future_identity") identity.authenticatedAt = new Date(actionNow.getTime() + 1);
    expect(() => auth.authenticate(flow, identity, callbackSession, callbackAt)).toThrow();
    expect(callbackSession.actionApproval).toBeUndefined();
  });

  it("expires the OAuth callback at the existing fifteen-minute deadline, not a replacement timer", () => {
    const { auth, session, state, flow } = actionFlow();
    expect(flow.expiresAt.getTime() - flow.createdAt.getTime()).toBe(15 * 60_000);
    expect(auth.beginCallback(session, state, flow.expiresAt)).toBeNull();
  });

  it("retains authenticated and completed legacy claim access only in the bound active session", () => {
    const { auth, session } = actionFlow();
    const { flow } = auth.startFlow(session, "claim", null, "verifier", actionNow);
    const rotated = auth.authenticate(flow, actionIdentity, session, actionNow);
    expect(auth.getBoundFlow(rotated, flow.id, "authenticated", actionNow)).toBe(flow);
    expect(auth.getBoundFlow(rotated, flow.id, "completed", actionNow)).toBeNull();
    auth.complete(flow);
    expect(auth.getBoundFlow(rotated, flow.id, "completed", new Date(flow.expiresAt.getTime() - 1))).toBe(flow);
    expect(auth.getBoundFlow(rotated, flow.id, "authenticated", actionNow)).toBeNull();
    expect(auth.getBoundFlow(rotated, "unknown-flow", "completed", actionNow)).toBeNull();
    const other = auth.getOrCreateSession(null, actionNow).session;
    expect(auth.getBoundFlow(other, flow.id, "completed", actionNow)).toBeNull();
    expect(auth.getBoundFlow(rotated, flow.id, "completed", actionNow)).toBe(flow);
  });

  it.each(["invalid_now", "invalid_created", "invalid_expiry", "future_created", "reversed_dates", "at_deadline", "past_deadline"])("rejects %s for legacy bound-flow access", condition => {
    const { auth, session } = actionFlow();
    const { flow } = auth.startFlow(session, "claim", null, "verifier", actionNow);
    const rotated = auth.authenticate(flow, actionIdentity, session, actionNow);
    let at = actionNow;
    if (condition === "invalid_now") at = new Date(NaN);
    if (condition === "invalid_created") flow.createdAt = new Date(NaN);
    if (condition === "invalid_expiry") flow.expiresAt = new Date(NaN);
    if (condition === "future_created") flow.createdAt = new Date(actionNow.getTime() + 1);
    if (condition === "reversed_dates") flow.expiresAt = new Date(flow.createdAt.getTime() - 1);
    if (condition === "at_deadline") at = flow.expiresAt;
    if (condition === "past_deadline") at = new Date(flow.expiresAt.getTime() + 1);
    expect(auth.getBoundFlow(rotated, flow.id, "authenticated", at)).toBeNull();
    auth.complete(flow);
    expect(auth.getBoundFlow(rotated, flow.id, "completed", at)).toBeNull();
  });

  it.each(["logout", "rotation", "copied_session", "idle_expiry", "invalid_session_date", "future_session_date"])("rejects a %s session for legacy bound-flow access", condition => {
    const { auth, session } = actionFlow();
    const { flow } = auth.startFlow(session, "claim", null, "verifier", actionNow);
    let rotated = auth.authenticate(flow, actionIdentity, session, actionNow);
    if (condition === "logout") auth.logout(rotated.id);
    if (condition === "rotation") {
      const next = auth.startFlow(rotated, "account_login", null, "verifier", actionNow).flow;
      const current = auth.authenticate(next, actionIdentity, rotated, actionNow);
      expect(auth.getBoundFlow(current, flow.id, "authenticated", actionNow)).toBeNull();
    }
    if (condition === "copied_session") rotated = { ...rotated };
    if (condition === "idle_expiry") rotated.lastSeenAt = new Date(actionNow.getTime() - SESSION_IDLE_TTL_MS - 1);
    if (condition === "invalid_session_date") rotated.lastSeenAt = new Date(NaN);
    if (condition === "future_session_date") rotated.lastSeenAt = new Date(actionNow.getTime() + 1);
    expect(auth.getBoundFlow(rotated, flow.id, "authenticated", actionNow)).toBeNull();
    auth.complete(flow);
    expect(auth.getBoundFlow(rotated, flow.id, "completed", actionNow)).toBeNull();
  });
});
