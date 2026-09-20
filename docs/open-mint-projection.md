# OpenSignatures chain projection — E20 foundation

This is an offline, unwired PostgreSQL projection for `OpenSignatures`, with a separate strict event decoder. It does not replace the active gallery, start an indexer, contact an RPC, authorize a mint, or establish public finality. The storage adapter accepts validated events; the adjacent decoder verifies event bytes and mint evidence but not chain authenticity. E20 is not complete.

The existing application and production-startup refusal are unchanged. No approved public chain, deployment, signer, finality policy or operating account is introduced.

## Storage and ownership

Apply `src/openMint/projection/projection-schema.sql` once with a migration role **after** the separate E17 `persistence/schema.sql`. Runtime does not apply either migration. The adapter uses the same `ExclusiveWriter` session, epoch fence and bounded database transactions; it does not create another writer lock or reconnect/retry after a lost commit acknowledgment.

`OpenMintProjection.open` registers an exact deployment configuration or requires an identical existing record. The configuration binds namespace ID, deployment ID, chain ID, address, manifest hash, exact deployment block/hash, and an explicitly supplied projection policy. Registration is not E19 manifest authentication: the coordinator must first validate the actual manifest and namespace/deployment permissions.

The separate tables retain:

- Immutable deployment configuration and immutable block-hash-qualified decoded log payloads.
- Canonical block headers and a head/promoted checkpoint, committed with projection changes.
- Mint records unique by deployment/token, canonical handle and nonce, with immutable mint position and original recipient.
- Ownership intervals at exact event positions. The current owner does not overwrite the original recipient or mint ordering.
- Insert-only promotion evidence references. References are assertions from a trusted coordinator, not a substitute for RPC/finality verification.

Materialized mint payloads must equal their retained log payload on read. A damaged item is returned as a minimal quarantined token entry rather than breaking unrelated gallery works. Artifact availability is separate from mint confidence and defaults to `unavailable`; changing it requires the exact artifact digest so a delayed check cannot mark a different post-reorg artifact available. No artifact is fetched by this adapter.

## Trusted input and bounded work

`append` accepts a deployment-bound `ValidatedBatch`, **not raw RPC data**. Limits are 32 contiguous blocks, 128 relevant events per block, 512 events and one MiB of canonical payload per call. Blocks use canonical decimal integers within PostgreSQL signed-bigint range; token IDs remain exact uint256 decimal strings. Addresses/hashes are lowercase, nonzero where required. Unknown event shapes, extra fields, wrong chain/address/manifest, gaps, reordered/duplicated log positions and inconsistent transaction positions are refused before writes.

Only `OpenSignatureMinted` and `Transfer` are implemented in this increment. Mint validation checks canonical handle, its exact `openMintHandleKey`, and the contract invariant `tokenId = uint256(handleKey)`. A mint must have the preceding zero-address `Transfer` for the same token/recipient/transaction. Transfers must continue the projected owner, and burns are refused because the active contract has no burn path. MBTI and `evidenceReference` are trusted enrichment; they are not invented event fields.

The separate `decode.ts` boundary now validates bounded raw `Transfer`/`OpenSignatureMinted` event shapes and their exact canonical ABI encoding. It rejects removed logs, wrong emitting address/block, malformed quantities/topics, reordered positions and trailing/noncanonical data. Mint enrichment must resolve from the trusted private durable store: it verifies the saved artifact bytes and SVG, namespace/deployment/chain/contract, exact handle/token/recipient/nonce/assessment/artifact/token-URI commitments, signed authorization digest, pinned authorizer's canonical ECDSA signature, and the historical mint block's timestamp within that authorization. It uses the contract's inclusive deadline, not the current wall clock. MBTI comes from the bound assessment, never a log's invented property or current renderer default. A bounded deadline covers asynchronous enrichment; caller mutation and late completion cannot alter the captured result.

This decoder explicitly returns `chainAuthenticated:false`. It does **not** establish raw-log completeness, successful receipts, header ancestry/canonicality, deployed contract code, or finality. The caller must independently verify those facts through bounded RPC observations before appending/promoting. It also must ensure the enrichment resolver reads committed accepted/signed/completed records, rather than arbitrary client JSON. Matching an event name, supplying a TypeScript type, or merely decoding a real signature is not chain authentication. Raw RPC endpoints must never feed the projection API directly.

Every accepted block is immutable apart from its canonical flag. Exact batch replay is idempotent. The same block hash with different payload is a durable safety halt, not a replacement. Any ordinary malformed/conflicting batch rolls its logs, projection and checkpoint back together.

## Reorg and confidence behavior

Backfill starts at the pinned deployment block. New blocks require a known canonical parent; the adapter does not search for ancestors or make an unbounded backfill request. A caller presenting a shallow fork must supply a bounded sequence beginning at the first changed height with its known canonical parent.

