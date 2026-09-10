# Local PostgreSQL + Anvil rehearsal

This is a local-only, interactive claim → wallet proof → mint → automatic indexing → transfer rehearsal. Claims, wallet bindings, authorizations, and chain projections survive app restarts. It never contacts or broadcasts to Sepolia, Ethereum mainnet, or an external RPC. Transaction guards require the configured repository-owned loopback Anvil node (default `http://127.0.0.1:18545`), chain ID `31337`, and recorded deployment/code evidence.

## Prerequisites

The defaults on this workstation are:

- PostgreSQL 16 tools: `/opt/homebrew/opt/postgresql@16/bin`
- Anvil: `/Users/bigu/.foundry/bin/anvil`
- Forge: `/Users/bigu/.foundry/bin/forge`

Override those directories/binaries with `LOCAL_POSTGRES_BIN`, `LOCAL_ANVIL_BIN`, and `LOCAL_FORGE_BIN`. Ports default to PostgreSQL `55432`, Anvil `18545`, and the foreground app `3000`; use `LOCAL_POSTGRES_PORT`, `LOCAL_ANVIL_PORT`, and `LOCAL_APP_PORT` before the first reset to change them. Keep the canonical app origin `http://127.0.0.1:3000` for the normal walkthrough. Do not switch app ports midway through an unfinished authorization: its frozen metadata includes the artifact origin and is not silently regenerated to fit a new port.

## Start from a clean local state

For an existing rehearsal, preserve its data with `npm run local:up` instead. The following command intentionally discards the previous local database, chain, and artifacts; stop the foreground app first.

```bash
npm run local:reset
```

`local:reset` stops only the owned processes recorded for this repository, removes only the ignored `.local/rehearsal` directory, and then:

1. initializes a checksummed PostgreSQL 16 cluster bound to `127.0.0.1`;
2. creates `signatures_gallery_local`, applies `src/store/schema.sql`, `src/store/migrations/002_v2_minting.sql`, and `src/local/schema.sql`, and records the exact V2 migration checksum;
3. starts a persisted Anvil chain on `127.0.0.1:18545` with chain ID `31337`;
4. seeds three V1 claims through the normal claim boundary into PostgreSQL and writes six content-addressed SVG/PNG references;
5. compiles and deploys `GalleryOfSignatures` with six pairwise-distinct public Anvil role accounts;
6. prepares and signs one exact V2 authorization, then submits it from a seventh, non-role Anvil account;
7. decodes the actual constructor and mint receipt logs, runs the indexer reducer, manually promotes the initial local seed block, and atomically stores mint/indexer snapshots in PostgreSQL;
8. verifies the schema, V1 rows, every referenced asset's presence/length/hash, contract bytecode/invariants, receipt, token owner, mint state, and Gallery projection.

The run record is `.local/rehearsal/runtime.json`. It contains addresses and hashes but no non-test secret. The fixed mnemonic is Anvil's public test mnemonic and must never be used outside a disposable local chain.

The CLI refuses to start or transact if another unowned RPC process already occupies the configured Anvil port, even if that process also reports chain ID 31337. `local:up`, `local:reset`, and `local:stop` refuse lifecycle changes while the foreground app holds the database writer lock. Stop that app with Ctrl-C first; do not kill an unrelated process to clear a port.

## Verify, inspect, stop, and restart

```bash
npm run local:status
npm run local:verify
npm run local:serve
```

Open <http://127.0.0.1:3000>. This entrypoint defaults to the X simulator. Use `npm run local:serve:x` for real X OAuth with the same local database and chain; see [Real X + local app](real-x-local.md) for developer-app setup, credentials and the browser walkthrough. The foreground app reads and updates:

- V1 accounts/signatures from PostgreSQL;
- exact SVG/PNG bytes from `.local/rehearsal/artifacts` with a PostgreSQL reference ledger;
- wallet challenges/bindings, authorization evidence, mint attempts, and indexer/Gallery projections in PostgreSQL JSONB snapshots.

At startup it checks the owned node, chain/deployment identity, runtime code hash, and seeded mint receipt. Its continuous reconciler scans actual contract logs and checks receipts, exact mint calldata, durable authorization/artifact commitments, token URI, and current holder. A missing browser transaction report does not hide a mint. The app enables two-second Anvil interval mining and polls approximately every second; confirmation normally takes a few seconds, not a guaranteed deadline.

HTTP mint mutations and indexer ticks share a single serialized runtime. An exclusive PostgreSQL writer lock prevents competing app writers; prepared intent is persisted before signing, the signed authorization before it is returned, and each indexer cursor plus its mint projection is committed atomically before publication. RPC/validation failures pause mint writes. A local chain rollback or changed confirmed block stops reconciliation and revokes affected local confirmations rather than inventing replacement history. Expired authorizations are released only after complete local-chain coverage and a pinned unused check; a reverted attempt does not release an authorization that can still be used.

## Simulator browser walkthrough

