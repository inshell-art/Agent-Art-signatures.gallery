#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import canonicalize from "canonicalize";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { encodeDeployData, keccak256, stringToHex } from "viem";

const HASH32 = /^0x[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const IPFS_URI = /^ipfs:\/\/(b[a-z2-7]+)$/;
const CURRENT_MANIFEST_VERSION = "sg-mint-deployment-1.0.0";
const SEPOLIA_GENESIS_HASH = "0x25a5cc106eea7138acab33231d7160d69cb777ee0c2c553fcddf5138993e6dd9";
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const ZERO_HASH = `0x${"0".repeat(64)}`;
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCHEMA_PATH = resolve(REPOSITORY_ROOT, "contracts/deployments/deployment-manifest.schema.json");
const MANIFEST_SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));

function fail(message) {
  throw new Error(`Invalid deployment manifest: ${message}`);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function requireHash(value, field, allowZero = false) {
  requireValue(HASH32.test(value), `${field} must be 0x plus 64 lowercase hexadecimal characters`);
  if (!allowZero) requireValue(value !== ZERO_HASH, `${field} must be nonzero`);
}

function requireSha256(value, field) {
  requireValue(SHA256.test(value), `${field} must be 64 lowercase hexadecimal characters`);
  requireValue(!/^0+$/.test(value), `${field} must be nonzero`);
}

function requireAddress(value, field) {
  requireValue(ADDRESS.test(value), `${field} must be a 20-byte hexadecimal address`);
  requireValue(value.toLowerCase() !== ZERO_ADDRESS, `${field} must be nonzero`);
}

function requireUint(value, field) {
  requireValue(UINT.test(value), `${field} must be a canonical unsigned decimal string`);
}

function requireSame(actual, expected, field) {
  requireValue(actual === expected, `${field} must equal ${JSON.stringify(expected)}`);
}

function schemaValueEqual(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function schemaTypeMatches(value, type) {
  switch (type) {
    case "null": return value === null;
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    default: fail(`schema uses unsupported type ${JSON.stringify(type)}`);
  }
}

function resolveSchemaReference(rootSchema, reference) {
  requireValue(reference.startsWith("#/"), `schema reference ${reference} must be local`);
  let current = rootSchema;
  for (const encodedPart of reference.slice(2).split("/")) {
    const part = encodedPart.replaceAll("~1", "/").replaceAll("~0", "~");
    requireValue(current && typeof current === "object" && Object.hasOwn(current, part),
      `schema reference ${reference} cannot be resolved`);
    current = current[part];
  }
  return current;
}

function validateJsonSchema(value, schema, rootSchema, path = "$") {
  if (schema.$ref) {
    validateJsonSchema(value, resolveSchemaReference(rootSchema, schema.$ref), rootSchema, path);
    return;
  }

  if (schema.type !== undefined) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    requireValue(allowedTypes.some((type) => schemaTypeMatches(value, type)),
      `${path} must have JSON Schema type ${allowedTypes.join(" or ")}`);
  }
  if (schema.const !== undefined) {
    requireValue(schemaValueEqual(value, schema.const), `${path} must equal the schema constant`);
  }
  if (schema.enum !== undefined) {
    requireValue(schema.enum.some((candidate) => schemaValueEqual(value, candidate)),
      `${path} is not one of the schema enum values`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined) {
      requireValue([...value].length >= schema.minLength, `${path} is shorter than the schema minimum`);
    }
    if (schema.pattern !== undefined) {
      requireValue(new RegExp(schema.pattern, "u").test(value), `${path} does not match the schema pattern`);
    }
  }
  if (typeof value === "number" && schema.minimum !== undefined) {
    requireValue(value >= schema.minimum, `${path} is below the schema minimum`);
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const requiredProperty of schema.required ?? []) {
      requireValue(Object.hasOwn(value, requiredProperty), `${path}.${requiredProperty} is required by the schema`);
    }
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const property of Object.keys(value)) {
        requireValue(Object.hasOwn(properties, property), `${path}.${property} is not allowed by the schema`);
      }
    }
    for (const [property, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, property)) {
        validateJsonSchema(value[property], propertySchema, rootSchema, `${path}.${property}`);
      }
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((entry, index) => validateJsonSchema(entry, schema.items, rootSchema, `${path}[${index}]`));
  }

  for (const memberSchema of schema.allOf ?? []) {
    validateJsonSchema(value, memberSchema, rootSchema, path);
  }
  if (schema.if !== undefined) {
    let matches = true;
    try {
      validateJsonSchema(value, schema.if, rootSchema, path);
    } catch {
      matches = false;
    }
    if (matches && schema.then !== undefined) validateJsonSchema(value, schema.then, rootSchema, path);
    if (!matches && schema.else !== undefined) validateJsonSchema(value, schema.else, rootSchema, path);
  }
}

