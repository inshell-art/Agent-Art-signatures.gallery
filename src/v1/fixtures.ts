import { createHash } from "node:crypto";
import { generateCodeVerifier } from "../claim/xOAuthClient.js";
import type { AuthenticatedIdentity, MemoryAuthState } from "./authState.js";
import { finalizeClaim, type ClaimRuntime } from "./claim.js";
import { GR0K_SCALE, normalizeHandleValue, validateRenderHandle } from "./input.js";
import { RENDERER_VERSION, sha256Hex } from "./renderer.js";

export function fixtureIdentity(handle: string, now = new Date()): AuthenticatedIdentity {
  const handleNormalized = normalizeHandleValue(handle);
  const xUserId = handleNormalized === "alice"
    ? "1234567890123456789"
    : BigInt(`0x${createHash("sha256").update(handleNormalized).digest("hex").slice(0, 15)}`).toString();
  return { xUserId, username: validateRenderHandle(handle), handleNormalized, authenticatedAt: now };
}

export async function seedDevelopmentClaim(runtime: ClaimRuntime, auth: MemoryAuthState, handle: string, gr0kRaw: number, claimedAt: Date) {
  const identity = fixtureIdentity(handle, new Date(claimedAt.getTime() - 2 * 60 * 1000));
  const renderer = runtime.renderers.get(RENDERER_VERSION);
  const renderHandle = validateRenderHandle(handle);
  const rendered = renderer.render({ handle: renderHandle, gr0kRaw, gr0kScale: GR0K_SCALE, rendererVersion: renderer.version });
  const { session } = auth.getOrCreateSession(null, identity.authenticatedAt);
  const { flow } = auth.startFlow(session, "claim", {
    handleNormalized: identity.handleNormalized,
    handleAtClaim: renderHandle,
    gr0kRaw,
    rendererVersion: renderer.version,
    previewSvgSha256: sha256Hex(rendered.svgUtf8),
  }, generateCodeVerifier(), identity.authenticatedAt);
  flow.status = "processing";
  auth.authenticate(flow, identity, session, identity.authenticatedAt);
  const result = await finalizeClaim(runtime, flow, identity, claimedAt);
  auth.complete(flow);
  return result;
}

export async function seedDevelopmentFixtures(runtime: ClaimRuntime, auth: MemoryAuthState): Promise<void> {
  await seedDevelopmentClaim(runtime, auth, "alice", 12, new Date("2026-08-14T09:30:00.000Z"));
  await seedDevelopmentClaim(runtime, auth, "alice", 37, new Date("2026-08-26T16:12:00.000Z"));
  await seedDevelopmentClaim(runtime, auth, "alice", 82, new Date("2026-09-02T11:05:00.000Z"));
}
