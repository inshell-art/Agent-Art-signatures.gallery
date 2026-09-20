import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AssessmentOperations, AssessmentOperationsError } from "../src/openMint/assessmentOperations.ts";
import { GROK_PILOT_PROFILE } from "../src/openMint/providerProfile.ts";
import { acquireProcessLock, FileKeyValueStore } from "../src/openMint/storage.ts";
import { readOnlyOperationsStore } from "./open-mint-attempt.mjs";

const ONE_USD_TICKS = "10000000000";

async function existingDirectory(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) === "/") throw new Error("Invalid recovery directory.");
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== resolve(path)) throw new Error("Recovery requires a real, existing directory.");
}

async function readCommand(path) {
  if (!isAbsolute(path)) throw new Error("Use an absolute command path.");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 16_384) throw new Error("Invalid recovery command file.");
    const bytes = Buffer.alloc(16_385);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 16_384) throw new Error("Recovery command exceeds size limit.");
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally { await file.close(); }
}

/** Offline only: this module imports no provider, wallet, chain or app launcher.
 * Dry-run has no writes. Apply requires the app's exclusive writer lock and only
 * stages authority; it never dispatches research or authorizes a mint.
 */
export async function reviewRecovery({ dataDirectory, command, apply = false, reviewDigest, now = new Date() }) {
  await existingDirectory(dataDirectory);
  const records = join(dataDirectory, "records");
  await existingDirectory(records);
  if (!command || command.profileVersion !== GROK_PILOT_PROFILE.id || command.reservationUsdTicks !== ONE_USD_TICKS
    || !Number.isFinite(now.getTime()) || now.getTime() >= Date.parse(GROK_PILOT_PROFILE.pricingChangesAt)) {
    throw new Error("Recovery requires the current unexpired pilot profile and reviewed reservation.");
  }
  if (apply && (typeof reviewDigest !== "string" || !/^[a-f0-9]{64}$/.test(reviewDigest))) throw new Error("Apply requires the exact dry-run digest.");
  let unlock;
  try {
    if (apply) unlock = await acquireProcessLock(dataDirectory);
    const reader = await readOnlyOperationsStore(records);
    const source = await new AssessmentOperations({ store: reader }).report(command.sourceAttemptId);
    if (!source || source.attempt.version !== 1) throw new Error("Recovery source is unavailable.");
    const assessments = join(dataDirectory, "assessments");
    let canonicalExists = false;
    try {
      await existingDirectory(assessments);
      // Do not instantiate FileAssessmentRepository: its reads create directories.
      await lstat(join(assessments, `${source.attempt.handle}.json`));
      canonicalExists = true;
    } catch (error) { if (error?.code !== "ENOENT") throw error; }
    const writer = apply ? await FileKeyValueStore.create(records) : undefined;
    const store = writer ? { ...reader, put: (key, value) => writer.put(key, value) } : reader;
    const operations = new AssessmentOperations({ store, generationEnabled: false, accountingRequired: true,
      allowedHandle: source.attempt.handle, reservationUsdTicks: ONE_USD_TICKS, maxExposureUsdTicks: ONE_USD_TICKS });
    if (canonicalExists) {
      // A completed grant remains idempotently inspectable after its result is saved.
      // get() validates the entire committed recovery; a partial/new grant cannot
      // use a canonical result to bypass eligibility. Core methods still bind the
      // exact command and review digest before returning that existing grant.
      const current = await operations.get(source.attempt.handle);
      if (current?.version !== 1 || current.recovery?.sourceAttemptId !== command.sourceAttemptId) {
        throw new Error("A canonical assessment already exists; new recovery is prohibited.");
      }
    }
    return apply ? await operations.stageRecovery(command, reviewDigest) : await operations.previewRecovery(command);
  } finally { await unlock?.(); }
}

async function main(args) {
  try {
    const values = new Map();
    for (let index = 0; index < args.length; index++) {
      const flag = args[index];
      if (!["--data-dir", "--command", "--apply", "--review-digest"].includes(flag) || values.has(flag)) throw new Error("Invalid arguments.");
      if (flag === "--apply") values.set(flag, true);
      else {
        const value = args[++index];
        if (!value || value.startsWith("--")) throw new Error("Missing argument.");
        values.set(flag, value);
      }
    }
    if (!values.has("--data-dir") || !values.has("--command") || (values.has("--review-digest") && !values.has("--apply"))) throw new Error("Missing arguments.");
    const command = await readCommand(values.get("--command"));
    const report = await reviewRecovery({ dataDirectory: values.get("--data-dir"), command,
      apply: values.has("--apply"), reviewDigest: values.get("--review-digest") });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    // Command fields and arbitrary parser/provider text never reach diagnostics.
    console.error(error instanceof AssessmentOperationsError ? `Recovery refused: ${error.code}.`
      : "Recovery refused: verify arguments, profile, evidence, existing data, and writer lock. No provider request was made.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