1. Open <http://127.0.0.1:3000/s/alice/0.731642> and select **Sign in with X and claim this signature**. If this exact signature was already claimed, choose a different valid `gr0k` value for a fresh work.
2. Choose **@alice** on the local OAuth screen and approve the simulated identity. You go directly to the signature page with a **Claimed** tag and a brief success toast; no second confirmation is required. Use the top four-square icon for the gallery or the collection dot for My Collection. Ordinary account sign-in creates no claim.
3. Open **My collection** using the collection dot. Select **Use local TEST wallet**, review the one-time wallet-proof message, and explicitly approve signing. The built-in wallet signs a real EIP-191/SIWE proof using public Anvil account index **6**; connecting alone does not create a binding. No extension or private-key import is needed.
4. On the new work, select **Mint this signature**, review the artwork, wallet, local chain, and publication disclosure, acknowledge the notice, then explicitly confirm the local transaction. A real signed transaction is submitted to Anvil. The page waits for observed contract evidence before showing Minted.
5. Inspect the same signature's **Provenance** and the **Minted** home tab. Both display the original claimant, initial mint wallet, and current token holder. The confirmation label is **Local Anvil automatic confirmation; single node**—not Ethereum finality.
6. Back in **My collection**, use **Transfer local token** and confirm the transaction. This control transfers only to the fixed second public TEST wallet, Anvil index **7**. After indexing, the holder changes; the original claim, mint wallet, and artwork do not. The built-in transfer control is one-way, not a general wallet or arbitrary transaction sender.

Both test keys are public. Never send real funds to them. **Link browser wallet instead** supports a separate EOA on this local Anvil chain; it must sign the same exact wallet proof and submit its own transaction. Use a dedicated test wallet, not a wallet holding valuable assets.

The CLI's initial mint remains valid historical local seed evidence, including its explicitly seeded wallet-proof record. On app startup that old active fixture binding is revoked; every new interactive mint requires a real SIWE binding. Existing real bindings remain durable.

Native forms use `Referrer-Policy: same-origin`, which preserves their correct Origin header while suppressing cross-origin referrers. Strict Origin/Fetch Metadata checks and session CSRF checks remain enabled; `Origin: null` is not accepted.

## Restart and failure rehearsal

Stop the foreground server with Ctrl-C, then stop the infrastructure:

```bash
npm run local:stop
```

The data remains on disk. Restart and reverify without redeploying or replaying fixture claims over newer account login metadata:

```bash
npm run local:up
npm run local:verify
npm run local:serve
```

Use `local:reset` only when intentionally discarding this repository's local database and chain.

App sessions and local OAuth flows are deliberately in memory. After an app restart, sign in again with the selected provider (X or the emulator); completed claims, real wallet bindings, authorization evidence, mint/transfer records, and the indexing cursor remain. A previously issued authorization is resumed or safely reconciled, not replaced just because the page was refreshed. A rejected confirmation sends nothing and can be retried. On an RPC/persistence safety error, inspect the server message rather than repeatedly resending or resetting the chain.

`local:up` and `local:verify` compare the recorded SHA-256 of `002_v2_minting.sql` with the current file. An unversioned or mismatched existing V2 schema fails closed and requires the explicit local reset; the CLI never guesses that a table's presence means a revised migration was applied.

## Repeatable interactive-path test

With `local:serve:emulator` already running at the canonical origin, the following explicitly creates a **Bob** claim, signs a real wallet proof, submits a local mint, waits for indexed confirmation, and transfers to the fixed second TEST wallet. It verifies chain receipts/ownership and that the original claim and artwork remain unchanged. It does not reset or deploy anything.

```bash
npm run local:test -- --execute-local-test-transactions
```

Keep the `signatureId` printed by that test. After stopping and restarting the app (and optionally the infrastructure), verify that same work without creating another claim or transaction:

```bash
npm run local:test -- --verify SIGNATURE_ID
```

Replace `SIGNATURE_ID` with the exact printed `sg1_…` value. Without one of these explicit modes, `local:test` refuses to run. If using a non-default app port chosen before the rehearsal, supply the same `LOCAL_APP_PORT` to both server and test.

## Fresh-migration integration test

```bash
npm run test:postgres:local
```

This creates a separate short-lived PostgreSQL cluster on an ephemeral loopback port, applies all three SQL files with `ON_ERROR_STOP`, checks key relations and the chain-block trigger in the PostgreSQL catalog, stops the server, and removes the temporary cluster.

## Honest boundaries

- Anvil mining is not Ethereum consensus or finality. The two promotion inputs to the pure reducer intentionally point to the same local node. The running app labels the result `Local Anvil automatic confirmation; single node`; the initial CLI seed uses a manual local promotion before the app starts.
- V2 mint/indexer durability is a complete JSONB snapshot of the in-memory reference model, not the normalized repository/worker implementation required for production.
- The continuous poller and exclusive writer are local-only. They do not supply a normalized production repository, independently operated RPC providers, public-network finality, or a production indexer daemon.
- Seeded/emulated X identities, renderer/card renderer, collection metadata, and keys are development fixtures. Real-X mode uses live X account consent for new interactive logins; it does not upgrade seeded records or make local claims production records. Interactive SIWE signatures and Anvil mint/transfer receipts are real local cryptographic evidence, not production provenance. IPFS CIDs are computed from retained local bytes, but metadata/artifacts are not published or pinned externally; an `ipfs://` URI does not imply public availability.
- Durable production sessions/flows, distributed rate limits, content leases/GC, independent RPC/pin providers, a protected signer, staging restore drills, and monitoring remain production gates. Local session loss on restart is expected.
- The production schema still permits only mainnet and Sepolia deployment rows. Anvil run metadata and snapshots live in the explicitly local-only `local_rehearsal` schema instead of weakening production constraints.
