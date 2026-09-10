import type { MemoryAuthState } from "../v1/authState.js";
import type { ClaimRuntime } from "../v1/claim.js";
import { fixtureIdentity, seedDevelopmentClaim } from "../v1/fixtures.js";
import { deriveSignatureId } from "../v1/identity.js";
import { DEV_RENDERER_VERSION } from "../v1/renderer.js";
import { FIXTURE_TRANSFER_HOLDER } from "./fixtures.js";
import type { V2MintService } from "./service.js";

/** Public handles checked against the linked primary sources on 2026-09-06.
 * Only the handle strings are real: identities, gr0k values, claims, wallets,
 * mints and transfers are fictional. No participation or endorsement implied.
 * One library seeds the stored records used by both Claimed and Minted. */
export const GALLERY_DEVELOPMENT_FIXTURES = [
  { handle: "beeple", gr0kRaw: 640000, sourceUrl: "https://www.beeple-crap.com/" },
  { handle: "xcopyart", gr0kRaw: 215000, sourceUrl: "https://xcopy.art/" },
  { handle: "refikanadol", gr0kRaw: 880000, sourceUrl: "https://links.refikanadol.com/" },
  { handle: "tylerxhobbs", gr0kRaw: 450000, sourceUrl: "https://www.tylerxhobbs.com/" },
  { handle: "reas", gr0kRaw: 730000, sourceUrl: "https://reas.com/" },
  { handle: "karpathy", gr0kRaw: 95000, sourceUrl: "https://karpathy.ai/" },
  { handle: "sama", gr0kRaw: 565000, sourceUrl: "https://blog.samaltman.com/" },
  { handle: "naval", gr0kRaw: 340000, sourceUrl: "https://nav.al/" },
  { handle: "paulg", gr0kRaw: 965000, sourceUrl: "https://www.paulgraham.com/" },
  { handle: "levelsio", gr0kRaw: 0, sourceUrl: "https://levels.io/" },
  { handle: "garrytan", gr0kRaw: 1000000, sourceUrl: "https://nav.al/" },
] as const;

/** Rich in-memory UI sample only. The durable Anvil rehearsal does not call
 * this: its Gallery must continue to reflect actual local-chain events. */
export async function seedGalleryDevelopmentFixtures(
  runtime: ClaimRuntime,
  auth: MemoryAuthState,
  service: V2MintService,
): Promise<void> {
  if (!service.config.fixtureMode || !service.config.enabled) return;

  for (const [index, fixture] of GALLERY_DEVELOPMENT_FIXTURES.entries()) {
    const claimedAt = new Date(Date.UTC(2026, 7, 20 + index, 9));
    const identity = fixtureIdentity(fixture.handle, claimedAt);
    const signatureId = deriveSignatureId({
      xUserId: identity.xUserId,
      handleNormalized: fixture.handle,
      gr0kRaw: fixture.gr0kRaw,
      rendererVersion: DEV_RENDERER_VERSION,
    });
    // Do not replay authentication or overwrite holder changes on a rerun.
    if (service.state.getProjection(signatureId).state === "finalized") continue;

    const { signature, account } = await seedDevelopmentClaim(runtime, auth, fixture.handle, fixture.gr0kRaw, claimedAt);
    const mintedAt = new Date(claimedAt.getTime() + 60 * 60 * 1000);
    service.seedFixtureBinding(account.xUserId, account.publicAccountId, mintedAt);
    const state = service.state.getProjection(signatureId).state;
    if (state === "unminted") await service.issueAuthorization(signature, account, mintedAt);

    // Use the same simulated lifecycle as the interactive rehearsal so cards
    // resolve to real stored claims, SVG/PNG assets, and frozen metadata.
    for (let step = 1; step <= 3 && service.state.getProjection(signatureId).state !== "finalized"; step++) {
      service.advanceFixture(signatureId, account.xUserId, new Date(mintedAt.getTime() + step * 60 * 1000));
    }
    if (index % 3 === 0) service.state.updateFinalizedHolder(signatureId, FIXTURE_TRANSFER_HOLDER);
  }
}
