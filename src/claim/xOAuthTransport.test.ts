import { beforeEach, describe, expect, it, vi } from "vitest";

const constructed = vi.hoisted(() => vi.fn());
vi.mock("undici", () => ({
  EnvHttpProxyAgent: class {
    constructor(options: unknown) { constructed(options); }
  },
}));
import { createXOAuthDispatcher } from "./xOAuthTransport.js";

beforeEach(() => constructed.mockReset());

describe("X-only environment proxy dispatcher", () => {
  it("leaves requests direct without a configured proxy", () => {
    expect(createXOAuthDispatcher({ NO_PROXY: "*" })).toBeUndefined();
    expect(constructed).not.toHaveBeenCalled();
  });

  it("uses HTTP_PROXY for HTTPS when no HTTPS proxy is set", () => {
    createXOAuthDispatcher({ HTTP_PROXY: "http://127.0.0.1:7890" });
    expect(constructed).toHaveBeenCalledWith({ httpProxy: "http://127.0.0.1:7890", httpsProxy: "http://127.0.0.1:7890", noProxy: "" });
  });

  it("supports an HTTPS-only proxy without inheriting a different process HTTP proxy", () => {
    createXOAuthDispatcher({ HTTPS_PROXY: "http://127.0.0.1:7890" });
    expect(constructed).toHaveBeenCalledWith({ httpProxy: "", httpsProxy: "http://127.0.0.1:7890", noProxy: "" });
  });

  it("honors lowercase precedence and explicit NO_PROXY exclusions", () => {
    createXOAuthDispatcher({ HTTP_PROXY: "http://upper.invalid", http_proxy: "http://lower.invalid",
      HTTPS_PROXY: "http://upper-tls.invalid", https_proxy: "https://lower-tls.invalid", NO_PROXY: "upper.invalid", no_proxy: "api.x.com,127.0.0.1" });
    expect(constructed).toHaveBeenCalledWith({ httpProxy: "http://lower.invalid", httpsProxy: "https://lower-tls.invalid", noProxy: "api.x.com,127.0.0.1" });
  });

  it("supports HTTP(S) ALL_PROXY as a fallback, not an override", () => {
    createXOAuthDispatcher({ ALL_PROXY: "http://fallback.invalid", HTTPS_PROXY: "http://explicit.invalid", NO_PROXY: "localhost" });
    expect(constructed).toHaveBeenCalledWith({ httpProxy: "http://fallback.invalid", httpsProxy: "http://explicit.invalid", noProxy: "localhost" });
  });

  it.each(["socks5://user:PROXY_SECRET@127.0.0.1:7890", "not-a-url-PROXY_SECRET", "http://proxy.invalid/PROXY_SECRET", "http://proxy.invalid?secret=PROXY_SECRET"])("fails closed without exposing invalid proxy details (%#)", value => {
    expect(() => createXOAuthDispatcher({ HTTPS_PROXY: value })).toThrow("Invalid X OAuth proxy configuration");
    try { createXOAuthDispatcher({ HTTPS_PROXY: value }); } catch (error) {
      expect(String(error)).not.toContain("PROXY_SECRET");
      expect((error as Error).cause).toBeUndefined();
    }
    expect(constructed).not.toHaveBeenCalled();
  });

  it("does not leak underlying proxy construction errors", () => {
    constructed.mockImplementationOnce(() => { throw new Error("PROXY_SECRET"); });
    expect(() => createXOAuthDispatcher({ HTTPS_PROXY: "http://proxy.invalid" })).toThrow("Invalid X OAuth proxy configuration");
  });
});
