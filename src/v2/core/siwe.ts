import { randomBytes } from "node:crypto";
import { getAddress, hashMessage, type Address, type Hex } from "viem";
import { requireCanonicalSignatureFrom } from "./ethereumSignature.js";

export const SIWE_LINK_STATEMENT = "Link this wallet to your X-authenticated signatures.gallery account for minting.";
export const SIWE_NONCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const SIWE_NONCE_LENGTH = 22;

const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OPAQUE_PATH_VALUE = /^[A-Za-z0-9._~-]+$/;
const CANONICAL_CHAIN_ID = /^(?:[1-9]\d*)$/;

export interface ExactSiweMessageFields {
  appHost: string;
  appOrigin: string;
  walletAddress: string;
  chainId: string | bigint;
  nonce: string;
  issuedAt: Date | string;
  expirationTime: Date | string;
  challengeId: string;
  publicAccountId: string;
}

export interface ParsedExactSiweMessage {
  appHost: string;
  appOrigin: string;
  walletAddress: Address;
  chainId: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  challengeId: string;
  publicAccountId: string;
}

function requireCanonicalTimestamp(value: Date | string, field: string): string {
  const serialized = value instanceof Date ? value.toISOString() : value;
  if (!CANONICAL_TIMESTAMP.test(serialized) || new Date(serialized).toISOString() !== serialized) {
    throw new Error(`${field} must be UTC RFC 3339 with millisecond precision.`);
  }
  return serialized;
}

function requireOpaquePathValue(value: string, field: string): string {
  if (!OPAQUE_PATH_VALUE.test(value)) {
    throw new Error(`${field} must be a nonempty opaque URI-path-safe string.`);
  }
  return value;
}

function normalizeChainId(value: string | bigint): string {
  const serialized = typeof value === "bigint" ? value.toString(10) : value;
  if (!CANONICAL_CHAIN_ID.test(serialized)) {
    throw new Error("chainId must be a positive canonical decimal string.");
  }
  return serialized;
}

function validateOriginAndHost(appOrigin: string, appHost: string): void {
  if (appOrigin.endsWith("/")) throw new Error("appOrigin must not have a trailing slash.");
  if (appHost !== appHost.toLowerCase()) throw new Error("appHost must be lowercase.");

  let url: URL;
  try {
    url = new URL(appOrigin);
  } catch {
    throw new Error("appOrigin must be an absolute origin URL.");
  }

  if (url.origin !== appOrigin || url.host !== appHost) {
    throw new Error("appOrigin must be the exact origin for appHost with no path, query, or fragment.");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("appOrigin must use HTTPS outside local development.");
  }
}

export function generateSiweNonce(entropy: (length: number) => Uint8Array = randomBytes): string {
  let nonce = "";
  // 248 is the largest multiple of 62 below 256, so rejection avoids modulo bias.
  while (nonce.length < SIWE_NONCE_LENGTH) {
    const sample = entropy(Math.max(16, SIWE_NONCE_LENGTH - nonce.length));
    if (sample.byteLength === 0) throw new Error("nonce entropy source returned no bytes.");
    for (const byte of sample) {
      if (byte >= 248) continue;
      nonce += SIWE_NONCE_ALPHABET[byte % SIWE_NONCE_ALPHABET.length];
      if (nonce.length === SIWE_NONCE_LENGTH) break;
    }
  }
  return nonce;
}

export function siweChallengeExpiry(now: Date, xAuthenticatedAt: Date): Date {
  const tenMinutesFromNow = now.getTime() + 10 * 60 * 1000;
  const xFreshnessLimit = xAuthenticatedAt.getTime() + 15 * 60 * 1000;
  return new Date(Math.min(tenMinutesFromNow, xFreshnessLimit));
}

