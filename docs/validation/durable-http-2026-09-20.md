# Durable private HTTP integration — September 20, 2026

E17/E19/E21 implementation increment on `codex/execution-table`. This is **offline integration evidence**, not a Sepolia deployment, active-app migration, real Grok assessment or completed public release candidate.

## What changed

- The approved staging destination is Ethereum Sepolia (`11155111`) at `https://staging.signatures.gallery`. No DNS/TLS/hosting account or deployment was created.
- The new local-only HTTP runtime composes PostgreSQL sessions, wallet proofs, private requests, fenced assessment work, immutable publication and persisted mint authorization. Strict request allowlists exclude browser-selected MBTI/model/prompt/recipient/deployment fields. Private reads do not allocate replacement sessions or start work.
- Restricted preparation-role grants and the catalog audit cover the exact request/publication/issuance tables. The real HTTP integration logs in as this nonsuperuser role; the database owner is used only for setup/fault injection.
- Repeated authorization acquires fresh chain evidence for the saved reservation nonce and returns its exact persisted signature. Restart with generation disabled does not call X, Grok, upload or signing again for the completed request.
- Current-head eligibility acquisition compares two independent configured RPC sources at a bounded common height, then runs the existing pinned hash/state checks. Abort/deadline/lag/disagreement fail closed. This is **eligibility**, not mint confirmation or finality.

Implementation contract and limits: [durable HTTP integration](../durable-http-integration.md), [chain adapter](../public-chain-adapter.md), [database-role audit](../database-role-audit.md).

## Executed checks

| Check | Observed result |
| --- | --- |
| Full suite, real loopback HTTP + disposable PostgreSQL enabled | 4,551 tests passed in 148 files; none failed |
| Coverage | 95.81% statements/lines, 92.06% branches, 98.39% functions; existing thresholds unchanged |
| TypeScript and build | Passed |
| Signature v1/v2 and slogan v2.0.1 locks | Passed; no renderer or golden changed |
| Offline Foundry contract suite | 75 passed |
| OpenSignatures manifest suite | 80 passed |
| Patch whitespace check | Passed |

Full-suite command: `OPEN_MINT_TEST_HTTP=1 OPEN_MINT_TEST_POSTGRES=1 npm run test:coverage`. Tests run fresh PostgreSQL on private Unix sockets and an ephemeral loopback HTTP listener. X, Grok, RPC, upload and independent retrieval are mocked; ECDSA uses published test literals. No wallet extension, paid provider, application database, live chain or public object store participates.

The first sandbox attempt could not initialize PostgreSQL shared memory; the same disposable suite passed with the required local process permissions. A later full parallel coverage run exposed two timing-sensitive tests: a successful ABI roundtrip had a 50 ms harness deadline, and a timeout-phase test could expire before reaching its intended provider phase. The ABI success test now has a 1 s harness allowance; the timeout-phase test controls both timer and monotonic time. Dedicated short-deadline assertions and production deadlines are unchanged. The final complete run passed.

## Remaining integration / decision gates

The running file-backed pilot and local chain are unchanged. Do not point its browser client at the new API: wallet transaction network/nonce context, simulation, submitted-transaction tracking, confirmed reveal and public galleries still need integration. Production/nonlocal startup remains refused.

The next chain-to-gallery integration needs an explicit finality policy. Proposed to the user: show inclusion as pending, then reveal/list only once two independent RPC sources agree on finalized confirmation. This checkpoint does not assume approval, select a confirmation count, or conflate current-head eligibility with finality.

Hosting/PostgreSQL/RPC/storage accounts and budgets, signer/admin custody, backup/restore operations, public abuse controls, actual device QA and the Sepolia deployment/rehearsal remain execution-table work. The prior X HTTP 402 pilot is not retried here. No external authority or spending approval follows from these local passes.

Hosted CI is checked after pushing; a local pass is not a hosted result.
