import { afterEach, describe, expect, it, vi } from "vitest";
import { getGlobalDispatcher } from "undici";
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
  RealXOAuthClient,
  XOAuthRequestError,
  X_IDENTITY_SCOPES,
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
    expect(url.origin + url.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/callback");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("users.read tweet.read");
  });

  it("pins the documented identity scopes, with no extra permissions", () => {
    expect(X_IDENTITY_SCOPES).toEqual(["users.read", "tweet.read"]);
    expect(Object.isFrozen(X_IDENTITY_SCOPES)).toBe(true);
  });

  it("cannot broaden scopes through a legacy or externally supplied config", () => {
    const config = {
      clientId: "client-1",
      redirectUri: "https://app.example/callback",
      scopes: ["users.read", "tweet.read", "tweet.write", "dm.read", "users.email", "offline.access"],
    };
    const client = new RealXOAuthClient(config);
    const url = new URL(client.getAuthorizeUrl("s", "c"));
    expect(url.searchParams.get("scope")).toBe("users.read tweet.read");
  });

  it("uses the sign-in token only for self-identity, returning only the ID and handle", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://api.x.com/2/oauth2/token") {
        return Response.json({ access_token: "identity-token", refresh_token: "discard-this-token" });
      }
      if (url === "https://api.x.com/2/users/me") {
        return Response.json({ data: { id: "999", username: "alice", name: "Alice", description: "Do not retain", protected: true } });
      }
      throw new Error("Identity sign-in must not request posts or other accounts");
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new RealXOAuthClient({ clientId: "client-1", redirectUri: "https://app.example/callback" });
    const token = await client.exchangeCode("code", "verifier");
    expect(token).toBe("identity-token");
    expect(await client.getUser(token)).toEqual({ id: "999", username: "alice" });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.x.com/2/oauth2/token", "https://api.x.com/2/users/me",
    ]);
  });

  it("exchangeCode posts to the token endpoint and returns the access token", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify({ access_token: "token-abc" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new RealXOAuthClient({ clientId: "client-1", redirectUri: "https://app.example/callback" });
    const token = await client.exchangeCode("auth-code", "verifier-1");

    expect(token).toBe("token-abc");
    const [url, init] = fetchMock.mock.calls[0];
    const headers = init!.headers as Record<string, string>;
    expect(url).toBe("https://api.x.com/2/oauth2/token");
    expect(init!.method).toBe("POST");
    expect(init!.redirect).toBe("error");
    expect(init!.signal).toBeInstanceOf(AbortSignal);
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
        expect(_url).toBe("https://api.x.com/2/users/me");
        expect(init.redirect).toBe("error");
        expect(init.signal).toBeInstanceOf(AbortSignal);
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

  it.each([null, {}, { access_token: "" }, { access_token: 123 }])("rejects malformed token responses: %j", async payload => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload)));
    const client = new RealXOAuthClient({ clientId: "c", redirectUri: "http://127.0.0.1:3000/auth/x/callback" });
    await expect(client.exchangeCode("code", "verifier")).rejects.toThrow("invalid response");
  });

  it.each([null, {}, { data: { id: 123, username: "alice" } }, { data: { id: "123", username: "a/b" } }, { data: { id: "0", username: "alice" } }])("rejects malformed account identities: %j", async payload => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload)));
    const client = new RealXOAuthClient({ clientId: "c", redirectUri: "http://127.0.0.1:3000/auth/x/callback" });
    await expect(client.getUser("token")).rejects.toThrow("invalid identity");
  });

  it("does not echo provider response bodies that might contain credentials", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("SECRET_TOKEN_IN_PROVIDER_BODY", { status: 403 })));
    const client = new RealXOAuthClient({ clientId: "c", redirectUri: "http://127.0.0.1:3000/auth/x/callback" });
    for (const operation of [client.exchangeCode("code", "verifier"), client.getUser("token")]) {
      await expect(operation).rejects.not.toThrow("SECRET_TOKEN_IN_PROVIDER_BODY");
    }
  });

  it("attaches a dispatcher only to the two X requests without changing global routing", async () => {
    const originalDispatcher = getGlobalDispatcher();
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => Response.json(url.endsWith("/token")
      ? { access_token: "test-token" } : { data: { id: "123", username: "alice" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new RealXOAuthClient({ clientId: "c", redirectUri: "https://app.example/callback" }, { HTTPS_PROXY: "http://127.0.0.1:7890" });
    try {
      await client.exchangeCode("test-code", "test-verifier");
      await client.getUser("test-token");
      const options = fetchMock.mock.calls.map(([, init]) => init as RequestInit & { dispatcher?: unknown });
      expect(options[0].dispatcher).toBeDefined();
      expect(options[1].dispatcher).toBe(options[0].dispatcher);
      expect(options.every(init => init.redirect === "error" && init.signal instanceof AbortSignal)).toBe(true);
      expect(getGlobalDispatcher()).toBe(originalDispatcher);
    } finally { await client.close(); }
  });

  it.each([
    [new TypeError("SECRET_NETWORK_URL", { cause: { code: "ECONNREFUSED", detail: "SECRET_NETWORK_URL" } }), "network"],
    [new TypeError("SECRET_NETWORK_URL", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }), "timeout"],
    [new DOMException("SECRET_NETWORK_URL", "TimeoutError"), "timeout"],
  ])("classifies transport failures without preserving sensitive error data (%#)", async (failure, kind) => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw failure; }));
    const client = new RealXOAuthClient({ clientId: "c", redirectUri: "https://app.example/callback" }, {});
    for (const [stage, operation] of [
      ["token_exchange", () => client.exchangeCode("test-code", "test-verifier")],
      ["identity_lookup", () => client.getUser("test-token")],
    ] as const) {
      const error = await operation().catch(error => error);
      expect(error).toBeInstanceOf(XOAuthRequestError);
      expect(error).toMatchObject({ stage, kind });
      expect(error.cause).toBeUndefined();
      expect(String(error) + JSON.stringify(error)).not.toContain("SECRET_NETWORK_URL");
    }
  });

  it("classifies invalid JSON without retaining the response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("SECRET_INVALID_JSON")));
    const client = new RealXOAuthClient({ clientId: "c", redirectUri: "https://app.example/callback" }, {});
    const error = await client.getUser("test-token").catch(error => error);
    expect(error).toMatchObject({ stage: "identity_lookup", kind: "invalid_response" });
    expect(String(error) + JSON.stringify(error)).not.toContain("SECRET_INVALID_JSON");
  });
});
