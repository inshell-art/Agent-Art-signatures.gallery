import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, numberToHex, padHex, parseAbiParameters } from "viem";

import { SIGNATURE_ID_GOLDEN_VECTOR } from "../core/signatureId.js";
import { decodeRawGalleryLog, RawEvmLogDecodeError } from "./decoder.js";
import {
  AUTHORIZATION_REVOKED_TOPIC,
  AUTHORIZATION_REVOKER_ROLE,
  AUTHORIZER_EPOCH_ADDED_TOPIC,
  AUTHORIZER_EPOCH_REVOKED_TOPIC,
  AUTHORIZER_MANAGER_ROLE,
  DEFAULT_ADMIN_DELAY_CHANGE_CANCELED_TOPIC,
  DEFAULT_ADMIN_DELAY_CHANGE_SCHEDULED_TOPIC,
  DEFAULT_ADMIN_ROLE,
  DEFAULT_ADMIN_TRANSFER_CANCELED_TOPIC,
  DEFAULT_ADMIN_TRANSFER_SCHEDULED_TOPIC,
  ERC721_TRANSFER_TOPIC,
  FROZEN_GALLERY_ABI_VERSION,
  PAUSED_TOPIC,
  PAUSER_ROLE,
  ROLE_ADMIN_CHANGED_TOPIC,
  ROLE_GRANTED_TOPIC,
  ROLE_REVOKED_TOPIC,
  SIGNATURE_MINTED_TOPIC,
  UNPAUSED_TOPIC,
  ZERO_ADDRESS,
} from "./topics.js";
import type { DeploymentIndexConfig, Hex, RawEvmLog } from "./types.js";

const contract = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Hex;
const wallet = "0x1111111111111111111111111111111111111111" as Hex;
const sender = "0x2222222222222222222222222222222222222222" as Hex;

function h(label: string): Hex {
  return `0x${createHash("sha256").update(label).digest("hex")}`;
}

const config: DeploymentIndexConfig = {
  deploymentId: "sepolia-canonical-v2",
  chainId: "11155111",
  contract,
  deploymentBlockNumber: "100",
  abiVersion: FROZEN_GALLERY_ABI_VERSION,
  mintTopic: SIGNATURE_MINTED_TOPIC,
  transferTopic: ERC721_TRANSFER_TOPIC,
};

function addressTopic(address: Hex): Hex {
  return padHex(address, { size: 32 });
}

function raw(topics: Hex[], data: Hex = "0x", overrides: Partial<RawEvmLog> = {}): RawEvmLog {
  return {
    chainId: config.chainId,
    address: contract,
    topics,
    data,
    blockNumber: "101",
    blockHash: h("block"),
    txHash: h("transaction"),
    transactionIndex: 2,
    logIndex: 3,
    ...overrides,
  };
}

const mintWords = parseAbiParameters("uint256, bytes32, bytes32, bytes32, bytes32, bytes32, uint32, bytes32");
const binding = h("binding");
const svg = h("svg");
const png = h("png");
const metadata = h("metadata");
const uri = h("uri");
const typedDataDigest = h("typed-data");
const authorizationId = h("authorization");

function mintRaw(overrides: Partial<RawEvmLog> = {}): RawEvmLog {
  const data = encodeAbiParameters(mintWords, [
    BigInt(SIGNATURE_ID_GOLDEN_VECTOR.tokenId),
    binding,
    svg,
    png,
    metadata,
    uri,
    7,
    typedDataDigest,
  ]);
  return raw([
    SIGNATURE_MINTED_TOPIC,
    SIGNATURE_ID_GOLDEN_VECTOR.signatureDigest as Hex,
    authorizationId,
    addressTopic(wallet),
  ], data, overrides);
}

