# Paid Grok fallback preparation

Prepared: 2026-09-14. Status: readiness audit and implementation checklist, not a live-provider validation or production approval.

Implementation update, 2026-09-15: the [preview / mint split](open-mint.md) now requires fresh wallet proof and chain eligibility before a paid preparation request. Durable `attempt:<handle>` admission records and live in-flight coalescing close the stale-pending allowance bypass described below; failed/uncertain uncached calls cannot be retried automatically or by another ordinary user request. This is an attempt guard, **not yet a provider usage/cost accounting ledger or dollar cap**. The model/output profile and live validation gates below remain unchanged. Preview URL MBTI is freely editable but never accepted by the trusted mint preparation endpoint.

While the [subscription OAuth inquiry](xai-integration-request.md) is pending, prepare the supported team-API-key route. The gallery pays for inference and native search. Grok remains the assessment author; changing the payer must not change the integrity boundary.

The detailed recommendation, cost scenarios, proposed pilot settings, and implementation gates are in [Low-cost Grok assessments](paid-grok-cost-research.md). That report is a design proposal, not a change to the current runtime or permission to spend.

## Preserve these invariants

- Trusted mint preparation input is only a validated handle, never MBTI, a prompt, model output, or a private chat transcript. Playful preview URLs are outside this trust boundary.
- Grok researches X with native X Search; the backend does not supply a curated collection of posts or a proposed MBTI.
- The backend receives the provider response directly and rejects incomplete, mismatched, ungrounded, or malformed responses.
- A successfully saved assessment is canonical per lowercase handle. Exact rendering spelling and existing assessment/artifact commitments are preserved.
- Anyone can mint, with recipient proof and explicit transaction consent. No X-account ownership claim returns.
- The contract verifies our backend's attestation, not an xAI signature. Neither prompt-injection immunity nor objective psychological truth is guaranteed.

## Existing implementation, inspected on 2026-09-14

| Capability | Current implementation |
| --- | --- |
| Paid transport | `src/openMint/grok.ts`: team `XAI_API_KEY`, fixed HTTPS Responses endpoint, redirects rejected |
| Assessment policy | Fresh backend instructions, only the canonical handle in user input, native X Search scoped to that handle |
| Validation | Expected model/handle, completed native search, X citation evidence, one valid MBTI JSON result |
| Transport bounds | 90-second default timeout; 1 MiB response cap; one outbound request, no automatic retry or fixture substitution |
| Current model | `grok-4.6`, overridable at server startup with `OPEN_MINT_GROK_MODEL` |
| Current output cap | 4096 tokens; no explicit reasoning or `max_turns` setting |
| Reuse | In-process coalescing and immutable per-handle saved assessments |
| Request allowance | Persisted UTC daily count, default 25; cached results bypass the count |
| Development separation | Real and fixture namespaces are separate; production startup remains refused |

The request allowance is NOT a dollar budget. The output cap and timeout do not bound all native-search charges. There is no provider usage/cost ledger today. Successful-result persistence retries reuse an in-memory result, but a crash before durable persistence can lose it; uncertain provider failures can also be retried by a later user request. Do not promise exactly one charge per handle under all failure conditions.

## Preparation work, in order

1. **Measure and account for spending.** Add a durable, server-only attempt ledger before transport: handle, attempt ID, model/policy, started/completed/unknown state, provider response ID, token/tool usage, and actual provider cost where available. Keep operational billing data separate from the immutable artwork assessment. Never record credentials. Unknown cost must not become zero.
2. **Control attempts and failures.** Persist in-flight/uncertain attempts, prevent repeated user-triggered spending, bound concurrency, and retain reservations across crashes. A timed-out call may still be charged. Do not automatically refund allowance or regenerate until uncertainty has an explicit recovery policy. A stale-pending budget bypass was reproduced offline on 2026-09-14: `service.ts` exempts a matching stored pending request from the count, even if saving its failed status previously failed. With allowance one, a mocked provider failure and one terminal-status write failure allowed two provider invocations while the budget remained one. The reproduction used in-memory mocks, no live API or dev-state writes. Bind exemptions to a genuinely shared durable attempt, not a request-status flag, and add a permanent regression test.
3. **Add application spending controls.** Retain the daily request cap; add operator-selected spending thresholds, conservative reservations, and a kill switch. Record that a local threshold is not an absolute per-call USD cap when native search volume is provider-controlled. Configure any provider-side billing limits only after confirming what they actually enforce.
4. **Prepare a lower-cost request profile.** Evaluate `grok-4.3`, short structured output, low/none reasoning, and a small assistant-turn limit. Enable only native X Search; leave image/video analysis off. Use a fixed research window if it passes quality review. These are proposals, not changes to current defaults. `max_turns` limits turns, not individual parallel searches or fetched posts.
5. **Verify without paying.** Extend mocked tests for usage validation, budget reservation, unknown outcomes, restart recovery, concurrent/case-variant requests, insufficient evidence, and no secret leakage. Add an explicit insufficient-evidence result: the current instructions permit refusal but the JSON schema requires an MBTI. Preserve existing renderer/identity/mint tests.
6. **Run a controlled live check only after approval.** Have the user provision a dedicated server API key through ignored local configuration and choose a spend limit. Start with one explicit handle, one attempt, no automatic retries, and a request allowance of one. Record actual token/search cost, latency, model and citations; repeat the handle to verify zero additional inference. A single request is not a guarantee of a fixed maximum price.
7. **Rehearse minting locally.** Use the accepted real assessment with isolated Anvil and the local test wallet. Do not deploy or transact on a public network. Broader production gates in [open-mint.md](open-mint.md) remain unchanged.

Keep model/policy choice explicit for new assessments and never rewrite saved artworks when optimizing cost. Do not silently downgrade models or replace a failed real assessment with a fixture.

## Pricing and accounting references

- [xAI pricing](https://docs.x.ai/developers/pricing): API-key billing is separate from subscription OAuth. The announced September 21, 2026, 12 PM PT change makes X Search per fetched post/profile rather than per call; recheck before the live trial.
- [Cost tracking](https://docs.x.ai/developers/cost-tracking): inspect `usage.cost_in_usd_ticks`; convert ticks to USD with the documented divisor of 10,000,000,000. Preserve integer ticks in the ledger.
- [Tool usage details](https://docs.x.ai/developers/tools/tool-usage-details): input accumulates across agentic turns; `max_turns` is not a tool-call or returned-post cap.
- [Grok 4.3 capabilities](https://docs.x.ai/developers/models/grok-4.3): verify structured outputs, reasoning controls, model availability, and search compatibility in the actual pilot.
- [API account billing FAQ](https://docs.x.ai/developers/faq/accounts): ordinary API usage is billed separately from Grok subscriptions.

## Validation record

No live xAI request, key creation, credit purchase, billing-setting change, or public-chain transaction was performed for this preparation. Runtime behavior has not been changed by these preparation documents.

On 2026-09-14, this targeted offline command passed **119 tests across six files** (reported test duration: 1.04 seconds):

```sh
npx vitest run src/openMint/grok.test.ts src/openMint/assessment.test.ts src/openMint/assessmentStore.test.ts src/openMint/service.test.ts src/openMint/identity.test.ts src/openMint/authorization.test.ts
```

Breakdown: provider 32, coordinator 5, assessment storage 4, service 27, identity 20, authorization 31. Fetch was mocked; this proves the tested local logic, not live xAI entitlement, real-response compatibility, actual costs, or production readiness. The existing `open:rehearsal` script is fixture-only; a separately guarded live smoke-test path remains to be prepared.
