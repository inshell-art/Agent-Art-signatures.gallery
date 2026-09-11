import { V2Error } from "../v2/errors.js";
import type { AuthenticatedIdentity, BrowserSession } from "./authState.js";
import type { SensitiveActionIntent } from "./types.js";

/** App-session idle expiry. This is unrelated to X tokens or an OAuth flow. */
export const SESSION_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function isSessionActive(session: BrowserSession, now = new Date()): boolean {
  const at = now.getTime();
  const lastSeenAt = session.lastSeenAt.getTime();
  return Number.isFinite(at) && Number.isFinite(lastSeenAt)
    && lastSeenAt <= at && at - lastSeenAt <= SESSION_IDLE_TTL_MS;
}

/** Age alone does not require another X login while the app session is active. */
export function requireSessionIdentity(session: BrowserSession, expectedXUserId?: string, now = new Date()): AuthenticatedIdentity {
  const identity = session.identity;
  if (!isSessionActive(session, now) || !identity
    || !Number.isFinite(identity.authenticatedAt.getTime()) || identity.authenticatedAt > now) {
    throw new V2Error(401, "AUTH_REQUIRED", "Your sign-in session is missing or expired. Sign in with X to continue.");
  }
  if (expectedXUserId !== undefined && identity.xUserId !== expectedXUserId) {
    throw new V2Error(403, "NOT_CLAIMANT", "The active X account does not own this action.");
  }
  return identity;
}

function sameIntent(left: SensitiveActionIntent, right: SensitiveActionIntent): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "mint_recipient" && right.kind === "mint_recipient") {
    return left.signatureId === right.signatureId && left.claimInstanceId === right.claimInstanceId
      && left.chainId === right.chainId && left.previousBindingId === right.previousBindingId;
  }
  if (left.kind === "claim_withdraw" && right.kind === "claim_withdraw") {
    return left.signatureId === right.signatureId && left.claimInstanceId === right.claimInstanceId;
  }
  if ((left.kind === "wallet_link" || left.kind === "wallet_revoke")
    && (right.kind === "wallet_link" || right.kind === "wallet_revoke")) {
    return left.chainId === right.chainId && left.previousBindingId === right.previousBindingId;
  }
  return false;
}

/** Time to review a freshly proven recipient; unrelated to app-session age. */
export const MINT_RECIPIENT_REVIEW_TTL_MS = 15 * 60_000;

/** Historical bindings are not permission for another work or a later mint. */
export function hasMintRecipient(
  session: BrowserSession,
  signature: { signatureId: string; claimInstanceId: string; xUserId: string },
  binding: { walletBindingId: string; address: string; chainId: bigint | string },
  now = new Date(),
  authorizationId?: string,
): boolean {
  const draft = session.mintRecipient;
  if (!draft) return false;
  try { requireSessionIdentity(session, signature.xUserId, now); } catch { return false; }
  return draft.sessionId === session.id && draft.xUserId === signature.xUserId
    && draft.signatureId === signature.signatureId && draft.claimInstanceId === signature.claimInstanceId
    && draft.chainId === binding.chainId.toString() && draft.walletBindingId === binding.walletBindingId
    && draft.address.toLowerCase() === binding.address.toLowerCase()
    && Number.isFinite(draft.provedAt.getTime()) && draft.provedAt <= now
    && Number.isFinite(draft.expiresAt.getTime()) && draft.expiresAt > now
    && draft.authorizationId === authorizationId;
}

/** A one-time capability from this action's OAuth callback, not identity freshness. */
export function hasActionApproval(session: BrowserSession, intent: SensitiveActionIntent, now = new Date()): boolean {
  const approval = session.actionApproval;
  if (!approval) return false;
  let identity: AuthenticatedIdentity;
  try {
    identity = requireSessionIdentity(session, undefined, now);
  } catch {
    return false;
  }
  return approval.sessionId === session.id && approval.xUserId === identity.xUserId
    && Number.isFinite(approval.confirmedAt.getTime()) && Number.isFinite(approval.expiresAt.getTime())
    && approval.confirmedAt <= now && approval.expiresAt > now
    && sameIntent(approval.intent, intent);
}

/** Consume only at the protected transition; another target cannot use the grant. */
export function consumeActionApproval(session: BrowserSession, intent: SensitiveActionIntent, now = new Date()): void {
  requireSessionIdentity(session, undefined, now);
  if (!hasActionApproval(session, intent, now)) {
    throw new V2Error(401, "X_ACTION_CONFIRMATION_REQUIRED", "Confirm this action with X to continue.");
  }
  delete session.actionApproval;
}
