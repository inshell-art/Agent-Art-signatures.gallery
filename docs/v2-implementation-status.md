# V2 implementation status

Authentication and mint UX checkpoint, 2026-09-11: an active app session established with X is sufficient for owned-claim mint setup; there is no routine extra X OAuth round trip per recipient or mint. Exact session-bound wallet proof, explicit recipient/work review, CSRF, replay/race defenses, and pending-authorization locks remain mandatory. Withdrawal and legacy generic wallet-management actions retain their separate X confirmation requirements. See [authentication policy](authentication-policy.md) for unchanged lifetimes and the accepted session-theft trade-off, and [current handoff](../HANDOFF.md) for verification and runtime safety.

Formal algorithm update, 2026-09-10: artwork now uses the approved **Signature Algorithm v1.0.0**, pinned to upstream commit `1e1dab4ec093261006feb7879c109413c0b3ac6d`. Inputs are exact-case handles and integer seeds `1–100` (default `22`), not decimal ratios. `sg-renderer-1.0.0` and `sg-card-1.0.0` produce the formal artwork; prior decimal-seed claims and permalinks are retired, not silently re-rendered. Account authorization still compares handles case-insensitively. This resolves the obsolete-algorithm blocker, not the external infrastructure and deployment gates below. See [formal algorithm adoption](formal-algorithm-v1.md).

Claim-flow update, 2026-09-09: the explicit **Claim with X** CTA binds consent to the exact preview. Matching OAuth authentication persists the claim before redirecting directly to its permanent signature page, with a success notice. Ordinary account sign-in does not claim; failed persistence offers an explicit CSRF-protected retry. Legacy cached forms retain their final confirmation because they do not carry the new consent. Minting remains a separate wallet action.

Earlier status snapshot: 2026-09-06.

Historical homepage update, 2026-09-06: the public home introduced **Claimed | Minted** views. At that point claim creation required a separate post-OAuth confirmation; the explicit-consent flow described above supersedes that interaction. Claimed remains the default and reads all committed V1 claims across accounts from the memory/PostgreSQL repository. Minted reads only existing finalized mint projections. A minted work remains claimed. Both views exclude suppressed records and paginate independently; local-rehearsal notes are distinguished in the DEV overlay. Claimed pages and unminted permalinks remain `noindex`; the finalized-only publication/indexing rules below refer to Minted, not to claim creation or visibility.

This repository has a real interactive repo-local PostgreSQL 16 + Anvil 31337 rehearsal and substantial executable safety logic. It is **not production-ready**, has not completed a Sepolia rehearsal, and has not deployed the collection to any public network. The production entrypoint remains intentionally refused in `src/main.ts`. A separate local entrypoint supports new browser claims, real SIWE proof, signed mint transactions, continuous local indexing, and transfers, using PostgreSQL-backed claims, file artifacts, and atomic mint/indexer snapshots.

## Transaction record

Transactions were sent **only to the disposable repo-owned Anvil chain ID 31337 on `127.0.0.1`**. Initial setup deploys the contract and submits one signed self-mint using public Anvil test keys; the interactive local server also submits user-confirmed local mints and transfers. No transaction was sent to Sepolia, Ethereum mainnet, or any other public network. The checked-in Anvil manifest remains example-only; the actual ephemeral run record is ignored under `.local/rehearsal/runtime.json`.

The default `npm run dev` fixture authorization response is still marked `fixture: true`; its browser flow stops before `eth_sendTransaction`. The durable local workflow is separate: `npm run local:serve` enables the interactive mint path only against the owned Anvil node, with real local signatures/transactions and a continuous, restartable snapshot-backed reconciler. Neither mode enables a public-network mint.

## What runs locally now

Two explicitly different local modes exist:

- `npm run dev` is the original dependency-free, fully in-memory simulation. Restarting discards its state.
- `npm run local:up` initializes or reuses repo-local PostgreSQL and Anvil state; `npm run local:serve` exposes durable claims/artifacts and real-Anvil mints/transfers, defaulting to the X simulator. `npm run local:serve:x` explicitly selects real X OAuth with the same local database and chain; `npm run local:serve:emulator` explicitly selects the simulator without reading real X credentials. Restarting PostgreSQL, Anvil, or the app preserves rehearsal state without replaying fixtures over newer account metadata. App sessions/OAuth flows remain ephemeral, so the user signs in again after an app restart; real wallet bindings and chain evidence persist. `local:reset` is the separate explicit destructive reset.

