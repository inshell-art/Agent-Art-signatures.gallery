/**
 * Async, post-mint provenance check (handoff §9.3). Called fire-and-forget
 * from the mint route — never awaited before the card response, so a slow
 * or down X API can't cause the unfurl to time out.
 */

import type { Store } from "../store/types.js";
import type { XApiClient } from "./xApiClient.js";

export async function verifyAndRecordProvenance(
  store: Store,
  xApiClient: XApiClient,
  instanceId: string,
  handle: string,
  sourcePostId: string,
  agentHandle: string,
): Promise<void> {
  const verified = await xApiClient.verifyMention({ postId: sourcePostId, handle, agentHandle });
  await store.updateProvenance(instanceId, verified ? "verified" : "unverified");
}
