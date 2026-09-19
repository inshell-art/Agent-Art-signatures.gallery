import { createHash, randomUUID } from "node:crypto";
import type { Assessment } from "./assessment.js";
import { canonicalHandle } from "./identity.js";
import { SerialKeys, type KeyValueStore } from "./storage.js";
import { validateXIdentity, type XIdentitySnapshot } from "./xIdentity.js";

export type ProviderLeg = "x-identity" | "grok";
export type AbstentionReason = "insufficient-evidence" | "subject-unavailable" | "provider-refusal";
export type SafeAssessmentOutcome = { kind: "accepted" } | { kind: "abstained"; reason: AbstentionReason } | { kind: "invalid" };
export type AssessmentFailureCategory = "identity" | "provider" | "storage" | "interrupted";
export interface ProviderReceipt {
  leg: ProviderLeg;
  startedAt: number;
  completedAt: number;
  category: "success" | "http-error" | "transport-error" | "timeout" | "invalid-body" | "oversized-body";
  httpStatus?: number;
  requestId?: string;
  responseId?: string;
  model?: string;
  usageStatus: "valid" | "missing" | "invalid";
  usage?: {
    inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number;
    reasoningTokens?: number; searchCalls?: number; serverSideToolCalls?: number; costInUsdTicks?: string;
  };
  cost: { status: "actual" | "estimated" | "unknown"; currency: "USD"; scale: 10; amount?: string; pricingReference?: string };
}
export interface AssessmentExecution {
  readonly attemptId: string;
  beforeDispatch(leg: ProviderLeg): Promise<void>;
  recordReceipt(receipt: ProviderReceipt): Promise<void>;
  identityVerified(snapshot: XIdentitySnapshot): Promise<void>;
  recordOutcome(outcome: SafeAssessmentOutcome): Promise<void>;
  assessmentPersisted(assessment: Assessment): Promise<void>;
}

const PHASES = ["xDispatchedAt", "xVerifiedAt", "grokDispatchedAt", "responseReceivedAt", "outcomeAt", "assessmentPersistedAt", "failedAt", "artifactPreparedAt", "artifactFailedAt"] as const;
type Phase = typeof PHASES[number];
export interface AssessmentAttempt {
  version: 1;
  id: string;
  handle: string;
  admittedAt: number;
  profileVersion: string;
  accountingRequired: boolean;
  phases: Partial<Record<Phase, number>>;
  outcome: "pending" | "accepted" | "abstained" | "invalid" | "failed-before-dispatch" | "failed-after-response" | "uncertain-after-dispatch";
  abstentionReason?: AbstentionReason;
  failureCategory?: AssessmentFailureCategory;
  reconciliation: "pending" | "complete" | "operator-review";
  acceptedAssessment?: { id: string; digest: string };
  identity?: XIdentitySnapshot;
  artifact: "pending" | "prepared" | "failed";
}
export interface LegacyAssessmentAttempt {
  version: 0;
  id: string;
  handle: string;
  admission: "unknown";
  legacyObservedAt: number;
  outcome: "uncertain-after-dispatch";
  reconciliation: "operator-review";
  artifact: "unknown";
}
export type AssessmentAttemptView = AssessmentAttempt | LegacyAssessmentAttempt;
interface Reservation {
  attemptId: string; handle: string; admittedAt: number; profileVersion: string; accountingRequired: boolean; reservedUsdTicks: string;
}
interface PaidBudget { version: 1; reservations: Reservation[] }
interface SavedReceipt { version: 1; attemptId: string; receipt: ProviderReceipt }
export type AssessmentOperationsErrorCode = "GENERATION_DISABLED" | "HANDLE_NOT_ALLOWED" | "ASSESSMENT_RETRY_BLOCKED" | "ASSESSMENT_LIMIT" | "ASSESSMENT_ACTIVE_LIMIT" | "ASSESSMENT_EXPOSURE_LIMIT" | "ASSESSMENT_ACCOUNTING_UNKNOWN" | "ASSESSMENT_OPERATIONS_CORRUPT" | "ASSESSMENT_OPERATIONS_STATE";
export class AssessmentOperationsError extends Error {
  constructor(readonly code: AssessmentOperationsErrorCode) { super(code); this.name = "AssessmentOperationsError"; }
}
/** Safe classification travels to the service; the original cause stays private. */
export class AssessmentPersistenceError extends Error {
  constructor(cause: unknown) { super("Assessment operational persistence failed.", { cause }); this.name = "AssessmentPersistenceError"; }
}
const BUDGET_KEY = "budget:paid_v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const REASONS = ["insufficient-evidence", "subject-unavailable", "provider-refusal"];
const FAILURES = ["identity", "provider", "storage", "interrupted"];
function corrupt(): never { throw new AssessmentOperationsError("ASSESSMENT_OPERATIONS_CORRUPT"); }
function stateError(): never { throw new AssessmentOperationsError("ASSESSMENT_OPERATIONS_STATE"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return corrupt();
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) corrupt();
}
function timestamp(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 8_640_000_000_000_000; }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function amount(value: unknown): value is string { return typeof value === "string" && /^(?:0|[1-9][0-9]{0,29})$/.test(value); }
function reference(value: unknown): value is string { return typeof value === "string" && REFERENCE.test(value); }
function canonical(value: unknown): value is string {
  try { return canonicalHandle(value) === value; } catch { return false; }
}
function validDay(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}
const same = (first: unknown, second: unknown): boolean => JSON.stringify(first) === JSON.stringify(second);
const receiptKey = (id: string, leg: ProviderLeg): string => `receipt:${id}_${leg === "x-identity" ? "x" : "grok"}`;
const legPhase = (leg: ProviderLeg): Phase => leg === "x-identity" ? "xDispatchedAt" : "grokDispatchedAt";