An unpromoted suffix can roll back only within the explicit `rollbackBlocks` policy, which must be 1–128. Orphan block/log evidence remains saved. Materialized orphan mints/ownership intervals are removed, prior ownership intervals reopen, and the replacement suffix is projected atomically. A conflicting deployment block, changed previously promoted boundary, immutable block contradiction or rollback beyond that horizon durably halts the deployment. Replay, `unavailable()` and restart cannot clear the halt; there is no reset/recovery API in this increment.

Promotion is a separate call naming an exact stored canonical block/hash, the pinned policy ID and an immutable evidence reference. No default confirmation count or public finality rule exists. `unavailable()` preserves all history but makes ordinary queries unknown; database/writer failures reject, never return an empty success that could imply no mint.

**Freshness remains a coordinator prerequisite.** The checkpoint's `health: "available"` means a structurally valid saved batch was processed, not that the latest public chain was consulted. Replaying old bytes may restore that storage-observation state without advancing head or promotion. `checkpoint()` therefore always reports `freshChainVerified:false`. A `confirmed` query result means confirmed in the explicitly promoted stored prefix; it is not a fresh-chain assertion or mint-authority decision. Before public reads or authority use, the future coordinator must enforce approved independent RPC agreement, chain clock, latest-head/finality freshness, maximum lag, historical state and tag-absence behavior. Those policies are not selected here.

Missing handles return `unknown`; observed but unpromoted mints return `pending`; safety-halted deployments return no ordinary public entries. Mint and owner lookup use the same promoted block. An unpromoted transfer cannot make a confirmed mint appear owned by its pending recipient. Pending lookup does not disclose assessment/artifact contents.

## Stable, snapshot-bound galleries

Home, MBTI and owner pages use descending immutable `(mint block, transaction index, log index, token ID)` ordering and indexed keyset queries, never assessment/access/owner-change timestamps. Each query returns at most 50 items plus one internal lookahead row. Database statement/lock deadlines also apply.

Cursors are canonical, bounded Base64URL JSON containing version, deployment, exact filter, page limit, promoted snapshot block/hash and final mint position. They contain no capability or secret and grant no authority. Subsequent pages require the same filter/limit and a retained canonical promoted snapshot. The explicit `snapshotRetentionBlocks` policy is 1–100000; older snapshots fail with a restart-pagination error. There is no silent move to a later snapshot. Owner filtering uses retained intervals as of the snapshot's end-of-block boundary, so later transfers cannot skip or duplicate a work between pages. Historical interval/log disk retention remains a separately reviewed archival/migration policy; this code does not delete audit evidence to shrink storage.

## Offline evidence

Run pure checks without a database:

```sh
npx vitest run src/openMint/projection/projection.test.ts
```

Run the real database suite:

```sh
OPEN_MINT_TEST_POSTGRES=1 npx vitest run src/openMint/projection/projection.test.ts
```

The shared test fixture starts a newly initialized PostgreSQL cluster in a temporary directory, uses a private Unix socket with TCP disabled, and stops/removes only that disposable cluster. It accepts neither an application database URL nor existing data directory. `OPEN_MINT_TEST_POSTGRES_BIN` can select installed PostgreSQL binaries. The tests use synthetic headers/events and no chain, wallet, provider or real assessment data.

Coverage includes strict inputs/cursors, exact replay and writer replacement, deployment binding, atomic checkpoint faults, competing mints, mint/Transfer matching, transferred and original ownership, same-block multiple transfers, stable owner snapshots, shallow rollback, deep/promoted contradiction halt, immutable log/mint guards, expired cursors, unavailable/unknown behavior, corrupt-item isolation, stale availability binding and writer loss. A saved-batch replay test explicitly proves it is not fresh-chain verification. `decode.test.ts` additionally uses real offline signatures from a published Foundry test key; malformed/changed logs, forged saved evidence, time-window boundaries, cancellation and late enrichment are rejected. No real wallet or network is involved.

## Remaining integration

- Independent authenticated RPC/header/receipt and complete event-range reads around the implemented strict decoder; signer/nonce/pause/role observations are not yet projected.
- Wire durable authorization/publication joins to the decoder's trusted enrichment callback, and E19 manifest/code/deployment admission.
- Approved network-specific finality and freshness policy, independent RPC checks, maximum lag, canonical head tracking, and reviewed halt recovery.
- Bounded indexing scheduler, backfill/adaptive range handling, retention/archive/restore tests and backup operations.
- Public read-service/cache integration and operating-scale query/EXPLAIN tests. The current foundation serializes reads on the exclusive writer for consistent testable transactions; it is not a production read-pool architecture.
- Public startup/admission/gallery wiring after the other E17–E23 gates. No returned projection value may independently authorize signing or treat absence as unminted.