The interactive app checks repository process ownership, chain/deployment identity, runtime code hash, and the seeded mint receipt. Its reconciler verifies exact receipts, calldata, EIP-712 evidence, metadata/artifact commitments, tokenURI, and holder projections; a missing advisory transaction report cannot conceal an actual mint. The built-in TEST wallet uses public Anvil account index 6, requires an explicitly approved one-time SIWE proof and mint confirmation, and can transfer only to the fixed second TEST wallet at index 7. The historical CLI seed's fixture binding is revoked at startup and is not authority for new mints. A dedicated injected browser EOA can instead sign its own proof and transaction.

Two-second Anvil interval mining and roughly one-second polling provide automatic local confirmation. The label is **Local Anvil automatic confirmation; single node**, never independent-provider agreement or Ethereum finality. A single exclusive PostgreSQL writer serializes HTTP mutations and indexing; intent is checkpointed before signing, the attestation before return, and cursor/projection snapshots atomically before publication. RPC/validation failures pause mint writes; chain rollback or confirmed-history changes halt reconciliation and revoke local confirmations. Expiry requires complete local-chain coverage plus a pinned unused check. `local:up`, `local:reset`, and `local:stop` refuse lifecycle changes while the app owns the writer.

The executable local surface includes:

- V1 preview, render assets, fixture/X-auth flow boundary, explicit claim creation, account collection, permalink, and immutable artifact responses;
- a presentation-only homepage composition that captures exact case-preserving words or an underscore-joined phrase through the formal renderer boundary at fixed integer `gr0k 22`, using the release's expanded-canvas policy for long text, then lays stored drawings out without renderer calls or non-uniform stretching; it creates no X-handle artifact, claim, or mint provenance (see `docs/slogan-composition.md`);
- a fixture account with three V2 states: unminted, included but unfinalized, and finalized;
- V2 wallet challenge/confirmation endpoints, binding revocation, active-session mint recipient selection, action-specific X confirmation for legacy generic wallet management and claim withdrawal, mint review and consent, authorization creation, advisory transaction reporting, mint status, finalized-position Gallery keyset reads, claimant transaction/current-holder detail, fixture-only lifecycle advancement in `npm run dev`, and actual Anvil mint/transfer controls in `local:serve`;
- exact SIWE and EIP-712 construction/verification, V1 digest-to-token-ID conversion, canonical signature checks, deterministic metadata bytes, SHA-256 commitments, and deterministic UnixFS CID calculation;
- system-following light/dark theme behavior and the complete fixture UI.

The `npm run dev` paths exercise request boundaries and state transitions, not infrastructure: its default wallet may be seeded without a real SIWE proof, its EOA check is simulated, computed CIDs are not pinned, finalized blocks are simulated, and no transaction is submitted. In the separate durable workflow, wallet proofs and Anvil mint/transfer transactions are real local cryptographic evidence. X is simulated by default or authenticated through real X in explicit real-X mode; existing seeded identities never become verified X records through a mode change. The renderer is the approved formal v1.0.0 algorithm in both modes. Local collection metadata, the authorizer key, and chain evidence remain rehearsal-only; computed IPFS CIDs are neither published nor pinned externally. Automatic single-node confirmation is not Ethereum finality.

## Safeguards implemented as pure or in-memory reference models

These components are executable and tested. Some have durable local adapters; the remaining production boundaries are explicit:

