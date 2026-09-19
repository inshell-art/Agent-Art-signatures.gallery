import { readdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pilotPreflight } from "../src/openMint/providerProfile.ts";

// Deliberately no provider constructor, process lock, mkdir, wallet, RPC or fetch.
const report = pilotPreflight(process.env);
const root = resolve(process.env.OPEN_MINT_DATA_DIR ?? ".local/open-mint/grok");
const base = resolve(".local/open-mint");
if (!root.startsWith(`${base}/`)) report.blockers.push("Choose a dedicated data namespace under .local/open-mint/.");
let records = 0;
if (root.startsWith(`${base}/`)) {
  try { records = (await readdir(join(root, "records"))).filter(name => name.endsWith(".json")).length; }
  catch (error) { if (error.code !== "ENOENT") report.blockers.push("Cannot inspect existing records safely."); }
  try { await stat(join(root, "writer.lock")); report.blockers.push("Namespace has a writer lock; use the running app or a fresh isolated namespace. Do not remove its lock blindly."); }
  catch (error) { if (error.code !== "ENOENT") report.blockers.push("Cannot inspect writer lock."); }
}
if (records) report.blockers.push("Existing records found; the first live pilot requires a fresh isolated namespace, not deletion or reset of this data.");
const port = Number(process.env.PORT ?? 3000), rpcPort = Number(process.env.OPEN_MINT_RPC_PORT ?? 18546);
if (![port, rpcPort].every(value => Number.isSafeInteger(value) && value >= 1024 && value <= 65535) || port === rpcPort) report.blockers.push("Choose distinct valid local app/RPC ports.");
if (process.env.OPEN_MINT_ORIGIN && process.env.OPEN_MINT_ORIGIN !== `http://127.0.0.1:${port}`) report.blockers.push("Local origin must match the literal loopback app port.");
console.log(JSON.stringify({ ...report, local: { dataDirectory: root, existingRecordFiles: records, appPort: port, rpcPort },
  approvalRequired: "One X lookup, then at most one Grok request for the allowlisted handle. User signs the Anvil mint. No retries or public deployment." }, null, 2));
process.exitCode = report.blockers.length ? 1 : 0;
