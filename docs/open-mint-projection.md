# OpenSignatures chain observation and projection — E19/E20

The PostgreSQL projection now composes with a bounded two-RPC observer, strict event/evidence decoder, atomic observation application, freshness-gated read coordinator, exact saved-artwork delivery and read-only HTTP routes. An explicitly started polling lifecycle and restricted preparation-plus-projection database role are tested. This composition is exercised locally against scripted RPCs and a disposable real database. It does not replace the running file-backed gallery or automatically start an indexer. E20 and public deployment are not complete.

The existing application and production-startup refusal are unchanged. Ethereum Sepolia and `https://staging.signatures.gallery` are the approved target, not a deployed environment. No RPC/storage account, signer, deployment, operating lag/freshness values or funding is chosen by this module.

## Authenticated observation and public-read boundary

`createProjectionObserver` snapshots an explicit deployment, chain identity and two distinct RPC identities. It checks chain ID, genesis and deployment pins, agreed canonical headers, runtime bytecode hash, EIP-712 domain and trusted authorizer at the observed head and every processed block. State calls use [EIP-1898](https://eips.ethereum.org/EIPS/eip-1898) hash selectors with `requireCanonical`; relevant logs use [EIP-234](https://eips.ethereum.org/EIPS/eip-234) exact-block filters, never a moving numeric range. The two sources must return the same normalized logs. Every relevant transaction must occupy its claimed block index and have a matching successful receipt containing exactly its relevant logs, from both sources.

This is **trusted RPC quorum verification, not a cryptographic Ethereum light client**. Matching node responses cannot detect two colluding operators or prove a wholly omitted transaction independently. Operators must choose genuinely independent sources and enforce DNS/egress policy; distinct configured IDs alone do not establish independence. Numeric canonical membership and finalized ancestry outside the contiguous acquired range rely on those nodes' execution/consensus view.

The explicit `finalized` block tag, not a confirmation count or elapsed-time heuristic, controls promotion ([Ethereum JSON-RPC](https://ethereum.org/en/developers/docs/apis/json-rpc/)). Both sources must attest at least the selected common finalized height and agree on its canonical hash. Missing tags, excessive lag, stale head/finality timestamps, clock reversal, parent/order conflicts, a changed header during acquisition, failed receipts and missing private evidence all fail closed. No older-height search is used to conceal source disagreement. A bounded ancestor search is used only to reconcile stored unfinalized history. A proven promoted-history contradiction or a fork outside the configured rollback horizon produces a halt witness; storage records `canonical-contradiction` and cannot automatically recover it.

One invocation processes at most 32 blocks, 128 relevant logs per block and 512 per batch. Each header has at most 4,096 transaction hashes and a relevant receipt at most 1,024 logs. The existing 1-MiB transport response cap, whole-observation deadline (at most 30 seconds), monotonic checks, parent cancellation and bounded private decoder apply. Rollback search is capped at the configured 1–128 blocks. No retries, transaction submission, provider call or daemon is hidden in the observer. The explicitly configured latest/finalized lag, age and witness TTL values are required; test values are not a Sepolia operating-policy approval.

The observer returns an opaque process-local witness, not serializable authority. `applyObservation` requires the exact immutable deployment, unchanged database cursor and a fresh witness under the **database clock**. Appending/reorg reconciliation and finality promotion commit atomically; expiry at the end rolls the entire operation back. Repeated immutable promotion references bind the promoted block, not a changing timestamp. The RPC sources/time/finalized-tip evidence remains process-local in this increment; durable observation-audit retention is still an operations task.

`PostgresAuthorizationIssuer.projectionEvidence` joins a historical signed reservation/signature to the exact accepted assessment and completed publication. It revalidates stored bindings, bytes and ECDSA without a fresh wallet session, unexpired request or enabled generation/issuance switch. It never reserves, signs, assesses, renews or publishes. The returned private object is consumed only by the strict decoder and must not be serialized through HTTP.

`createProjectionCoordinator` exposes one explicit `sync(signal)` plus read-only `gallery`/`lookup`. Sync is serialized, immediately withdraws prior freshness, and does not retry. Public reads cannot call sync. On restart there is no witness, even if PostgreSQL retained `health=available`. During partial backfill, stale verification, outages or concurrent sync, public reads return unknown; absence never grants mint eligibility. A caught-up, fresh inclusion can return **confirming** for detail lookup. Only finalized promotion admits galleries and owner snapshots. A provisional transfer does not alter the finalized owner's collection.

`projection/http.ts` exposes `GET /api/gallery` (exclusive `mbti` or `owner` filter, `limit` 1–50, `after` cursor), `GET /api/signatures/<canonical-handle>/status`, and optionally `GET /api/signatures/<canonical-handle>/artwork/<artifact-digest>/{svg,png,metadata}`. It allowlists public fields, uses no-store/noindex, rejects bodies/unknown or duplicate parameters, emits 503 on unknown confidence and never allocates a session. Artwork responses use nosniff and a sandboxed deny-by-default CSP. The local durable API server can compose these routes optionally, behind its unchanged loopback/Host/proxy restrictions. They are not active-home-page wiring.

`createVerifiedArtworkReads` loads only completed immutable publications for the current namespace/origin. It validates all saved SVG/PNG/metadata bytes and commitments against the verified mint, with the same fresh confidence before and after the bounded read. It returns the exact saved bytes, never a current-renderer substitute, provider call or remote-fetch fallback. Confirming can reveal; pending, unknown, stale, mismatched and quarantined records cannot. An explicit allowlisted detail model preserves verified spelling, original renderer and factual assessment provenance, but exposes no private request, signature, session or provider receipt. Local backup integrity and remote availability are separate; this read does not mark a remote URI as available. Withdrawn confidence prevents new responses, but cannot erase bytes already disclosed.

`createProjectionPoller` starts only with an explicit `start(signal)`. It runs one sync at a time, schedules from completion rather than accumulated missed ticks, backs off completed unavailable reads to an explicit maximum, and resets delay on success. A safety halt, unexpected exception, busy coordinator or hung pass stops the single-use poller; none automatically recovers. Parent cancellation/stop withdraws process-local freshness immediately and aborts active work. Late completion cannot restore that generation's read authority. This scheduler knows only chain sync and withdrawal—not assessment, publication, signer or broadcast capabilities. It is not started by imports, HTTP GETs or the active application. Operating cadence/deadline values remain explicit configuration, not production defaults.

## Storage and ownership

Apply `src/openMint/projection/projection-schema.sql` once with a migration role **after** the separate E17 `persistence/schema.sql`, followed by the explicit `projection-v2.sql` upgrade. For an existing v1 projection, back up the selected database and stop its writer before applying only the v2 upgrade. The upgrade preserves all saved rows and adds ownership-interval guards; it refuses any starting version other than exactly v1. Runtime requires v2 and never applies migrations or grants automatically. The adapter uses the same `ExclusiveWriter` session, epoch fence and bounded database transactions; it does not create another writer lock or reconnect/retry after a lost commit acknowledgment. No live database was upgraded by this development work.

`projectionRuntimeGrants` and `auditProjectionRole` define a separate combined preparation/projection capability profile for PostgreSQL 16. A directly authenticated nonowner login can append immutable evidence, update canonical/checkpoint fields and roll back unpromoted materialized mints/ownership. It cannot update/delete immutable logs, blocks, promotions, artifacts or signed evidence, change generation/issuance policy, run DDL/truncate, or delegate grants. Trigger guards preserve promoted mints and ownership intervals. As with the preparation audit, this is a specific privilege/layout audit, not proof of resistance to arbitrary malicious SQL through permitted state-update capabilities; startup/schema/configuration and application validation remain required.

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

**Raw store reads are maintenance primitives, not public confidence.** The checkpoint's `health: "available"` means a structurally valid saved batch was processed, not that the latest public chain was consulted. Replaying old bytes may restore that storage-observation state without advancing head or promotion. `checkpoint()` therefore always reports `freshChainVerified:false`. Runtime reads must go through the coordinator's opaque, applied, caught-up witness check; it validates TTL and exact head/promoted hashes at both ends of the database read. No projection lookup authorizes a mint.

Missing handles return `unknown`; raw store lookups of unpromoted mints return `pending` with no artwork. The freshness-gated coordinator may instead return `confirming` with verified mint commitments. Safety-halted deployments return no ordinary public entries. Confirmed mint and owner lookup use the same promoted block.

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

Coverage includes strict inputs/cursors, exact replay and writer replacement, deployment binding, atomic checkpoint faults, competing mints, mint/Transfer matching, transferred and original ownership, same-block multiple transfers, stable owner snapshots, shallow rollback, deep/promoted contradiction halt, immutable log/mint/ownership guards, expired cursors, unavailable/unknown behavior, corrupt-item isolation, stale availability binding and writer loss. A saved-batch replay test explicitly proves it is not fresh-chain verification. `decode.test.ts` additionally uses real offline signatures from a published Foundry test key; malformed/changed logs, forged saved evidence, time-window boundaries, cancellation and late enrichment are rejected. The issuance suite composes the actual durable signed publication through observation, Confirming, finalization, exact-byte reveal and writer restart without signing again. It caught a block cursor sorting text rather than numeric height across 9→10; the query now explicitly sorts the numeric database column and the regression checks the exact contiguous tail. Polling tests include cancellation, bounded backoff and late completion, plus real coordinator/database composition. No real wallet or public network is involved.

## Remaining integration

- Operator-selected independent RPCs and lag/freshness policy; actual Ethereum Sepolia capability/deployment evidence, and reviewed halt recovery. No live RPC was called in these tests.
- E19 manifest admission and E21 startup integration of the restricted role; signer/nonce/pause/role changes are not separately projected (identity changes fail closed).
- Activate the bounded indexing lifecycle only inside an admitted runtime; retention/archive/restore tests, operational audit retention and backup operations remain.
- Public HTML/browser/cache integration and operating-scale query/EXPLAIN tests. Verified immutable asset delivery is implemented but not active in the existing site. The current foundation serializes reads on the exclusive writer for consistent testable transactions; it is not a production read-pool architecture.
- Public startup/admission/gallery wiring after the other E17–E23 gates. No returned projection value may independently authorize signing or treat absence as unminted.
