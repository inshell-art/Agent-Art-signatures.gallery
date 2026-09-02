/**
 * X OAuth 2.0 (PKCE) client — handoff §10.
 *
 * Real implementation against X's public OAuth endpoints, not a
 * placeholder — but it is untested against the live API in this repo,
 * since that requires a registered X app's credentials. `MockXOAuthClient`
 * (below) is what api/claim.test.ts exercises instead.
 */

import { createHash, randomBytes } from "node:crypto";

export interface XUser {
  id: string;
  username: string;
}

export interface XOAuthClient {
  getAuthorizeUrl(state: string, codeChallenge: string): string;
  exchangeCode(code: string, codeVerifier: string): Promise<string>; // -> access token
  getUser(accessToken: string): Promise<XUser>;
}

export interface XOAuthConfig {
  clientId: string;
  clientSecret?: string; // confidential clients only; public clients rely on PKCE alone
  redirectUri: string;
  scopes?: string[];
}

const AUTHORIZE_URL = "https://twitter.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
const USER_URL = "https://api.twitter.com/2/users/me";
const DEFAULT_SCOPES = ["users.read", "tweet.read"];

export class RealXOAuthClient implements XOAuthClient {
  constructor(private config: XOAuthConfig) {}

  getAuthorizeUrl(state: string, codeChallenge: string): string {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("scope", (this.config.scopes ?? DEFAULT_SCOPES).join(" "));
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

    const res = await fetch(TOKEN_URL, { method: "POST", headers, body: body.toString() });
    if (!res.ok) {
      throw new Error(`X token exchange failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { access_token: string };
    return json.access_token;
  }

  async getUser(accessToken: string): Promise<XUser> {
    const res = await fetch(USER_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      throw new Error(`X user lookup failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { data: { id: string; username: string } };
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
