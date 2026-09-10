import { randomBytes } from "node:crypto";
import {
  concatHex,
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbiParameters,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { requireCanonicalSignatureFrom } from "./ethereumSignature.js";
import { parseCanonicalCidV1 } from "./ipfsCid.js";

export type Bytes32Hex = `0x${string}`;

export const MINT_AUTHORIZATION_PRIMARY_TYPE = "MintAuthorization" as const;
export const MINT_AUTHORIZATION_TYPE_STRING = "MintAuthorization(bytes32 signatureDigest,bytes32 walletBindingId,address mintWallet,bytes32 svgSha256,bytes32 pngSha256,bytes32 metadataSha256,bytes32 tokenURIHash,bytes32 authorizationId,uint64 validAfter,uint64 deadline,uint32 authorizerEpoch)";
export const MINT_AUTHORIZATION_TYPEHASH = keccak256(stringToHex(MINT_AUTHORIZATION_TYPE_STRING));

export const MINT_AUTHORIZATION_TYPES = {
  MintAuthorization: [
    { name: "signatureDigest", type: "bytes32" },
    { name: "walletBindingId", type: "bytes32" },
    { name: "mintWallet", type: "address" },
    { name: "svgSha256", type: "bytes32" },
    { name: "pngSha256", type: "bytes32" },
    { name: "metadataSha256", type: "bytes32" },
    { name: "tokenURIHash", type: "bytes32" },
    { name: "authorizationId", type: "bytes32" },
    { name: "validAfter", type: "uint64" },
    { name: "deadline", type: "uint64" },
    { name: "authorizerEpoch", type: "uint32" },
  ],
} as const;

const DOMAIN_NAME = "signatures.gallery";
const DOMAIN_VERSION = "2";
const EIP712_DOMAIN_TYPE_STRING = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const EIP712_DOMAIN_TYPEHASH = keccak256(stringToHex(EIP712_DOMAIN_TYPE_STRING));
const BYTES32 = /^0x[0-9a-f]{64}$/;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT32 = (1n << 32n) - 1n;
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;

export interface MintAuthorizationDomain {
  name: typeof DOMAIN_NAME;
  version: typeof DOMAIN_VERSION;
  chainId: bigint;
  verifyingContract: Address;
}

export interface MintAuthorization {
  signatureDigest: Bytes32Hex;
  walletBindingId: Bytes32Hex;
  mintWallet: Address;
  svgSha256: Bytes32Hex;
  pngSha256: Bytes32Hex;
  metadataSha256: Bytes32Hex;
  tokenURIHash: Bytes32Hex;
  authorizationId: Bytes32Hex;
  validAfter: bigint;
  deadline: bigint;
  authorizerEpoch: number;
}

export interface MintAuthorizationInput extends Omit<MintAuthorization, "mintWallet" | "validAfter" | "deadline"> {
  mintWallet: string;
  validAfter: bigint | string | number;
  deadline: bigint | string | number;
}

export interface MintAuthorizationDomainInput {
  chainId: bigint | string | number;
  verifyingContract: string;
}

export interface MintAuthorizationTypedData {
  domain: MintAuthorizationDomain;
  types: typeof MINT_AUTHORIZATION_TYPES;
  primaryType: typeof MINT_AUTHORIZATION_PRIMARY_TYPE;
  message: MintAuthorization;
}

function bytes32(value: string, field: string, nonzero = false): Bytes32Hex {
  if (!BYTES32.test(value)) throw new Error(`${field} must be exactly 32 lowercase hexadecimal bytes.`);
  if (nonzero && value === ZERO_BYTES32) throw new Error(`${field} must be nonzero.`);
  return value as Bytes32Hex;
}

function unsigned(value: bigint | string | number, max: bigint, field: string): bigint {
  let parsed: bigint;
  try {
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error();
    if (typeof value === "string" && !/^(?:0|[1-9]\d*)$/.test(value)) throw new Error();
    parsed = BigInt(value);
  } catch {
    throw new Error(`${field} must be a canonical unsigned integer.`);
  }
  if (parsed < 0n || parsed > max) throw new Error(`${field} is outside its Solidity integer range.`);
  return parsed;
}

export function mintAuthorizationDomain(input: MintAuthorizationDomainInput): MintAuthorizationDomain {
  const chainId = unsigned(input.chainId, (1n << 256n) - 1n, "chainId");
  if (chainId === 0n) throw new Error("chainId must be nonzero.");
  const verifyingContract = getAddress(input.verifyingContract);
  if (/^0x0{40}$/i.test(verifyingContract)) throw new Error("verifyingContract must be nonzero.");
  return { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract };
}

export function normalizeMintAuthorization(input: MintAuthorizationInput): MintAuthorization {
  const validAfter = unsigned(input.validAfter, MAX_UINT64, "validAfter");
  const deadline = unsigned(input.deadline, MAX_UINT64, "deadline");
  const authorizerEpoch = unsigned(input.authorizerEpoch, MAX_UINT32, "authorizerEpoch");
  if (deadline <= validAfter) throw new Error("deadline must be later than validAfter.");
  if (authorizerEpoch === 0n) throw new Error("authorizerEpoch must be nonzero.");
  const mintWallet = getAddress(input.mintWallet);
  if (/^0x0{40}$/i.test(mintWallet)) throw new Error("mintWallet must be nonzero.");

  return {
    signatureDigest: bytes32(input.signatureDigest, "signatureDigest"),
    walletBindingId: bytes32(input.walletBindingId, "walletBindingId", true),
    mintWallet,
    svgSha256: bytes32(input.svgSha256, "svgSha256"),
    pngSha256: bytes32(input.pngSha256, "pngSha256"),
    metadataSha256: bytes32(input.metadataSha256, "metadataSha256"),
    tokenURIHash: bytes32(input.tokenURIHash, "tokenURIHash"),
    authorizationId: bytes32(input.authorizationId, "authorizationId", true),
    validAfter,
    deadline,
    authorizerEpoch: Number(authorizerEpoch),
  };
}

export function requireBackendAuthorizationWindow(authorization: MintAuthorization): void {
  if (authorization.deadline - authorization.validAfter !== 900n) {
    throw new Error("V2 backend authorization window must be exactly 900 seconds.");
  }
}

export function normalizeBackendMintAuthorization(input: MintAuthorizationInput): MintAuthorization {
  const normalized = normalizeMintAuthorization(input);
  requireBackendAuthorizationWindow(normalized);
  return normalized;
}

export function randomNonzeroBytes32(entropy: (length: number) => Uint8Array = randomBytes): Bytes32Hex {
  for (;;) {
    const candidate = entropy(32);
    if (candidate.byteLength !== 32) throw new Error("bytes32 entropy source must return exactly 32 bytes.");
    const hex = Buffer.from(candidate).toString("hex");
    if (!/^0+$/.test(hex)) return `0x${hex}`;
  }
}

export function backendAuthorizationTimes(canonicalBlockTimestamp: bigint | string | number): {
  validAfter: bigint;
  deadline: bigint;
} {
  const blockTimestamp = unsigned(canonicalBlockTimestamp, MAX_UINT64, "canonicalBlockTimestamp");
  if (blockTimestamp < 60n) throw new Error("canonicalBlockTimestamp is too early for 60-second tolerance.");
  const validAfter = blockTimestamp - 60n;
  return { validAfter, deadline: validAfter + 900n };
}

export function mintAuthorizationStructHash(input: MintAuthorizationInput | MintAuthorization): Hex {
  const authorization = normalizeMintAuthorization(input);
  return keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32, bytes32, bytes32, address, bytes32, bytes32, bytes32, bytes32, bytes32, uint64, uint64, uint32"),
    [
      MINT_AUTHORIZATION_TYPEHASH,
      authorization.signatureDigest,
      authorization.walletBindingId,
      authorization.mintWallet,
      authorization.svgSha256,
      authorization.pngSha256,
      authorization.metadataSha256,
      authorization.tokenURIHash,
      authorization.authorizationId,
      authorization.validAfter,
      authorization.deadline,
      authorization.authorizerEpoch,
    ],
  ));
}

