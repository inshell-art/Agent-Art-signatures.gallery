// Anvil snapshots can stall RPC while being serialized. These local-only limits
// leave time for a snapshot without retrying mint submissions or weakening any
// chain/contract/provenance checks.
//
// The dump is not asked to carry every historical snapshot. Doing so grew the
// state file without bound on a long-lived rehearsal until each rewrite outlasted
// the interval and the node stopped answering RPC at all. The reconciler's
// historical reads still resolve, including tokenURI at a mint's own block after
// a stop/start cycle; if a future change makes an older state read fail, restore
// the flag and bound the file another way instead.
export const LOCAL_RPC_TIMEOUT_MS = 30_000;
export const LOCAL_NODE_LIFECYCLE_TIMEOUT_MS = 180_000;
export const LOCAL_ANVIL_PERSISTENCE_ARGS = [
  "--state-interval", "60",
] as const;
export const LOCAL_RPC_HTTP_OPTIONS = {
  timeout: LOCAL_RPC_TIMEOUT_MS,
  retryCount: 0,
  fetchOptions: { redirect: "error" },
} as const;

/** Wait for large snapshots to load/save, never force-kill or reset on timeout. */
export async function waitForLocalNode(
  ready: () => boolean | Promise<boolean>,
  timeoutMessage: string,
): Promise<void> {
  const deadline = Date.now() + LOCAL_NODE_LIFECYCLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(timeoutMessage);
}
