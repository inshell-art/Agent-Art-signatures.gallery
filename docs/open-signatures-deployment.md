# OpenSignatures deployment preparation — E19 local increment

This is separate from the GalleryOfSignatures deployment tooling. It prepares and checks **OpenSignatures**, whose exact EIP-712 domain is `SignaturesOpenMint` / `1`. It does not deploy publicly, start an RPC server, provision accounts, read private keys, enable the application, or complete E19.

The existing production startup refusal is unchanged. Do not use `NODE_ENV=development` as a hosted-staging bypass. The user selected **Ethereum Sepolia** on 2026-09-20; this tooling does not approve signer custody, operational owners, finality policy or a deployment budget. See [the architecture decision](public-architecture.md).

## Files and checks

- `contracts/script/DeployOpenSignatures.s.sol`: Foundry script using the actual nine-argument constructor. Both configuration and deployment reject every chain except 31337. `LOCAL_ONLY_NO_PUBLIC_BROADCAST` is mandatory. No private key is read by the script; Foundry must obtain any explicitly requested local signing authority separately.
- `contracts/tools/open-signatures-manifest.schema.json`: strict versioned manifest shape; undeclared fields, including keys/secrets and legacy getter claims, are refused.
- `contracts/tools/open-signatures-manifest.mjs`: pure offline checks against separately supplied expected identity, compiled artifact, exact source/collection bytes and observations.
- `contracts/tools/open-signatures-validate.mjs`: read-only, bounded-file CLI for local evidence only. No RPC requests or broadcast flag. The supplied RPC URL is syntax-checked, not contacted. Symlink evidence files, relative paths, missing/duplicate/unknown arguments and oversized inputs are refused.
- `contracts/test/DeployOpenSignatures.t.sol` and `contracts/tools/open-signatures-manifest.node-test.mjs`: local EVM/mock evidence only. Node fixtures are explicitly synthetic; the compiled runtime template is not a real deployed-code observation.

Run from the repository root:

```sh
cd contracts
forge build --offline
forge test --offline --match-contract DeployOpenSignaturesTest
cd ..
node --test contracts/tools/open-signatures-manifest.node-test.mjs
```

No public RPC, Anvil process, provider, wallet or account is needed for these tests. The existing contract suite remains applicable for authorization, replay, signer rotation, pause and nonce-revocation behavior. The new script does not modify those semantics.

## Local script configuration

For any separate, expressly requested Anvil rehearsal, use a disposable isolated chain, **not the active pilot chain**. First publish/verify or locally prepare the exact small collection document and review the constructor and six role identities. A simulation does not authorize a subsequent broadcast.

The script reads these non-secret configuration variables:

| Variable | Required meaning |
| --- | --- |
| `OPEN_DEPLOY_CHAIN_ID` | `31337`; all public chains are refused, including testnets. |
| `OPEN_DEPLOY_DOMAIN_NAME`, `OPEN_DEPLOY_DOMAIN_VERSION` | Exactly `SignaturesOpenMint`, `1`. |
| `OPEN_DEPLOY_COLLECTION_NAME`, `OPEN_DEPLOY_COLLECTION_SYMBOL` | Exact immutable constructor values; at most 128/16 UTF-8 bytes. |
| `OPEN_DEPLOY_COLLECTION_URI` | Exact raw SHA-256 CIDv1 `ipfs://` URI for the approved small collection bytes. |
| `OPEN_DEPLOY_ADMIN_DELAY_SECONDS` | Explicit positive uint48; no public delay policy is selected here. |
| `OPEN_DEPLOY_DEPLOYER` | Local deployment sender, which retains no privileged role. |
| `OPEN_DEPLOY_DELAYED_ADMIN` | Delayed default admin. |
| `OPEN_DEPLOY_AUTHORIZER_MANAGER` | Authorizer rotation owner. |
| `OPEN_DEPLOY_PAUSER` | Emergency pause owner. |
| `OPEN_DEPLOY_NONCE_REVOKER` | Nonce revocation owner; this is not the legacy authorization-revoker role. |
| `OPEN_DEPLOY_AUTHORIZER` | Online EOA signing identity with none of the four administrative roles. |
| `OPEN_DEPLOY_ACKNOWLEDGEMENT` | Exactly `LOCAL_ONLY_NO_PUBLIC_BROADCAST`. |

All six addresses must be nonzero and pairwise distinct. A deployment manifest also requires six distinct named owner references under `six-distinct-principals-v1`. References are review assertions, not proof of custody or organizational independence. Any weaker role-separation policy requires a deliberate reviewed revision, not an implicit collision exception.

For a configured isolated Anvil only, `forge script script/DeployOpenSignatures.s.sol:DeployOpenSignatures --rpc-url <isolated-loopback-RPC>` performs a simulation unless the operator explicitly adds Foundry's broadcast option. This document does not authorize running that option. The script still refuses public chain IDs even if a caller adds it.

## Manifest and evidence contract

Use manifest version `sg-open-signatures-deployment-v1`, ABI identifier `sg-open-signatures-abi-v1`, contract `OpenSignatures`. No real deployment manifest is shipped: inventing transaction hashes, owners or successful observations would misrepresent deployment evidence. Tests construct complete mock records to exercise the schema.

The manifest binds:

1. Chain ID and genesis hash; deployment address, transaction hash, sender/nonce, successful receipt block/hash, initcode hash and complete runtime code hash. CREATE address is recomputed from sender/nonce; CREATE2 is unsupported by this script/profile.
2. Exact domain name/version, chain ID and verifying contract.
3. All nine constructor arguments, including exact immutable `collectionURI`, delayed admin delay and operational identities.
4. Named owners and strict separation policy.
5. Compiler version, canonical compiler settings/metadata/ABI SHA-256, exact active-contract source SHA-256, creation-code Keccak and runtime-template Keccak. Metadata commits dependency source hashes. Rebuild from the reviewed source/dependencies before validation; the tool is not a reproducible-build attestation service.
6. Exact collection-byte SHA-256, narrow collection importer profile and publication/retrieval evidence references.

