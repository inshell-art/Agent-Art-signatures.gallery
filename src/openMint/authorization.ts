import {
  concatHex,
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiParameters,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { requireCanonicalSignatureFrom } from "../v2/core/ethereumSignature.js";

export const OPEN_MINT_PRIMARY_TYPE = "OpenMintAuthorization" as const;
export const OPEN_MINT_TYPE_STRING = "OpenMintAuthorization(bytes32 handleKey,bytes32 assessmentDigest,bytes32 artifactDigest,address recipient,bytes32 tokenURIHash,bytes32 nonce,uint64 issuedAt,uint64 deadline)";
export const OPEN_MINT_TYPEHASH = keccak256(stringToHex(OPEN_MINT_TYPE_STRING));
export const OPEN_MINT_MAX_WINDOW_SECONDS = 900n;
export const OPEN_MINT_TYPES = {
  OpenMintAuthorization: [
    { name: "handleKey", type: "bytes32" },
    { name: "assessmentDigest", type: "bytes32" },
    { name: "artifactDigest", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "tokenURIHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export interface OpenMintAuthorization {
  handleKey: Hex;
  assessmentDigest: Hex;
  artifactDigest: Hex;
  recipient: Address;
  tokenURIHash: Hex;
  nonce: Hex;
  issuedAt: bigint;
  deadline: bigint;
}

export interface OpenMintAuthorizationInput extends Omit<OpenMintAuthorization, "recipient" | "issuedAt" | "deadline"> {
  recipient: string;
  issuedAt: bigint | string | number;
  deadline: bigint | string | number;
}

export interface OpenMintDomainInput {
  chainId: bigint | string | number;
  verifyingContract: string;
}

function unsigned(value: bigint | string | number, bits: number, field: string): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error(`${field} must be a safe integer.`);
  if (typeof value === "string" && !/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`${field} must be a canonical unsigned integer.`);
  const result = BigInt(value);
  if (result <= 0n || result >= 1n << BigInt(bits)) throw new Error(`${field} must be a nonzero uint${bits}.`);
  return result;
}

function nonzeroAddress(value: string, field: string): Address {
  const address = getAddress(value);
  if (/^0x0{40}$/i.test(address)) throw new Error(`${field} must be nonzero.`);
  return address;
}

function commitment(value: string, field: string): Hex {
  if (!/^0x[0-9a-f]{64}$/.test(value) || /^0x0{64}$/.test(value)) {
    throw new Error(`${field} must be nonzero and exactly 32 lowercase hexadecimal bytes.`);
  }
  return value as Hex;
}

/** Canonical handle identity is independent of the assessment, MBTI, and recipient. */
export function openMintHandleKey(normalizedHandle: string): Hex {
  if (!/^[a-z0-9_]{1,15}$/.test(normalizedHandle)) throw new Error("Handle must be 1–15 lowercase ASCII letters, digits, or underscores.");
  return keccak256(encodeAbiParameters(parseAbiParameters("string, string"), [
    "signatures.gallery/open-handle/v1", normalizedHandle,
  ]));
}

export function openMintDomain(input: OpenMintDomainInput) {
  return {
    name: "SignaturesOpenMint" as const,
    version: "1" as const,
    chainId: unsigned(input.chainId, 256, "chainId"),
    verifyingContract: nonzeroAddress(input.verifyingContract, "verifyingContract"),
  };
}

export function normalizeOpenMintAuthorization(input: OpenMintAuthorizationInput): OpenMintAuthorization {
  const issuedAt = unsigned(input.issuedAt, 64, "issuedAt");
  const deadline = unsigned(input.deadline, 64, "deadline");
  if (deadline <= issuedAt || deadline - issuedAt > OPEN_MINT_MAX_WINDOW_SECONDS) {
    throw new Error("Authorization lifetime must be greater than zero and at most 900 seconds.");
  }
  return {
    handleKey: commitment(input.handleKey, "handleKey"),
    assessmentDigest: commitment(input.assessmentDigest, "assessmentDigest"),
    artifactDigest: commitment(input.artifactDigest, "artifactDigest"),
    recipient: nonzeroAddress(input.recipient, "recipient"),
    tokenURIHash: commitment(input.tokenURIHash, "tokenURIHash"),
    nonce: commitment(input.nonce, "nonce"),
    issuedAt,
    deadline,
  };
}

export function openMintTypedData(domain: OpenMintDomainInput, authorization: OpenMintAuthorizationInput) {
  return {
    domain: openMintDomain(domain),
    types: OPEN_MINT_TYPES,
    primaryType: OPEN_MINT_PRIMARY_TYPE,
    message: normalizeOpenMintAuthorization(authorization),
  };
}

export function openMintStructHash(authorization: OpenMintAuthorizationInput): Hex {
  const a = normalizeOpenMintAuthorization(authorization);
  return keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32, bytes32, bytes32, bytes32, address, bytes32, bytes32, uint64, uint64"),
    [OPEN_MINT_TYPEHASH, a.handleKey, a.assessmentDigest, a.artifactDigest, a.recipient, a.tokenURIHash, a.nonce, a.issuedAt, a.deadline],
  ));
}

