import { describe, expect, it } from "vitest";
import { generationPolicy, GROK_PILOT_PROFILE, pilotPreflight } from "./providerProfile.js";

const approved = { OPEN_MINT_GENERATION_ENABLED: "1", OPEN_MINT_PILOT_APPROVED: "1", OPEN_MINT_PILOT_HANDLE: "@ALIce",
  OPEN_MINT_RESERVATION_USD_TICKS: "10000000000", OPEN_MINT_EXPOSURE_USD_TICKS: "10000000000" };
const REVIEWED = new Date("2026-09-19T00:00:00.000Z");

describe("server-owned one-attempt pilot profile", () => {
  it("defaults paid generation off even with keys and keeps fixture settings separate", () => {
    expect(generationPolicy(false, { XAI_API_KEY: "mock", OPEN_MINT_X_BEARER_TOKEN: "mock" }, REVIEWED)).toMatchObject({ enabled: false, maxTotalAttempts: 1, maxActiveAttempts: 1, accountingRequired: true });
    expect(generationPolicy(true, {}, REVIEWED)).toMatchObject({ enabled: true, accountingRequired: false, dailyLimit: 25 });
    expect(generationPolicy(false, approved, REVIEWED)).toMatchObject({ enabled: true, allowedHandle: "alice", dailyLimit: 1, accountingRequired: true });
    expect(GROK_PILOT_PROFILE).toMatchObject({ model: "grok-4.3", maxTurns: 3, maxOutputTokens: 1024, reasoningEffort: "low" });
    expect(Object.isFrozen(GROK_PILOT_PROFILE)).toBe(true);
  });
  it.each([
    { OPEN_MINT_GENERATION_ENABLED: "yes" }, { OPEN_MINT_PILOT_APPROVED: "true" },
    { ...approved, OPEN_MINT_PILOT_APPROVED: "0" }, { ...approved, OPEN_MINT_PILOT_HANDLE: undefined },
    { ...approved, OPEN_MINT_PILOT_HANDLE: "bad/handle" }, { ...approved, OPEN_MINT_RESERVATION_USD_TICKS: undefined },
    { ...approved, OPEN_MINT_EXPOSURE_USD_TICKS: "-1" }, { ...approved, OPEN_MINT_RESERVATION_USD_TICKS: "01" },
    { ...approved, OPEN_MINT_RESERVATION_USD_TICKS: "1.1" }, { ...approved, OPEN_MINT_EXPOSURE_USD_TICKS: "1" },
    { ...approved, OPEN_MINT_GROK_MODEL: "grok-4.6" }, { OPEN_MINT_DAILY_ASSESSMENT_LIMIT: "-1" },
    { OPEN_MINT_DAILY_ASSESSMENT_LIMIT: "NaN" }, { OPEN_MINT_DAILY_ASSESSMENT_LIMIT: "1001" },
  ])("rejects invalid or unapproved configuration %#", env => { expect(() => generationPolicy(false, env, REVIEWED)).toThrow(); });
  it.each([
    ["2026-09-21T18:59:59.999Z", true], ["2026-09-21T19:00:00.000Z", false], ["2026-09-22T00:00:00.000Z", false],
  ])("enforces the pricing review boundary at %s without rejecting saved-result startup", (time, enabled) => {
    const policy = generationPolicy(false, approved, new Date(time));
    expect(policy.enabled).toBe(enabled);
    expect(policy.disabledReason).toBe(enabled ? undefined : "pricing-review-required");
    expect(generationPolicy(true, {}, new Date(time)).enabled).toBe(true);
  });
  it("keeps expired-profile read-only startup possible without a new exposure approval", () => {
    expect(generationPolicy(false, { OPEN_MINT_GENERATION_ENABLED: "1" }, new Date(GROK_PILOT_PROFILE.pricingChangesAt)))
      .toMatchObject({ enabled: false, disabledReason: "pricing-review-required" });
    expect(() => generationPolicy(false, approved, new Date("invalid"))).toThrow("Invalid generation policy time");
  });
  it("ignores an old generation model only while paid dispatch is disabled", () => {
    expect(generationPolicy(false, { OPEN_MINT_GROK_MODEL: "grok-4.6" }, REVIEWED)).toMatchObject({ enabled: false });
    expect(generationPolicy(false, { ...approved, OPEN_MINT_GROK_MODEL: "grok-4.6" }, new Date(GROK_PILOT_PROFILE.pricingChangesAt)))
      .toMatchObject({ enabled: false, disabledReason: "pricing-review-required" });
    expect(() => generationPolicy(false, { ...approved, OPEN_MINT_GROK_MODEL: "grok-4.6" }, REVIEWED)).toThrow("reviewed profile revision");
  });
  it("prints key presence only and distinguishes configuration from entitlement or a dollar cap", () => {
    const report = pilotPreflight({ ...approved, XAI_API_KEY: "secret-key-value", OPEN_MINT_X_BEARER_TOKEN: "secret-token-value" }, new Date("2026-09-19T00:00:00Z"));
    expect(report.blockers).toEqual([]);
    expect(report.credentials).toEqual({ xaiConfigured: true, xConfigured: true });
    expect(report.accountEntitlement).toContain("unverified");
    expect(report.providerDollarCap).toContain("not-guaranteed");
    expect(JSON.stringify(report)).not.toContain("secret");
  });
  it("reports missing prerequisites and the known pricing transition without spending", () => {
    expect(pilotPreflight({}, new Date("2026-09-19T00:00:00Z")).blockers).toHaveLength(3);
    expect(pilotPreflight({ ...approved, OPEN_MINT_GROK_MODEL: "bad" }, REVIEWED).blockers.join(" ")).toContain("reviewed profile");
    expect(pilotPreflight(approved, new Date("2026-09-21T19:00:00Z")).blockers.join(" ")).toContain("pricing transition");
  });
});
