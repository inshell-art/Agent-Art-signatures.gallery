import { MemoryBlockstore } from "blockstore-core";
import { importer, type ImportResult } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { base32 } from "multiformats/bases/base32";
import { CID } from "multiformats/cid";

export const IPFS_IMPORTER_PROFILE = Object.freeze({
  name: "sg-ipfs-unixfs-1.0.0",
  cidVersion: 1 as const,
  multihash: "sha2-256" as const,
  rawLeaves: true as const,
  chunkSize: 262_144,
  wrapWithDirectory: false as const,
  mode: undefined,
  mtime: undefined,
});

export function parseCanonicalCidV1(value: string): CID {
  if (!/^b[a-z2-7]+$/.test(value)) {
    throw new Error("CID must be a lowercase Base32 CIDv1 string.");
  }
  let cid: CID;
  try {
    cid = CID.parse(value, base32.decoder);
  } catch {
    throw new Error("CID must be a valid lowercase Base32 CIDv1 string.");
  }
  if (cid.version !== 1 || cid.toString(base32.encoder) !== value) {
    throw new Error("CID must be a canonical lowercase Base32 CIDv1 string.");
  }
  if (cid.multihash.code !== 0x12 || cid.multihash.digest.byteLength !== 32) {
    throw new Error("CID must use the sha2-256 multihash.");
  }
  if (cid.code !== 0x55 && cid.code !== 0x70) {
    throw new Error("CID must identify a raw leaf or dag-pb UnixFS root.");
  }
  return cid;
}

/**
 * Computes the exact CID a pin adapter must return before any external write.
 * No path, mode, or mtime enters the DAG and directory wrapping is disabled.
 */
export async function deterministicUnixfsCid(bytes: Uint8Array): Promise<string> {
  const blockstore = new MemoryBlockstore();
  let result: ImportResult | undefined;

  for await (const entry of importer([{ content: bytes }], blockstore, {
    cidVersion: IPFS_IMPORTER_PROFILE.cidVersion,
    rawLeaves: IPFS_IMPORTER_PROFILE.rawLeaves,
    chunker: fixedSize({ chunkSize: IPFS_IMPORTER_PROFILE.chunkSize }),
    wrapWithDirectory: IPFS_IMPORTER_PROFILE.wrapWithDirectory,
  })) {
    result = entry;
  }

  if (result === undefined) throw new Error("UnixFS importer produced no file root.");
  const serialized = result.cid.toString(base32.encoder);
  parseCanonicalCidV1(serialized);
  return serialized;
}
