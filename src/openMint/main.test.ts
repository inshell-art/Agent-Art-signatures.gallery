import { afterEach, describe, expect, it, vi } from "vitest";
import { openMintProviders, startOpenMintApp } from "./main.js";
import { AssessmentCoordinator } from "./assessment.js";
import { MemoryAssessmentRepository } from "./assessmentStore.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
describe("open mint provider configuration", () => {
  it("rejects unsafe support configuration before startup side effects", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("PORT", "3026");
    vi.stubEnv("OPEN_MINT_ORIGIN", "http://127.0.0.1:3026");
    vi.stubEnv("OPEN_MINT_DATA_DIR", ".local/open-mint/support-config-test");
    vi.stubEnv("OPEN_MINT_GENERATION_ENABLED", "0");
    vi.stubEnv("OPEN_MINT_SUPPORT_URL", "https://user:private-secret@help.example.test");
    await expect(startOpenMintApp()).rejects.toThrow("OPEN_MINT_SUPPORT_URL must be an HTTPS URL without credentials.");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("constructs configured transports without requests and fails closed on either missing key", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(openMintProviders(false, {})).toEqual({ provider: undefined, identityResolver: undefined });
    expect(openMintProviders(false, { XAI_API_KEY: "mock-xai" }).identityResolver).toBeUndefined();
    expect(openMintProviders(false, { OPEN_MINT_X_BEARER_TOKEN: "mock-x" }).provider).toBeUndefined();
    const configured = openMintProviders(false, { XAI_API_KEY: "mock-xai", OPEN_MINT_X_BEARER_TOKEN: "mock-x" });
    expect(configured.provider?.provenance).toBe("grok");
    expect(configured.identityResolver?.provenance).toBe("x-api");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires explicit fixture mode and labels both simulated stages", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const { provider, identityResolver } = openMintProviders(true, { XAI_API_KEY: "unused", OPEN_MINT_X_BEARER_TOKEN: "unused" });
    const assessment = await new AssessmentCoordinator({ provider: provider!, identityResolver, repository: new MemoryAssessmentRepository() }).assess("@Alice");
    expect(assessment).toMatchObject({ provenance: "development-fixture", xIdentity: { provenance: "development-fixture", username: "alice" } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("permits credentialless read-only startup with an old model but rejects it before enabled paid work", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-19T00:00:00.000Z"));
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(openMintProviders(false, { OPEN_MINT_GENERATION_ENABLED: "0", OPEN_MINT_GROK_MODEL: "grok-4.6" }))
      .toEqual({ provider: undefined, identityResolver: undefined });
    expect(() => openMintProviders(false, { OPEN_MINT_GENERATION_ENABLED: "1", OPEN_MINT_GROK_MODEL: "grok-4.6",
      OPEN_MINT_PILOT_APPROVED: "1", OPEN_MINT_PILOT_HANDLE: "alice", OPEN_MINT_RESERVATION_USD_TICKS: "10000000000", OPEN_MINT_EXPOSURE_USD_TICKS: "10000000000" }))
      .toThrow("reviewed profile revision");
    expect(fetch).not.toHaveBeenCalled();
  });
});
