import { randomBytes, timingSafeEqual } from "node:crypto";
import { generateCodeChallenge, type XOAuthClient, type XUser } from "./xOAuthClient.js";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface LocalOAuthAccount extends XUser {
  key: string;
  displayName: string;
}

export interface LocalAuthorizationView {
  requestId: string;
  accounts: readonly LocalOAuthAccount[];
  expiresAt: Date;
}

export type LocalOAuthDecision = "approve" | "deny" | "provider_error";

interface AuthorizationRequest {
  state: string;
  codeChallenge: string;
  expiresAt: number;
}

interface AuthorizationCode {
  account: LocalOAuthAccount;
  codeChallenge: string;
  expiresAt: number;
}

interface AccessGrant {
  account: LocalOAuthAccount;
  expiresAt: number;
}

export class LocalOAuthEmulatorError extends Error {}

const DEFAULT_ACCOUNTS: readonly LocalOAuthAccount[] = Object.freeze([
  Object.freeze({ key: "alice", id: "1234567890123456789", username: "alice", displayName: "Alice · fixture claimant" }),
  Object.freeze({ key: "bob", id: "9876543210987654321", username: "bob", displayName: "Bob · alternate fixture account" }),
  Object.freeze({ key: "newcomer", id: "5550000000000000001", username: "newcomer", displayName: "Newcomer · starts with no claims" }),
  Object.freeze({ key: "alice-renamed", id: "1234567890123456789", username: "alice_studio", displayName: "Alice · renamed-handle rehearsal" }),
]);

function opaqueToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

function equalText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * An in-process OAuth provider used only by the development rehearsal.
 * It deliberately follows the authorization-code + PKCE redirects instead
 * of granting an identity inside the application route.
 */
export class LocalXOAuthEmulator implements XOAuthClient {
  readonly providerKind = "local_rehearsal" as const;
  private readonly requests = new Map<string, AuthorizationRequest>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly grants = new Map<string, AccessGrant>();
  private readonly accountByKey: Map<string, LocalOAuthAccount>;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = DEFAULT_TTL_MS,
    accounts: readonly LocalOAuthAccount[] = DEFAULT_ACCOUNTS,
  ) {
    this.accountByKey = new Map(accounts.map((account) => [account.key, Object.freeze({ ...account })]));
  }

  getAuthorizeUrl(state: string, codeChallenge: string): string {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
      throw new LocalOAuthEmulatorError("The local authorization request is malformed.");
    }
    const requestId = opaqueToken();
    this.requests.set(requestId, { state, codeChallenge, expiresAt: this.now() + this.ttlMs });
    return `/dev/oauth/x/authorize?request=${encodeURIComponent(requestId)}`;
  }

  getAuthorizationRequest(requestId: string): LocalAuthorizationView | null {
    const request = this.requests.get(requestId);
    if (!request || request.expiresAt <= this.now()) {
      if (request) this.requests.delete(requestId);
      return null;
    }
    return {
      requestId,
      accounts: [...this.accountByKey.values()],
      expiresAt: new Date(request.expiresAt),
    };
  }

  completeAuthorization(requestId: string, decision: LocalOAuthDecision, accountKey?: string): string {
    const request = this.requests.get(requestId);
    if (!request || request.expiresAt <= this.now()) {
      if (request) this.requests.delete(requestId);
      throw new LocalOAuthEmulatorError("The local authorization request is invalid, expired, or already used.");
    }

    if (decision === "approve" && !this.accountByKey.has(accountKey ?? "")) {
      throw new LocalOAuthEmulatorError("Choose one listed local rehearsal account.");
    }
    if (decision !== "approve" && decision !== "deny" && decision !== "provider_error") {
      throw new LocalOAuthEmulatorError("The local authorization decision is invalid.");
    }

    this.requests.delete(requestId);
    const callback = new URL("http://local.invalid/auth/x/callback");
    callback.searchParams.set("state", request.state);
    if (decision === "deny") {
      callback.searchParams.set("error", "access_denied");
      callback.searchParams.set("error_description", "The local rehearsal account denied access.");
    } else if (decision === "provider_error") {
      callback.searchParams.set("error", "temporarily_unavailable");
      callback.searchParams.set("error_description", "The local rehearsal provider simulated an error.");
    } else {
      const code = opaqueToken();
      this.codes.set(code, {
        account: this.accountByKey.get(accountKey!)!,
        codeChallenge: request.codeChallenge,
        expiresAt: this.now() + this.ttlMs,
      });
      callback.searchParams.set("code", code);
    }
    return `${callback.pathname}${callback.search}`;
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<string> {
    const grant = this.codes.get(code);
    // Authorization codes are one-shot even when the verifier is wrong.
    this.codes.delete(code);
    if (!grant || grant.expiresAt <= this.now()) {
      throw new LocalOAuthEmulatorError("The local authorization code is invalid, expired, or already used.");
    }
    if (!equalText(generateCodeChallenge(codeVerifier), grant.codeChallenge)) {
      throw new LocalOAuthEmulatorError("The local authorization code failed PKCE verification.");
    }
    const accessToken = opaqueToken(32);
    this.grants.set(accessToken, { account: grant.account, expiresAt: this.now() + this.ttlMs });
    return accessToken;
  }

  async getUser(accessToken: string): Promise<XUser> {
    const grant = this.grants.get(accessToken);
    // The app needs one identity lookup per callback; make rehearsal grants
    // one-shot so tests expose accidental callback replay.
    this.grants.delete(accessToken);
    if (!grant || grant.expiresAt <= this.now()) {
      throw new LocalOAuthEmulatorError("The local access grant is invalid, expired, or already used.");
    }
    return { id: grant.account.id, username: grant.account.username };
  }
}
