# Durable preparation HTTP integration

September 20, 2026. E17/E18/E21 increment; **local integration only**, not public startup, deployment or completion of M2.

`persistence/runtimeService.ts` now composes durable sessions, private requests, the fenced assessment worker, immutable publication and reserve-before-signing. `persistence/http.ts` exposes those operations over an actual loopback-only Node HTTP server. Neither module replaces `src/main.ts` or the running file-backed pilot. No environment file, account, local chain or historical assessment is migrated.

The exact intended staging origin is **https://staging.signatures.gallery** on **Ethereum Sepolia, 11155111**. That approved destination is not a switch that enables this local integration server. The constructor still requires matching `local-real`/Grok/31337 components; the listener rejects production mode, non-loopback connections, wrong Host and proxy headers. A public runtime still requires the reviewed startup/operating boundaries below.

## HTTP contract

| Route | Behavior |
| --- | --- |
| `GET /api/session` | Only route that may allocate a session; returns allowlisted wallet/CSRF/timing context. |
| `POST /api/wallet/challenge`, `/api/wallet/verify` | Durable, one-use, generation-bound wallet proof; a request-scoped challenge first checks private ownership. No assessment or signing. |
| `POST /api/session/logout` | Durably revokes the session and clears the cookie. |
| `POST /api/assessments` | Accepts **only** a handle. Requires current general wallet proof, exact origin/CSRF and a backend-generated chain witness. Atomically admits/joins work, then starts one bounded preparation in the background. |
| `GET /api/assessments/<code>` | Owner-session status only. Never starts/retries work or exposes MBTI, assessment bytes, publication URI or signature. Inactive incomplete work is shown as interrupted/review-needed, not indefinitely running. |
| `POST /api/mints/authorize` | Accepts only a private code and `consent: true`. Fetches fresh eligibility for a server-selected nonce, reuses an existing reservation nonce, verifies publication, and returns exact OpenSignatures mint calldata after signature persistence. Never broadcasts a transaction. |
| Optional `GET /api/gallery`, `/api/signatures/<handle>/status` | When the verified projection coordinator is explicitly composed, exposes bounded finalized gallery queries and inclusion/finality confidence without sessions, RPC sync, assessments or signatures. See [chain observation/projection](open-mint-projection.md). |
| Optional `GET /api/signatures/<handle>/artwork/<artifact-digest>/{svg,png,metadata}` | Returns only exact saved and hash-verified completed-publication bytes after fresh canonical inclusion. No session, remote fetch, renderer or provider call; no-store/noindex and sandboxed CSP. |

These are integration endpoints, **not yet a complete browser-service replacement**: wallet chain-context/nonce/simulation, transaction-hint handling, rendered reveal pages and active galleries/assets remain unwired. Verified inclusion/finality status and exact asset reads can now be composed, but the current browser client still expects a validated network/nonce context which this isolated authorization response does not supply. Do not redirect the running UI to this listener.

Every response is no-store/noindex with no CORS allowlist, no-referrer, nosniff and a deny-by-default CSP. Unknown paths, queries, dev controls, absolute request URLs, unsupported methods, proxy headers, malformed/oversized JSON and compressed request bodies are rejected. Only 32 HTTP handlers and one preparation are active at once; HTTP parsing and eligibility have deadlines. These limits are local safety bounds, **not public durable abuse throttling**.

Private reads/POSTs require an existing live session; expiry/logout does not manufacture a replacement. Cookies are Secure for the fixed HTTPS session origin, HttpOnly, SameSite=Lax and host-only; ambiguous duplicate session cookies are refused. Neither browser fields nor forwarded headers select origin, deployment, recipient, MBTI, prompt, model, chain witness or authorization commitments.

## Failure and restart policy

Database records remain the source of truth. An HTTP disconnect is not proof of failed dispatch. Status GETs never retry an assessment, publication or signing call. There is no automatic queue pump on startup. Explicit requests may join existing work or recover the same accepted assessment/artifact, but cannot reclaim a marked/claimed interrupted provider job. Failed or uncertain signing preserves its reservation and cannot call the signer again. Repeated issuance of the original live request reuses its exact saved signature/nonce; generation changes and expired reservations still require the existing reconciliation policy.

Publication uses exactly the saved bytes and checks independent retrieval before authority. A failed publication does not change the accepted assessment. A new explicit request may recover publication without another assessment; this is subject to the eventual approved storage budget policy. Shutdown stops HTTP admission, drains bounded preparation, then closes the writer. Do not close the writer underneath work or infer a clean crash recovery from an orderly restart test.

## Restricted database role

`preparationRuntimeGrants` generates explicit SQL for the foundation plus request/publication/issuance extensions. It does not execute SQL, create an account or grant future tables. Immutable request/artifact/evidence records are select/insert-only. Authorization updates are limited to `state` and `signing_epoch`; generation/issuance enablement, budgets, profiles, expiry, nonces and commitments remain operator-owned. No delete, truncate, DDL, ownership or grant option is granted.

`auditPreparationRole` applies the existing bounded PostgreSQL 16 catalog audit to that exact extension layout/privilege set with a distinct report scope. Its historical `foundationLayout` check key now covers the supplied preparation profile too. Projection/rollback, future tables, hosting-specific role inheritance and compromised-client resistance are not certified by this profile. The grants/audit and complete HTTP pipeline are exercised under a direct nonsuperuser login in a disposable database, not only under the database owner.

The separately reviewed `projectionRuntimeGrants`/`auditProjectionRole` profile adds exact projection capabilities, including only materialized-row rollback deletes. Projection schema v2 is an explicit operator migration; it protects promoted ownership intervals in addition to the existing mint/evidence guards. The base preparation profile remains unchanged. See [projection storage/ownership](open-mint-projection.md#storage-and-ownership).

## Verification and remaining work

Run `OPEN_MINT_TEST_HTTP=1 OPEN_MINT_TEST_POSTGRES=1 npx vitest run src/openMint/persistence`. These tests use disposable private Unix-socket PostgreSQL and real loopback HTTP/ECDSA, with **mocked X, Grok, RPC, upload and retrieval**. No paid call, public upload, wallet extension or transaction broadcast is exercised.

Coverage includes saved-result/signature reuse through writer/server restart; private request isolation; logout/expiry; duplicate cookies; input and origin/CSRF spoofing; generation changes during eligibility; capacity/coalescing; uncertain provider/signer outcomes; corrupt retrieval blocking authority; late eligibility rejection; runtime-role privilege denial and excessive-grant detection. The projection composition adds inclusion/finality and exact saved reveal evidence. Full public startup, durable admission throttling, activation of chain polling, independent real adapters, catastrophic recovery, public page integration and actual Sepolia acceptance remain separate execution-table tasks.