| Area | What exists | Current boundary |
| --- | --- | --- |
| V1/V2 identity bridge | Exact Base32 digest decoding, payload recomputation, decimal token ID, and golden vectors | Used for seeded and interactive local Anvil mints; no public-network deployment exists |
| SIWE and EOA policy | Exact message grammar, one-time/session-bound challenge rules, canonical EIP-191 signatures, and a dual-RPC EOA verifier; the interactive local entrypoint uses a real proof and pinned local code check | Production dual-RPC behavior is unit-tested with fake clients; only the single-node local verifier is wired into a running entrypoint |
| Metadata and IPFS identity | RFC 8785 JSON, exact hashes, CIDv1/UnixFS profile, immutable V1 byte checks, and golden fixtures | Computes locally only; there is no external pin/retrieval adapter or retained provider evidence |
| Authorization | Exact EIP-712 schema/digest, 900-second issuance window, low-`s` 65-byte signature verification, idempotency and ambiguous-signing states; local intent/attestation checkpoints and evidence-gated expiry | Local runtime persists reference-model snapshots and uses a public test signer; no normalized production repository, KMS/HSM adapter, or production signer-audit worker exists |
| Content writer/GC | Shared object references, write reservations, leases, fencing tokens, exact-byte verification, erasure control version, grace period, stale-worker rejection, shared-hash retention, race/crash tests, and a local content-addressed file adapter with PostgreSQL reference ledger | The local file adapter is not an external object store and has no production garbage-collection worker |
| Chain indexing | Strict frozen-ABI decoder and pure reducer for contiguous scans, receipt/log checks, control-state replay, reorgs, promotion, quarantine, transfer ownership, and safety halt; a continuous local Anvil reconciler verifies pinned historical tokenURI/receipt evidence and atomically stores cursor/projection snapshots | The running poller is single-node/local-only, not a normalized production repository or production archive-state/independent-provider finality daemon |
| Gallery publication/erasure | Pure two-phase staging/activation fence, suppression, purge requests, stale publisher rejection, erasure reconciliation, and cutover predicates; the local HTTP fixture also applies one in-memory suppression gate to authorization, Gallery, status, permalink, collection, and artifact reads | The durable two-phase publisher is not connected to HTTP/CDN/sitemap/robots/pin providers, and there is no durable legal/compliance workflow |
| Startup operations | Strict parsing of the V2 commitment configuration, exact Ethereum/Sepolia identity checks, fail-closed health decision, redacted config summary, and fixed metric/alert names | The layer is tested but not yet connected to `src/main.ts`, RPCs, signer, pin services, monitoring, or deployment state |
| PostgreSQL schema | Additive migration `src/store/migrations/002_v2_minting.sql` with serialized binding heads, one-live-authorization indexes, evidence-gated terminal transitions/erasure, append-only finalized observations, references, leases, controls, and fences; a fresh-cluster PG16 integration test applies the V1 schema, V2 migration, and local schema; local reuse is guarded by the recorded migration checksum | It has been exercised only on disposable local PostgreSQL 16.15, not a staging/production database; V2 mint/indexer runtime persistence is a JSONB snapshot of the reference model rather than normalized production repositories |

Unit tests establish model and adapter behavior; the repeatable local transaction test and read-only restart check additionally exercise the actual PostgreSQL/Anvil path. Local serialized checkpoints and exclusive writer ownership are not evidence of production/distributed crash recovery, provider independence, retained IPFS availability, public-network canonical agreement, or a staging restore drill.

## Contract and guarded deployment tooling

The repository contains a real non-upgradeable Solidity ERC-721 implementation and offline Foundry tests for mint commitments, replay resistance, epoch management, revocation, pause behavior, role separation, transfer semantics, constructor commitments, and the shared backend/contract golden authorization.

The deployment surface is intentionally constrained:

- `contracts/script/DeployGalleryOfSignatures.s.sol` supports Anvil and Sepolia rehearsal inputs and unconditionally rejects chain ID `1`;
- it reads no raw private key and relies on an externally configured signer;
- omitting `--broadcast` performs a simulation only;
- `contracts/deployments/deployment-manifest.schema.json` and its validator require chain, bytecode, constructor, role, metadata, source, and finality evidence;
- `contracts/deployments/example.anvil.json` validates only with `--allow-example` and must never be treated as a real deployment manifest;
- no external contract/security audit has been completed.

The repository does not contain a Sepolia contract address, deployment transaction, finalized deployment block, verified source record, or rehearsal-verified manifest.

## External gates still closed

Sepolia issuance remains blocked until all of the following are real and independently evidenced:

