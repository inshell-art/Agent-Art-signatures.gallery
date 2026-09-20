import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AssessmentOperations, AssessmentOperationsError } from "../src/openMint/assessmentOperations.ts";

const MAX_BYTES = 8 * 1024 * 1024;

const PREFIXES = ["attempt:", "receipt:", "budget:", "recovery:", "recoveryattempt:", "recoveryhead:", "recoverylink:"];

/** Inspection deliberately does not use FileKeyValueStore.create or acquire a writer lock. */
export async function readOnlyOperationsStore(directory) {
  if (typeof directory !== "string" || !isAbsolute(directory) || resolve(directory) === "/") throw new Error("Invalid records directory.");
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid records directory.");
  const store = {
    async get(key) {
      if (!/^[a-z]+:[A-Za-z0-9_-]{1,100}$/.test(key) || !PREFIXES.some(prefix => key.startsWith(prefix))) throw new Error("Invalid inspection key.");
      let file;
      try { file = await open(join(directory, `${key.replace(":", "-")}.json`), constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > MAX_BYTES) throw new Error("Invalid inspection record.");
        const buffer = Buffer.alloc(info.size + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > info.size) throw new Error("Inspection record changed while reading.");
        return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      } finally { await file.close(); }
    },
    async entries(prefix) {
      if (!PREFIXES.includes(prefix)) throw new Error("Invalid inspection prefix.");
      const names = (await readdir(directory)).filter(name => name.startsWith(prefix.replace(":", "-")) && name.endsWith(".json")).sort();
      const entries = [];
      for (const name of names) {
        const key = name.slice(0, -5).replace("-", ":"), value = await this.get(key);
        if (value !== undefined) entries.push([key, value]);
      }
      return entries;
    },
    async put() { throw new Error("Inspection is read-only."); },
  };
  return store;
}

export async function inspectAttempt(directory, reference) {
  return new AssessmentOperations({ store: await readOnlyOperationsStore(directory) }).report(reference);
}

async function main(args) {
  if (args.length !== 4 || args[0] !== "--records" || args[2] !== "--reference") {
    console.error("Usage: node --import tsx scripts/open-mint-attempt.mjs --records /absolute/data/records --reference ATTEMPT_ID");
    process.exitCode = 2; return;
  }
  try {
    const report = await inspectAttempt(args[1], args[3]);
    if (!report) { console.error("Attempt reference not found."); process.exitCode = 1; return; }
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    // Do not echo parser contents, file paths, arguments, provider errors or secrets.
    console.error(error instanceof AssessmentOperationsError ? `Inspection refused: ${error.code}.` : "Inspection failed: records are unavailable or invalid.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
