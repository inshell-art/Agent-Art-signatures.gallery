import { afterEach, describe, expect, it, vi } from "vitest";
import { openMintProviders } from "./main.js";
import { AssessmentCoordinator } from "./assessment.js";
import { MemoryAssessmentRepository } from "./assessmentStore.js";

afterEach(() => vi.unstubAllGlobals());
describe("open mint provider configuration", () => {
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
});
