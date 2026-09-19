# Private assessment operations

The M1 ledger uses the application's existing exclusive process lock and file store. It has no retry worker, distributed coordination, provider retrieval operation or public administration route. A ledger admission is not spending authorization: the real pilot still requires the E09 profile review and E10 user approval.

## Storage and immutable boundaries

`assessmentOperations.ts` validates versioned operational records separately from canonical assessments and artifacts. No billing fields, attempt phases or diagnostic references enter assessment/artifact hashes or public metadata.

- `attempt:<canonical-handle>` holds one version 1 attempt with an immutable UUID, admission time, server profile version, explicit accounting mode, append-only phase timestamps, safe outcome, accepted-assessment reference and separate artifact outcome.
- `budget:paid_v1` contains immutable admission reservations. The reservation is written before the numeric daily counter and attempt. Interrupted writes can retain an unused reservation; they cannot admit an unrecorded outbound call.
- `budget:YYYY-MM-DD` retains the numeric counter format. Counters from every date are validated; negative, fractional, nonnumeric or malformed records stop admission. Reservations independently retain total and unresolved exposure across day changes.
- `receipt:<attempt-id>_x` and `receipt:<attempt-id>_grok` contain versioned, bounded, allowlisted operational receipts. Repeating an identical receipt is idempotent; replacing one is refused.

Historical unversioned attempts are projected read-only as legacy/unknown. Their old `createdAt` is called `legacyObservedAt`: terminal writes in the former implementation replaced that timestamp, so it is not reliable original admission evidence. Old `started`, `failed` and `succeeded` values never confer permission to dispatch. Inspection does not migrate or overwrite those files.

## Durable ordering and failures

The coordinator awaits each hook before advancing:

1. Admission reservation, daily counter, attempt, then the service's request record.
2. X dispatch marker, X call, receipt, validated identity.
3. Grok dispatch marker, Grok call, receipt, semantic accepted/abstained/invalid outcome.
4. Canonical assessment publication, accepted-assessment linkage, artifact preparation, request ready.

Adapters record available HTTP/response/usage evidence before semantic parsing, so invalid JSON/schema, abstention and non-2xx responses still have accounting. No arbitrary response bodies, posts, credentials or hidden reasoning are retained. A receipt write failure stops progression; the preceding dispatch marker and reservation remain. A receipt that saved before its phase update failed is still visible on inspection.

Failure categories are the enums `identity`, `provider`, `storage` and `interrupted`; raw exception messages are never saved. A failure with no dispatch marker is `failed-before-dispatch`. A dispatched last leg with an observed HTTP response is `failed-after-response`; otherwise it is `uncertain-after-dispatch`. An accepted semantic outcome and accepted result reference are never overwritten by downstream failure. Artifact failure has its own state and can recover using the same canonical result.

Dispatch markers are conservative: a crash between their durable write and the network call cannot prove whether dispatch happened. Neither absence of a successful result nor passage of time clears the guard. A failed assessment publication must not trigger another model request. Result-only persistence recovery is handled by the coordinator; after restart, missing canonical bytes leave the attempt blocked.

## Admission and honest accounting

Real accounting defaults to generation disabled, one total admitted attempt, one active attempt and one daily attempt. The caller supplies an allowlisted canonical handle and reviewed exposure settings for the actual pilot. The module's default one-dollar reservation/exposure value is a disabled software default, not approval to spend and not a provider price ceiling. Main startup policy determines usable configuration.

USD values use canonical decimal integer strings at scale 10 (10^10 ticks per USD). No floating-point money or citation-derived billing estimate is used. Actual, estimated and unknown cost are distinct. Estimates must name a dated/versioned pricing reference. Missing usage and malformed usage do not become zero. A known charge greater than its reservation increases exposure. Unknown or estimated final accounting blocks another paid admission; reservations persist across restarts and dates. There is no automatic release, including for a known pre-dispatch failure.

The generation callback is checked at admission and before each provider leg, so activating the kill switch can stop Grok after X has completed. It does not revoke an outbound request already sent. Saved-assessment reads, inspection and local artifact recovery do not need generation enabled or provider credentials.

Explicit development fixtures set `accountingRequired: false`. The attempt and reservation persist that exemption, and reports say `fixture-not-billed`. Fixture receipts are not fabricated. Loading a fixture exemption into a real accounting configuration blocks new paid admission. Missing receipts from a real mock/provider remain unresolved.

Application admission cannot guarantee a provider's per-call dollar ceiling. Account billing controls, model/tool capabilities and accepted uncertainty must be checked in E09/E10. Additional instances remain unsupported; run this module only under the application's exclusive process writer lock.

## Read-only operator report

Run locally with an attempt reference from the sanitized diagnostic response:

```sh
node --import tsx scripts/open-mint-attempt.mjs \
  --records /absolute/path/to/.local/open-mint/grok/records \
  --reference 01234567-89ab-4cde-8fab-0123456789ab
```

The command only opens existing records for reading; it does not create directories, acquire/remove locks, contact providers or rewrite records. It rejects symlink record files and bounds reads. Reports include private provider references and operational evidence, so keep output local to the operator. They omit wallet/session ownership, private mint codes, raw posts and secrets. Inspection against a live writer can show a conservative intermediate snapshot; run again if a phase is actively advancing.

`automaticRetryAllowed` is always false. There is deliberately no reset, delete, release or retry CLI flag.

## Reviewed recovery contract for E21 — not implemented in M1

A future recovery action must have a dry-run report, authenticated operator identity, immutable evidence references and an explicit approval for any additional paid dispatch. It must prove the original attempt never dispatched Grok using phase history and independent provider/billing evidence. A missing receipt, timeout, failed request or old `failed` status is insufficient proof. X dispatch and possible X charges must be reconciled separately.

The approved operation must link a new attempt and budget reservation to the original immutable attempt, append an audit record, and bind an idempotency identifier to the exact action/evidence/approval. Repeating the same operation returns the existing result, not another dispatch. Conflicting idempotency reuse fails. Accepted canonical assessments can never be rerolled. Unknown Grok dispatch, unknown billing or uncertain result publication keeps recovery blocked. No record deletion, blanket counter reset or budget release may substitute for this review.

Until that operation is reviewed and implemented, stop and inspect; even a proven pre-Grok failure cannot be user-retried during the one-attempt pilot.

## Offline evidence

`src/openMint/assessmentOperations.test.ts` exercises admission races, limits, kill-switch activation between legs, conservative legacy reads, malformed counters/records, bounded receipt data, unknown/estimated/overrun costs, separate artifact recovery, and faults before and after every durable lifecycle write. File-store restart tests preserve result references and unresolved exposure. All provider activity in these tests is simulated; they establish no live compatibility or observed provider cost.
