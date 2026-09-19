# Paid Grok fallback preparation

Prepared: 2026-09-14. Status: readiness audit and implementation checklist, not a live-provider validation or production approval.

Implementation update, **2026-09-19**: use [the one-attempt pilot runbook](grok-pilot.md) for current operation. Wallet proof and chain eligibility precede paid preparation. Versioned attempts, pre-dispatch markers, separate private receipts, validated usage/cost evidence, explicit abstention, count/concurrency/exposure admission and a generation kill switch are implemented. The real launcher now pins `grok-4.3`, low reasoning, 1024 output tokens and three assistant turns. Saved verified results remain reusable without generation credentials. None of this establishes a per-request dollar cap or live account compatibility.

The September 14 stale-pending allowance bypass and rendering-spelling findings are resolved. [Service regressions](../src/openMint/service.test.ts) cover terminal-write failure plus restart without repeat dispatch, and X-returned spelling/snapshot reuse after restart and request expiry; [coordinator tests](../src/openMint/assessment.test.ts) cover the bound identity snapshot. The current ledger adds fault-injection and restart accounting tests in [assessmentOperations.test.ts](../src/openMint/assessmentOperations.test.ts). Historical findings below describe the old audit, not open retry permission or missing current guards.

While the [subscription OAuth inquiry](xai-integration-request.md) is pending, prepare the supported team-API-key route. The gallery pays for inference and native search. Grok remains the assessment author; changing the payer must not change the integrity boundary.

The original cost scenarios and rejected alternatives are retained in [the September 14 research](paid-grok-cost-research.md). Its multi-attempt evaluation proposals are historical and are superseded by the one-total-attempt runbook. No document grants permission to spend.

## Preserve these invariants

- Trusted mint preparation input is only a validated handle, never MBTI, a prompt, model output, or a private chat transcript. Playful preview URLs are outside this trust boundary.
- Grok researches X with native X Search; the backend does not supply a curated collection of posts or a proposed MBTI.
- The backend receives the provider response directly and rejects incomplete, mismatched, ungrounded, or malformed responses.
- A successfully saved assessment is canonical per lowercase handle. Exact rendering spelling and existing assessment/artifact commitments are preserved.
- Anyone can mint, with recipient proof and explicit transaction consent. No X-account ownership claim returns.
- The contract verifies our backend's attestation, not an xAI signature. Neither prompt-injection immunity nor objective psychological truth is guaranteed.

## Historical implementation snapshot, inspected on 2026-09-14

| Capability | Implementation at that audit |
| --- | --- |
| Paid transport | `src/openMint/grok.ts`: team `XAI_API_KEY`, fixed HTTPS Responses endpoint, redirects rejected |
| Assessment policy | Fresh backend instructions, only the canonical handle in user input, native X Search scoped to that handle |
| Validation | Expected model/handle, completed native search, X citation evidence, one valid MBTI JSON result |
| Transport bounds | 90-second default timeout; 1 MiB response cap; one outbound request, no automatic retry or fixture substitution |
| Model at audit | `grok-4.6`, then overridable at server startup with `OPEN_MINT_GROK_MODEL` |
| Output cap at audit | 4096 tokens; then no explicit reasoning or `max_turns` setting |
| Reuse | In-process coalescing and immutable per-handle saved assessments |
| Request allowance | Persisted UTC daily count, default 25; cached results bypass the count |
| Development separation | Real and fixture namespaces are separate; production startup remains refused |

At that audit there was no usage/cost ledger, and the reproduced stale-pending path allowed a later user request to repeat an uncertain call. Those gaps are now addressed by durable attempt guards and receipt accounting. The remaining limitation is unchanged: local allowance, output and timeout controls cannot guarantee a provider-enforced charge ceiling or prove a remote request was cancelled.

## Preparation status, 2026-09-19

1. **Implemented:** versioned private attempt lifecycle and a separate receipt for each provider leg before semantic validation. Allowlisted usage and exact integer cost evidence exclude raw posts, credentials and reasoning. Unknown X or xAI cost stays unknown.
2. **Implemented:** durable dispatch markers, no repeat admission after uncertain/unsuccessful work, one active and one total paid attempt, and reservation retention across restart/day changes. The original offline bypass produced two mocked calls for allowance one; the permanent service regression now requires exactly one call even when both terminal writes fail.
3. **Implemented:** strict persisted counter/reservation validation, an allowlisted handle, conservative monetary admission and a generation-only kill switch. Missing receipts never release spend automatically. Further recovery requires a separately approved, audited future operation.
4. **Implemented candidate:** the dated server profile uses `grok-4.3`/low/1024/three turns with native X Search and media analysis off. Accepted output keeps subject/search/citation validation; insufficient evidence and other bounded abstentions create no artifact or authority. Live quality/access remain unverified.
5. **Verified offline:** provider/identity/receipt tests cover accepted, abstained, invalid, HTTP-error, malformed/oversized-body, timeout and receipt-write-failure paths. Ledger/service tests cover admission, durable failure and recovery. See the runbook for commands and the dated test record.
6. **Outstanding approval/access:** preflight currently reports both `XAI_API_KEY` and `OPEN_MINT_X_BEARER_TOKEN` absent, generation disabled and account entitlement unverified. Obtain one target, one attempt and explicit acceptance of the $1 illustrative reservation's charge uncertainty; provision credentials privately. Do not test access with an unapproved paid call.
7. **Outstanding live validation:** run the approved attempt in fresh isolated real storage/Anvil, inspect receipts, verify zero-call reuse, and obtain the user's wallet approval for the local mint. Stop on failure; no automatic replacement attempt or public deployment.

Keep model/policy choice explicit for new assessments and never rewrite saved artworks when optimizing cost. Do not silently downgrade models or replace a failed real assessment with a fixture.

## Pricing and accounting references

- [xAI pricing](https://docs.x.ai/developers/pricing): API-key billing is separate from subscription OAuth. The announced September 21, 2026, 12 PM PT change makes X Search per fetched post/profile rather than per call; recheck before the live trial.
- [Cost tracking](https://docs.x.ai/developers/cost-tracking): inspect `usage.cost_in_usd_ticks`; convert ticks to USD with the documented divisor of 10,000,000,000. Preserve integer ticks in the ledger.
- [Tool usage details](https://docs.x.ai/developers/tools/tool-usage-details): input accumulates across agentic turns; `max_turns` is not a tool-call or returned-post cap.
- [Grok 4.3 capabilities](https://docs.x.ai/developers/models/grok-4.3): verify structured outputs, reasoning controls, model availability, and search compatibility in the actual pilot.
- [API account billing FAQ](https://docs.x.ai/developers/faq/accounts): ordinary API usage is billed separately from Grok subscriptions.

## Validation record

No live X/xAI request, key creation, credit purchase, billing-setting change or public-chain transaction was performed for this preparation. The September 19 implementation changes are covered by the current runbook; the following numbers retain the original September 14 audit evidence.

On 2026-09-14, this targeted offline command passed **119 tests across six files** (reported test duration: 1.04 seconds):

```sh
npx vitest run src/openMint/grok.test.ts src/openMint/assessment.test.ts src/openMint/assessmentStore.test.ts src/openMint/service.test.ts src/openMint/identity.test.ts src/openMint/authorization.test.ts
```

Breakdown at that date: provider 32, coordinator 5, assessment storage 4, service 27, identity 20, authorization 31. Fetch was mocked; this proves the tested local logic, not live xAI entitlement, real-response compatibility, actual costs or production readiness. `open:rehearsal` remains fixture-only. `open:preflight` and the current runbook now describe the guarded real path; its live execution remains unapproved and unverified.