export function mintAuthorizationDomainSeparator(input: MintAuthorizationDomainInput): Hex {
  const domain = mintAuthorizationDomain(input);
  return keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32, bytes32, bytes32, uint256, address"),
    [
      EIP712_DOMAIN_TYPEHASH,
      keccak256(stringToHex(domain.name)),
      keccak256(stringToHex(domain.version)),
      domain.chainId,
      domain.verifyingContract,
    ],
  ));
}

export function mintAuthorizationDigest(
  domainInput: MintAuthorizationDomainInput,
  authorizationInput: MintAuthorizationInput | MintAuthorization,
): Hex {
  return keccak256(concatHex([
    "0x1901",
    mintAuthorizationDomainSeparator(domainInput),
    mintAuthorizationStructHash(authorizationInput),
  ]));
}

export function mintAuthorizationTypedData(
  domainInput: MintAuthorizationDomainInput,
  authorizationInput: MintAuthorizationInput | MintAuthorization,
): MintAuthorizationTypedData {
  return {
    domain: mintAuthorizationDomain(domainInput),
    types: MINT_AUTHORIZATION_TYPES,
    primaryType: MINT_AUTHORIZATION_PRIMARY_TYPE,
    message: normalizeMintAuthorization(authorizationInput),
  };
}

export function tokenUriHash(tokenUri: string): Hex {
  if (!tokenUri.startsWith("ipfs://")) {
    throw new Error("tokenURI must be an exact lowercase ipfs:// CID URI.");
  }
  parseCanonicalCidV1(tokenUri.slice("ipfs://".length));
  return keccak256(stringToHex(tokenUri));
}

export async function verifyGalleryAttestation(
  domainInput: MintAuthorizationDomainInput,
  authorizationInput: MintAuthorizationInput | MintAuthorization,
  galleryAttestation: string,
  expectedAuthorizer: string,
): Promise<void> {
  const digest = mintAuthorizationDigest(domainInput, authorizationInput);
  await requireCanonicalSignatureFrom(digest, galleryAttestation, expectedAuthorizer);
}
