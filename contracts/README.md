# Gallery of Signatures V2 contract

This directory contains the non-upgradeable V2 ERC-721 and its isolated Foundry suite.

```sh
cd contracts
forge test --offline
```

The remapping deliberately uses the root project's pinned `@openzeppelin/contracts` package. The production deployment delay is `48 hours`; tests keep the delay as an explicit constructor argument. No live-chain transaction or production deployment configuration is included: a deployment requires the separately reviewed manifest, role addresses, collection commitments, and network authorization described in the V2 handoff.

`fixtures/mint-authorization-golden.json` is a public deterministic cross-language fixture. Its signature is produced by a test-only key and must never be treated as a credential.

`script/DeployGalleryOfSignatures.s.sol` is a guarded rehearsal deployer for Anvil and Sepolia. It requires every domain, collection, chain, and role input explicitly, keeps signing outside the script, and rejects chain ID `1`. It was dry-run locally without `--broadcast`; no chain transaction was sent. See `REHEARSAL.md` and `deployments/README.md` before using it.
