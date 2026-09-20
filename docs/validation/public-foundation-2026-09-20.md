# Public foundation checkpoint — September 20, 2026

This is local implementation and review evidence for E17–E22, not a deployed public service or completion of those milestones. The user selected Ethereum Sepolia for staging; no deployment, provisioning, new paid dispatch or production enablement occurred.

## Verified locally

- `OPEN_MINT_TEST_HTTP=1 OPEN_MINT_TEST_POSTGRES=1 npm run test:coverage -- --reporter=dot` passed across **146 files**. Coverage: **95.74% statements/lines, 92.08% branches, 98.35% functions**. Existing 93/87/97 thresholds were not lowered. PostgreSQL suites ran against disposable private Unix-socket PostgreSQL 16.15 clusters, not a live database. All provider and public RPC transports were mocked.
- `npm run typecheck`, `npm run build` and `git diff --check` passed. Build verified all renderer locks, including the intentionally separate signature v2.0.0 and slogan v2.0.1.
- `npm run test:contract`: **75 passed**, including OpenSignatures replay/domain/role/expiry checks and offline fuzzing. No public transaction was sent.
- `npm run test:open:manifest`: **80 passed**; legacy manifest validation and its **nine** role tests also passed. Public broadcast and runtime admission remain disabled by the new tooling.
- Separate [fixture Anvil rehearsals](local-anvil-2026-09-20.md) passed. Those simulated assessments are not real Grok evidence. The real `@karpathy` pilot remains [blocked after X HTTP 402](e10-pilot-2026-09-20.md).

## New boundaries exercised

1. Exclusive database writer, durable wallet sessions and one-use proofs; atomic private request/admission; immutable handle/result/receipt/spend records.
2. Explicit assessment execution with fresh per-leg chain/session/policy checks, committed dispatch markers, typed terminal outcomes and no automatic retry. Whole-run deadlines prevent late callbacks and queued writes.
3. Versioned immutable artifact bytes/CIDs, privacy-minimized public metadata, independent exact-byte retrieval and durable publication journal. Forged SVGs are checked against the locked renderer. Backup/restore tests preserve exact bytes.
4. Reserve-before-signing, immutable authorization heads, actual ECDSA verification, lost-commit and generation-change guards. Timer starvation cannot admit an overdue signer result.
5. Two-source pinned chain eligibility; bounded RPC/body handling; opaque process-local witnesses; monotonic deadlines. These are mocked observations, not live Sepolia attestations.
6. Persistent mint/transfer projection, stable snapshot cursors, bounded rollback and deep-contradiction halt. Strict event decoding binds saved assessment, publication and signed authorization. RPC log completeness/canonicality/finality acquisition is still required.
7. Restricted foundation grant generation and read-only PostgreSQL capability audit, with actual role-login integration tests. Extension grants and integrated startup still need review.
8. Environment-aware sharing policy and local noindex. No public card endpoint, sitemap or public indexing was activated.

The composed `pipeline.postgres.test.ts` uses actual database APIs, wallet-message verification and a public test-key signature. It proves a bad retrieval blocks issuance and an orderly writer restart reuses exact saved assessment/artifact/signature bytes with no extra assessment or signing. Provider, chain and object-storage transports remain mocked. It does not certify live-provider behavior, remote storage durability or catastrophic recovery.

Independent internal review covered the publication bindings, issuer, decoder deadlines, worker cancellation, role audit and composed test. Findings were fixed and retested. This is not the independent release security review required by E24.

## Remaining integration

The active app remains the local file-backed service. The new PostgreSQL worker/issuer are deliberately not a public startup path. Remaining work includes explicit staging configuration/startup, async HTTP/session integration, durable rate limits and trusted proxies, render/publication job execution, approved egress/upload/signer adapters, canonical chain/finality acquisition and gallery integration, full extension-role validation, versioned upgrade/restore/reconciliation tools, public-origin sharing, real wallet/device QA and operational ownership.

Public origin, hosting/storage/RPC accounts and budgets, custody/role owners, retention/support and the deployment package still need decisions before their external actions. Sepolia selection alone does not supply them. The About “First” claim scope and readable mobile-guidance wrapping remain separate product decisions. See [the execution table](../development-plan.md) for milestone status.

Hosted CI must be observed for the pushed implementation revision separately from this local report.
