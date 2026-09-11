# V2 deployment and end-to-end rehearsal runbook

This runbook is for local Anvil and Sepolia only. The deploy script hard-reverts on Ethereum mainnet. It reads no private key and does not write a manifest; signer custody stays in an external Foundry keystore, hardware wallet, or approved test signer. Running a command without `--broadcast` is a simulation. Nothing in this runbook authorizes a real-network transaction.

## Stop conditions

Stop before deployment if any item is missing or ambiguous:

- a clean reviewed source commit and passing V1, V2, and contract tests;
- the exact approved collection metadata canonical bytes and deterministic CID;
- successful byte-for-byte retrieval from two independent retained pins;
- exact chain ID and genesis hash from independently configured RPCs;
- distinct documented deployer, delayed admin Safe, authorizer manager, fast pauser, authorization revoker, and dedicated test authorizer;
- confirmation that the deployer receives no role and the online authorizer has no admin or custody role;
- an approved staging finality/reorg policy and healthy indexer;
- a completed dry run whose initcode hash matches the reviewed draft manifest.

The checked-in collection document is a deterministic rehearsal candidate, not an approved or pinned production asset. Adding collection imagery or changing its copy changes its SHA-256, CID, URI hash, constructor arguments, initcode, runtime code, and manifest.

## Baseline validation

