import { describe, expect, it } from "vitest";
import { base32 } from "multiformats/bases/base32";
import { base58btc } from "multiformats/bases/base58";
import { CID } from "multiformats/cid";
import { identity } from "multiformats/hashes/identity";
import { sha256, sha512 } from "multiformats/hashes/sha2";
import { deterministicUnixfsCid, parseCanonicalCidV1 } from "./ipfsCid.js";

const RAW_CODEC = 0x55;
const DAG_PB_CODEC = 0x70;
const DAG_CBOR_CODEC = 0x71;

describe("canonical IPFS CID acceptance", () => {
  it("accepts only the raw-leaf and dag-pb CIDs the frozen importer can produce", async () => {
    const digest = await sha256.digest(Uint8Array.from([1, 2, 3]));
    for (const codec of [RAW_CODEC, DAG_PB_CODEC]) {
      const value = CID.createV1(codec, digest).toString(base32.encoder);
      expect(parseCanonicalCidV1(value).code).toBe(codec);
    }
  });

  it("rejects any multihash other than sha2-256", async () => {
    const long = CID.createV1(RAW_CODEC, await sha512.digest(Uint8Array.from([1, 2, 3])));
    expect(() => parseCanonicalCidV1(long.toString(base32.encoder))).toThrow(/sha2-256 multihash/);
    const inline = CID.createV1(RAW_CODEC, identity.digest(Uint8Array.from([1, 2, 3])));
    expect(() => parseCanonicalCidV1(inline.toString(base32.encoder))).toThrow(/sha2-256 multihash/);
  });

  it("rejects codecs that are neither a raw leaf nor a dag-pb UnixFS root", async () => {
    const cbor = CID.createV1(DAG_CBOR_CODEC, await sha256.digest(Uint8Array.from([1, 2, 3])));
    expect(() => parseCanonicalCidV1(cbor.toString(base32.encoder))).toThrow(/raw leaf or dag-pb UnixFS root/);
  });

  it("rejects non-Base32 multibase spellings before parsing them as a CID", async () => {
    const cid = CID.createV1(RAW_CODEC, await sha256.digest(Uint8Array.from([1, 2, 3])));
    for (const value of [
      "",
      cid.toString(base32.encoder).toUpperCase(),
      cid.toString(base58btc.encoder),
      "Qmd28zFxqzFcSbzjfCwzYxjvdqvYxjvdqvYxjvdqvYxjvd",
      `ipfs://${cid.toString(base32.encoder)}`,
      `${cid.toString(base32.encoder)} `,
    ]) {
      expect(() => parseCanonicalCidV1(value)).toThrow(/Base32 CIDv1/);
    }
  });

  it("rejects well-formed Base32 that is not a decodable CID", () => {
    expect(() => parseCanonicalCidV1("baaaa")).toThrow(/valid lowercase Base32 CIDv1/);
    expect(() => parseCanonicalCidV1("b234567")).toThrow(/valid lowercase Base32 CIDv1/);
  });

  it("produces a canonical raw-leaf CID for content under one chunk", async () => {
    const value = await deterministicUnixfsCid(Buffer.from("exact frozen artifact bytes"));
    expect(value).toMatch(/^b[a-z2-7]+$/);
    expect(parseCanonicalCidV1(value).code).toBe(RAW_CODEC);
    expect(await deterministicUnixfsCid(Buffer.from("exact frozen artifact bytes"))).toBe(value);
    expect(await deterministicUnixfsCid(Buffer.from("exact frozen artifact byteS"))).not.toBe(value);
  });

  it("switches to a dag-pb root once content exceeds the frozen 256KiB chunk size", async () => {
    const value = await deterministicUnixfsCid(Buffer.alloc(262_144 + 1, 7));
    expect(parseCanonicalCidV1(value).code).toBe(DAG_PB_CODEC);
  });
});
