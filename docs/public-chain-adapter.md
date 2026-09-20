# Read-only public chain gate

`src/openMint/publicChain.ts` and `publicChainRpc.ts` are a separate E19 foundation. Nothing imports them into the active local server or selects a public network. They do not create a signer, hold a private key, simulate a mint, submit transactions, or turn on public deployment. Tests use mocked RPC responses and an existing literal Solidity/TypeScript signature vector, never a wallet or live endpoint.

## Explicit trust inputs

Construct `PublicChainGate` with a namespace ID, deployment ID, chain ID, genesis hash, deployment block number/hash, contract address, runtime code hash, authorizer address, explicit time bounds, and two separately configured `PublicChainRpc` sources. The caller supplies the exact observation block number/hash; there is no `latest` fallback or default chain. The gate snapshots its configuration and request identity.

Both sources must independently agree with every identity pin. Distinct source IDs are a configuration sanity check, not proof of independent infrastructure. Operators must select independent sources and trustworthy deployment pins; agreeing RPCs are not a cryptographic proof of chain truth. Deployment manifests and administrative role-history verification remain separate requirements.

All account-code and contract reads use EIP-1898 `{ blockHash, requireCanonical: true }`. A source that does not support canonical hash selectors fails closed; the adapter never retries with a number, `latest`, another RPC, or a weaker selector. Explicit numeric headers reconcile the genesis, deployment, and observation block hashes. The observation header and chain ID are reread before accepting evidence. Both sources' timestamps must agree.

At that one block the gate requires:

- Nonempty contract runtime matching the expected Keccak-256 hash.
- Exact EIP-5267 domain: fields `0x0f`, `SignaturesOpenMint`, version `1`, expected chain and contract, zero salt, no extensions.
- The expected `trustedAuthorizer` and recipient code exactly `0x`. Missing code is not an EOA; deployed contracts and delegated-code accounts are rejected.
- `paused`, `mintedHandle(handleKey)`, `usedNonces(nonce)`, and `revokedNonces(nonce)` all decode to `false`.
- A fresh block, bounded future clock skew, and no backwards local clock movement during the observation.

`verifyAuthorization` additionally verifies an already supplied canonical signature, binds canonical handle, exact token URI hash, assessment digest and artifact digest, checks the contract's `authorizationDigest` against the local EIP-712 digest, and requires the authorization active at both block time and wall-clock time. It does not establish backend acceptance of those assessment/artifact commitments. Those independent durable checks remain mandatory.

## Admission handoff

`currentChainEligibility.ts` now supplies a backend-owned acquisition step when a caller does not already have an exact block pin. It reads `latest` headers once from both configured sources, rejects malformed/disagreeing heads or head-height skew beyond an **explicit** `maxHeadLag` policy (bounded to 0–64 blocks), then chooses the lower reported height. It never searches backwards or substitutes another RPC. Both sources must subsequently verify that exact block/hash and all state/identity/freshness pins through the unchanged gate. There are at most two additional reads; an outer monotonic deadline/cancellation signal covers both head selection and the full inner gate, including late/hung callbacks. Configuration and callback bindings are captured before asynchronous work.

This is **current mint eligibility, not a finality policy**. It cannot promote a mint or gallery record. The maximum permitted head lag, real RPC source independence and Sepolia promotion/finality policy still require their explicit operating configuration. The active local server is not switched to public RPC by adding this helper.

`preflight({ block, handle, recipient, nonce })` returns an opaque in-process `PublicChainEligibility`. It is registered in a private WeakMap; JSON, clones, or caller-supplied booleans cannot recreate it. `readPublicChainEligibility(witness, { namespaceId, deploymentId, handle, recipient, nonce?, now })` validates the exact binding and freshness and returns a frozen evidence snapshot. Time fields `observedAt` and `validUntil` are epoch milliseconds; block timestamps are epoch seconds as `bigint`.

The trusted admission layer must provide its own current database clock, validate before committing admission (including after transaction delays), and compare every deployment identity pin against its durable deployment profile. A request cannot supply the accessor's expected identity or clock. Expiry is the earliest of the configured witness TTL, maximum block age, and, for signed authorization checks, signature expiry. Witnesses cannot survive process restart and persisted evidence is audit data, not a reusable capability.

This witness is only a fresh unminted/eligible-at-block observation. It is not a paid-work reservation, session proof, artifact acceptance, authorization to sign, replay-proof single-use admission capability, or guarantee that a later transaction succeeds. Another transaction, signer rotation, pause, revocation, reorg, or recipient-code change can invalidate the observed state immediately. Durable admission, signer-time rechecks, canonical transaction/finality tracking and reorg recovery must still be implemented and integrated independently.

## Bounded transport

`createPublicChainHttpRpc` wraps the installed viem HTTP transport and exposes only four read methods: `eth_chainId`, `eth_getBlockByNumber`, `eth_getCode`, and `eth_call`. Its explicit HTTPS URL, request timeout and response-byte limit are required. Batch requests, retries and redirects are disabled. Strict bounded JSON-RPC envelope validation correlates the exact request ID and version and requires exactly one result or well-formed error. A separate deadline bounds the complete RPC including response-body reads; the gate also caps its entire two-source observation and aborts outstanding work. Child fetches are aborted even on early response rejection. Each preflight performs 28 requests at most, or 30 when checking a supplied signature's on-chain digest. There are no unbounded loops or log scans.

Both the gate and HTTP transport combine timers with monotonic elapsed-time checks. Expiry is rechecked before dispatch, after headers, during streamed body reads, after decoding and before returning evidence, including when immediately resolved promises delay timer callbacks. Concurrent RPC reads have separate deadline contexts. Late response bodies are cancelled and cannot become a valid witness.

The fetch function is deliberately required and injected. The URL guard rejects credentials, fragments, literal IPs, localhost and common internal-only suffixes, but does **not** resolve DNS or enforce network egress by itself. Before public integration, the supplied fetch must enforce an approved DNS/IP/egress policy against rebinding/private targets, cancellation, TLS and connection limits. Never pass a URL controlled by an end user. Public operating decisions, endpoint availability, source independence, RPC canonical-hash support, real deployment identity/role evidence, chain finality, public-host startup and all actual network validation remain pending. No production approval is implied by these modules or their mocked tests.

## Evidence

Run `npx vitest run src/openMint/publicChain.test.ts` and `npm run typecheck`. Tests exercise the gate and actual installed viem HTTP/ABI path with injected mock fetches, without opening a socket. They cover identity/domain mismatch, malformed/missing data, both-source agreement, nonce/pause/handle blocking, EOA/delegated-code scope, reorgs, freshness/clock bounds, forged/rebound/expired witnesses, immutable snapshots, literal signature verification, canonical selectors, unsupported RPC behavior, timeout/cancellation, response size limits and no retries/writes.
