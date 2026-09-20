import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import canonicalize from "canonicalize";
import { getContractAddress, keccak256 } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { ABI_VERSION, COLLECTION_PROFILE, MANIFEST_VERSION, buildIdentity, deploymentInitcode, validateOpenSignaturesManifest, validateRpcConfiguration } from "./open-signatures-manifest.mjs";

const artifact = JSON.parse(readFileSync(new URL("../out/OpenSignatures.sol/OpenSignatures.json", import.meta.url)));
const sourceBytes = readFileSync(new URL("../src/OpenSignatures.sol", import.meta.url));
const sha = bytes => `0x${createHash("sha256").update(bytes).digest("hex")}`;
const h = byte => `0x${byte.repeat(32)}`;
const a = byte => `0x${byte.repeat(20)}`;
const zeroHash = h("00");
const scratch = mkdtempSync(join(tmpdir(), "open-signatures-manifest-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

async function fixture(environment = "local-anvil") {
  const collectionBytes = Buffer.from(canonicalize({ name: "Open Signatures local preparation", description: "Offline mock evidence, not a deployment." }));
  const collectionURI = `ipfs://${CID.createV1(raw.code, await sha256.digest(collectionBytes)).toString()}`;
  const constructor = { name: "Open Signatures local preparation", symbol: "OPEN", collectionURI, adminDelay: "172800",
    delayedAdmin: a("22"), authorizerManager: a("33"), pauser: a("44"), nonceRevoker: a("55"), authorizer: a("66") };
  const chainId = environment === "local-anvil" ? "31337" : "11155111";
  const contract = getContractAddress({ from: a("11"), nonce: 7n }).toLowerCase();
  // Compiled template used only as MOCK observed runtime; no Anvil or RPC call.
  const runtimeCode = artifact.deployedBytecode.object;
  const manifest = { manifestVersion: MANIFEST_VERSION, contract: "OpenSignatures", abiVersion: ABI_VERSION, environment,
    chain: { chainId, genesisHash: h("a1") }, deployment: { address: contract, transactionHash: h("b1"), blockNumber: "10", blockHash: h("c1"),
      deployer: a("11"), nonce: "7", initcodeHash: keccak256(deploymentInitcode(artifact, constructor)), runtimeCodeHash: keccak256(runtimeCode) },
    domain: { name: "SignaturesOpenMint", version: "1", chainId, verifyingContract: contract }, constructor,
    roleSeparation: "six-distinct-principals-v1", roleOwners: { deployer: "local-deployer", delayedAdmin: "local-admin", authorizerManager: "local-manager", pauser: "local-pauser", nonceRevoker: "local-revoker", authorizer: "local-online-signer" },
    build: buildIdentity(artifact, sourceBytes), collection: { profile: COLLECTION_PROFILE, bytesSha256: sha(collectionBytes),
      publication: environment === "local-anvil" ? "local-only" : "verified", evidenceReferences: environment === "local-anvil" ? [] : ["mock-publication", "mock-retrieval"] } };
  const observed = { chainId, genesisHash: manifest.chain.genesisHash, blockNumber: "10", blockHash: manifest.deployment.blockHash, contractAddress: contract, runtimeCode,
    receipt: { status: "success", transactionHash: manifest.deployment.transactionHash, blockNumber: "10", blockHash: manifest.deployment.blockHash,
      from: manifest.deployment.deployer, to: null, nonce: "7", contractAddress: contract, transactionInput: deploymentInitcode(artifact, constructor) },
    domain: { fields: "0x0f", ...manifest.domain, salt: zeroHash, extensions: [] }, name: constructor.name, symbol: constructor.symbol,
    contractURI: collectionURI, defaultAdmin: constructor.delayedAdmin, defaultAdminDelay: constructor.adminDelay, trustedAuthorizer: constructor.authorizer,
    paused: false, roleMatrix: Array.from({ length: 24 }, (_, index) => index % 6 === Math.floor(index / 6) + 1) };
  const expected = { chainId, genesisHash: manifest.chain.genesisHash, contractAddress: contract, trustedAuthorizer: constructor.authorizer,
    initcodeHash: manifest.deployment.initcodeHash, runtimeCodeHash: manifest.deployment.runtimeCodeHash };
  const options = { artifact, sourceBytes, collectionBytes, observed, expected, rpcUrl: environment === "local-anvil" ? "http://127.0.0.1:18599" : "https://rpc.example.com/",
    allowlistedTestnetChainIds: environment === "local-anvil" ? [] : ["11155111"] };
  return { manifest, options };
}

test("valid local mock evidence grants no public broadcast, observation trust or runtime authority", async () => {
  const { manifest, options } = await fixture();
  const before = JSON.stringify(manifest), result = await validateOpenSignaturesManifest(manifest, options);
  assert.equal(result.offlineConsistent, true); assert.equal(result.publicBroadcastAllowed, false);
  assert.equal(result.runtimeAdmissionAllowed, false); assert.equal(result.observationsIndependentlyVerified, false);
  assert.match(result.manifestSha256, /^0x[0-9a-f]{64}$/); assert.equal(JSON.stringify(manifest), before);
});

for (const [name, mutate] of [
  ["legacy domain", m => { m.domain.name = "signatures.gallery"; }],
  ["legacy version", m => { m.domain.version = "2"; }],
  ["chain mismatch", m => { m.chain.chainId = "1337"; }],
  ["domain chain mismatch", m => { m.domain.chainId = "1"; }],
  ["domain contract mismatch", m => { m.domain.verifyingContract = a("77"); }],
  ["signer mismatch", m => { m.constructor.authorizer = a("77"); }],
  ["code hash mismatch", m => { m.deployment.runtimeCodeHash = h("dd"); }],
  ["build mismatch", m => { m.build.compilerVersion = "unreviewed compiler"; }],
  ["creation code mismatch", m => { m.build.creationCodeHash = h("dd"); }],
  ["constructor commitment mismatch", m => { m.constructor.adminDelay = "86400"; }],
  ["zero admin delay", m => { m.constructor.adminDelay = "0"; }],
  ["uint48 overflow", m => { m.constructor.adminDelay = String(2 ** 48); }],
  ["immutable URI mismatch", m => { m.constructor.collectionURI = "ipfs://bafkreih7bz4qacjadndnf76hu3toyzy54za2hreks45npcwxzkwuimgpdi"; }],
  ["mutable URI", m => { m.constructor.collectionURI = "https://example.com/collection.json"; }],
  ["oversized UTF-8 name", m => { m.constructor.name = "界".repeat(43); }],
  ["oversized UTF-8 symbol", m => { m.constructor.symbol = "界".repeat(6); }],
  ["unexpected secret field", m => { m.privateKey = "not-a-real-secret"; }],
  ["invented legacy getter", m => { m.deployment.collectionMetadataSha256 = h("aa"); }],
  ["duplicate owner", m => { m.roleOwners.pauser = m.roleOwners.deployer; }],
  ["malformed hash", m => { m.chain.genesisHash = "0x1"; }],
  ["zero genesis", m => { m.chain.genesisHash = zeroHash; }],
  ["unsafe numeric chain", m => { m.chain.chainId = 31337; }],
]) test(`rejects ${name}`, async () => {
  const { manifest, options } = await fixture(); mutate(manifest);
  await assert.rejects(validateOpenSignaturesManifest(manifest, options));
});

const identityKeys = ["deployer", "delayedAdmin", "authorizerManager", "pauser", "nonceRevoker", "authorizer"];
for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) test(`rejects address collision ${identityKeys[i]}/${identityKeys[j]}`, async () => {
  const { manifest, options } = await fixture();
  const value = i === 0 ? manifest.deployment.deployer : manifest.constructor[identityKeys[i]];
  manifest.constructor[identityKeys[j]] = value;
  if (j === 5) options.expected.trustedAuthorizer = value;
  await assert.rejects(validateOpenSignaturesManifest(manifest, options), /role addresses/);
});

for (const [name, mutate] of [
  ["wrong chain", o => { o.chainId = "1"; }], ["wrong genesis", o => { o.genesisHash = h("dd"); }],
  ["wrong contract", o => { o.contractAddress = a("77"); }], ["wrong block", o => { o.blockNumber = "9"; }],
  ["wrong block hash", o => { o.blockHash = h("dd"); }], ["wrong runtime", o => { o.runtimeCode = `0x00${o.runtimeCode.slice(4)}`; }],
  ["wrong signer", o => { o.trustedAuthorizer = a("77"); }], ["wrong admin", o => { o.defaultAdmin = a("77"); }],
  ["extra signer privilege", o => { o.roleMatrix[5] = true; }], ["missing pauser", o => { o.roleMatrix[15] = false; }],
  ["paused deployment", o => { o.paused = true; }], ["wrong domain name", o => { o.domain.name = "signatures.gallery"; }],
  ["wrong domain address", o => { o.domain.verifyingContract = a("77"); }], ["domain extension", o => { o.domain.extensions = [1]; }],
  ["wrong immutable URI", o => { o.contractURI += "/changed"; }], ["reverted receipt", o => { o.receipt.status = "reverted"; }],
  ["wrong receipt sender", o => { o.receipt.from = a("77"); }], ["wrong deployment bytes", o => { o.receipt.transactionInput += "00"; }],
  ["wrong deployment transaction", o => { o.receipt.transactionHash = h("dd"); }], ["call instead of CREATE", o => { o.receipt.to = a("77"); }],
]) test(`rejects observed ${name}`, async () => {
  const { manifest, options } = await fixture(); mutate(options.observed);
  await assert.rejects(validateOpenSignaturesManifest(manifest, options));
});

test("requires actual compiled OpenSignatures source and ABI, not legacy build evidence", async () => {
  const { manifest, options } = await fixture(); options.sourceBytes = Buffer.from("not the compiled source");
  await assert.rejects(validateOpenSignaturesManifest(manifest, options), /compiled source/);
  const bad = structuredClone(artifact); bad.abi.push({ type: "function", name: "currentAuthorizerEpoch", inputs: [], outputs: [] });
  assert.throws(() => buildIdentity(bad, sourceBytes), /legacy ABI/);
  const payable = structuredClone(artifact); payable.abi.find(item => item.type === "constructor").stateMutability = "payable";
  assert.throws(() => buildIdentity(payable, sourceBytes), /constructor mutability/);
});

test("rejects changed, oversized or noncanonical collection bytes", async () => {
  for (const bytes of [Buffer.from('{ "name": "changed" }'), Buffer.alloc(262145, 32), Buffer.from("\xff", "latin1")]) {
    const { manifest, options } = await fixture(); options.collectionBytes = bytes;
    await assert.rejects(validateOpenSignaturesManifest(manifest, options));
  }
});

test("public drafts require an explicit testnet allowlist and never enable public execution", async () => {
  const { manifest, options } = await fixture("public-testnet-draft");
  await assert.rejects(validateOpenSignaturesManifest(manifest, { ...options, allowlistedTestnetChainIds: [] }), /allowlisted/);
  const result = await validateOpenSignaturesManifest(manifest, options); assert.equal(result.publicBroadcastAllowed, false);
  manifest.chain.chainId = "1"; options.allowlistedTestnetChainIds = ["1"];
  await assert.rejects(validateOpenSignaturesManifest(manifest, options), /mainnet/);
});

test("public draft requires reviewed collection publication and retrieval evidence", async () => {
  const { manifest, options } = await fixture("public-testnet-draft"); manifest.collection.publication = "local-only";
  await assert.rejects(validateOpenSignaturesManifest(manifest, options), /publication/);
  manifest.collection.publication = "verified"; manifest.collection.evidenceReferences = ["one-assertion"];
  await assert.rejects(validateOpenSignaturesManifest(manifest, options), /evidence/);
});

for (const identity of [
  mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: 5 }).address.toLowerCase(),
  privateKeyToAccount(`0x${"1".padStart(64, "0")}`).address.toLowerCase(), "0x0000000000000000000000000000000000000007",
]) test(`public rejects known test signer ${identity}`, async () => {
  const { manifest, options } = await fixture("public-testnet-draft"); manifest.constructor.authorizer = identity; options.expected.trustedAuthorizer = identity;
  await assert.rejects(validateOpenSignaturesManifest(manifest, options), /test identities/);
});

