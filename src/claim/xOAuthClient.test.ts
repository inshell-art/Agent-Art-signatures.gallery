import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
  RealXOAuthClient,
} from "./xOAuthClient.js";

describe("PKCE helpers", () => {
  it("generateCodeVerifier/generateState produce distinct, non-empty values each call", () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
    expect(generateState()).not.toBe(generateState());
    expect(generateCodeVerifier().length).toBeGreaterThan(0);
  });

  it("generateCodeChallenge is deterministic (S256 of the verifier) and differs per verifier", () => {
    expect(generateCodeChallenge("verifier-a")).toBe(generateCodeChallenge("verifier-a"));
    expect(generateCodeChallenge("verifier-a")).not.toBe(generateCodeChallenge("verifier-b"));
  });
});

describe("RealXOAuthClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds an authorize URL with PKCE S256 and the configured redirect/scopes", () => {
    const client = new RealXOAuthClient({ clientId: "client-1", redirectUri: "https://app.example/callback" });
    const url = new URL(client.getAuthorizeUrl("state-1", "challenge-1"));
    expect(url.origin + url.pathname).toBe("https://twitter.com/i/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/callback");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("users.read tweet.read");
  });

  it("uses custom scopes when configured", () => {
    const client = new RealXOAuthClient({
      clientId: "client-1",
      redirectUri: "https://app.example/callback",
      scopes: ["offline.access"],
    });
    const url = new URL(client.getAuthorizeUrl("s", "c"));
    expect(url.searchParams.get("scope")).toBe("offline.access");
  });

  it("exchangeCode posts to the token endpoint and returns the access token", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify({ access_token: "token-abc" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new RealXOAuthClient({ clientId: "client-1", redirectUri: "https://app.example/callback" });
    const token = await client.exchangeCode("auth-code", "verifier-1");

    expect(token).toBe("token-abc");
    const [url, init] = fetchMock.mock.calls[0];
    const headers = init!.headers as Record<string, string>;
    expect(url).toBe("https://api.twitter.com/2/oauth2/token");
    expect(init!.method).toBe("POST");
    expect(headers.Authorization).toBeUndefined();
    const body = new URLSearchParams(init!.body as string);
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(body.get("client_id")).toBe("client-1");
  });

  it("adds Basic auth when a clientSecret is configured (confidential client)", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify({ access_token: "t" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new RealXOAuthClient({
      clientId: "client-1",
      clientSecret: "secret-1",
      redirectUri: "https://app.example/callback",
    });
    await client.exchangeCode("code", "verifier");

    const [, init] = fetchMock.mock.calls[0];
    const headers = init!.headers as Record<string, string>;
    const expected = `Basic ${Buffer.from("client-1:secret-1").toString("base64")}`;
    expect(headers.Authorization).toBe(expected);
  });

  it("throws when the token exchange fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad request", { status: 400 })));
    const client = new RealXOAuthClient({ clientId: "c", redirectUri: "https://app.example/callback" });
    await expect(client.exchangeCode("code", "verifier")).rejects.toThrow(/X token exchange failed: 400/);
  });

  it("getUser returns id/username from the API response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: any) => {
        expect(init.headers.Authorization).toBe("Bearer token-abc");
        return new Response(JSON.stringify({ data: { id: "999", username: "alice" } }), { status: 200 });
      }),
    );
    const client = new RealXOAuthClient({ clientId: "c", redirectUri: "https://app.example/callback" });
    const user = await client.getUser("token-abc");
    expect(user).toEqual({ id: "999", username: "alice" });
  });

  it("throws when the user lookup fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    const client = new RealXOAuthClient({ clientId: "c", redirectUri: "https://app.example/callback" });
    await expect(client.getUser("bad-token")).rejects.toThrow(/X user lookup failed: 401/);
  });
});
