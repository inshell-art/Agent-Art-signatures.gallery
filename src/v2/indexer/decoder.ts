import { hexToBytes } from "viem";

import { signatureIdFromDigest } from "../core/signatureId.js";
import {
  AUTHORIZATION_REVOKED_TOPIC,
  AUTHORIZER_EPOCH_ADDED_TOPIC,
  AUTHORIZER_EPOCH_REVOKED_TOPIC,
  DEFAULT_ADMIN_DELAY_CHANGE_CANCELED_TOPIC,
  DEFAULT_ADMIN_DELAY_CHANGE_SCHEDULED_TOPIC,
  DEFAULT_ADMIN_TRANSFER_CANCELED_TOPIC,
  DEFAULT_ADMIN_TRANSFER_SCHEDULED_TOPIC,
  ERC721_TRANSFER_TOPIC,
  FROZEN_GALLERY_ABI_VERSION,
  PAUSED_TOPIC,
  ROLE_ADMIN_CHANGED_TOPIC,
  ROLE_GRANTED_TOPIC,
  ROLE_REVOKED_TOPIC,
  SIGNATURE_MINTED_TOPIC,
  UNPAUSED_TOPIC,
} from "./topics.js";
import type {
  ContractLogBase,
  DecodedGalleryLog,
  DecodedSignatureMintedLog,
  DeploymentIndexConfig,
  Hex,
  MintValidationEvidence,
  RawEvmLog,
  SignatureMintedLog,
} from "./types.js";

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DATA = /^0x(?:[0-9a-f]{2})*$/;
const DECIMAL = /^(?:0|[1-9]\d*)$/;
const UINT32_MAX = 0xffff_ffffn;
const UINT48_MAX = 0xffff_ffff_ffffn;

export class RawEvmLogDecodeError extends Error {}

function fail(message: string): never {
  throw new RawEvmLogDecodeError(message);
}

function requireHash(value: string, field: string): asserts value is Hex {
  if (!HASH.test(value)) fail(`${field} must be an exact lowercase 32-byte value.`);
}

function requireAddress(value: string, field: string): asserts value is Hex {
  if (!ADDRESS.test(value)) fail(`${field} must be an exact 20-byte address.`);
}