function readContractArtifact(artifactPath) {
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  requireValue(Array.isArray(artifact.abi), "compiled GalleryOfSignatures ABI is missing");
  requireValue(/^0x(?:[0-9a-f]{2})+$/.test(artifact.bytecode?.object),
    "compiled GalleryOfSignatures creation bytecode is missing or unlinked");
  return artifact;
}

function canonicalAbiSha256(artifactPath) {
  const artifact = readContractArtifact(artifactPath);
  return createHash("sha256").update(Buffer.from(canonicalize(artifact.abi), "utf8")).digest("hex");
}

function compiledDeploymentInitcodeHash(artifactPath, constructor) {
  const artifact = readContractArtifact(artifactPath);
  const initcode = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [
      constructor.collection_name,
      constructor.collection_symbol,
      constructor.collection_uri,
      constructor.collection_metadata_sha256,
      constructor.collection_uri_keccak256,
      BigInt(constructor.default_admin_delay_seconds),
      constructor.delayed_admin,
      constructor.authorizer_manager,
      constructor.pauser,
      constructor.authorization_revoker,
      constructor.initial_authorizer,
    ],
  });
  return keccak256(initcode);
}

function requireRepositoryCommit(commit) {
  const result = spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  requireValue(result.status === 0, "build.source_commit must identify a commit present in this repository");
}

function requireCanonicalSepoliaSourceUrl(value, contractAddress) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("source_verification.url must be an absolute URL");
  }
  requireValue(
    url.protocol === "https:"
      && url.username === ""
      && url.password === ""
      && url.hostname === "sepolia.etherscan.io"
      && url.pathname.toLowerCase() === `/address/${contractAddress.toLowerCase()}`
      && url.search === ""
      && url.hash === "#code",
    "source_verification.url must be the canonical Sepolia Etherscan contract code URL",
  );
}

function rejectMutableCollectionKeys(value, path = "collection metadata") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectMutableCollectionKeys(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;

  const forbidden = new Set(["owner", "supply", "floor_price", "floorprice", "social_count", "socialcount"]);
  for (const [key, entry] of Object.entries(value)) {
    requireValue(!forbidden.has(key.toLowerCase()), `${path}.${key} is mutable and forbidden`);
    rejectMutableCollectionKeys(entry, `${path}.${key}`);
  }
}

async function validateCollectionMetadata(collection) {
  requireSame(collection.document_version, "sg-collection-metadata-1.0.0", "collection metadata version");
  requireSame(collection.import_profile, "sg-ipfs-unixfs-1.0.0", "collection importer profile");
  requireSha256(collection.sha256, "collection_metadata.sha256");
  requireHash(collection.uri_keccak256, "collection_metadata.uri_keccak256");
  requireValue(Number.isInteger(collection.independent_pin_count) && collection.independent_pin_count >= 0,
    "collection_metadata.independent_pin_count must be a nonnegative integer");

  const uriMatch = IPFS_URI.exec(collection.uri);
  requireValue(uriMatch, "collection_metadata.uri must be an exact lowercase Base32 CIDv1 ipfs:// URI");
  requireSame(collection.cid, uriMatch[1], "collection metadata CID/URI");

  const canonicalBytes = Buffer.from(collection.canonical_utf8_base64, "base64");
  requireSame(canonicalBytes.toString("base64"), collection.canonical_utf8_base64, "canonical metadata Base64");
  requireSame(canonicalBytes.toString("utf8"), collection.canonical_json, "canonical metadata UTF-8 bytes");

  const parsedMetadata = JSON.parse(collection.canonical_json);
  requireSame(canonicalize(parsedMetadata), collection.canonical_json, "RFC 8785 canonical collection JSON");
  rejectMutableCollectionKeys(parsedMetadata);

  const contentSha256 = createHash("sha256").update(canonicalBytes).digest("hex");
  requireSame(contentSha256, collection.sha256, "collection metadata SHA-256");
  const contentDigest = await sha256.digest(canonicalBytes);
  requireSame(CID.createV1(raw.code, contentDigest).toString(), collection.cid, "collection metadata raw CIDv1");
  requireSame(keccak256(stringToHex(collection.uri)), collection.uri_keccak256,
    "collection metadata URI Keccak-256");
}