- a deployment-specific, independently reproduced record of the approved formal renderer/card-renderer versions and exact artifact commitments; the renderer algorithm itself is already pinned and parity-tested, not awaiting approval;
- a backed-up durable V1 database, successful additive migration, control/reference backfill, and tested restore/rebuild procedure;
- durable implementations for signatures, sessions, flow state, rate limits, mint state, content leases/references, indexer checkpoints, publication leases, and erasure records;
- two genuinely independent archive-capable RPC providers, live historical-state checks, continuous indexer operation, finalized checkpoint agreement, and restart/reorg rehearsals;
- two independent IPFS pin providers plus independent byte-for-byte retrieval verification;
- a dedicated non-exportable staging signer, signer request idempotency, local recovery verification, audit reconciliation, and alerting;
- approved distinct deployer/admin Safe/authorizer manager/pauser/revoker/online-authorizer assignments;
- approved canonical collection metadata bytes and commitments;
- active claimant session → explicit recipient selection → exact SIWE proof → reviewed authorization → Sepolia mint → finality → Gallery → transfer end-to-end rehearsal, including expired sessions/flows, replayed or wrong-target proofs, superseded recipients, and the existing mint/indexer failure cases;
- source verification, independently reproduced initcode/runtime hashes, a real manifest, monitoring, incident/runbook work, and security review;
- separate explicit approval to broadcast the Sepolia deployment and mint transactions.

Ethereum mainnet remains a later, separate decision. It additionally requires explicit mainnet authorization and a reviewed change to tooling that currently rejects chain ID `1`. A Sepolia success would not itself authorize mainnet deployment.

## Exact inspection and verification commands

Install from the lockfile, then run each command from the repository root:

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run test:v2
npm run test:contract
npm run test:manifest
npm run test:manifest:roles
npm run test:postgres:local
```

The baseline commands after dependency installation passed in this working tree on 2026-09-05; rerun them for the current working tree. HTTP tests bind a loopback port; a restricted sandbox must allow loopback listening. The manifest command proves only that the illustrative file satisfies the example rules.

For browser inspection:

```bash
npm run dev
```

Then open <http://localhost:3000>. The page must show the development-rehearsal environment indicator and disclosure. Use **My collection** → **Use local OAuth emulator** → **@alice** → **Approve local identity** to exercise the redirect, one-time state, PKCE exchange, identity lookup, callback, and session rotation before inspecting the fixture states. This provider is local and proves no X account control.

For the real local infrastructure rehearsal, install PostgreSQL 16 and Foundry in the documented default locations, then run:

```bash
npm run local:up
npm run local:verify
npm run local:serve
```

Open <http://127.0.0.1:3000/s/alice/73> → **Claim with X** → approve **@alice** in the simulator → the permanent claimed signature page → **Mint this signature** → **Connect wallet** (or open DEV on that exact mint page and use **Use local TEST wallet**) → approve the exact SIWE proof → review the work/recipient and acknowledge publication → confirm the transaction → **Transfer local token** after automatic indexing. The claim needs no second confirmation after OAuth, and an active claimant session does not repeat X sign-in for mint setup. Keep the canonical `http://127.0.0.1:3000` origin across restarts; unfinished frozen metadata is not silently regenerated if the port changes. Native-form origin handling uses `Referrer-Policy: same-origin` while retaining strict Origin and CSRF checks.

For real X authentication instead, configure the separate X developer app and git-ignored `.env.local`, run `npm run local:auth:check`, then start `npm run local:serve:x`. Use your own exact-case handle and an integer seed from 1 through 100 in the preview URL. The simulator's Alice account is not available in real-X mode. See [Real X + local app](real-x-local.md).

With the foreground app running, explicitly execute the repeatable Bob claim/mint/transfer test, then retain its printed signature ID for read-only verification after restart:

```bash
npm run local:test -- --execute-local-test-transactions
npm run local:test -- --verify SIGNATURE_ID
```

Stop the foreground app with Ctrl-C before `npm run local:stop`. Lifecycle commands refuse an active app writer. `local:up` restarts infrastructure without redeploying; `local:reset` is the explicit destructive reset for `.local/rehearsal` only. See `docs/local-rehearsal.md` for exact ports, overrides, verification, and limitations.

On the simulator's local-provider screen, **@bob** exercises account switching (its collection is empty only before creating Bob claims or running `local:test`), **Simulate account denial** exercises a terminal denial callback, and **Simulate provider error** exercises the unavailable-provider callback. Choosing Bob while rehearsing `/s/alice/37` must stop at `HANDLE_MISMATCH`. Log out and restart the login flow to select another account. These simulator controls are disabled in `local:serve:x`; live X consent is used there instead.

Do not use any fixture identity, address, key, CID, block, transaction, or finality label as production provenance.

For deployment-tooling details and stop conditions, read `contracts/REHEARSAL.md` and `contracts/deployments/README.md`. Do not add `--broadcast` without a separate, explicit network transaction approval.