`buildIdentity(artifact, sourceBytes)` produces the build fields from a reviewed Foundry artifact. `deploymentInitcode(artifact, constructor)` reproduces the exact constructor payload. Never copy an untrusted candidate's values into the independent expected-identity input just to make validation pass.

The separate expected-identity JSON has exactly `chainId`, `genesisHash`, `contractAddress`, `trustedAuthorizer`, `initcodeHash`, `runtimeCodeHash`. All quantities are canonical decimal strings; addresses and hashes are lowercase hexadecimal. The source file must match the artifact's recorded source hash and the artifact must target `src/OpenSignatures.sol:OpenSignatures` with the actual nonpayable constructor/mint ABI.

The observation JSON contains `chainId`, `genesisHash`, `blockNumber`, `blockHash`, `contractAddress`, `runtimeCode`, `receipt`, `domain`, `name`, `symbol`, `contractURI`, `defaultAdmin`, `defaultAdminDelay`, `trustedAuthorizer`, `paused`, `roleMatrix`:

- `receipt` contains `status: "success"`, `transactionHash`, `blockNumber`, `blockHash`, `from`, `to: null`, `nonce`, `contractAddress`, `transactionInput`. Supply the transaction's actual input and nonce, not values inferred only from a successful receipt.
- `domain` is ERC-5267 data: `fields: "0x0f"`, `name`, `version`, decimal-string `chainId`, `verifyingContract`, zero `salt`, empty `extensions`.
- `roleMatrix` is 24 booleans from `hasRole`. Rows: default admin, authorizer manager, pauser, nonce revoker. Columns: deployer, delayed admin, authorizer manager, pauser, nonce revoker, online authorizer. Exactly the intended owner in each row is true. This does **not** invent an enumerable role getter or prove the absence of unknown additional members; a future public adapter must reconcile deployment/role logs.
- Pin all state observations to one block/hash no earlier than deployment. Reconcile it with independent canonical headers before trusting it. The tool validates supplied relationships, not RPC honesty or finality.

Runtime comparison verifies executable bytes against the compiled template, accounting for Solidity immutable slots. The **full** runtime hash must independently match the expected pin. Domain and role getters are then checked. OpenSignatures has no `collectionMetadataSha256`, `collectionURIHash`, `currentAuthorizerEpoch` or legacy authorization-revoker getter; no validation relies on them.

Local CLI example (replace every evidence path and the isolated RPC URL):

```sh
node contracts/tools/open-signatures-validate.mjs \
  --manifest /absolute/evidence/manifest.json \
  --artifact /absolute/build/OpenSignatures.json \
  --source /absolute/source/OpenSignatures.sol \
  --collection /absolute/evidence/collection.json \
  --expected /absolute/review/expected-identity.json \
  --observed /absolute/evidence/observations.json \
  --rpc-url http://127.0.0.1:ISOLATED_PORT
```

Success returns `offlineConsistent:true`, a manifest SHA-256, and **false** for `observationsIndependentlyVerified`, `publicBroadcastAllowed`, and `runtimeAdmissionAllowed`. It is never a launch or signing authorization.

## Collection URI and public-draft boundaries

`sg-open-collection-raw-sha256-v1` is deliberately narrower than E18's general deterministic UnixFS publication profile: one canonical UTF-8 JSON object, maximum 262144 bytes, raw-codec CIDv1 with SHA-256 and an exact root `ipfs://` URI. No path, query, fragment, gateway rewrite or mutable HTTPS URI is accepted. The collection `name` must equal the constructor name. E18 may use dag-pb for larger assets; those are not silently treated as raw collection documents. Publication/privacy checks for nested collection fields remain E18 integration work.

The pure validator can evaluate a `public-testnet-draft` only with an explicit caller-supplied testnet chain-ID allowlist and HTTPS RPC configuration. There is no implicit public network in the generic validator. For this project's approved staging target, the caller must use only Ethereum Sepolia (`11155111`), with independently verified genesis and deployment pins. Mainnet, dev chain IDs, literal IP/development RPC endpoints, known Foundry/Hardhat first-20 mnemonic accounts, small scalar test-key accounts and obvious tiny addresses are refused. This finite test-identity denylist is defense in depth, not proof that a remaining address has safe custody. No private keys belong in a manifest or CLI argument.

Public drafts additionally require `publication:"verified"` and distinct publication/retrieval evidence references. Strings cannot establish independent publication by themselves: the operator must verify the actual E18 receipts and bytes. Even a consistent public draft cannot pass the local CLI or script broadcast gate.

## Remaining E19/E21/E23 work

- A bounded public-chain/RPC adapter fetching independent block-pinned evidence, checking DNS-resolved destinations/redirects/timeouts/body limits, code/domain/signer/roles and chain clock, and verifying actual signed authorizations.
- Ethereum Sepolia genesis verification, finality/provider agreement, source verification, deployment package, role owners and signer custody. Network selection is recorded; finite configuration checks do not replace operational review.
- Durable binding of manifest hash to namespace/deployment, E18 verified collection/artifact receipts, E20 canonical role/mint/transfer projection and recovery.
- Explicit reviewed staging startup mode that cannot borrow development-only controls; production refusal remains until that integration and separate approvals.
- A separately reviewed public broadcast gate and funding/deployment approval. No non-local broadcast path is implemented here; green local tests cannot open it.