async function validateManifest(manifest, { allowExample, artifactPath }) {
  validateJsonSchema(manifest, MANIFEST_SCHEMA, MANIFEST_SCHEMA);
  requireSame(manifest.$schema, "./deployment-manifest.schema.json", "$schema");
  requireSame(manifest.manifest_version, CURRENT_MANIFEST_VERSION, "manifest_version");
  requireValue(["example_only", "draft", "rehearsal_verified"].includes(manifest.status),
    "unknown status");
  requireValue(typeof manifest.example_only === "boolean", "example_only must be boolean");
  if (manifest.example_only && !allowExample) fail("example-only manifests require --allow-example");
  requireValue(manifest.example_only === (manifest.status === "example_only"),
    "example_only must correspond exactly to status=example_only");

  requireUint(manifest.chain.chain_id, "chain.chain_id");
  requireValue(manifest.chain.chain_id !== "1", "Ethereum mainnet is forbidden under this handoff");
  requireValue(["31337", "11155111"].includes(manifest.chain.chain_id), "only Anvil and Sepolia are allowed");
  if (manifest.status === "rehearsal_verified") {
    requireSame(manifest.chain.chain_id, "11155111", "rehearsal_verified chain ID");
  }
  requireSame(manifest.chain.network_name, manifest.chain.chain_id === "31337" ? "anvil" : "sepolia",
    "chain.network_name");
  requireHash(manifest.chain.genesis_hash, "chain.genesis_hash");
  if (manifest.chain.chain_id === "11155111") {
    requireSame(manifest.chain.genesis_hash, SEPOLIA_GENESIS_HASH, "Sepolia genesis hash");
  }

  const deployment = manifest.deployment;
  requireAddress(deployment.contract_address, "deployment.contract_address");
  requireHash(deployment.transaction_hash, "deployment.transaction_hash");
  requireUint(deployment.block_number, "deployment.block_number");
  requireHash(deployment.block_hash, "deployment.block_hash");
  requireHash(deployment.deployment_initcode_keccak256, "deployment.deployment_initcode_keccak256");
  requireHash(deployment.runtime_code_keccak256, "deployment.runtime_code_keccak256");
  requireValue(BigInt(deployment.block_number) > 0n, "deployment.block_number must be positive");

  const constructor = manifest.constructor_arguments;
  requireSame(constructor.collection_name, "Gallery of Signatures", "constructor collection name");
  requireSame(constructor.collection_symbol, "SIGN", "constructor collection symbol");
  requireValue(IPFS_URI.test(constructor.collection_uri), "constructor collection URI");
  requireHash(constructor.collection_metadata_sha256, "constructor collection metadata SHA-256");
  requireHash(constructor.collection_uri_keccak256, "constructor collection URI hash");
  requireUint(constructor.default_admin_delay_seconds, "constructor admin delay");
  requireValue(BigInt(constructor.default_admin_delay_seconds) > 0n, "constructor admin delay must be positive");
  for (const field of ["delayed_admin", "authorizer_manager", "pauser", "authorization_revoker", "initial_authorizer"]) {
    requireAddress(constructor[field], `constructor_arguments.${field}`);
  }

  const identity = manifest.contract_identity;
  requireSame(identity.name, "Gallery of Signatures", "contract name");
  requireSame(identity.symbol, "SIGN", "contract symbol");
  requireSame(identity.eip712_name, "signatures.gallery", "EIP-712 name");
  requireSame(identity.eip712_version, "2", "EIP-712 version");
  requireSame(identity.initial_authorizer_epoch, 1, "initial authorizer epoch");

  const roles = manifest.roles;
  for (const field of ["deployer", "delayed_admin_safe", "authorizer_manager", "pauser", "authorization_revoker", "online_authorizer"]) {
    requireAddress(roles[field], `roles.${field}`);
  }
  requireValue(roles.deployer_retained_privilege === false, "deployer must retain no privilege");
  const roleFields = ["deployer", "delayed_admin_safe", "authorizer_manager", "pauser", "authorization_revoker", "online_authorizer"];
  for (let i = 0; i < roleFields.length; i += 1) {
    for (let j = i + 1; j < roleFields.length; j += 1) {
      requireValue(roles[roleFields[i]].toLowerCase() !== roles[roleFields[j]].toLowerCase(),
        `role identities ${roleFields[i]} and ${roleFields[j]} must differ`);
    }
  }

  requireSame(constructor.delayed_admin.toLowerCase(), roles.delayed_admin_safe.toLowerCase(), "admin role");
  requireSame(constructor.authorizer_manager.toLowerCase(), roles.authorizer_manager.toLowerCase(), "manager role");
  requireSame(constructor.pauser.toLowerCase(), roles.pauser.toLowerCase(), "pauser role");
  requireSame(constructor.authorization_revoker.toLowerCase(), roles.authorization_revoker.toLowerCase(),
    "revoker role");
  requireSame(constructor.initial_authorizer.toLowerCase(), roles.online_authorizer.toLowerCase(),
    "authorizer role");

  await validateCollectionMetadata(manifest.collection_metadata);
  requireSame(constructor.collection_uri, manifest.collection_metadata.uri, "constructor/metadata URI");
  requireSame(constructor.collection_metadata_sha256.slice(2), manifest.collection_metadata.sha256,
    "constructor/metadata SHA-256");
  requireSame(constructor.collection_uri_keccak256, manifest.collection_metadata.uri_keccak256,
    "constructor/metadata URI hash");

  const observed = manifest.onchain_verification;
  requireUint(observed.observed_at_block, "onchain_verification.observed_at_block");
  requireValue(BigInt(observed.observed_at_block) >= BigInt(deployment.block_number),
    "onchain_verification.observed_at_block must not precede deployment.block_number");
  requireSame(observed.contract_uri, constructor.collection_uri, "observed contractURI");
  requireSame(observed.collection_metadata_sha256, constructor.collection_metadata_sha256,
    "observed collection SHA-256");
  requireSame(observed.collection_uri_keccak256, constructor.collection_uri_keccak256,
    "observed collection URI hash");
  requireSame(observed.current_authorizer_epoch, 1, "observed authorizer epoch");
  requireSame(observed.current_authorizer.toLowerCase(), roles.online_authorizer.toLowerCase(),
    "observed authorizer");
  requireValue(observed.paused === false, "new deployment must not be paused");
  requireValue(typeof observed.runtime_code_independently_verified === "boolean",
    "runtime verification flag must be boolean");

  const finality = manifest.finality_policy;
  requireUint(finality.reorg_overlap_blocks, "finality_policy.reorg_overlap_blocks");
  requireValue(Number.isInteger(finality.required_provider_agreement) && finality.required_provider_agreement >= 1,
    "finality provider agreement");
  if (manifest.chain.chain_id === "11155111") {
    requireSame(finality.block_tag, "finalized", "Sepolia finality block tag");
    requireValue(finality.required_provider_agreement >= 2, "Sepolia requires two agreeing providers");
    requireValue(finality.deployment_block_pinned === true, "Sepolia deployment block must be pinned");
    requireValue(manifest.collection_metadata.independent_pin_count >= 2, "Sepolia requires two independent pins");
  }

  const build = manifest.build;
  requireValue(/^[0-9a-f]{40}$/.test(build.source_commit), "source commit must be 40 lowercase hex characters");
  requireSame(build.compiler.version, "0.8.30+commit.73712a01.Emscripten.clang", "compiler version");
  requireValue(build.compiler.optimizer_enabled === true, "optimizer must be enabled");
  requireSame(build.compiler.optimizer_runs, 200, "optimizer runs");
  requireSame(build.compiler.evm_version, "prague", "EVM version");
  requireValue(build.compiler.via_ir === false, "via-IR must remain disabled for this build");
  requireSame(build.packages.openzeppelin_contracts, "5.6.1", "OpenZeppelin version");
  requireSame(build.abi.version, "sg-gallery-abi-1.0.0", "ABI version");
  requireSame(build.abi.hash_algorithm, "sha256-rfc8785-json", "ABI hash algorithm");
  requireSha256(build.abi.sha256, "build.abi.sha256");
  requireValue(existsSync(artifactPath),
    "compiled GalleryOfSignatures artifact is required; run `cd contracts && forge build --offline`");
  requireSame(canonicalAbiSha256(artifactPath), build.abi.sha256, "compiled ABI SHA-256");
  requireSame(
    deployment.deployment_initcode_keccak256,
    compiledDeploymentInitcodeHash(artifactPath, constructor),
    "deployment initcode Keccak-256 for compiled bytecode and constructor arguments",
  );

  if (manifest.status === "rehearsal_verified") {
    requireValue(observed.runtime_code_independently_verified === true, "verified status requires runtime check");
    requireSame(manifest.source_verification.explorer, "sepolia.etherscan.io", "source verification explorer");
    requireSame(manifest.source_verification.status, "verified", "source verification status");
    requireValue(typeof manifest.source_verification.url === "string" && manifest.source_verification.url.length > 0,
      "verified source URL");
    requireValue(!/^0+$/.test(build.source_commit), "verified manifest needs a real source commit");
    requireRepositoryCommit(build.source_commit);
    requireCanonicalSepoliaSourceUrl(manifest.source_verification.url, deployment.contract_address);
  }

  requireValue(manifest.mainnet_deployment_approval_record === null,
    "this rehearsal-only validator does not accept a mainnet approval record");
}

const args = process.argv.slice(2);
const allowExample = args.includes("--allow-example");
const positional = args.filter((arg) => !arg.startsWith("--"));
if (positional.length !== 1) {
  process.stderr.write("Usage: node contracts/tools/validate-deployment-manifest.mjs [--allow-example] <manifest.json>\n");
  process.exit(2);
}

const manifestPath = resolve(positional[0]);
const artifactPath = resolve(REPOSITORY_ROOT, "contracts/out/GalleryOfSignatures.sol/GalleryOfSignatures.json");

try {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  await validateManifest(manifest, { allowExample, artifactPath });
  process.stdout.write(`Deployment manifest validated: ${manifestPath}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
