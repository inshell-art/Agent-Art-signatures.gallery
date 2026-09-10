import { getAddress } from "viem";
import type { SignatureStore } from "../v1/store.js";
import { V2MintService } from "./service.js";

export const FIXTURE_TRANSFER_HOLDER = getAddress("0x90F79bf6EB2c4f870365E785982E1f101E93b906");

/** Seeds three deliberately different states so the V2 product can be felt
 * locally: unminted, included-but-unfinalized, and finalized. Every visible
 * surface remains marked as a development rehearsal. */
export async function seedV2DevelopmentFixtures(service: V2MintService, signatures: SignatureStore): Promise<void> {
  if (!service.config.fixtureMode) return;
  const xUserId = "1234567890123456789";
  const account = await signatures.getAccount(xUserId);
  if (!account) throw new Error("V2 fixture account must be seeded after V1 fixtures.");
  const claims = await signatures.listSignaturesForAccount(xUserId);
  if (claims.length < 3) throw new Error("V2 fixture rehearsal requires three V1 claims.");
  service.seedFixtureBinding(xUserId, account.publicAccountId, new Date("2026-09-04T12:00:00.000Z"));

  const included = claims[1];
  await service.issueAuthorization(included, account, new Date("2026-09-04T12:02:00.000Z"));
  service.advanceFixture(included.signatureId, xUserId, new Date("2026-09-04T12:03:00.000Z"));
  service.advanceFixture(included.signatureId, xUserId, new Date("2026-09-04T12:04:00.000Z"));

  const finalized = claims[2];
  await service.issueAuthorization(finalized, account, new Date("2026-09-04T11:30:00.000Z"));
  service.advanceFixture(finalized.signatureId, xUserId, new Date("2026-09-04T11:31:00.000Z"));
  service.advanceFixture(finalized.signatureId, xUserId, new Date("2026-09-04T11:32:00.000Z"));
  service.advanceFixture(finalized.signatureId, xUserId, new Date("2026-09-04T11:45:00.000Z"));
  // Make claimant, initial recipient, and current holder visibly distinct in
  // the rehearsal without implying that a real Transfer was observed.
  service.state.updateFinalizedHolder(finalized.signatureId, FIXTURE_TRANSFER_HOLDER);
}
