import { describe, expect, it } from "vitest";
import { generateCodeChallenge } from "./xOAuthClient.js";
import { LocalOAuthEmulatorError, LocalXOAuthEmulator } from "./localXOAuthEmulator.js";

const verifier = "test-verifier-that-is-long-enough-for-the-rehearsal";

function requestIdFrom(url: string): string {
  return new URL(url, "http://local.invalid").searchParams.get("request")!;
}

describe("LocalXOAuthEmulator", () => {
  it("uses an opaque provider request and completes a one-time PKCE exchange", async () => {
    const provider = new LocalXOAuthEmulator();
    const state = "state_that_stays_server_side_123456";
    const authorizeUrl = provider.getAuthorizeUrl(state, generateCodeChallenge(verifier));
    expect(authorizeUrl).toMatch(/^\/dev\/oauth\/x\/authorize\?request=/);
    expect(authorizeUrl).not.toContain(state);
    expect(authorizeUrl).not.toContain(generateCodeChallenge(verifier));

    const requestId = requestIdFrom(authorizeUrl);
    const view = provider.getAuthorizationRequest(requestId)!;
    expect(view.accounts.map((account) => account.username)).toEqual(["alice", "bob", "newcomer", "alice_studio"]);
    const callback = provider.completeAuthorization(requestId, "approve", "alice");
    expect(provider.getAuthorizationRequest(requestId)).toBeNull();

    const callbackUrl = new URL(callback, "http://local.invalid");
    expect(callbackUrl.searchParams.get("state")).toBe(state);
    const code = callbackUrl.searchParams.get("code")!;
    const token = await provider.exchangeCode(code, verifier);
    await expect(provider.exchangeCode(code, verifier)).rejects.toBeInstanceOf(LocalOAuthEmulatorError);
    await expect(provider.getUser(token)).resolves.toEqual({ id: "1234567890123456789", username: "alice" });
    await expect(provider.getUser(token)).rejects.toBeInstanceOf(LocalOAuthEmulatorError);
  });

  it("consumes a code after a wrong PKCE verifier", async () => {
    const provider = new LocalXOAuthEmulator();
    const requestId = requestIdFrom(provider.getAuthorizeUrl("state_for_wrong_pkce_123456789", generateCodeChallenge(verifier)));
    const callback = new URL(provider.completeAuthorization(requestId, "approve", "alice"), "http://local.invalid");
    const code = callback.searchParams.get("code")!;
    await expect(provider.exchangeCode(code, `${verifier}-tampered`)).rejects.toThrow("PKCE");
    await expect(provider.exchangeCode(code, verifier)).rejects.toThrow("already used");
  });

  it("returns explicit denial and provider-error callbacks without issuing codes", () => {
    const provider = new LocalXOAuthEmulator();
    const denialRequest = requestIdFrom(provider.getAuthorizeUrl("state_for_denial_123456789012", generateCodeChallenge(verifier)));
    const denial = new URL(provider.completeAuthorization(denialRequest, "deny"), "http://local.invalid");
    expect(denial.searchParams.get("error")).toBe("access_denied");
    expect(denial.searchParams.has("code")).toBe(false);

    const errorRequest = requestIdFrom(provider.getAuthorizeUrl("state_for_error_1234567890123", generateCodeChallenge(verifier)));
    const failure = new URL(provider.completeAuthorization(errorRequest, "provider_error"), "http://local.invalid");
    expect(failure.searchParams.get("error")).toBe("temporarily_unavailable");
    expect(failure.searchParams.has("code")).toBe(false);
  });

  it("rejects unknown accounts without consuming a correctable request", () => {
    const provider = new LocalXOAuthEmulator();
    const requestId = requestIdFrom(provider.getAuthorizeUrl("state_for_account_123456789012", generateCodeChallenge(verifier)));
    expect(() => provider.completeAuthorization(requestId, "approve", "mallory")).toThrow("listed");
    expect(provider.getAuthorizationRequest(requestId)).not.toBeNull();
  });

  it("expires authorization requests and codes", async () => {
    let now = 1_000;
    const provider = new LocalXOAuthEmulator(() => now, 100);
    const expiredRequest = requestIdFrom(provider.getAuthorizeUrl("state_for_expiry_1234567890123", generateCodeChallenge(verifier)));
    now += 101;
    expect(provider.getAuthorizationRequest(expiredRequest)).toBeNull();

    const codeRequest = requestIdFrom(provider.getAuthorizeUrl("state_for_code_expiry_123456789", generateCodeChallenge(verifier)));
    const callback = new URL(provider.completeAuthorization(codeRequest, "approve", "alice"), "http://local.invalid");
    now += 101;
    await expect(provider.exchangeCode(callback.searchParams.get("code")!, verifier)).rejects.toThrow("expired");
  });
});
