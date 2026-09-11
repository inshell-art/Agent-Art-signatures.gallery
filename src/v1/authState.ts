import { createHash, randomBytes } from "node:crypto";
import { V2Error } from "../v2/errors.js";
import { isSessionActive } from "./authPolicy.js";
import type { OAuthPurpose, SensitiveActionIntent } from "./types.js";

export const CLAIM_ON_RETURN_INTENT = "claim-on-return-v1";

const FLOW_TTL_MS = 15 * 60 * 1000;

function token(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface AuthenticatedIdentity {
  xUserId: string;
  username: string;
  handleNormalized: string;
  authenticatedAt: Date;
}

export interface BrowserSession {
  id: string;
  csrfToken: string;
  identity: AuthenticatedIdentity | null;
  createdAt: Date;
  lastSeenAt: Date;
  /** Short-lived, session-bound feedback; never part of a public signature response. */
  claimNotice?: { signatureId: string; expiresAt: Date };
  /** Only the latest explicitly selected mint recipient may complete its proof. */
  mintRecipientChallengeId?: string;
  /** A fresh recipient proof for one exact mint, never general wallet authority. */
  mintRecipient?: {
    signatureId: string;
    claimInstanceId: string;
    xUserId: string;
    sessionId: string;
    walletBindingId: string;
    address: string;
    chainId: string;
    provedAt: Date;
    expiresAt: Date;
    /** Once reserved, this proof may only retry this exact authorization. */
    authorizationId?: string;
  };
  /** One-time action consent from X, restricted to this rotated session and target. */
  actionApproval?: {
    intent: SensitiveActionIntent;
    sessionId: string;
    xUserId: string;
    confirmedAt: Date;
    /** Reuses the initiating OAuth flow deadline; this is not an identity-age timer. */
    expiresAt: Date;
  };
}

export type FlowStatus = "pending" | "processing" | "authenticated" | "completed" | "failed";

export interface OAuthFlow {
  id: string;
  purpose: OAuthPurpose;
  /** Server-validated canonical mint route, bound to this one-time OAuth flow. */
  returnTo?: string;
  actionIntent?: SensitiveActionIntent;
  /** Stable account ID expected on an action callback, regardless of handle changes. */
  actionXUserId?: string;
  stateDigest: string;
  boundSessionIdDigest: string;
  pkceVerifier: string;
  /** Exact spelling consented to on the artwork preview. */
  handleAtClaim: string | null;
  handleNormalized: string | null;
  gr0kRaw: number | null;
  rendererVersion: string | null;
  previewSvgSha256: string | null;
  /** Explicit consent from the same-origin “and claim” POST, never ordinary login. */
  claimIntent?: typeof CLAIM_ON_RETURN_INTENT;
  claimFailure?: "storage_unavailable" | "rate_limited";
  status: FlowStatus;
  identity: AuthenticatedIdentity | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface ClaimFlowInput {
  claimIntent?: typeof CLAIM_ON_RETURN_INTENT;
  handleAtClaim: string;
  handleNormalized: string;
  gr0kRaw: number;
  rendererVersion: string;
  previewSvgSha256: string;
}

export class MemoryAuthState {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly flows = new Map<string, OAuthFlow>();
  private readonly states = new Map<string, string>();

  getOrCreateSession(id: string | null, now = new Date()): { session: BrowserSession; created: boolean } {
    const existing = id ? this.sessions.get(id) : undefined;
    if (existing && isSessionActive(existing, now)) {
      existing.lastSeenAt = now;
      return { session: existing, created: false };
    }
    if (id) this.logout(id);
    const session: BrowserSession = { id: token(), csrfToken: token(), identity: null, createdAt: now, lastSeenAt: now };
    this.sessions.set(session.id, session);
    return { session, created: true };
  }

  getSession(id: string | null, now = new Date()): BrowserSession | null {
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session || !isSessionActive(session, now)) {
      this.logout(id);
      return null;
    }
    session.lastSeenAt = now;
    return session;
  }

  startFlow(session: BrowserSession, purpose: OAuthPurpose, input: ClaimFlowInput | null, verifier: string, now = new Date()): { flow: OAuthFlow; state: string } {
    const state = token();
    const flow: OAuthFlow = {
      id: token(18),
      purpose,
      ...(purpose === "sensitive_action" && session.identity ? { actionXUserId: session.identity.xUserId } : {}),
      stateDigest: digest(state),
      boundSessionIdDigest: digest(session.id),
      pkceVerifier: verifier,
      handleAtClaim: input?.handleAtClaim ?? null,
      handleNormalized: input?.handleNormalized ?? null,
      gr0kRaw: input?.gr0kRaw ?? null,
      rendererVersion: input?.rendererVersion ?? null,
      previewSvgSha256: input?.previewSvgSha256 ?? null,
      ...(purpose === "claim" && input?.claimIntent === CLAIM_ON_RETURN_INTENT ? { claimIntent: CLAIM_ON_RETURN_INTENT } : {}),
      status: "pending",
      identity: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + FLOW_TTL_MS),
    };
    this.flows.set(flow.id, flow);
    this.states.set(flow.stateDigest, flow.id);
    this.cleanup(now);
    return { flow, state };
  }

  beginCallback(session: BrowserSession, state: string, now = new Date()): OAuthFlow | null {
    const stateDigest = digest(state);
    const flowId = this.states.get(stateDigest);
    if (!flowId) return null;
    const flow = this.flows.get(flowId);
    if (!flow || flow.status !== "pending" || !Number.isFinite(now.getTime()) || flow.expiresAt <= now) {
      this.states.delete(stateDigest);
      return null;
    }
    // A guessed/stolen state presented from a different browser must not burn
    // the legitimate browser's callback capability.
    if (this.sessions.get(session.id) !== session || !isSessionActive(session, now)
      || flow.boundSessionIdDigest !== digest(session.id)) return null;
    this.states.delete(stateDigest);
    flow.status = "processing";
    return flow;
  }

  authenticate(flow: OAuthFlow, identity: AuthenticatedIdentity, session: BrowserSession, now = new Date()): BrowserSession {
    if (this.flows.get(flow.id) !== flow || this.sessions.get(session.id) !== session
      || !isSessionActive(session, now) || flow.boundSessionIdDigest !== digest(session.id)
      || (flow.status !== "processing" && flow.status !== "pending")
      || !Number.isFinite(flow.createdAt.getTime()) || flow.createdAt > now
      || !Number.isFinite(flow.expiresAt.getTime()) || flow.expiresAt <= now
      || !Number.isFinite(identity.authenticatedAt.getTime()) || identity.authenticatedAt > now) {
      throw new Error("Flow cannot be authenticated.");
    }
    if (flow.purpose === "sensitive_action") {
      if (!flow.actionIntent || (!flow.actionXUserId && (session.identity || flow.actionIntent.kind !== "wallet_link"))) {
        this.fail(flow);
        throw new Error("Sensitive action requires a bound target and account.");
      }
      if (flow.actionXUserId !== undefined && flow.actionXUserId !== identity.xUserId) {
        this.fail(flow);
        throw new V2Error(403, "NOT_CLAIMANT", "Confirm this action with the same X account that started it.");
      }
    }
    const rotated: BrowserSession = {
      id: token(),
      csrfToken: token(),
      identity,
      createdAt: session.createdAt,
      lastSeenAt: now,
    };
    if (flow.purpose === "sensitive_action") {
      rotated.actionApproval = {
        intent: { ...flow.actionIntent! },
        sessionId: rotated.id,
        xUserId: identity.xUserId,
        confirmedAt: new Date(now.getTime()),
        expiresAt: new Date(flow.expiresAt.getTime()),
      };
    }
    this.logout(session.id);
    this.sessions.set(rotated.id, rotated);
    this.states.delete(flow.stateDigest);
    flow.boundSessionIdDigest = digest(rotated.id);
    flow.identity = identity;
    flow.pkceVerifier = "";
    flow.status = flow.purpose === "claim" ? "authenticated" : "completed";
    return rotated;
  }

  getBoundFlow(session: BrowserSession, flowId: string, requiredStatus: FlowStatus, now = new Date()): OAuthFlow | null {
    const flow = this.flows.get(flowId);
    if (!flow || this.sessions.get(session.id) !== session || !isSessionActive(session, now)
      || !Number.isFinite(flow.createdAt.getTime()) || !Number.isFinite(flow.expiresAt.getTime())
      || flow.createdAt > now || flow.expiresAt <= now || flow.expiresAt <= flow.createdAt
      || flow.status !== requiredStatus || flow.boundSessionIdDigest !== digest(session.id)) return null;
    return flow;
  }

  complete(flow: OAuthFlow): void {
    if (flow.status === "authenticated") flow.status = "completed";
  }

  setClaimNotice(session: BrowserSession, signatureId: string, now = new Date()): void {
    session.claimNotice = { signatureId, expiresAt: new Date(now.getTime() + 5 * 60_000) };
  }

  takeClaimNotice(session: BrowserSession, signatureId: string, now = new Date()): boolean {
    const notice = session.claimNotice;
    if (!notice) return false;
    if (notice.expiresAt <= now) {
      delete session.claimNotice;
      return false;
    }
    if (!session.identity || notice.signatureId !== signatureId) return false;
    delete session.claimNotice;
    return true;
  }

  fail(flow: OAuthFlow): void {
    flow.status = "failed";
    flow.pkceVerifier = "";
    this.states.delete(flow.stateDigest);
  }

  logout(sessionId: string | null): void {
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (session) {
      // Async wallet/claim operations may still hold this object after the map
      // entry disappears. Revoke its authority as well as the browser cookie.
      session.identity = null;
      delete session.actionApproval;
      delete session.claimNotice;
      delete session.mintRecipient;
      delete session.mintRecipientChallengeId;
    }
    this.sessions.delete(sessionId);
  }

  clearClaimNotices(signatureId: string): void {
    for (const session of this.sessions.values()) {
      if (session.claimNotice?.signatureId === signatureId) delete session.claimNotice;
    }
  }

  private cleanup(now: Date): void {
    for (const [id, flow] of this.flows) {
      if (flow.expiresAt < now) {
        this.states.delete(flow.stateDigest);
        this.flows.delete(id);
      }
    }
  }
}