describe("frozen Gallery raw EVM log decoder", () => {
  it("pins every consumed event topic and operational role identifier", () => {
    expect({
      SIGNATURE_MINTED_TOPIC,
      ERC721_TRANSFER_TOPIC,
      AUTHORIZER_EPOCH_ADDED_TOPIC,
      AUTHORIZER_EPOCH_REVOKED_TOPIC,
      AUTHORIZATION_REVOKED_TOPIC,
      PAUSED_TOPIC,
      UNPAUSED_TOPIC,
      ROLE_GRANTED_TOPIC,
      ROLE_REVOKED_TOPIC,
      ROLE_ADMIN_CHANGED_TOPIC,
      DEFAULT_ADMIN_TRANSFER_SCHEDULED_TOPIC,
      DEFAULT_ADMIN_TRANSFER_CANCELED_TOPIC,
      DEFAULT_ADMIN_DELAY_CHANGE_SCHEDULED_TOPIC,
      DEFAULT_ADMIN_DELAY_CHANGE_CANCELED_TOPIC,
    }).toEqual({
      SIGNATURE_MINTED_TOPIC: "0x292299975d9bbcb3075f9491c122ed328521a062efd3ed3eb0e8aeb71589b5ac",
      ERC721_TRANSFER_TOPIC: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      AUTHORIZER_EPOCH_ADDED_TOPIC: "0x7a4e40c400272de94dd632aabc6943dc539b5f3d3dad19f084e22fe6bb272259",
      AUTHORIZER_EPOCH_REVOKED_TOPIC: "0xbcfd958ab4aec869e708513875a41974ccc898f7e9c491cdd7a1a9b6f3ba4406",
      AUTHORIZATION_REVOKED_TOPIC: "0xef786f52c09890dbad354834c511ca83222f56ada7ad73891b5dc7295f687278",
      PAUSED_TOPIC: "0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258",
      UNPAUSED_TOPIC: "0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa",
      ROLE_GRANTED_TOPIC: "0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d",
      ROLE_REVOKED_TOPIC: "0xf6391f5c32d9c69d2a47ea670b442974b53935d1edc7fd64eb21e047a839171b",
      ROLE_ADMIN_CHANGED_TOPIC: "0xbd79b86ffe0ab8e8776151514217cd7cacd52c909f66475c3af44e129f0b00ff",
      DEFAULT_ADMIN_TRANSFER_SCHEDULED_TOPIC: "0x3377dc44241e779dd06afab5b788a35ca5f3b778836e2990bdb26a2a4b2e5ed6",
      DEFAULT_ADMIN_TRANSFER_CANCELED_TOPIC: "0x8886ebfc4259abdbc16601dd8fb5678e54878f47b3c34836cfc51154a9605109",
      DEFAULT_ADMIN_DELAY_CHANGE_SCHEDULED_TOPIC: "0xf1038c18cf84a56e432fdbfaf746924b7ea511dfe03a6506a0ceba4888788d9b",
      DEFAULT_ADMIN_DELAY_CHANGE_CANCELED_TOPIC: "0x2b1fa2edafe6f7b9e97c1a9e0c3660e645beb2dcaa2d45bdbf9beaf5472e1ec5",
    });
    expect({ DEFAULT_ADMIN_ROLE, AUTHORIZER_MANAGER_ROLE, PAUSER_ROLE, AUTHORIZATION_REVOKER_ROLE }).toEqual({
      DEFAULT_ADMIN_ROLE: `0x${"00".repeat(32)}`,
      AUTHORIZER_MANAGER_ROLE: "0x7c6b03864b3aa1e45fbddb92b09807389f2c160367db6dd13b5a742928503cb8",
      PAUSER_ROLE: "0x65d7a28e3265b37a6474929f336521b332c1681b933f6cb9f3376673440d862a",
      AUTHORIZATION_REVOKER_ROLE: "0x5aaee457d5842042ef9d884ecc4f4502a2d6201dfa22fe7e702b1e48c0095acb",
    });
  });

  it("decodes the exact SignatureMinted and ERC-721 Transfer layouts", () => {
    const mint = decodeRawGalleryLog(config, mintRaw());
    expect(mint).toEqual(expect.objectContaining({
      kind: "signature_minted",
      address: contract.toLowerCase(),
      abiVersion: FROZEN_GALLERY_ABI_VERSION,
      event: {
        signatureId: SIGNATURE_ID_GOLDEN_VECTOR.signatureId,
        signatureDigest: SIGNATURE_ID_GOLDEN_VECTOR.signatureDigest,
        authorizationId,
        mintWallet: wallet,
        tokenId: SIGNATURE_ID_GOLDEN_VECTOR.tokenId,
        walletBindingId: binding,
        svgSha256: svg,
        pngSha256: png,
        metadataSha256: metadata,
        tokenURIHash: uri,
        authorizerEpoch: 7,
        authorizationDigest: typedDataDigest,
      },
    }));

    const transfer = decodeRawGalleryLog(config, raw([
      ERC721_TRANSFER_TOPIC,
      addressTopic(ZERO_ADDRESS),
      addressTopic(wallet),
      numberToHex(BigInt(SIGNATURE_ID_GOLDEN_VECTOR.tokenId), { size: 32 }),
    ]));
    expect(transfer).toEqual(expect.objectContaining({
      kind: "transfer",
      from: ZERO_ADDRESS,
      to: wallet,
      tokenId: SIGNATURE_ID_GOLDEN_VECTOR.tokenId,
    }));
  });

  it("decodes custom, pause, AccessControl, and delayed-admin control events", () => {
    const uint48 = parseAbiParameters("uint48");
    const uint48Pair = parseAbiParameters("uint48, uint48");
    const cases: Array<[RawEvmLog, Record<string, unknown>]> = [
      [raw([AUTHORIZER_EPOCH_ADDED_TOPIC, numberToHex(1, { size: 32 }), addressTopic(wallet)]), { kind: "authorizer_epoch_added", epoch: 1, authorizer: wallet }],
      [raw([AUTHORIZER_EPOCH_REVOKED_TOPIC, numberToHex(1, { size: 32 }), addressTopic(wallet)]), { kind: "authorizer_epoch_revoked", epoch: 1, authorizer: wallet }],
      [raw([AUTHORIZATION_REVOKED_TOPIC, authorizationId]), { kind: "authorization_revoked", authorizationId }],
      [raw([PAUSED_TOPIC], encodeAbiParameters(parseAbiParameters("address"), [wallet])), { kind: "paused", account: wallet }],
      [raw([UNPAUSED_TOPIC], encodeAbiParameters(parseAbiParameters("address"), [wallet])), { kind: "unpaused", account: wallet }],
      [raw([ROLE_GRANTED_TOPIC, PAUSER_ROLE, addressTopic(wallet), addressTopic(sender)]), { kind: "role_granted", role: PAUSER_ROLE, account: wallet, sender }],
      [raw([ROLE_REVOKED_TOPIC, PAUSER_ROLE, addressTopic(wallet), addressTopic(sender)]), { kind: "role_revoked", role: PAUSER_ROLE, account: wallet, sender }],
      [raw([ROLE_ADMIN_CHANGED_TOPIC, PAUSER_ROLE, DEFAULT_ADMIN_ROLE, AUTHORIZER_MANAGER_ROLE]), { kind: "role_admin_changed", role: PAUSER_ROLE, previousAdminRole: DEFAULT_ADMIN_ROLE, newAdminRole: AUTHORIZER_MANAGER_ROLE }],
      [raw([DEFAULT_ADMIN_TRANSFER_SCHEDULED_TOPIC, addressTopic(wallet)], encodeAbiParameters(uint48, [1_800_000_100])), { kind: "default_admin_transfer_scheduled", newAdmin: wallet, acceptSchedule: "1800000100" }],
      [raw([DEFAULT_ADMIN_TRANSFER_CANCELED_TOPIC]), { kind: "default_admin_transfer_canceled" }],
      [raw([DEFAULT_ADMIN_DELAY_CHANGE_SCHEDULED_TOPIC], encodeAbiParameters(uint48Pair, [3600, 1_800_000_200])), { kind: "default_admin_delay_change_scheduled", newDelay: "3600", effectSchedule: "1800000200" }],
      [raw([DEFAULT_ADMIN_DELAY_CHANGE_CANCELED_TOPIC]), { kind: "default_admin_delay_change_canceled" }],
    ];
    for (const [input, expected] of cases) expect(decodeRawGalleryLog(config, input)).toEqual(expect.objectContaining(expected));
  });

  it("fails closed on deployment, envelope, removal, topic-count, and data-size drift", () => {
    expect(() => decodeRawGalleryLog(config, mintRaw({ chainId: "1" }))).toThrow(/chainId/);
    expect(() => decodeRawGalleryLog(config, mintRaw({ address: sender }))).toThrow(/configured deployment/);
    expect(() => decodeRawGalleryLog({ ...config, abiVersion: "sg-gallery-abi-2.0.0" }, mintRaw())).toThrow(/frozen Gallery ABI/);
    expect(() => decodeRawGalleryLog({ ...config, mintTopic: h("wrong topic") }, mintRaw())).toThrow(/event topics/);
    expect(() => decodeRawGalleryLog(config, mintRaw({ removed: true }))).toThrow(/cannot be decoded as canonical/);
    expect(() => decodeRawGalleryLog(config, { ...mintRaw(), topics: mintRaw().topics.slice(0, 3) })).toThrow(/exactly 4 topics/);
    expect(() => decodeRawGalleryLog(config, { ...mintRaw(), data: `${mintRaw().data}${"00".repeat(32)}` as Hex })).toThrow(/exactly 8 ABI words/);
  });

  it("rejects noncanonical address and bounded-integer ABI words", () => {
    const badAddressWord = `0x01${"00".repeat(11)}${wallet.slice(2)}` as Hex;
    expect(() => decodeRawGalleryLog(config, raw([
      ERC721_TRANSFER_TOPIC,
      badAddressWord,
      addressTopic(wallet),
      numberToHex(1, { size: 32 }),
    ]))).toThrow(/noncanonical address padding/);

    expect(() => decodeRawGalleryLog(config, raw([
      AUTHORIZER_EPOCH_ADDED_TOPIC,
      numberToHex(1n << 32n, { size: 32 }),
      addressTopic(wallet),
    ]))).toThrow(/uint32 padding/);

    expect(() => decodeRawGalleryLog(config, raw(
      [DEFAULT_ADMIN_TRANSFER_SCHEDULED_TOPIC, addressTopic(wallet)],
      numberToHex(1n << 48n, { size: 32 }),
    ))).toThrow(/uint48 padding/);
  });

  it("rejects noncanonical hex but ignores a well-formed unrelated contract event", () => {
    const uppercaseTopic = SIGNATURE_MINTED_TOPIC.toUpperCase() as Hex;
    expect(() => decodeRawGalleryLog(config, raw([uppercaseTopic]))).toThrow(/lowercase 32-byte/);
    expect(() => decodeRawGalleryLog(config, raw([SIGNATURE_MINTED_TOPIC], "0x0" as Hex))).toThrow(/byte-aligned/);
    expect(decodeRawGalleryLog(config, raw([h("Approval(address,address,uint256)")]))).toBeNull();
    expect(() => decodeRawGalleryLog(config, raw([]))).toThrow(RawEvmLogDecodeError);
  });
});
