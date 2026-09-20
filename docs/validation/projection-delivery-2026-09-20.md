# Verified artwork delivery, restricted projection and polling

September 20, 2026. E18–E21 local integration increment following `4b7d9dd`.

## What passed

- Full offline HTTP/PostgreSQL coverage: **4,801 tests / 156 files** after terminal-lifecycle hardening (4,799 at `684f3de`). Coverage **95.93% statements/lines, 92.28% branches, 98.38% functions**; thresholds unchanged.
- TypeScript typecheck, build and all renderer/slogan source/golden locks passed.
- Earlier in this same implementation batch: **75 contract tests** and **80 OpenSignatures manifest-tooling tests** passed. No contract/tooling source changed in this increment.
- Whitespace checks passed. Hosted CI is recorded separately after the branch push; local green is not hosted evidence.

The database tests use newly initialized PostgreSQL 16 clusters with private Unix sockets and TCP disabled. HTTP tests bind disposable loopback listeners. Provider, upload and chain responses are scripted; signing uses established public test vectors. No new X/Grok charge, actual wallet signature, public upload or live chain transaction occurred. The running app, Anvil, `.env.local` and saved pilot history were not changed.

## Acceptance evidence

1. **Real durable composition:** saved accepted assessment/publication → exact reserved ECDSA signature → independent scripted RPC observation → PostgreSQL inclusion → Confirming → finalized gallery/reveal → writer restart. The exact saved PNG is returned and the signer is called once. Restart cannot inherit stale read confidence. This caught and fixed numeric block cursor ordering across a decimal digit boundary; a 7–12 tail is explicitly asserted.
2. **Exact public artifact reads:** a bounded reader verifies completed saved SVG/PNG/metadata bytes, namespace/origin, handle/MBTI and every committed digest against current inclusion/finality at both ends. Wrong digest, stale/reorged confidence, corruption, missing publication and timeouts fail closed. No rerender substitute or provider call is used. Public model fields are allowlisted; private request/session/attempt/signing/provider receipt data is absent.
3. **HTTP integration:** optional digest-qualified SVG/PNG/metadata routes deliver exact bytes with no-store/noindex, nosniff and sandboxed CSP, without allocating a session. Existing status/gallery handlers stay read-only. Query/body/method failures and withdrawn confidence do not expose assets. These routes are not activated in the existing file-backed site.
4. **Restricted role:** direct nonsuperuser preparation-plus-projection login can observe, reconcile shallow forks and finalize. Tests deny immutable evidence deletion, altered commitments/policy, truncate, DDL, trigger bypass and grant escalation, and audit missing/excessive privileges. The grant template performs no provisioning. It is a capability audit, not certification against arbitrary malicious allowed SQL.
5. **Explicit migration:** new runtime refuses projection v1. Operator-applied `projection-v2.sql` preserves rows, adds ownership-interval guards and refuses repeat/unknown-version application. Promoted ownership/mint rollback is refused. Tests apply it only to disposable databases; no application startup migration or live upgrade occurs.
6. **Bounded scheduler:** explicit start only; one chain sync at a time; completion-based cadence; bounded exponential backoff; no catch-up burst; stop on safety halt, unexpected busy state, exception or hung pass. Stop/parent cancellation withdraws freshness immediately and prevents late results from restoring it. Fake-clock fault tests and actual coordinator/database polling both pass. It has no provider, publication, signer or broadcast capability.
7. **Terminal failures survive restart:** a saved safety halt is not reclassified as retryable chain unavailability. A restarted coordinator returns the halt without fetching RPCs. Writer loss/closure also returns a terminal outcome and stops polling. Two added regressions plus the full suite/typecheck/build passed after this lifecycle review.

## Still not complete

- Public startup/manifest/configuration/role admission, actual independent RPCs and chosen cadence/freshness values.
- Browser transaction context/nonce/simulation and active HTML/gallery integration.
- Durable abuse controls, independent real storage/signer adapters, operating-scale query plans and catastrophic recovery.
- Approved infrastructure/accounts/budgets/custody and an actual Ethereum Sepolia deployment/rehearsal.
- E10 remains blocked by the separately documented X billing/access failures; these tests are not a real Grok assessment.

The active production refusal remains intact. Nothing here authorizes deployment or changes the token, renderer, accepted assessment or historical artifact identity.
