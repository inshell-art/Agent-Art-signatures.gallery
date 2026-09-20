import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateOpenSignaturesManifest } from "./open-signatures-manifest.mjs";

async function boundedFile(path, max) {
  if (!isAbsolute(path)) throw new Error("Absolute evidence paths required");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat(); if (!info.isFile() || info.size > max) throw new Error("Evidence file bounds");
    const bytes = Buffer.alloc(max + 1), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > max) throw new Error("Evidence file bounds");
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}
export async function main(args) {
  try {
    const flags = ["--manifest", "--artifact", "--source", "--collection", "--expected", "--observed", "--rpc-url"];
    const values = new Map();
    for (let i = 0; i < args.length; i += 2) {
      if (!flags.includes(args[i]) || values.has(args[i]) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("Invalid arguments");
      values.set(args[i], args[i + 1]);
    }
    if (values.size !== flags.length) throw new Error("Missing evidence");
    const json = async (flag, max) => JSON.parse((await boundedFile(values.get(flag), max)).toString("utf8"));
    const manifest = await json("--manifest", 65536);
    // The CLI offers no public mode or broadcast flag. Public draft validation is
    // available only as a pure API with separately reviewed chain/RPC inputs.
    if (manifest.environment !== "local-anvil") throw new Error("Public CLI validation not approved");
    const result = await validateOpenSignaturesManifest(manifest, { artifact: await json("--artifact", 4 * 1024 * 1024),
      sourceBytes: await boundedFile(values.get("--source"), 262144), collectionBytes: await boundedFile(values.get("--collection"), 262144),
      expected: await json("--expected", 4096), observed: await json("--observed", 1024 * 1024), rpcUrl: values.get("--rpc-url") });
    console.log(JSON.stringify(result));
  } catch {
    console.error("OpenSignatures deployment record refused. Verify the local evidence and configuration; no RPC or broadcast was performed.");
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
