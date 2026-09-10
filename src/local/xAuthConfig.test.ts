import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { loadLocalAppConfig, localXOAuthClient } from "./xAuthConfig.js";

const credentials = { X_OAUTH_CLIENT_ID: "test-client-id", X_OAUTH_CLIENT_SECRET: "test-client-secret" };

describe("explicit local X provider configuration", () => {
  it("defaults to the simulator even if real credentials are present", () => {
    for (const env of [{}, credentials]) {
      const config = loadLocalAppConfig(env);
      expect(config.authMode).toBe("emulator");
      expect(config.oauth).toBeUndefined();
      expect(localXOAuthClient(config)).toBeUndefined();
    }
  });

  it("selects real OAuth independently from the local chain and pins the callback", () => {
    const config = loadLocalAppConfig({ ...credentials, LOCAL_X_AUTH_MODE: "real" });
    expect(config).toMatchObject({ port: 3000, appOrigin: "http://127.0.0.1:3000", identityDailyCallLimit: 100 });
    expect(config.oauth?.redirectUri).toBe("http://127.0.0.1:3000/auth/x/callback");
    expect(localXOAuthClient(config)?.providerKind).toBe("x");
  });

  it("lets explicit launch commands override the env mode", () => {
    expect(loadLocalAppConfig({ ...credentials, LOCAL_X_AUTH_MODE: "emulator" }, ["--x-auth=real"]).authMode).toBe("real");
    expect(loadLocalAppConfig({ LOCAL_X_AUTH_MODE: "real" }, ["--x-auth=emulator"]).authMode).toBe("emulator");
  });

  it.each([{}, { X_OAUTH_CLIENT_ID: "sensitive-id" }, { X_OAUTH_CLIENT_SECRET: "sensitive-secret" }, { ...credentials, X_OAUTH_CLIENT_SECRET: " " }])("never falls back when real-mode configuration is incomplete: %j", env => {
    expect(() => loadLocalAppConfig(env, ["--x-auth=real"])).toThrow("No simulator fallback");
    try { loadLocalAppConfig(env, ["--x-auth=real"]); } catch (error) { expect(String(error)).not.toMatch(/sensitive-id|sensitive-secret|test-client-id/); }
  });

  it.each(["http://localhost:3000/auth/x/callback", "http://127.0.0.1:3001/auth/x/callback", "http://127.0.0.1:3000/auth/x/callback/", "http://127.0.0.1:3000/auth/x/callback?test=1", "https://example.com/auth/x/callback"])("rejects a noncanonical callback: %s", redirect => {
    expect(() => loadLocalAppConfig({ ...credentials, X_OAUTH_REDIRECT_URI: redirect }, ["--x-auth=real"])).toThrow("must exactly match");
  });

  it.each(["http://localhost:3000", "http://0.0.0.0:3000", "https://example.com", "http://127.0.0.1:3000/"])("rejects an app origin that splits the browser session: %s", origin => {
    expect(() => loadLocalAppConfig({ APP_ORIGIN: origin })).toThrow("APP_ORIGIN must be");
  });

  it.each(["0", "65536", "3000abc", "3e3", "", "-1"])("rejects invalid ports: %s", port => {
    expect(() => loadLocalAppConfig({ LOCAL_APP_PORT: port })).toThrow("valid TCP port");
  });

  it("supports an explicit alternate port with an exactly matching callback", () => {
    expect(loadLocalAppConfig({ ...credentials, LOCAL_APP_PORT: "3010", APP_ORIGIN: "http://127.0.0.1:3010", X_OAUTH_REDIRECT_URI: "http://127.0.0.1:3010/auth/x/callback" }, ["--x-auth=real"]).port).toBe(3010);
  });

  it("rejects production, ambiguous flags, unknown modes and invalid budget limits", () => {
    expect(() => loadLocalAppConfig({ NODE_ENV: "production" })).toThrow("cannot run in production");
    expect(() => loadLocalAppConfig({ LOCAL_X_AUTH_MODE: "auto" })).toThrow("must be emulator or real");
    for (const args of [["--x-auth=auto"], ["--x-auth=real", "--x-auth=emulator"], ["--unknown"]]) expect(() => loadLocalAppConfig({}, args)).toThrow("at most once");
    for (const value of ["0", "NaN", "100.5", "100000"]) expect(() => loadLocalAppConfig({ X_IDENTITY_DAILY_CALL_LIMIT: value })).toThrow("X_IDENTITY_DAILY_CALL_LIMIT");
    expect(() => localXOAuthClient({ port: 3000, appOrigin: "http://127.0.0.1:3000", authMode: "real", identityDailyCallLimit: 100 })).toThrow("No simulator fallback");
  });

  it("checks configuration without accessing infrastructure or printing credentials", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/local/xAuthCheck.ts"], {
      encoding: "utf8", env: { ...process.env, ...credentials, APP_ORIGIN: "http://127.0.0.1:3000", LOCAL_APP_PORT: "3000", X_OAUTH_REDIRECT_URI: "", NODE_ENV: "test" },
    });
    expect(JSON.parse(output)).toMatchObject({ configured: true, credentials: "present (not tested against X)" });
    expect(output).not.toContain(credentials.X_OAUTH_CLIENT_ID);
    expect(output).not.toContain(credentials.X_OAUTH_CLIENT_SECRET);
  });
});