export function buildExactSiweMessage(input: ExactSiweMessageFields): string {
  validateOriginAndHost(input.appOrigin, input.appHost);
  const address = getAddress(input.walletAddress);
  const chainId = normalizeChainId(input.chainId);
  if (!/^[A-Za-z0-9]{22}$/.test(input.nonce)) {
    throw new Error("nonce must be exactly 22 ASCII alphanumeric characters.");
  }
  const issuedAt = requireCanonicalTimestamp(input.issuedAt, "issuedAt");
  const expirationTime = requireCanonicalTimestamp(input.expirationTime, "expirationTime");
  if (new Date(expirationTime).getTime() <= new Date(issuedAt).getTime()) {
    throw new Error("expirationTime must be later than issuedAt.");
  }
  const challengeId = requireOpaquePathValue(input.challengeId, "challengeId");
  const publicAccountId = requireOpaquePathValue(input.publicAccountId, "publicAccountId");

  return [
    `${input.appHost} wants you to sign in with your Ethereum account:`,
    address,
    "",
    SIWE_LINK_STATEMENT,
    "",
    `URI: ${input.appOrigin}`,
    "Version: 1",
    `Chain ID: ${chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expirationTime}`,
    `Request ID: ${challengeId}`,
    "Resources:",
    `- ${input.appOrigin}/account-ref/${publicAccountId}`,
  ].join("\n");
}

function afterPrefix(line: string, prefix: string, field: string): string {
  if (!line.startsWith(prefix)) throw new Error(`SIWE message is missing exact ${field} field.`);
  return line.slice(prefix.length);
}

export function parseExactSiweMessage(message: string): ParsedExactSiweMessage {
  if (message.includes("\r") || message.endsWith("\n")) {
    throw new Error("SIWE message must use LF line endings and have no trailing newline.");
  }
  const lines = message.split("\n");
  if (lines.length !== 14 || lines[2] !== "" || lines[3] !== SIWE_LINK_STATEMENT || lines[4] !== "" || lines[6] !== "Version: 1" || lines[12] !== "Resources:") {
    throw new Error("SIWE message does not match the frozen signatures.gallery layout.");
  }

  const hostSuffix = " wants you to sign in with your Ethereum account:";
  if (!lines[0].endsWith(hostSuffix)) throw new Error("SIWE message has an invalid domain line.");
  const appHost = lines[0].slice(0, -hostSuffix.length);
  const walletAddress = getAddress(lines[1]);
  if (walletAddress !== lines[1]) throw new Error("SIWE wallet address must use exact EIP-55 checksum casing.");

  const appOrigin = afterPrefix(lines[5], "URI: ", "URI");
  const chainId = normalizeChainId(afterPrefix(lines[7], "Chain ID: ", "chain ID"));
  const nonce = afterPrefix(lines[8], "Nonce: ", "nonce");
  const issuedAt = requireCanonicalTimestamp(afterPrefix(lines[9], "Issued At: ", "issued-at"), "issuedAt");
  const expirationTime = requireCanonicalTimestamp(afterPrefix(lines[10], "Expiration Time: ", "expiration-time"), "expirationTime");
  const challengeId = requireOpaquePathValue(afterPrefix(lines[11], "Request ID: ", "request ID"), "challengeId");
  const resourcePrefix = `- ${appOrigin}/account-ref/`;
  const publicAccountId = requireOpaquePathValue(afterPrefix(lines[13], resourcePrefix, "account resource"), "publicAccountId");

  const parsed: ParsedExactSiweMessage = {
    appHost,
    appOrigin,
    walletAddress,
    chainId,
    nonce,
    issuedAt,
    expirationTime,
    challengeId,
    publicAccountId,
  };

  // Rebuilding catches every noncanonical spelling or spacing that a parser
  // might otherwise inadvertently accept.
  if (buildExactSiweMessage(parsed) !== message) {
    throw new Error("SIWE message is not in its exact canonical form.");
  }
  return parsed;
}

export function siweMessageHash(message: string): Hex {
  parseExactSiweMessage(message);
  return hashMessage(message);
}

export function requireCurrentSiweWindow(message: string, now: Date): ParsedExactSiweMessage {
  const parsed = parseExactSiweMessage(message);
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) throw new Error("current time must be a valid instant.");
  if (nowMs < new Date(parsed.issuedAt).getTime()) throw new Error("SIWE challenge is not active yet.");
  if (nowMs >= new Date(parsed.expirationTime).getTime()) throw new Error("SIWE challenge has expired.");
  return parsed;
}

export async function verifyExactSiweProof(
  message: string,
  proof: string,
  expected: ExactSiweMessageFields,
): Promise<Address> {
  const parsed = parseExactSiweMessage(message);
  const expectedMessage = buildExactSiweMessage(expected);
  if (message !== expectedMessage) throw new Error("SIWE message does not match the server-issued challenge fields.");
  await requireCanonicalSignatureFrom(siweMessageHash(message), proof, parsed.walletAddress);
  return getAddress(expected.walletAddress);
}
