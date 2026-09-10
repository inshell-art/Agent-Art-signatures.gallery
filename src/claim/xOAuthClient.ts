/**
 * X OAuth 2.0 (PKCE) client — handoff §10.
 *
 * Real implementation against X's public OAuth endpoints, not a
 * placeholder — but it is untested against the live API in this repo,
 * since that requires a registered X app's credentials and user consent.
 * Tests intercept the provider transport; they are not live X evidence.
 */

import { createHash, randomBytes } from "node:crypto";
import { createXOAuthDispatcher } from "./xOAuthTransport.js";

export interface XUser {
  id: string;
  username: string;
}

export interface XOAuthClient {
  readonly providerKind?: "x" | "local_rehearsal";
  getAuthorizeUrl(state: string, codeChallenge: string): string;
  exchangeCode(code: string, codeVerifier: string): Promise<string>; // -> access token
  getUser(accessToken: string): Promise<XUser>;
}

export interface XOAuthConfig {
  clientId: string;
  clientSecret?: string; // confidential clients only; public clients rely on PKCE alone
  redirectUri: string;
}

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const USER_URL = "https://api.x.com/2/users/me";
// X requires both scopes for GET /2/users/me, despite its broad consent copy.
// https://docs.x.com/fundamentals/authentication/guides/v2-authentication-mapping
// This identity-only client never reads posts or requests write/email/DM/offline
// access. Deliberately not configurable: new permissions need a reviewed change.
export const X_IDENTITY_SCOPES = Object.freeze(["users.read", "tweet.read"] as const);

export type XOAuthRequestStage = "token_exchange" | "identity_lookup";
export type XOAuthFailureKind = "http" | "network" | "timeout" | "invalid_response";

/** Only fixed classifications and HTTP status survive; no response body, URL,
 * code, token, credential, raw network error or identity is retained. */
export class XOAuthRequestError extends Error {
  constructor(readonly stage: XOAuthRequestStage, readonly kind: XOAuthFailureKind, readonly httpStatus?: number) {
    const operation = stage === "token_exchange" ? "token exchange" : "user lookup";
    super(kind === "http" ? `X ${operation} failed: ${httpStatus}`
      : kind === "invalid_response" ? (stage === "token_exchange" ? "X token exchange returned an invalid response." : "X user lookup returned an invalid identity.")
      : `X ${operation} failed: ${kind}.`);
    this.name = "XOAuthRequestError";
  }
}

export class RealXOAuthClient implements XOAuthClient {
  readonly providerKind = "x" as const;
  private readonly dispatcher: ReturnType<typeof createXOAuthDispatcher>;

  constructor(private config: XOAuthConfig, env: NodeJS.ProcessEnv = process.env) {
    this.dispatcher = createXOAuthDispatcher(env);
  }

  async close(): Promise<void> { await this.dispatcher?.close(); }

  private async requestJson(stage: XOAuthRequestStage, url: string, init: RequestInit): Promise<unknown> {
    const options = { ...init, dispatcher: this.dispatcher, redirect: "error" as const, signal: AbortSignal.timeout(10_000) };
    let res: Response;
    try {
      res = await fetch(url, options);
    } catch (error) {
      const timeout = error instanceof Error && (error.name === "TimeoutError" ||
        (error.cause as { code?: unknown } | undefined)?.code === "UND_ERR_CONNECT_TIMEOUT");
      throw new XOAuthRequestError(stage, timeout ? "timeout" : "network");
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new XOAuthRequestError(stage, "http", res.status);
    }
    try { return await res.json(); }
    catch { throw new XOAuthRequestError(stage, "invalid_response"); }
  }

  getAuthorizeUrl(state: string, codeChallenge: string): string {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("scope", X_IDENTITY_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<string> {
    const body = new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      code_verifier: codeVerifier,
    });

    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
    if (this.config.clientSecret) {
      const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
      headers.Authorization = `Basic ${basic}`;
    }

    const json = await this.requestJson("token_exchange", TOKEN_URL, { method: "POST", headers, body: body.toString() }) as { access_token?: unknown } | null;
    if (!json || typeof json.access_token !== "string" || !json.access_token.trim()) throw new XOAuthRequestError("token_exchange", "invalid_response");
    return json.access_token;
  }

  async getUser(accessToken: string): Promise<XUser> {
    const json = await this.requestJson("identity_lookup", USER_URL, { headers: { Authorization: `Bearer ${accessToken}` } }) as { data?: { id?: unknown; username?: unknown } } | null;
    if (!json?.data || typeof json.data.id !== "string" || !/^[1-9]\d{0,19}$/.test(json.data.id)
      || typeof json.data.username !== "string" || !/^[a-zA-Z0-9_]{1,15}$/.test(json.data.username)) throw new XOAuthRequestError("identity_lookup", "invalid_response");
    return { id: json.data.id, username: json.data.username };
  }
}

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function generateState(): string {
  return randomBytes(16).toString("base64url");
}