From the repository root:

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run test:contract
npm run test:manifest
npm run test:manifest:roles
```

Record the exact `git rev-parse HEAD`, `forge --version`, compiler version, OpenZeppelin lockfile version, and canonical ABI SHA-256. Do not continue from an uncommitted or differently built tree.

## Explicit deployment inputs

The script requires all of these variables and rejects omissions:

```text
DEPLOY_EXPECTED_CHAIN_ID
DEPLOY_NETWORK_NAME
DEPLOY_GENESIS_HASH
DEPLOY_EIP712_NAME                 signatures.gallery
DEPLOY_EIP712_VERSION              2
DEPLOY_COLLECTION_NAME             Gallery of Signatures
DEPLOY_COLLECTION_SYMBOL           SIGN
DEPLOY_COLLECTION_URI              exact ipfs:// CIDv1 URI
DEPLOY_COLLECTION_METADATA_SHA256  0x-prefixed SHA-256
DEPLOY_COLLECTION_URI_HASH         Keccak-256 of exact URI UTF-8 bytes
DEPLOY_DEFAULT_ADMIN_DELAY_SECONDS
DEPLOYER_ADDRESS
DEPLOY_DELAYED_ADMIN
DEPLOY_AUTHORIZER_MANAGER
DEPLOY_PAUSER
DEPLOY_AUTHORIZATION_REVOKER
DEPLOY_INITIAL_AUTHORIZER
DEPLOY_ACKNOWLEDGEMENT              SEPOLIA_OR_LOCAL_REHEARSAL_ONLY_NO_MAINNET
```

Do not put private keys, RPC credentials, KMS credentials, or pin credentials in these values. Verify the genesis hash outside Solidity—the EVM cannot read an old block hash reliably—and paste that independently observed value into the environment and manifest.

## Local Anvil rehearsal

1. Start a disposable Anvil chain with chain ID `31337`. Use six distinct test accounts for deployer, admin, manager, pauser, revoker, and authorizer; never reuse any production address or key.
2. Record Anvil block zero and its genesis hash. Set network name exactly `anvil`, a documented nonzero admin delay, and the rehearsal acknowledgement.
3. Run a dry simulation first:

   ```sh
   cd contracts
   forge script script/DeployGalleryOfSignatures.s.sol:DeployGalleryOfSignatures --offline --rpc-url http://127.0.0.1:8545 --sender "$DEPLOYER_ADDRESS"
   ```

4. Compare the returned initcode hash and simulated runtime hash with independently computed values. Inspect every constructor argument and role assignment.
5. If the local rehearsal owner approves, repeat against the disposable Anvil chain with Foundry's local unlocked-account mode and `--broadcast`. This is local-only; never adapt the command to mainnet.
6. Build an actual `draft` manifest from the receipt and pinned block, validate it without `--allow-example`, and add its Markdown evidence record.
7. Exercise the full application path: existing V1 claim → action-specific X confirmation for wallet linking → SIWE proof → binding → frozen metadata → durable authorization → linked-wallet mint → unfinalized → finalized → Gallery → transfer → holder update. Also verify that an active claimant session with an existing proved wallet reaches mint review without another X login based solely on identity age. Confirm claimant and initial minter remain unchanged after transfer.
8. Exercise wallet rejection, expired app sessions/OAuth flows, expired or reused action approvals, wrong-action/wrong-target confirmation, invalid/replayed SIWE, metadata and signer outages, transaction revert/replacement, browser loss after submission, indexer restart, shallow reorg, RPC disagreement, exact authorization revocation, epoch revocation, pause, delayed-admin-only unpause, and transfer while minting is paused. The [authentication policy](../docs/authentication-policy.md) keeps app sessions, OAuth flows, SIWE proofs, and on-chain authorization deadlines separate.

Discarding the Anvil process is the local rollback. Keep test manifests clearly marked; never promote their addresses or hashes into staging configuration.

## Sepolia rehearsal

1. Use the canonical Sepolia chain ID `11155111`; independently verify its genesis identity with both RPC providers. Set network name exactly `sepolia`.
2. Approve and pin the exact collection bytes through two independent providers before deployment. Independently retrieve and verify the canonical bytes, SHA-256, CID, URI, and URI Keccak hash.
3. Confirm the delayed admin and authorizer manager are the intended test Safe/multisig controls, the pauser is a separate emergency guardian, the revoker is documented, the authorizer is a dedicated staging key, and the deployer differs from every privileged address.
4. Use a shorter staging admin delay only if the exact value and reason are documented. Production remains 48 hours.
5. Run `forge script` without `--broadcast` against Sepolia, using an externally configured sender. Record the simulation, gas estimate, exact constructor ABI encoding, initcode hash, predicted address, and runtime hash.
6. Obtain the explicit Sepolia transaction approval required by your team. Then use the approved external signer and add `--broadcast`; never pass or log a raw private key. This handoff does not authorize that action by itself.
7. Pin the mined deployment block/hash. Fetch the creation transaction input and `eth_getCode` at that pinned block from independent RPCs. Decode each `0x` byte string exactly once, then Keccak-hash the raw bytes. Do not hash RPC text or source files.
8. Verify exact source on the canonical explorer. Read and compare `name`, `symbol`, `eip712Domain`, `contractURI`, both collection commitments, pause state, epoch `1`, authorizer, admin delay, default admin, and all operational roles.
9. Complete and validate the JSON manifest. Sepolia requires `finalized`, agreement by at least two providers, two retained pins, a pinned deployment block, independently verified runtime code, a nonzero source commit, and explorer status `verified` before status becomes `rehearsal_verified`.
10. Enable issuance only after backend startup checks match the finalized manifest. Then perform the complete §19.8 claim-to-transfer flow and all listed failure rehearsals. Keep transaction reports advisory; prove mint state from canonical logs and finalized projections.

If anything differs after a Sepolia transaction, disable authorization issuance, pause minting through the guardian if necessary, preserve the immutable evidence, and diagnose. A deployed contract cannot be rolled back or replaced under this handoff. Do not repoint the service to a replacement collection.

## Mainnet boundary

Stop after Sepolia. The checked-in deployer and manifest validator refuse chain ID `1`. Mainnet requires a separate explicit authorization, production collection-metadata approval, completed security review, final role addresses, two production pin services, finality evidence, an unsigned runbook, and a deliberate reviewed change to the hard gate. No mainnet transaction is permitted by this V2 implementation handoff.
