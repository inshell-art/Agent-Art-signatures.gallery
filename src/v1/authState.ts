import { createHash, randomBytes } from "node:crypto";
import type { OAuthPurpose } from "./types.js";

export const CLAIM_ON_RETURN_INTENT = "claim-on-return-v1";

const FLOW_TTL_MS = 15 * 60 * 1000;
const SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
}

export type FlowStatus = "pending" | "processing" | "authenticated" | "completed" | "failed";

export interface OAuthFlow {
  id: string;
  purpose: OAuthPurpose;
  /** Server-validated canonical mint route, bound to this one-time OAuth flow. */
  returnTo?: string;
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
    if (existing && now.getTime() - existing.lastSeenAt.getTime() <= SESSION_IDLE_TTL_MS) {
      existing.lastSeenAt = now;
      return { session: existing, created: false };
    }
    if (id) this.sessions.delete(id);
    const session: BrowserSession = { id: token(), csrfToken: token(), identity: null, createdAt: now, lastSeenAt: now };
    this.sessions.set(session.id, session);
    return { session, created: true };
  }

  getSession(id: string | null, now = new Date()): BrowserSession | null {
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session || now.getTime() - session.lastSeenAt.getTime() > SESSION_IDLE_TTL_MS) {
      if (id) this.sessions.delete(id);
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
    if (!flow || flow.status !== "pending" || flow.expiresAt < now) {
      this.states.delete(stateDigest);
      return null;
    }
    // A guessed/stolen state presented from a different browser must not burn
    // the legitimate browser's callback capability.
    if (flow.boundSessionIdDigest !== digest(session.id)) return null;
    this.states.delete(stateDigest);
    flow.status = "processing";
    return flow;
  }

  authenticate(flow: OAuthFlow, identity: AuthenticatedIdentity, session: BrowserSession, now = new Date()): BrowserSession {
    if (flow.status !== "processing" && flow.status !== "pending") throw new Error("Flow cannot be authenticated.");
    const rotated: BrowserSession = {
      id: token(),
      csrfToken: token(),
      identity,
      createdAt: session.createdAt,
      lastSeenAt: now,
    };
    this.sessions.delete(session.id);
    this.sessions.set(rotated.id, rotated);
    flow.boundSessionIdDigest = digest(rotated.id);
    flow.identity = identity;
    flow.pkceVerifier = "";
    flow.status = flow.purpose === "claim" ? "authenticated" : "completed";
    return rotated;
  }

  getBoundFlow(session: BrowserSession, flowId: string, requiredStatus: FlowStatus, now = new Date()): OAuthFlow | null {
    const flow = this.flows.get(flowId);
    if (!flow || flow.expiresAt < now || flow.status !== requiredStatus || flow.boundSessionIdDigest !== digest(session.id)) return null;
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
  }

  logout(sessionId: string | null): void {
    if (sessionId) this.sessions.delete(sessionId);
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
