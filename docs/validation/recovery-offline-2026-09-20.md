# Narrow recovery and wallet-RPC guidance validation

Checked September 20, 2026 on `codex/execution-table`, following `e68a22a`. This is offline implementation evidence, not another real provider attempt.

## Scope and invariants

- Added a read-only review / explicit offline apply command for exactly one linked recovery after the original real pilot's observed X HTTP 402, before any Grok dispatch. It is not a reset or general retry mechanism.
- Requires separate paid-approval, rejection and account-specific billing evidence references, exact command/digest binding, the original profile and reservation, and the exclusive app writer lock for apply. OS access is the local operator boundary; reference strings record reviewed evidence, not external authentication.
- Original attempt and provider receipt bytes remain unchanged. Original reservation is retained; replacement admission and operator reconciliation are separately linked and audited. Unknown provider cost is not rewritten as measured zero.
- Crash tests cover failures before and after each of six writes. Incomplete recovery cannot dispatch; exact replay finishes the same grant and cannot grant a third attempt. Conflicting replay, accepted results, uncertain Grok work and chained recovery are refused.
- Attempt-ID fencing rejects stale lifecycle callbacks. Service integration proves that startup, old-page reads and disabled generation do not dispatch. Fresh wallet proof and explicit mint intent are required. Successful recovery is reused; a second X rejection is not retried.
- CLI idempotence after a successful accepted result was identified in independent review and corrected with regression coverage. No duplicate-dispatch path was found in that review; this is not a substitute for E24 security review.
- Wallet block-proof transport failures now show validated configured loopback RPC guidance instead of raw stale-RPC/provider errors. Wallet cancellation, generation races and duplicate-submission guards remain intact. No automatic RPC reconfiguration, wallet signing, nonce repair or additional provider retry was added.
- E16's [public architecture proposal](../public-architecture.md) is drafted. It does not authorize provisioning, public chain use, key custody or deployment; active public-startup refusal remains unchanged.

## Automated checks

- `OPEN_MINT_TEST_HTTP=1 npm run test:coverage -- --reporter=dot`: **3,758 tests passed across 124 files**. Coverage **95.11% statements, 91.23% branches, 98.07% functions**; thresholds unchanged. All providers are mocked; HTTP checks use isolated loopback.
- Added **107 tests**: 35 recovery-ledger/fault tests, 44 recovery-CLI tests, five service recovery integrations and 23 wallet-RPC regressions.
- `npm run typecheck`, `npm run build` and renderer locks passed. Signature v1.0.0/v2.0.0 and slogan-only v2.0.1 captures are unchanged.
- **65 contract tests**, manifest validation and **nine manifest-role tests** passed offline.
- `git diff --check` passed.
- Hosted CI is separate evidence and must be checked against the pushed implementation revision.

## Browser checks

Used the visual-DOM CDP skill, fresh headless Chrome profiles, actual page/client/CSS/fonts and a temporary read-only loopback fixture with a fake wallet. The fake wallet rejects its block-proof read with an obsolete RPC error; no real extension, application store, provider, key or chain is involved.

| Viewport/theme | Result |
| --- | --- |
| 390×844 light | Correct configured RPC shown once, raw obsolete RPC absent, no horizontal overflow, font loaded, mint CTA disabled |
| 1280×1100 dark | Same checks passed; desktop screenshot inspected |

Both runs made only local GET requests, all returning 200. Fake wallet calls were account selection, chain-ID reads and one failed block-proof read. **Zero POSTs, signing, sends, provider requests or wallet-network mutations.** Screenshot inspection caught repetitive reconnect advice; it was shortened and both browser cases rerun successfully.

Temporary evidence: `/private/tmp/sg-recovery-qa.3qb9Jd/mobile-light.png`, `desktop-dark.png`, `coverage.log`. The QA server was stopped afterward.

## Real pilot remains unchanged

No recovery command was applied to `.local/open-mint/grok-pilot-20260920`. No additional X/Grok call, wallet/chain mutation, budget reset or namespace replacement occurred. The existing app process was not restarted and still serves its earlier loaded code. The [original failed pilot](e10-pilot-2026-09-20.md) needs account-specific billing reconciliation and separate additional-attempt approval before recovery is staged or consumed. E10/E11 live validation remains incomplete.
