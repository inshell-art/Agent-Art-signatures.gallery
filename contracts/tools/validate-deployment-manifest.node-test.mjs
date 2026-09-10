import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const toolsDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(toolsDirectory, "../..");
const validator = join(toolsDirectory, "validate-deployment-manifest.mjs");
const example = JSON.parse(readFileSync(join(repositoryRoot, "contracts/deployments/example.anvil.json"), "utf8"));
const scratch = mkdtempSync(join(tmpdir(), "signatures-gallery-manifest-test-"));
const repositoryCommit = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).stdout.trim();

after(() => rmSync(scratch, { recursive: true, force: true }));

const constructorField = {
  delayed_admin_safe: "delayed_admin",
  authorizer_manager: "authorizer_manager",
  pauser: "pauser",
  authorization_revoker: "authorization_revoker",
  online_authorizer: "initial_authorizer",
};

function validateCollision(first, second) {
  const manifest = structuredClone(example);
  manifest.roles[second] = manifest.roles[first];
  if (constructorField[second]) {
    manifest.constructor_arguments[constructorField[second]] = manifest.roles[first];
  }
  return validateManifest(manifest, `${first}-${second}`);
}

function validateManifest(manifest, name, allowExample = true) {
  const manifestPath = join(scratch, `${name}.json`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  return spawnSync(process.execPath, [validator, ...(allowExample ? ["--allow-example"] : []), manifestPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

function rehearsalVerifiedManifest() {
  const manifest = structuredClone(example);
  manifest.status = "rehearsal_verified";
  manifest.example_only = false;
  manifest.chain = {
    chain_id: "11155111",
    network_name: "sepolia",
    genesis_hash: "0x25a5cc106eea7138acab33231d7160d69cb777ee0c2c553fcddf5138993e6dd9",
  };
  manifest.build.source_commit = repositoryCommit;
  manifest.collection_metadata.independent_pin_count = 2;
  manifest.onchain_verification.runtime_code_independently_verified = true;
  manifest.finality_policy = {
    block_tag: "finalized",
    required_provider_agreement: 2,
    reorg_overlap_blocks: "12",
    deployment_block_pinned: true,
  };
  manifest.source_verification = {
    explorer: "sepolia.etherscan.io",
    status: "verified",
    url: `https://sepolia.etherscan.io/address/${manifest.deployment.contract_address}#code`,
  };
  return manifest;
}

for (const [first, second] of [
  ["delayed_admin_safe", "authorizer_manager"],
  ["delayed_admin_safe", "authorization_revoker"],
  ["authorizer_manager", "authorization_revoker"],
  ["pauser", "authorization_revoker"],
]) {
  test(`rejects the formerly permitted ${first}/${second} collision`, () => {
    const result = validateCollision(first, second);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`role identities ${first} and ${second} must differ`));
  });
}

test("rejects undeclared top-level and nested manifest fields", () => {
  const topLevel = structuredClone(example);
  topLevel.private_key = "must-never-enter-a-manifest";
  let result = validateManifest(topLevel, "extra-top-level");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\$\.private_key is not allowed by the schema/);

  const nested = structuredClone(example);
  nested.deployment.rpc_url = "https://rpc.example.invalid/secret";
  result = validateManifest(nested, "extra-nested");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\$\.deployment\.rpc_url is not allowed by the schema/);
});

test("rejects a manifest whose initcode hash does not match the compiled constructor payload", () => {
  const manifest = structuredClone(example);
  manifest.deployment.deployment_initcode_keccak256 = `0x${"cc".repeat(32)}`;
  const result = validateManifest(manifest, "fabricated-initcode");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /deployment initcode Keccak-256 for compiled bytecode and constructor arguments/);
});

test("rejects an on-chain observation that predates the deployment block", () => {
  const manifest = structuredClone(example);
  manifest.deployment.block_number = "2";
  manifest.onchain_verification.observed_at_block = "1";
  const result = validateManifest(manifest, "observation-before-deployment");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /observed_at_block must not precede deployment\.block_number/);
});

test("rejects fabricated rehearsal source evidence", () => {
  const unknownCommit = rehearsalVerifiedManifest();
  unknownCommit.build.source_commit = "1".repeat(40);
  let result = validateManifest(unknownCommit, "unknown-source-commit", false);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /source_commit must identify a commit present in this repository/);

  const fakeExplorer = rehearsalVerifiedManifest();
  fakeExplorer.source_verification.url = "https://example.invalid/fake";
  result = validateManifest(fakeExplorer, "fake-source-url", false);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /canonical Sepolia Etherscan contract code URL/);

  const inconsistentExplorer = rehearsalVerifiedManifest();
  inconsistentExplorer.source_verification.explorer = "another-explorer.invalid";
  result = validateManifest(inconsistentExplorer, "inconsistent-source-explorer", false);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /source verification explorer must equal "sepolia\.etherscan\.io"/);
});

test("accepts a schema-complete internally consistent rehearsal evidence record", () => {
  const result = validateManifest(rehearsalVerifiedManifest(), "consistent-rehearsal", false);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Deployment manifest validated/);
});
