# Durable authorization reservation foundation

This is a separate, offline-tested E17 increment. It is **not wired to the active service or HTTP routes**. `PostgresAuthorizationIssuer.open` refuses anything except the `local-real` / `grok` namespace on chain `31337`, even if an issuance profile is enabled. Public runtime and production refusal are unchanged. No public deployment, provider call or real custody signer was used to validate this work.

## Database and authority boundaries

Apply `persistence/authorization-schema.sql` only after the base, requests and publication schemas, using a reviewed migration owner. The module does not run migrations. Its four additive tables are:

- `issuance_profiles`: disabled by default; immutable deployment-scoped authorization lifetime, signer timeout and independent chain-evidence freshness limits. Only the enabled kill switch can change.
- `authorizations`: exact immutable canonical payload, typed-data digest, nonce, recipient, assessment/artifact commitments, authorizer/domain, request/session hash/current generation and deadline. Deployment+nonce and deployment+digest are unique.
- `authorization_heads`: one permanent handle/deployment reservation. This increment deliberately has no replacement/delete operation.
- `authorization_signatures`: insert-only exact canonical signature bytes. Identical bytes are idempotent; conflicting bytes fail closed.

Tables and new trigger functions explicitly revoke `PUBLIC` privileges. This migration does not grant a runtime role access. The foundation-only runtime grant template is not an issuance grant: a future least-privilege issuance migration needs its own review. Migration ownership, trigger disablement and direct administrative SQL are outside the runtime threat boundary.

All database operations use the existing pinned `ExclusiveWriter`: one session advisory-lock owner, monotonic writer epoch, durable commits, no transparent reconnect/retry. A failed or ambiguous COMMIT acknowledgement cannot return authority or start the next external step. A new owner must explicitly reopen the adapter after the old connection releases its lock.

## Reservation and signing sequence

The trusted backend supplies explicit mint consent, the original session token and request code, captured current generation, exact Origin/CSRF context and a server-created opaque `PublicChainGate` witness. None of the signed fields is selected from browser-supplied typed data. The signer is injected, its address must match the pinned authorizer, and its function/address are captured before asynchronous work.

1. Privately load the owned request and `journal.load(handle, true)`. The journal revalidates the accepted assessment and the exact saved artifact bytes/CIDs plus all six upload/retrieval observations. Make a private copy; no RPC, publication or provider call occurs here.
2. In the reservation transaction, lock the current session and handle. Validate live request ownership/expiry, nonrevoked session/expiry, current wallet and generation, Origin/CSRF, unexpired general or exact-code wallet proof, and absence of a replacement challenge. The request's original generation remains an admission audit value: a newer matching proof may authorize a first reservation.
3. In that same transaction, rebind the accepted assessment's exact validated payload and indexed identity to the request and saved artifact. Require byte-identical stored header/SVG/PNG/metadata, a completed publication, matching origin and all six observations from the pinned independent destination/source. This intentionally duplicates a small part of the journal's checks: the earlier asynchronous CID validation is tied to identical immutable database bytes, not trusted across a mutable object reference. Keep these checks aligned if the journal format changes.
4. Validate the opaque chain witness against namespace/deployment, handle, recipient, nonce and all request-profile chain/code/genesis/deployment/authorizer pins. The gate verifies the actual `SignaturesOpenMint` / `1` domain, canonical block, unminted handle and unused/unrevoked nonce. The issuer independently applies **both** the request-profile and issuance-profile evidence/block-age/future-skew bounds using PostgreSQL time, including immediately before transaction completion. It does not perform RPC or refresh stale evidence itself.
5. Commit the exact reservation and permanent handle head before any signer call. The deadline is bounded by immutable profile lifetime and live request/session/proof expiries; at creation more than 15 seconds of safe time must remain relative to both wall and observed block time. Existing heads can only reuse the identical payload and same request/session/generation/recipient/artifact. Different nonce or owner context cannot silently allocate new authority.
6. A second transaction rechecks current context, witness and deadline, then commits `reserved → signing` with the current writer epoch. Only the process that receives that commit acknowledgement may invoke the captured signer. The signer receives a deeply frozen copy of the persisted typed data and a bounded abort signal, outside the database transaction.
7. Locally verify the returned signature against the precise typed data and pinned authorizer, including canonical ECDSA restrictions. Persist identical signature bytes and `signing → signed` atomically. A timeout, exception or invalid signature preserves `unknown`; a storage failure can leave `signing`. Neither state is automatically retried, cleared or replaced. A late signer response after timeout is ignored.
8. Before release, recheck the live session/generation/proof, request, kill switch, reservation head, exact completed publication, witness freshness and deadline in another transaction. A session change during signing prevents release, but a received valid signature is still saved: potentially created authority must not disappear from accounting. Replaying a valid signed record re-verifies the stored signature and does not call the signer again.

The result of `reserve`/`issue` is an **internal backend value**, not a safe HTTP response. It includes private request/session hashes and assessment identifiers. A future route must produce an allowlisted transaction projection, retain existing generation guards and never log or expose the whole reservation. This module does not construct or submit a wallet transaction, collect transaction hints, or prove a mint succeeded.

## Conservative recovery behavior

`reserved` means no acknowledged signing fence was claimed; an explicit restart may claim that same exact payload. `signing` and `unknown` mean a signer may have received it and block all duplicate dispatch. `signed` may replay only the exact saved signature while every current prerequisite still passes. A lost signature-persistence acknowledgement can recover the saved signature after explicit restart without a second signer call.

Expiration is not release. No request timeout, authorization deadline, logout, fresh proof, new request or missing transaction result removes the handle head. A generation change after reservation may leave the old reservation deliberately blocked even if the same wallet reconnects. Rebinding/releasing it requires a later reviewed reconciliation operation; this foundation does not implement one. The coordinator must retain/reuse a reserved nonce when obtaining a fresh witness, rather than propose a new random nonce on every retry.

No recovery path reassesses a handle or mutates accepted assessment/artifact bytes. A chain outage is unavailable, never proof of unminted status. Witnesses are bounded observations, not a guarantee against a competing chain transaction after observation; the contract remains the final mint/nonce enforcement boundary.

## Offline evidence and remaining work

Run the focused test with a disposable Unix-socket-only PostgreSQL cluster:

```sh
OPEN_MINT_TEST_POSTGRES=1 npx vitest run src/openMint/persistence/authorizations.test.ts
```

The 45 tests include seven real cryptographic public-vector checks and 38 actual PostgreSQL cases: committed pre-sign fences; one complete real crypto + DB issue/replay using the repository's existing public scalar-1 test account; duplicate calls/restarts; current general/code proof; strict independent freshness limits; publication tamper rebinding; rejected/hung/invalid signers; post-sign logout/generation/kill-switch changes; head/signature write faults; lost reservation, signing-claim and signature COMMIT acknowledgements; ownership loss; exact-byte signature idempotence; permanent expired heads; public-mode refusal; and trigger-function permissions. Most fault-path DB tests stub signature validation to isolate state transitions. The public test key is not a real account secret and is never used with a network or deployment.

Still required before public issuance: approved deployment/storage policies, reviewed scoped DB grants, real custody-signer adapter and operational policy, current-witness orchestration with frozen nonce reuse, bounded route/transaction projection integration, chain-backed unknown-authority reconciliation and head replacement, submission tracking, full service/session/browser integration and recovery exercises. This increment does not complete E17 or enable public minting.
