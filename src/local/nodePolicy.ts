// Full historical Anvil snapshots can stall RPC while being serialized. These
// local-only limits leave time for a snapshot without retrying mint submissions
// or weakening any chain/contract/provenance checks.
export const LOCAL_RPC_TIMEOUT_MS = 30_000;
export const LOCAL_NODE_LIFECYCLE_TIMEOUT_MS = 180_000;
export const LOCAL_ANVIL_PERSISTENCE_ARGS = [
  "--state-interval", "60", "--preserve-historical-states",
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