function requireIndex(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${field} must be a nonnegative safe integer.`);
}

function requireDecimal(value: string, field: string): void {
  if (!DECIMAL.test(value)) fail(`${field} must be a canonical unsigned decimal string.`);
}

function requireTopicCount(raw: RawEvmLog, count: number, eventName: string): void {
  if (raw.topics.length !== count) fail(`${eventName} must contain exactly ${count} topics.`);
}

function dataWords(raw: RawEvmLog, count: number, eventName: string): Hex[] {
  if (raw.data.length !== 2 + count * 64) fail(`${eventName} data must contain exactly ${count} ABI words.`);
  return Array.from({ length: count }, (_, index) => `0x${raw.data.slice(2 + index * 64, 2 + (index + 1) * 64)}` as Hex);
}

function requireEmptyData(raw: RawEvmLog, eventName: string): void {
  if (raw.data !== "0x") fail(`${eventName} data must be empty.`);
}

function addressFromWord(word: Hex, field: string): Hex {
  if (!/^0x0{24}[0-9a-f]{40}$/.test(word)) fail(`${field} has noncanonical address padding.`);
  return `0x${word.slice(26)}` as Hex;
}

function uint32FromWord(word: Hex, field: string): number {
  requireHash(word, field);
  const value = BigInt(word);
  if (value > UINT32_MAX) fail(`${field} has noncanonical uint32 padding.`);
  return Number(value);
}

function uint48FromWord(word: Hex, field: string): string {
  requireHash(word, field);
  const value = BigInt(word);
  if (value > UINT48_MAX) fail(`${field} has noncanonical uint48 padding.`);
  return value.toString();
}

function base(raw: RawEvmLog, topic0: Hex): ContractLogBase {
  return {
    chainId: raw.chainId,
    address: raw.address.toLowerCase() as Hex,
    topic0,
    abiVersion: FROZEN_GALLERY_ABI_VERSION,
    blockNumber: raw.blockNumber,
    blockHash: raw.blockHash,
    txHash: raw.txHash,
    transactionIndex: raw.transactionIndex,
    logIndex: raw.logIndex,
  };
}

function validateEnvelope(config: DeploymentIndexConfig, raw: RawEvmLog): Hex {
  if (config.abiVersion !== FROZEN_GALLERY_ABI_VERSION) fail("deployment ABI version is not the frozen Gallery ABI.");
  if (config.mintTopic !== SIGNATURE_MINTED_TOPIC || config.transferTopic !== ERC721_TRANSFER_TOPIC) {
    fail("deployment event topics do not match the frozen Gallery ABI.");
  }
  requireDecimal(config.chainId, "config.chainId");
  requireAddress(config.contract, "config.contract");
  requireDecimal(raw.chainId, "chainId");
  if (raw.chainId !== config.chainId) fail("log chainId does not match the configured deployment.");
  requireAddress(raw.address, "address");
  if (raw.address.toLowerCase() !== config.contract.toLowerCase()) fail("log address does not match the configured deployment.");
  requireDecimal(raw.blockNumber, "blockNumber");
  requireHash(raw.blockHash, "blockHash");
  requireHash(raw.txHash, "txHash");
  requireIndex(raw.transactionIndex, "transactionIndex");
  requireIndex(raw.logIndex, "logIndex");
  if (raw.removed !== undefined && raw.removed !== false) fail("removed subscription logs are hints and cannot be decoded as canonical observations.");
  if (!Array.isArray(raw.topics) || raw.topics.length === 0) fail("log must contain an event signature topic.");
  raw.topics.forEach((topic, index) => requireHash(topic, `topics[${index}]`));
  if (!DATA.test(raw.data)) fail("data must be canonical lowercase, byte-aligned hex.");
  return raw.topics[0]!;
}

/**
 * Strictly decodes the static events consumed by the V2 indexer. A valid log
 * from the same contract with an unrelated event topic (for example Approval)
 * returns null; a recognized event with a noncanonical shape always throws.
 */
export function decodeRawGalleryLog(config: DeploymentIndexConfig, raw: RawEvmLog): DecodedGalleryLog | null {
  const topic0 = validateEnvelope(config, raw);
  const common = base(raw, topic0);

  switch (topic0) {
    case SIGNATURE_MINTED_TOPIC: {
      requireTopicCount(raw, 4, "SignatureMinted");
      const words = dataWords(raw, 8, "SignatureMinted");
      const signatureDigest = raw.topics[1]!;
      const authorizationId = raw.topics[2]!;
      const mintWallet = addressFromWord(raw.topics[3]!, "SignatureMinted.mintWallet");
      const event = {
        signatureId: signatureIdFromDigest(hexToBytes(signatureDigest)),
        signatureDigest,
        authorizationId,
        mintWallet,
        tokenId: BigInt(words[0]!).toString(),
        walletBindingId: words[1]!,
        svgSha256: words[2]!,
        pngSha256: words[3]!,
        metadataSha256: words[4]!,
        tokenURIHash: words[5]!,
        authorizerEpoch: uint32FromWord(words[6]!, "SignatureMinted.authorizerEpoch"),
        authorizationDigest: words[7]!,
      };
      return { ...common, kind: "signature_minted", event };
    }
    case ERC721_TRANSFER_TOPIC: {
      requireTopicCount(raw, 4, "Transfer");
      requireEmptyData(raw, "Transfer");
      return {
        ...common,
        kind: "transfer",
        from: addressFromWord(raw.topics[1]!, "Transfer.from"),
        to: addressFromWord(raw.topics[2]!, "Transfer.to"),
        tokenId: BigInt(raw.topics[3]!).toString(),
      };
    }
    case AUTHORIZER_EPOCH_ADDED_TOPIC:
    case AUTHORIZER_EPOCH_REVOKED_TOPIC: {
      const eventName = topic0 === AUTHORIZER_EPOCH_ADDED_TOPIC ? "AuthorizerEpochAdded" : "AuthorizerEpochRevoked";
      requireTopicCount(raw, 3, eventName);
      requireEmptyData(raw, eventName);
      return {
        ...common,
        kind: topic0 === AUTHORIZER_EPOCH_ADDED_TOPIC ? "authorizer_epoch_added" : "authorizer_epoch_revoked",
        epoch: uint32FromWord(raw.topics[1]!, `${eventName}.epoch`),
        authorizer: addressFromWord(raw.topics[2]!, `${eventName}.authorizer`),
      };
    }
    case AUTHORIZATION_REVOKED_TOPIC:
      requireTopicCount(raw, 2, "AuthorizationRevoked");
      requireEmptyData(raw, "AuthorizationRevoked");
      return { ...common, kind: "authorization_revoked", authorizationId: raw.topics[1]! };
    case PAUSED_TOPIC:
    case UNPAUSED_TOPIC: {
      const eventName = topic0 === PAUSED_TOPIC ? "Paused" : "Unpaused";
      requireTopicCount(raw, 1, eventName);
      const words = dataWords(raw, 1, eventName);
      return {
        ...common,
        kind: topic0 === PAUSED_TOPIC ? "paused" : "unpaused",
        account: addressFromWord(words[0]!, `${eventName}.account`),
      };
    }
    case ROLE_GRANTED_TOPIC:
    case ROLE_REVOKED_TOPIC: {
      const eventName = topic0 === ROLE_GRANTED_TOPIC ? "RoleGranted" : "RoleRevoked";
      requireTopicCount(raw, 4, eventName);
      requireEmptyData(raw, eventName);
      return {
        ...common,
        kind: topic0 === ROLE_GRANTED_TOPIC ? "role_granted" : "role_revoked",
        role: raw.topics[1]!,
        account: addressFromWord(raw.topics[2]!, `${eventName}.account`),
        sender: addressFromWord(raw.topics[3]!, `${eventName}.sender`),
      };
    }
    case ROLE_ADMIN_CHANGED_TOPIC:
      requireTopicCount(raw, 4, "RoleAdminChanged");
      requireEmptyData(raw, "RoleAdminChanged");
      return {
        ...common,
        kind: "role_admin_changed",
        role: raw.topics[1]!,
        previousAdminRole: raw.topics[2]!,
        newAdminRole: raw.topics[3]!,
      };
    case DEFAULT_ADMIN_TRANSFER_SCHEDULED_TOPIC: {
      requireTopicCount(raw, 2, "DefaultAdminTransferScheduled");
      const words = dataWords(raw, 1, "DefaultAdminTransferScheduled");
      return {
        ...common,
        kind: "default_admin_transfer_scheduled",
        newAdmin: addressFromWord(raw.topics[1]!, "DefaultAdminTransferScheduled.newAdmin"),
        acceptSchedule: uint48FromWord(words[0]!, "DefaultAdminTransferScheduled.acceptSchedule"),
      };
    }
    case DEFAULT_ADMIN_TRANSFER_CANCELED_TOPIC:
      requireTopicCount(raw, 1, "DefaultAdminTransferCanceled");
      requireEmptyData(raw, "DefaultAdminTransferCanceled");
      return { ...common, kind: "default_admin_transfer_canceled" };
    case DEFAULT_ADMIN_DELAY_CHANGE_SCHEDULED_TOPIC: {
      requireTopicCount(raw, 1, "DefaultAdminDelayChangeScheduled");
      const words = dataWords(raw, 2, "DefaultAdminDelayChangeScheduled");
      return {
        ...common,
        kind: "default_admin_delay_change_scheduled",
        newDelay: uint48FromWord(words[0]!, "DefaultAdminDelayChangeScheduled.newDelay"),
        effectSchedule: uint48FromWord(words[1]!, "DefaultAdminDelayChangeScheduled.effectSchedule"),
      };
    }
    case DEFAULT_ADMIN_DELAY_CHANGE_CANCELED_TOPIC:
      requireTopicCount(raw, 1, "DefaultAdminDelayChangeCanceled");
      requireEmptyData(raw, "DefaultAdminDelayChangeCanceled");
      return { ...common, kind: "default_admin_delay_change_canceled" };
    default:
      return null;
  }
}

export function attachMintValidation(
  log: DecodedSignatureMintedLog,
  validation: MintValidationEvidence,
): SignatureMintedLog {
  return { ...structuredClone(log), validation: structuredClone(validation) };
}
