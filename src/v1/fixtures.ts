import { createHash } from "node:crypto";
import { generateCodeVerifier } from "../claim/xOAuthClient.js";
import type { AuthenticatedIdentity, MemoryAuthState } from "./authState.js";
import { finalizeClaim, type ClaimRuntime } from "./claim.js";
import { GR0K_SCALE } from "./input.js";
import { sha256Hex } from "./renderer.js";

export function fixtureIdentity(handleNormalized: string, now = new Date()): AuthenticatedIdentity {
  const xUserId = handleNormalized === "alice"
    ? "1234567890123456789"
    : BigInt(`0x${createHash("sha256").update(handleNormalized).digest("hex").slice(0, 15)}`).toString();
  return { xUserId, username: handleNormalized, handleNormalized, authenticatedAt: now };
}

async function seedOne(runtime: ClaimRuntime, auth: MemoryAuthState, handle: string, gr0kRaw: number, claimedAt: Date): Promise<void> {
  const identity = fixtureIdentity(handle, new Date(claimedAt.getTime() - 2 * 60 * 1000));
  const renderer = runtime.renderers.get("sg-renderer-dev-fixture");
  const rendered = renderer.render({ handleNormalized: handle, gr0kRaw, gr0kScale: GR0K_SCALE, rendererVersion: renderer.version });
  const { session } = auth.getOrCreateSession(null, identity.authenticatedAt);
  const { flow } = auth.startFlow(session, "claim", {
    handleNormalized: handle,
    gr0kRaw,
    rendererVersion: renderer.version,
    previewSvgSha256: sha256Hex(rendered.svgUtf8),
  }, generateCodeVerifier(), identity.authenticatedAt);
  flow.status = "processing";
  auth.authenticate(flow, identity, session, identity.authenticatedAt);
  await finalizeClaim(runtime, flow, identity, claimedAt);
  auth.complete(flow);
}

export async function seedDevelopmentFixtures(runtime: ClaimRuntime, auth: MemoryAuthState): Promise<void> {
  await seedOne(runtime, auth, "alice", 120000, new Date("2026-08-14T09:30:00.000Z"));
  await seedOne(runtime, auth, "alice", 371924, new Date("2026-08-26T16:12:00.000Z"));
  await seedOne(runtime, auth, "alice", 820000, new Date("2026-09-02T11:05:00.000Z"));
}
