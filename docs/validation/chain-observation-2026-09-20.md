# Chain observation/read integration — September 20, 2026

Scope: E19/E20 offline implementation. The existing local application/Anvil, environment files, funded provider accounts, public infrastructure and deployment were not changed.

Implemented composition:

1. Two explicit RPC identities validate pinned chain/deployment/code/domain/signer, bounded canonical headers, matching hash-filtered event logs, successful receipts and transaction positions.
2. The strict decoder resolves historical signed authorization and exact completed-publication evidence; no renewed session, signer call or paid assessment is needed.
3. A nonserializable, time-limited observation is applied to the fenced PostgreSQL projection. Cursor comparison, append/reorg handling and finalized promotion share one transaction and database-clock expiry checks.
4. The coordinator exposes Confirming after fresh inclusion and galleries only after finalized promotion. Restart, partial backfill, outage, stale observation or concurrent resync cannot reuse stored health as current chain authority.
5. Optional public GET status/gallery routes integrate with the isolated durable API listener. They allocate no session, trigger no RPC sync, publish no private assessment/signature/receipt fields, and stay no-store/noindex.

Verification at this checkpoint:

- Full HTTP + disposable PostgreSQL coverage: **4,711 tests, 152 files**, **95.90% statements/lines, 92.19% branches, 98.43% functions**; thresholds unchanged.
- Two additional targeted PostgreSQL fault tests then exercised rollback on promotion-write failure and witness expiry during the transaction.
- Typecheck and build/three renderer locks passed.
- **75 contract tests** and **80 OpenSignatures manifest tests** passed.
- Actual isolated HTTP + PostgreSQL exercised unavailable → Confirming → finalized gallery admission; GETs added zero RPC calls.
- Real cryptography used published test keys. RPC, X, Grok, uploads and retrieval were scripted/offline; no external provider or blockchain transaction was sent.

This is trusted two-RPC quorum verification, not a cryptographic light client or live Sepolia acceptance. It cannot prove independence of two configured operators or detect their coordinated omission. Runtime role/startup integration, a bounded indexing scheduler, durable RPC observation audit retention, real immutable storage delivery, public page wiring and live-wallet/testnet acceptance remain open. The active file-backed UI has not been redirected to the durable API listener. Hosted CI is recorded separately after an authorized push.
