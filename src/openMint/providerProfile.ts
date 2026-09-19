import { canonicalHandle } from "./identity.js";

/** Server-owned pilot profile. Changing it never changes an existing canonical assessment. */
export const GROK_PILOT_PROFILE = Object.freeze({
  id: "sg-grok-mbti-2026-09-19-v1",
  model: "grok-4.3",
  reasoningEffort: "low" as const,
  maxOutputTokens: 1024,
  maxTurns: 3,
  timeoutMs: 90_000,
  pricingReviewedAt: "2026-09-19",
  pricingChangesAt: "2026-09-21T19:00:00.000Z",
});
export const FIXTURE_PROFILE_VERSION = "sg-fixture-mbti-v1";

export interface GenerationPolicy {
  enabled: boolean;
  disabledReason?: "pricing-review-required";
  allowedHandle?: string;
  dailyLimit: number;
  maxTotalAttempts: number;
  maxActiveAttempts: number;
  accountingRequired: boolean;
  reservationUsdTicks: string;
  maxExposureUsdTicks: string;
}

function flag(value: string | undefined, name: string): boolean {
  if (value !== undefined && value !== "0" && value !== "1") throw new Error(`Invalid ${name}; use 0 or 1.`);
  return value === "1";
}
function ticks(value: string | undefined, name: string): string {
  if (value === undefined || !/^[1-9][0-9]{0,14}$/.test(value)) throw new Error(`${name} must be explicit positive integer USD ticks (1 USD = 10000000000 ticks).`);
  return value;
}

/** Constructing configuration never sends requests or changes account billing settings. */
export function generationPolicy(fixture: boolean, env: NodeJS.ProcessEnv, now = new Date()): GenerationPolicy {
  const dailyLimit = Number(env.OPEN_MINT_DAILY_ASSESSMENT_LIMIT ?? (fixture ? 25 : 1));
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 1000) throw new Error("Invalid daily assessment limit.");
  if (fixture) return { enabled: true, dailyLimit, maxTotalAttempts: 10_000, maxActiveAttempts: 4, accountingRequired: false,
    reservationUsdTicks: "1", maxExposureUsdTicks: "10000" };
  const requested = flag(env.OPEN_MINT_GENERATION_ENABLED, "OPEN_MINT_GENERATION_ENABLED");
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid generation policy time.");
  // Re-evaluated at admission and immediately before each paid leg. Expiry closes
  // generation without preventing startup or access to saved immutable results.
  const pricingReviewRequired = now.getTime() >= Date.parse(GROK_PILOT_PROFILE.pricingChangesAt);
  const enabled = requested && !pricingReviewRequired;
  if (enabled && env.OPEN_MINT_GROK_MODEL && env.OPEN_MINT_GROK_MODEL !== GROK_PILOT_PROFILE.model) throw new Error("The pilot uses the pinned server request profile; model overrides require a reviewed profile revision.");
  const approved = flag(env.OPEN_MINT_PILOT_APPROVED, "OPEN_MINT_PILOT_APPROVED");
  const allowedHandle = env.OPEN_MINT_PILOT_HANDLE === undefined ? undefined : canonicalHandle(env.OPEN_MINT_PILOT_HANDLE);
  if (enabled && (!approved || !allowedHandle)) throw new Error("Real generation requires explicit pilot approval and an allowlisted handle.");
  const reservationUsdTicks = enabled ? ticks(env.OPEN_MINT_RESERVATION_USD_TICKS, "OPEN_MINT_RESERVATION_USD_TICKS") : "10000000000";
  const maxExposureUsdTicks = enabled ? ticks(env.OPEN_MINT_EXPOSURE_USD_TICKS, "OPEN_MINT_EXPOSURE_USD_TICKS") : "10000000000";
  if (BigInt(reservationUsdTicks) > BigInt(maxExposureUsdTicks)) throw new Error("The pilot reservation exceeds its accepted exposure threshold.");
  return { enabled, ...(pricingReviewRequired ? { disabledReason: "pricing-review-required" as const } : {}),
    allowedHandle, dailyLimit, maxTotalAttempts: 1, maxActiveAttempts: 1, accountingRequired: true, reservationUsdTicks, maxExposureUsdTicks };
}

/** Safe configuration summary: no credentials, capability codes, prompts or provider bodies. */
export function pilotPreflight(env: NodeJS.ProcessEnv, now = new Date()) {
  let policy: GenerationPolicy | undefined;
  const blockers: string[] = [];
  try { policy = generationPolicy(false, env, now); } catch (error) { blockers.push((error as Error).message); }
  const credentials = { xaiConfigured: !!env.XAI_API_KEY?.trim(), xConfigured: !!env.OPEN_MINT_X_BEARER_TOKEN?.trim() };
  if (!credentials.xaiConfigured) blockers.push("XAI_API_KEY is missing.");
  if (!credentials.xConfigured) blockers.push("OPEN_MINT_X_BEARER_TOKEN is missing.");
  if (!policy?.enabled && policy?.disabledReason !== "pricing-review-required") blockers.push("Paid generation remains disabled; obtain the user's one-attempt approval before enabling it.");
  if (now.toISOString() >= GROK_PILOT_PROFILE.pricingChangesAt) blockers.push("The documented X Search pricing transition has occurred; review the exposure envelope before a paid call.");
  return { profile: GROK_PILOT_PROFILE, credentials, policy, blockers,
    accountEntitlement: "unverified-without-live-provider-check",
    providerDollarCap: "not-guaranteed: output/turn/time limits do not cap fetched resources or total charges",
    automaticRetries: 0,
    stopConditions: ["X lookup failure", "abstention", "invalid result", "timeout or missing receipt", "durable-write failure", "unexpected model or account identity"],
  };
}