for (const url of ["http://rpc.example.com", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://rpc.local", "https://rpc.invalid", "https://rpc.test", "https://10.0.0.1", "https://user:password@rpc.example.com", "https://localhost.", "https://rpc.local.", "https://rpc.internal", "https://rpc.onion"]) {
  test(`public configuration rejects dev/unsafe endpoint ${url}`, () => assert.throws(() => validateRpcConfiguration(url, "public-testnet-draft")));
}

function evidenceFiles(manifest, options) {
  const values = { manifest, artifact: options.artifact, source: options.sourceBytes, collection: options.collectionBytes, expected: options.expected, observed: options.observed };
  const args = [];
  for (const [key, value] of Object.entries(values)) {
    const path = join(scratch, `${key}.json`); writeFileSync(path, Buffer.isBuffer(value) ? value : JSON.stringify(value)); args.push(`--${key}`, path);
  }
  return [...args, "--rpc-url", options.rpcUrl];
}
const validator = fileURLToPath(new URL("./open-signatures-validate.mjs", import.meta.url));
const cli = args => spawnSync(process.execPath, [validator, ...args], { env: {}, encoding: "utf8", timeout: 10000 });
test("offline CLI reads bounded separate evidence, writes nothing and has no broadcast switch", async () => {
  const { manifest, options } = await fixture(), args = evidenceFiles(manifest, options);
  const before = readdirSync(scratch).sort().map(name => [name, sha(readFileSync(join(scratch, name)))]);
  const result = cli(args); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).publicBroadcastAllowed, false);
  assert.deepEqual(readdirSync(scratch).sort().map(name => [name, sha(readFileSync(join(scratch, name)))]), before);
  const bad = cli([...args, "--broadcast"]); assert.equal(bad.status, 1); assert.equal(bad.stdout, "");
  assert.match(bad.stderr, /no RPC or broadcast was performed/);
});
test("CLI refuses public mode, symlink/oversized manifests and unknown secret fields without echo", async () => {
  const { manifest, options } = await fixture(), args = evidenceFiles(manifest, options);
  const alias = join(scratch, "manifest-link.json"); symlinkSync(args[1], alias);
  assert.equal(cli([args[0], alias, ...args.slice(2)]).status, 1);
  writeFileSync(args[1], Buffer.alloc(65537, 32)); assert.equal(cli(args).status, 1);
  manifest.environment = "public-testnet-draft"; writeFileSync(args[1], JSON.stringify(manifest)); assert.equal(cli(args).status, 1);
  manifest.environment = "local-anvil"; manifest.secret = "must-not-echo"; writeFileSync(args[1], JSON.stringify(manifest));
  const bad = cli(args); assert.equal(bad.status, 1); assert.doesNotMatch(bad.stderr, /must-not-echo/);
});