/** Reject arbitrary dumps instead of trying to redact them after persistence. */
export function validateProviderReceipt(value: unknown): ProviderReceipt {
  const record = object(value);
  fields(record, ["leg", "startedAt", "completedAt", "category", "usageStatus", "cost"], ["httpStatus", "requestId", "responseId", "model", "usage"]);
  if (!["x-identity", "grok"].includes(String(record.leg)) || !timestamp(record.startedAt) || !timestamp(record.completedAt)
    || record.completedAt < record.startedAt || !["success", "http-error", "transport-error", "timeout", "invalid-body", "oversized-body"].includes(String(record.category))
    || !["valid", "missing", "invalid"].includes(String(record.usageStatus))) corrupt();
  if (record.httpStatus !== undefined && (!integer(record.httpStatus) || record.httpStatus < 100 || record.httpStatus > 599)) corrupt();
  for (const key of ["requestId", "responseId", "model"]) if (record[key] !== undefined && !reference(record[key])) corrupt();
  if (record.usage !== undefined) {
    const usage = object(record.usage);
    fields(usage, [], ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningTokens", "searchCalls", "serverSideToolCalls", "costInUsdTicks"]);
    if (record.usageStatus !== "valid" || !Object.keys(usage).length) corrupt();
    for (const [key, value] of Object.entries(usage)) if (key === "costInUsdTicks" ? !amount(value) : !integer(value)) corrupt();
  }
  if (record.usageStatus === "valid" && record.usage === undefined) corrupt();
  const cost = object(record.cost);
  fields(cost, ["status", "currency", "scale"], ["amount", "pricingReference"]);
  if (cost.currency !== "USD" || cost.scale !== 10 || !["actual", "estimated", "unknown"].includes(String(cost.status))) corrupt();
  if (cost.status === "unknown") { if (cost.amount !== undefined || cost.pricingReference !== undefined) corrupt(); }
  else if (!amount(cost.amount)) corrupt();
  if (cost.pricingReference !== undefined && !reference(cost.pricingReference)) corrupt();
  if (cost.status === "estimated" && cost.pricingReference === undefined) corrupt();
  if (cost.status === "actual" && record.usage && (record.usage as ProviderReceipt["usage"])?.costInUsdTicks !== undefined
    && (record.usage as ProviderReceipt["usage"])!.costInUsdTicks !== cost.amount) corrupt();
  return structuredClone(record) as unknown as ProviderReceipt;
}

/** Legacy observations are projected conservatively; reading never rewrites old files. */
export function validateAssessmentAttempt(value: unknown, expectedHandle: string): AssessmentAttemptView {
  const record = object(value), handle = canonicalHandle(expectedHandle);
  if (record.version === undefined) {
    fields(record, ["handle", "createdAt", "status"], ["assessmentId"]);
    if (record.handle !== handle || !timestamp(record.createdAt) || !["started", "succeeded", "failed"].includes(String(record.status))
      || (record.assessmentId !== undefined && !reference(record.assessmentId))) corrupt();
    return { version: 0, id: `legacy-${createHash("sha256").update(handle).digest("hex").slice(0, 24)}`, handle, admission: "unknown",
      legacyObservedAt: record.createdAt, outcome: "uncertain-after-dispatch", reconciliation: "operator-review", artifact: "unknown" };
  }
  fields(record, ["version", "id", "handle", "admittedAt", "profileVersion", "accountingRequired", "phases", "outcome", "reconciliation", "artifact"],
    ["abstentionReason", "failureCategory", "acceptedAssessment", "identity"]);
  if (record.version !== 1 || typeof record.id !== "string" || !UUID.test(record.id) || record.handle !== handle
    || !timestamp(record.admittedAt) || !reference(record.profileVersion) || typeof record.accountingRequired !== "boolean"
    || !["pending", "accepted", "abstained", "invalid", "failed-before-dispatch", "failed-after-response", "uncertain-after-dispatch"].includes(String(record.outcome))
    || !["pending", "complete", "operator-review"].includes(String(record.reconciliation)) || !["pending", "prepared", "failed"].includes(String(record.artifact))) corrupt();
  const phases = object(record.phases);
  fields(phases, [], PHASES);
  for (const time of Object.values(phases)) if (!timestamp(time) || time < record.admittedAt) corrupt();
  const ordered = ["xDispatchedAt", "xVerifiedAt", "grokDispatchedAt", "responseReceivedAt", "outcomeAt", "assessmentPersistedAt"];
  let previous = record.admittedAt;
  for (const key of ordered) if (phases[key] !== undefined) { if (Number(phases[key]) < previous) corrupt(); previous = Number(phases[key]); }
  if (phases.xVerifiedAt !== undefined && phases.xDispatchedAt === undefined) corrupt();
  if (phases.grokDispatchedAt !== undefined && phases.xDispatchedAt !== undefined && phases.xVerifiedAt === undefined) corrupt();
  if ((phases.responseReceivedAt !== undefined || phases.outcomeAt !== undefined) && phases.grokDispatchedAt === undefined) corrupt();
  if (["accepted", "abstained", "invalid"].includes(String(record.outcome)) && phases.outcomeAt === undefined) corrupt();
  if (["failed-before-dispatch", "failed-after-response", "uncertain-after-dispatch"].includes(String(record.outcome)) && phases.failedAt === undefined) corrupt();
  if (record.outcome === "failed-before-dispatch" && (phases.xDispatchedAt !== undefined || phases.grokDispatchedAt !== undefined)) corrupt();
  if (record.abstentionReason !== undefined && (!REASONS.includes(String(record.abstentionReason)) || record.outcome !== "abstained")) corrupt();
  if (record.outcome === "abstained" && record.abstentionReason === undefined) corrupt();
  if (record.failureCategory !== undefined && !FAILURES.includes(String(record.failureCategory))) corrupt();
  if (record.acceptedAssessment !== undefined) {
    const accepted = object(record.acceptedAssessment); fields(accepted, ["id", "digest"]);
    if (!reference(accepted.id) || typeof accepted.digest !== "string" || !/^0x[0-9a-f]{64}$/.test(accepted.digest)
      || record.outcome !== "accepted" || phases.assessmentPersistedAt === undefined) corrupt();
  } else if (phases.assessmentPersistedAt !== undefined) corrupt();
  if (record.reconciliation === "complete" && !record.acceptedAssessment) corrupt();
  if (record.identity !== undefined) {
    try { validateXIdentity(record.identity, handle); } catch { corrupt(); }
    if (phases.xVerifiedAt === undefined) corrupt();
  } else if (phases.xVerifiedAt !== undefined) corrupt();
  if ((record.artifact !== "pending" && !record.acceptedAssessment) || (record.artifact === "prepared" && phases.artifactPreparedAt === undefined)
    || (record.artifact === "failed" && phases.artifactFailedAt === undefined)) corrupt();
  return structuredClone(record) as unknown as AssessmentAttempt;
}

function validateBudget(value: unknown): PaidBudget {
  if (value === undefined) return { version: 1, reservations: [] };
  const record = object(value); fields(record, ["version", "reservations"]);
  if (record.version !== 1 || !Array.isArray(record.reservations) || record.reservations.length > 10_000) corrupt();
  const ids = new Set<string>(), handles = new Set<string>();
  for (const item of record.reservations) {
    const reservation = object(item); fields(reservation, ["attemptId", "handle", "admittedAt", "profileVersion", "accountingRequired", "reservedUsdTicks"]);
    if (typeof reservation.attemptId !== "string" || !UUID.test(reservation.attemptId) || !canonical(reservation.handle)
      || !timestamp(reservation.admittedAt) || !reference(reservation.profileVersion) || typeof reservation.accountingRequired !== "boolean" || !amount(reservation.reservedUsdTicks)
      || (reservation.accountingRequired && reservation.reservedUsdTicks === "0")
      || ids.has(reservation.attemptId) || handles.has(reservation.handle)) corrupt();
    ids.add(reservation.attemptId); handles.add(reservation.handle);
  }
  return structuredClone(record) as unknown as PaidBudget;
}

export interface AssessmentOperationsOptions {
  store: KeyValueStore;
  now?: () => number;
  generationEnabled?: boolean | (() => boolean);
  /** Only explicit development fixtures may disable monetary accounting. */
  accountingRequired?: boolean;
  allowedHandle?: string;
  maxTotalAttempts?: number;
  maxActiveAttempts?: number;
  dailyLimit?: number;
  reservationUsdTicks?: string;
  maxExposureUsdTicks?: string;
}
export interface AssessmentOperatorReport {
  version: 1;
  attempt: AssessmentAttemptView;
  receipts: ProviderReceipt[];
  reservationUsdTicks?: string;
  exposureUsdTicks?: string;
  accounting: "actual" | "unresolved" | "legacy-unknown" | "fixture-not-billed";
  automaticRetryAllowed: false;
}

/** Single-writer operational ledger. No method deletes guards, releases unknown charges or retries a dispatch. */
export class AssessmentOperations {
  readonly #locks = new SerialKeys();
  readonly #now: () => number;
  readonly #limits: { total: number; active: number; daily: number; reservation: string; exposure: string };
  constructor(readonly options: AssessmentOperationsOptions) {
    this.#now = options.now ?? Date.now;
    this.#limits = { total: options.maxTotalAttempts ?? 1, active: options.maxActiveAttempts ?? 1, daily: options.dailyLimit ?? 1,
      reservation: options.reservationUsdTicks ?? "10000000000", exposure: options.maxExposureUsdTicks ?? "10000000000" };
    for (const limit of [this.#limits.total, this.#limits.active, this.#limits.daily]) if (!integer(limit) || limit < 1 || limit > 10_000) corrupt();
    if (!amount(this.#limits.reservation) || BigInt(this.#limits.reservation) === 0n || !amount(this.#limits.exposure)
      || (options.allowedHandle !== undefined && !canonical(options.allowedHandle))
      || (options.generationEnabled !== undefined && typeof options.generationEnabled !== "boolean" && typeof options.generationEnabled !== "function")
      || (options.accountingRequired !== undefined && typeof options.accountingRequired !== "boolean")) corrupt();
  }
  #time(attempt?: AssessmentAttempt): number {
    const time = this.#now();
    if (!timestamp(time)) corrupt();
    return Math.max(time, attempt?.admittedAt ?? 0, ...Object.values(attempt?.phases ?? {}));
  }
  async get(value: string): Promise<AssessmentAttemptView | undefined> {
    const handle = canonicalHandle(value), saved = await this.options.store.get<unknown>(`attempt:${handle}`);
    return saved === undefined ? undefined : validateAssessmentAttempt(saved, handle);
  }
  async #current(handle: string): Promise<AssessmentAttempt> {
    const attempt = await this.get(handle);
    if (!attempt || attempt.version !== 1) return stateError();
    return attempt;
  }
  async #save(attempt: AssessmentAttempt): Promise<void> {
    validateAssessmentAttempt(attempt, attempt.handle);
    await this.#put(`attempt:${attempt.handle}`, attempt);
  }
  async #put(key: string, value: unknown): Promise<void> {
    try { await this.options.store.put(key, value); }
    catch (error) { throw new AssessmentPersistenceError(error); }
  }
  async #receipts(attempt: AssessmentAttempt): Promise<ProviderReceipt[]> {
    const receipts: ProviderReceipt[] = [];
    for (const leg of ["x-identity", "grok"] as const) {
      const raw = await this.options.store.get<unknown>(receiptKey(attempt.id, leg));
      if (raw === undefined) continue;
      const record = object(raw); fields(record, ["version", "attemptId", "receipt"]);
      const receipt = validateProviderReceipt(record.receipt);
      if (record.version !== 1 || record.attemptId !== attempt.id || receipt.leg !== leg || attempt.phases[legPhase(leg)] === undefined) corrupt();
      receipts.push(receipt);
    }
    return receipts;
  }
  async #accounting(attempt: AssessmentAttempt, reservation: Reservation): Promise<{ exposure: bigint; actual: boolean; receipts: ProviderReceipt[] }> {
    const receipts = await this.#receipts(attempt);
    const dispatched = (["x-identity", "grok"] as const).filter(leg => attempt.phases[legPhase(leg)] !== undefined);
    const actual = !attempt.accountingRequired || (dispatched.length > 0 && attempt.outcome !== "pending" && receipts.length === dispatched.length && receipts.every(receipt => receipt.cost.status === "actual"));
    const known = receipts.reduce((sum, receipt) => sum + (receipt.cost.status === "unknown" ? 0n : BigInt(receipt.cost.amount!)), 0n);
    // Estimates and partial receipts cannot settle the reservation; known overruns still count.
    return { exposure: actual ? known : known > BigInt(reservation.reservedUsdTicks) ? known : BigInt(reservation.reservedUsdTicks), actual, receipts };
  }
  async admit(value: string, profileVersion: string): Promise<AssessmentAttempt> {
    const handle = canonicalHandle(value);
    if (!reference(profileVersion)) corrupt();
    return this.#locks.run("admission", async () => {
      const enabled = typeof this.options.generationEnabled === "function" ? this.options.generationEnabled() : this.options.generationEnabled;
      if (enabled !== true) throw new AssessmentOperationsError("GENERATION_DISABLED");
      if (this.options.allowedHandle !== undefined && handle !== this.options.allowedHandle) throw new AssessmentOperationsError("HANDLE_NOT_ALLOWED");
      if (await this.get(handle)) throw new AssessmentOperationsError("ASSESSMENT_RETRY_BLOCKED");
      const now = this.#time(), day = new Date(now).toISOString().slice(0, 10);
      const budget = validateBudget(await this.options.store.get(BUDGET_KEY));
      const attempts = await this.options.store.entries<unknown>("attempt:");
      const saved = attempts.map(([key, record]) => validateAssessmentAttempt(record, key.slice(8)));
      let legacyDaily = 0;
      for (const [key, value] of await this.options.store.entries<unknown>("budget:")) {
        if (key === BUDGET_KEY) continue;
        if (!/^budget:\d{4}-\d{2}-\d{2}$/.test(key) || !integer(value) || !validDay(key.slice(7))) corrupt();
        if (key === `budget:${day}`) legacyDaily = value;
      }
      if (budget.reservations.some(item => item.handle === handle)) throw new AssessmentOperationsError("ASSESSMENT_RETRY_BLOCKED");
      const reservedIds = new Set(budget.reservations.map(item => item.attemptId));
      if (this.options.accountingRequired !== false && saved.some(item => item.version === 0 || !reservedIds.has(item.id))) throw new AssessmentOperationsError("ASSESSMENT_ACCOUNTING_UNKNOWN");
      if (Math.max(budget.reservations.length, saved.length) >= this.#limits.total || Math.max(legacyDaily, budget.reservations.filter(item => new Date(item.admittedAt).toISOString().slice(0, 10) === day).length) >= this.#limits.daily) {
        throw new AssessmentOperationsError("ASSESSMENT_LIMIT");
      }
      let exposure = 0n, active = 0;
      for (const reservation of budget.reservations) {
        const attempt = saved.find(item => item.id === reservation.attemptId);
        if (!attempt || attempt.version !== 1) throw new AssessmentOperationsError("ASSESSMENT_ACCOUNTING_UNKNOWN");
        if (attempt.handle !== reservation.handle || attempt.admittedAt !== reservation.admittedAt || attempt.profileVersion !== reservation.profileVersion || attempt.accountingRequired !== reservation.accountingRequired) corrupt();
        if (this.options.accountingRequired !== false && !attempt.accountingRequired) throw new AssessmentOperationsError("ASSESSMENT_ACCOUNTING_UNKNOWN");
        if (attempt.outcome === "pending") active++;
        const accounting = await this.#accounting(attempt, reservation);
        if (!accounting.actual && attempt.outcome !== "pending") throw new AssessmentOperationsError("ASSESSMENT_ACCOUNTING_UNKNOWN");
        exposure += accounting.exposure;
      }
      if (active >= this.#limits.active) throw new AssessmentOperationsError("ASSESSMENT_ACTIVE_LIMIT");
      const accountingRequired = this.options.accountingRequired !== false;
      const reservationAmount = accountingRequired ? this.#limits.reservation : "0";
      if (exposure + BigInt(reservationAmount) > BigInt(this.#limits.exposure)) throw new AssessmentOperationsError("ASSESSMENT_EXPOSURE_LIMIT");
      const attempt: AssessmentAttempt = { version: 1, id: randomUUID(), handle, admittedAt: now, profileVersion, accountingRequired, phases: {}, outcome: "pending", reconciliation: "pending", artifact: "pending" };
      // Reserve first. A crash/write failure can consume a slot without a call, never hide a call.
      budget.reservations.push({ attemptId: attempt.id, handle, admittedAt: now, profileVersion, accountingRequired, reservedUsdTicks: reservationAmount });
      await this.#put(BUDGET_KEY, budget);
      await this.#put(`budget:${day}`, legacyDaily + 1);
      await this.#save(attempt);
      return attempt;
    });
  }
  async execution(value: string): Promise<AssessmentExecution> {
    const handle = canonicalHandle(value), admitted = await this.#current(handle);
    const run = (action: (attempt: AssessmentAttempt) => Promise<void>) => this.#locks.run(handle, async () => {
      const attempt = await this.#current(handle);
      if (attempt.id !== admitted.id) return stateError();
      await action(attempt);
    });
    return {
      attemptId: admitted.id,
      beforeDispatch: leg => run(async attempt => {
        if (!["x-identity", "grok"].includes(leg) || attempt.outcome !== "pending" || attempt.phases[legPhase(leg)] !== undefined) return stateError();
        if (leg === "x-identity" && attempt.phases.grokDispatchedAt !== undefined) return stateError();
        if (leg === "grok" && attempt.phases.xDispatchedAt !== undefined && attempt.phases.xVerifiedAt === undefined) return stateError();
        const enabled = typeof this.options.generationEnabled === "function" ? this.options.generationEnabled() : this.options.generationEnabled;
        if (enabled !== true) throw new AssessmentOperationsError("GENERATION_DISABLED");
        attempt.phases[legPhase(leg)] = this.#time(attempt);
        await this.#save(attempt);
      }),
      recordReceipt: value => run(async attempt => {
        const receipt = validateProviderReceipt(value);
        if (attempt.phases[legPhase(receipt.leg)] === undefined) return stateError();
        const key = receiptKey(attempt.id, receipt.leg);
        const saved: SavedReceipt = { version: 1, attemptId: attempt.id, receipt };
        const existing = await this.options.store.get<SavedReceipt>(key);
        if (existing !== undefined && !same(existing, saved)) return stateError();
        if (!existing) await this.#put(key, saved);
        if (receipt.leg === "grok" && receipt.httpStatus !== undefined && attempt.phases.responseReceivedAt === undefined) {
          attempt.phases.responseReceivedAt = this.#time(attempt); await this.#save(attempt);
        }
      }),
      identityVerified: snapshot => run(async attempt => {
        const identity = validateXIdentity(snapshot, handle);
        if (attempt.outcome !== "pending" || attempt.phases.xDispatchedAt === undefined || attempt.phases.grokDispatchedAt !== undefined) return stateError();
        if (attempt.identity) { if (!same(attempt.identity, identity)) return stateError(); return; }
        attempt.identity = identity; attempt.phases.xVerifiedAt = this.#time(attempt); await this.#save(attempt);
      }),
      recordOutcome: outcome => run(async attempt => {
        const value = object(outcome); fields(value, ["kind"], value.kind === "abstained" ? ["reason"] : []);
        if (!["accepted", "abstained", "invalid"].includes(String(value.kind)) || (value.kind === "abstained" && !REASONS.includes(String(value.reason)))) corrupt();
        if (attempt.outcome === outcome.kind && attempt.abstentionReason === (outcome.kind === "abstained" ? outcome.reason : undefined)) return;
        if (attempt.outcome !== "pending" || attempt.phases.grokDispatchedAt === undefined) return stateError();
        attempt.outcome = outcome.kind;
        if (outcome.kind === "abstained") attempt.abstentionReason = outcome.reason;
        attempt.phases.outcomeAt = this.#time(attempt); attempt.reconciliation = "operator-review";
        await this.#save(attempt);
      }),
      assessmentPersisted: assessment => run(async attempt => {
        if (assessment.handle !== handle || !reference(assessment.id) || !/^0x[0-9a-f]{64}$/.test(assessment.digest)
          || attempt.outcome !== "accepted") return stateError();
        const accepted = { id: assessment.id, digest: assessment.digest };
        if (attempt.acceptedAssessment) { if (!same(attempt.acceptedAssessment, accepted)) return stateError(); return; }
        attempt.acceptedAssessment = accepted; attempt.phases.assessmentPersistedAt = this.#time(attempt);
        const receipts = await this.#receipts(attempt);
        const dispatched = [attempt.phases.xDispatchedAt, attempt.phases.grokDispatchedAt].filter(time => time !== undefined).length;
        attempt.reconciliation = !attempt.accountingRequired || (receipts.length === dispatched && receipts.every(receipt => receipt.cost.status === "actual")) ? "complete" : "operator-review";
        await this.#save(attempt);
      }),
    };
  }
  async fail(value: string, category: AssessmentFailureCategory): Promise<void> {
    const handle = canonicalHandle(value);
    if (!FAILURES.includes(category)) corrupt();
    return this.#locks.run(handle, async () => {
      const attempt = await this.#current(handle);
      if (attempt.phases.failedAt === undefined) attempt.phases.failedAt = this.#time(attempt);
      if (attempt.failureCategory === undefined) attempt.failureCategory = category;
      if (attempt.outcome === "pending") {
        const dispatched = attempt.phases.xDispatchedAt !== undefined || attempt.phases.grokDispatchedAt !== undefined;
        const receipts = await this.#receipts(attempt);
        const lastLeg = attempt.phases.grokDispatchedAt !== undefined ? "grok" : "x-identity";
        const received = receipts.some(receipt => receipt.leg === lastLeg && receipt.httpStatus !== undefined);
        attempt.outcome = !dispatched ? "failed-before-dispatch" : received ? "failed-after-response" : "uncertain-after-dispatch";
      }
      attempt.reconciliation = "operator-review";
      await this.#save(attempt);
    });
  }
  async artifactOutcome(value: string, outcome: "prepared" | "failed"): Promise<void> {
    const handle = canonicalHandle(value);
    return this.#locks.run(handle, async () => {
      const attempt = await this.#current(handle);
      if (!attempt.acceptedAssessment || !["prepared", "failed"].includes(outcome)) return stateError();
      if (attempt.artifact === "prepared" || attempt.artifact === outcome) return;
      attempt.artifact = outcome;
      const phase = outcome === "prepared" ? "artifactPreparedAt" : "artifactFailedAt";
      if (attempt.phases[phase] === undefined) attempt.phases[phase] = this.#time(attempt);
      await this.#save(attempt);
    });
  }
  async report(attemptId: string): Promise<AssessmentOperatorReport | undefined> {
    if (!UUID.test(attemptId) && !/^legacy-[a-f0-9]{24}$/.test(attemptId)) return stateError();
    const attempts = await this.options.store.entries<unknown>("attempt:");
    const attempt = attempts.map(([key, record]) => validateAssessmentAttempt(record, key.slice(8))).find(item => item.id === attemptId);
    if (!attempt) return undefined;
    if (attempt.version === 0) return { version: 1, attempt, receipts: [], accounting: "legacy-unknown", automaticRetryAllowed: false };
    const budget = validateBudget(await this.options.store.get(BUDGET_KEY));
    const reservation = budget.reservations.find(item => item.attemptId === attempt.id);
    if (!reservation || reservation.handle !== attempt.handle || reservation.admittedAt !== attempt.admittedAt || reservation.profileVersion !== attempt.profileVersion || reservation.accountingRequired !== attempt.accountingRequired) corrupt();
    const accounting = await this.#accounting(attempt, reservation);
    return { version: 1, attempt, receipts: accounting.receipts, reservationUsdTicks: reservation.reservedUsdTicks,
      exposureUsdTicks: accounting.exposure.toString(), accounting: !attempt.accountingRequired ? "fixture-not-billed" : accounting.actual ? "actual" : "unresolved", automaticRetryAllowed: false };
  }
}
