# Deployment manifests

Every deployment gets one immutable JSON manifest conforming to `deployment-manifest.schema.json` and one sibling Markdown evidence record for human review. `example.anvil.json` is illustrative only and is deliberately rejected unless the validator receives `--allow-example`.

The manifest records the chain/genesis identity, deployment transaction and block, constructor arguments, exact build, ABI hash, creation and runtime bytecode hashes, EIP-712 identity, roles, collection metadata bytes and commitments, on-chain reads, source verification, and finality policy. The local validator checks its structure and cross-field commitments; it cannot independently prove network observations, explorer verification, provider independence, or retained pins. Reviewers must verify those claims against the cited external evidence before changing status. It contains no RPC URLs, credentials, private keys, signer key identifiers, or pin-provider secrets.

Validate the example after compiling:

```sh
cd contracts
forge build --offline
cd ..
node contracts/tools/validate-deployment-manifest.mjs --allow-example contracts/deployments/example.anvil.json
node --test contracts/tools/validate-deployment-manifest.node-test.mjs
```

For an actual rehearsal, copy the example to a network-and-address-specific filename, replace every illustrative value from independently collected evidence, set `example_only` to `false`, and use `draft` until all verification fields are complete. Only Sepolia may become `rehearsal_verified`; local Anvil manifests remain `draft`. `rehearsal_verified` requires two independent retained pins, two-provider finalized agreement, pinned deployment block, independently checked runtime code, explorer source verification, and a real source commit. This rehearsal-only schema deliberately has no production status.

The current validator and deploy script reject chain ID `1`. Mainnet needs separate explicit authorization and a reviewed tooling change; do not weaken that gate as part of a rehearsal.