export function openMintDomainSeparator(input: OpenMintDomainInput): Hex {
  const domain = openMintDomain(input);
  return keccak256(encodeAbiParameters(parseAbiParameters("bytes32, bytes32, bytes32, uint256, address"), [
    keccak256(stringToHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
    keccak256(stringToHex(domain.name)), keccak256(stringToHex(domain.version)), domain.chainId, domain.verifyingContract,
  ]));
}

export function openMintDigest(domain: OpenMintDomainInput, authorization: OpenMintAuthorizationInput): Hex {
  return keccak256(concatHex(["0x1901", openMintDomainSeparator(domain), openMintStructHash(authorization)]));
}

export function openMintTokenURIHash(tokenURI: string): Hex {
  if (tokenURI.length === 0) throw new Error("Token URI must be nonempty.");
  return keccak256(stringToHex(tokenURI));
}

/** Signature verification only; the service must separately enforce time, chain state, and its trusted assessment policy. */
export async function verifyOpenMintAuthorization(
  domain: OpenMintDomainInput,
  authorization: OpenMintAuthorizationInput,
  signature: string,
  authorizer: string,
): Promise<boolean> {
  try {
    await requireCanonicalSignatureFrom(openMintDigest(domain, authorization), signature, nonzeroAddress(authorizer, "authorizer"));
    return true;
  } catch {
    return false;
  }
}

export interface OpenMintSigner {
  signTypedData: (input: ReturnType<typeof openMintTypedData>) => Promise<Hex>;
}

/** Low-level cryptography helper. Backend policy must build the authorization from its own assessment and artifacts. */
export async function signOpenMintAuthorization(
  domain: OpenMintDomainInput,
  authorization: OpenMintAuthorizationInput,
  signer: OpenMintSigner,
): Promise<Hex> {
  return signer.signTypedData(openMintTypedData(domain, authorization));
}

export const OPEN_MINT_ABI = parseAbi([
  "struct OpenMintAuthorization { bytes32 handleKey; bytes32 assessmentDigest; bytes32 artifactDigest; address recipient; bytes32 tokenURIHash; bytes32 nonce; uint64 issuedAt; uint64 deadline; }",
  "constructor(string collectionName_,string collectionSymbol_,string collectionURI_,uint48 defaultAdminDelay_,address delayedAdmin_,address authorizerManager_,address pauser_,address nonceRevoker_,address initialAuthorizer_)",
  "function mint(string normalizedHandle,OpenMintAuthorization a,string tokenURI_,bytes signature) returns (uint256 tokenId)",
  "function handleKey(string normalizedHandle) pure returns (bytes32)",
  "function hashOpenMintAuthorization(OpenMintAuthorization a) pure returns (bytes32)",
  "function authorizationDigest(OpenMintAuthorization a) view returns (bytes32)",
  "function trustedAuthorizer() view returns (address)",
  "function mintedHandle(bytes32 handleKey_) view returns (bool)",
  "function usedNonces(bytes32 nonce) view returns (bool)",
  "function revokedNonces(bytes32 nonce) view returns (bool)",
  "function provenance(uint256 tokenId) view returns (string normalizedHandle,bytes32 assessmentDigest,bytes32 artifactDigest,address mintRecipient,bytes32 tokenURIHash,bytes32 authorizationDigest)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function contractURI() view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function transferFrom(address from,address to,uint256 tokenId)",
  "function safeTransferFrom(address from,address to,uint256 tokenId)",
  "function approve(address to,uint256 tokenId)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function setApprovalForAll(address operator,bool approved)",
  "function isApprovedForAll(address owner,address operator) view returns (bool)",
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  "function paused() view returns (bool)",
  "function setTrustedAuthorizer(address authorizer)",
  "function revokeNonce(bytes32 nonce)",
  "function pauseMinting()",
  "function unpauseMinting()",
  "event OpenSignatureMinted(bytes32 indexed handleKey,bytes32 indexed nonce,address indexed recipient,uint256 tokenId,string normalizedHandle,bytes32 assessmentDigest,bytes32 artifactDigest,bytes32 tokenURIHash,bytes32 authorizationDigest)",
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
  "error InvalidHandle()",
  "error HandleKeyMismatch()",
  "error ZeroCommitment()",
  "error ZeroRecipient()",
  "error WrongRecipient()",
  "error ContractWalletUnsupported()",
  "error InvalidAuthorizationWindow()",
  "error AuthorizationNotActive()",
  "error AuthorizationExpired()",
  "error NonceUnavailable()",
  "error HandleAlreadyMinted()",
  "error TokenURIHashMismatch()",
  "error InvalidAttestation()",
]);
