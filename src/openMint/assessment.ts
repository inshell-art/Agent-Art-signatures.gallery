import { randomUUID } from "node:crypto";
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { canonicalHandle, isMbti, LEGACY_MAPPING_VERSION, LEGACY_RENDERER_VERSION, POLICY_VERSION, RENDERER_VERSION, seedForMbti, type MBTI } from "./identity.js";
import { validateXIdentity, type XIdentityResolver, type XIdentitySnapshot } from "./xIdentity.js";
import type { AssessmentExecution } from "./assessmentOperations.js";

export type AssessmentProvenance = "grok" | "development-fixture";
interface AssessmentBase {
  readonly id: string;
  readonly handle: string;
  readonly mbti: MBTI;
  readonly policyVersion: typeof POLICY_VERSION;
  readonly model: string;
  readonly providerResponseId: string;
  readonly sourceUrls: readonly string[];
  readonly createdAt: string;
  readonly provenance: AssessmentProvenance;
  readonly digest: Hex;
  /** Absent on historical assessments. Never inferred from client spelling or upgraded. */
  readonly xIdentity?: XIdentitySnapshot;
}
/** Original immutable records retain their exact seed adapter and digest. */
export interface LegacyAssessment extends AssessmentBase {
  readonly rendererVersion: typeof LEGACY_RENDERER_VERSION;
  readonly seed: number;
  readonly mappingVersion: typeof LEGACY_MAPPING_VERSION;
}
/** Native MBTI artwork has no synthetic numeric seed or mapping adapter. */
export interface NativeMbtiAssessment extends AssessmentBase {
  readonly rendererVersion: typeof RENDERER_VERSION;
}
export type Assessment = LegacyAssessment | NativeMbtiAssessment;
export type UnsignedAssessment = Omit<LegacyAssessment, "digest"> | Omit<NativeMbtiAssessment, "digest">;

/** This interface is injected at server startup, never constructed from a public request. */
export interface AssessmentProvider {
  readonly provenance: AssessmentProvenance;
  readonly model: string;
  assess(handle: string, identity?: XIdentitySnapshot, execution?: AssessmentExecution): Promise<ProviderAssessment | ProviderAbstention>;
}
export interface ProviderAbstention {
  readonly kind: "abstained";
  readonly reason: "insufficient-evidence" | "subject-unavailable" | "provider-refusal";
  readonly handle: string;
  readonly model: string;
  readonly providerResponseId: string;
  readonly xUserId?: string;
}
export class AssessmentAbstainedError extends Error {
  constructor(readonly reason: ProviderAbstention["reason"]) { super("Grok did not return an assessment. No type was invented and no retry will be automatic."); }
}
export interface ProviderAssessment {
  readonly handle: string;
  readonly mbti: MBTI;
  readonly model: string;
  readonly providerResponseId: string;
  readonly sourceUrls: readonly string[];
  readonly xUserId?: string;
}
export interface AssessmentRepository {
  get(handle: string): Promise<Assessment | undefined>;
  putIfAbsent(value: Assessment): Promise<Assessment>;
}

const LEGACY_FIELDS = ["id", "handle", "mbti", "seed", "rendererVersion", "mappingVersion", "policyVersion", "model", "providerResponseId", "sourceUrls", "createdAt", "provenance", "digest"];
const NATIVE_FIELDS = ["id", "handle", "mbti", "rendererVersion", "policyVersion", "model", "providerResponseId", "sourceUrls", "createdAt", "provenance", "digest"];
const PROVIDER_FIELDS = ["handle", "mbti", "model", "providerResponseId", "sourceUrls"];

export function exactObject(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length || fields.some((field) => !Object.hasOwn(record, field))) {
    throw new Error(`Invalid ${label} fields.`);
  }
  return record;
}

export function isXSource(value: string): boolean {
  const url = new URL(value);
  return ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname)
    && /^\/(?:[A-Za-z0-9_]{1,15}(?:\/status\/[0-9]+)?|i\/(?:status|user)\/[0-9]+)\/?$/.test(url.pathname);
}

/** References are provider metadata, not arbitrary URLs authored in its JSON answer. */
export function validateSourceUrls(value: unknown, provenance: AssessmentProvenance): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error("Invalid assessment source references.");
  const sources = value.map((item: unknown) => {
    if (typeof item !== "string" || item.length > 2048 || /[\s\u0000-\u001f]/.test(item)) throw new Error("Invalid assessment source URL.");
    let url: URL;
    try { url = new URL(item); } catch { throw new Error("Invalid assessment source URL."); }
    if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("Invalid assessment source URL.");
    return url.href;
  });
  const result = [...new Set(sources)].sort();
  if (provenance === "grok" && !result.some(isXSource)) throw new Error("Grok assessment requires X Search source evidence.");
  return Object.freeze(result);
}

export function assessmentDigest(value: UnsignedAssessment): Hex {
  if (value.xIdentity) {
    if (value.rendererVersion !== RENDERER_VERSION) throw new Error("X identity snapshots require the native renderer.");
    const { xIdentity, ...unbound } = value;
    return keccak256(encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32" }, ...Array.from({ length: 6 }, () => ({ type: "string" as const }))],
      ["signatures.gallery/open-assessment/v3", assessmentDigest(unbound), xIdentity.canonicalHandle,
        xIdentity.username, xIdentity.userId, xIdentity.verifiedAt, xIdentity.provenance, xIdentity.freshness],
    ));
  }
  if (value.rendererVersion === LEGACY_RENDERER_VERSION) return keccak256(encodeAbiParameters(
    [{ type: "string" }, { type: "string" }, { type: "string" }, { type: "string" }, { type: "uint16" },
      { type: "string" }, { type: "string" }, { type: "string" }, { type: "string" }, { type: "string" },
      { type: "string[]" }, { type: "string" }, { type: "string" }],
    ["signatures.gallery/open-assessment/v1", value.id, value.handle, value.mbti, value.seed,
      value.rendererVersion, value.mappingVersion, value.policyVersion, value.model, value.providerResponseId,
      [...value.sourceUrls], value.createdAt, value.provenance],
  ));
  if (value.rendererVersion !== RENDERER_VERSION) throw new Error("Unsupported assessment version.");
  return keccak256(encodeAbiParameters(
    [{ type: "string" }, { type: "string" }, { type: "string" }, { type: "string" },
      { type: "string" }, { type: "string" }, { type: "string" }, { type: "string" },
      { type: "string[]" }, { type: "string" }, { type: "string" }],
    ["signatures.gallery/open-assessment/v2", value.id, value.handle, value.mbti,
      value.rendererVersion, value.policyVersion, value.model, value.providerResponseId,
      [...value.sourceUrls], value.createdAt, value.provenance],
  ));
}

/** Validates saved data on every read. A digest detects corruption, it is not provider authentication. */
export function validateAssessment(value: unknown): Assessment {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid assessment.");
  const version = (value as Record<string, unknown>).rendererVersion;
  if (version !== RENDERER_VERSION && version !== LEGACY_RENDERER_VERSION) throw new Error("Unsupported assessment version.");
  const fields = version === LEGACY_RENDERER_VERSION ? LEGACY_FIELDS : NATIVE_FIELDS;
  const hasIdentity = Object.hasOwn(value, "xIdentity");
  if (hasIdentity && version === LEGACY_RENDERER_VERSION) throw new Error("Legacy assessments cannot be relabeled with X verification.");
  const record = exactObject(value, hasIdentity ? [...fields, "xIdentity"] : fields, "assessment");
  if (canonicalHandle(record.handle) !== record.handle || !isMbti(record.mbti)) throw new Error("Invalid assessment identity or artwork mapping.");
  if (version === LEGACY_RENDERER_VERSION && (record.seed !== seedForMbti(record.mbti) || record.mappingVersion !== LEGACY_MAPPING_VERSION)) throw new Error("Invalid legacy artwork mapping.");
  if (record.policyVersion !== POLICY_VERSION) throw new Error("Unsupported assessment policy.");
  if (record.provenance !== "grok" && record.provenance !== "development-fixture") throw new Error("Invalid assessment provenance.");
  if (typeof record.id !== "string" || !/^[a-f0-9-]{36}$/.test(record.id)) throw new Error("Invalid assessment identifier.");
  validateProviderMetadata(record.model, record.providerResponseId, record.provenance);
  if (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt)) || new Date(record.createdAt).toISOString() !== record.createdAt) throw new Error("Invalid assessment timestamp.");
  const sourceUrls = validateSourceUrls(record.sourceUrls, record.provenance);
  if (JSON.stringify(sourceUrls) !== JSON.stringify(record.sourceUrls)) throw new Error("Assessment sources are not canonical.");
  const xIdentity = hasIdentity ? validateXIdentity(record.xIdentity, record.handle as string) : undefined;
  if (xIdentity && (xIdentity.provenance === "development-fixture") !== (record.provenance === "development-fixture")) throw new Error("Assessment X identity provenance mismatch.");
  const assessment = { ...record, sourceUrls, ...(xIdentity ? { xIdentity } : {}) } as unknown as Assessment;
  if (typeof record.digest !== "string" || !/^0x[0-9a-f]{64}$/.test(record.digest) || assessmentDigest(assessment) !== record.digest) throw new Error("Invalid assessment digest.");
  return Object.freeze(assessment);
}

function validateProviderMetadata(model: unknown, responseId: unknown, provenance: AssessmentProvenance): void {
  if (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)) throw new Error("Invalid assessment model.");
  if (typeof responseId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(responseId)) throw new Error("Invalid provider response identifier.");
  if (provenance === "grok" && (!model.startsWith("grok-") || responseId.startsWith("development-fixture:"))) throw new Error("Invalid Grok provenance.");
  if (provenance === "development-fixture" && (model !== "development-fixture-v1" || !responseId.startsWith("development-fixture:"))) throw new Error("Invalid fixture provenance.");
}

/** One successful assessment becomes canonical. There is deliberately no public completion/import API. */
export class AssessmentCoordinator {
  readonly #provider?: AssessmentProvider;
  readonly #repository: AssessmentRepository;
  readonly #now: () => Date;
  readonly #pending = new Map<string, Promise<Assessment>>();
  readonly #success = new Map<string, Assessment>();
  readonly #provenance: AssessmentProvenance;
  readonly #model?: string;
  readonly #identityResolver?: XIdentityResolver;
  readonly #identities = new Map<string, XIdentitySnapshot>();

  constructor(options: { provider?: AssessmentProvider; expectedProvenance?: AssessmentProvenance; repository: AssessmentRepository; identityResolver?: XIdentityResolver; now?: () => Date }) {
    this.#provider = options.provider;
    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date());
    const provenance = options.expectedProvenance ?? options.provider?.provenance;
    if (!provenance || (options.provider && options.provider.provenance !== provenance)) throw new Error("Explicit assessment provenance is required and must match its provider.");
    this.#provenance = provenance;
    this.#model = options.provider?.model;
    this.#identityResolver = options.identityResolver;
    if (!["grok", "development-fixture"].includes(this.#provenance)) throw new Error("Unsupported assessment provider.");
    if (this.#identityResolver && (this.#identityResolver.provenance === "development-fixture") !== (this.#provenance === "development-fixture")) throw new Error("Assessment resolver provenance mismatch.");
  }
  get identityProvenance(): XIdentitySnapshot["provenance"] | undefined { return this.#identityResolver?.provenance; }
  get generationConfigured(): boolean { return !!this.#provider; }

  async get(value: unknown): Promise<Assessment | undefined> {
    const handle = canonicalHandle(value);
    const result = this.#success.get(handle) ?? await this.#repository.get(handle);
    if (!result) return undefined;
    const saved = validateAssessment(result);
    if (saved.handle !== handle || saved.provenance !== this.#provenance) throw new Error("Assessment storage provenance or handle mismatch.");
    this.#success.set(handle, saved);
    return saved;
  }

  assess(value: unknown, execution?: AssessmentExecution): Promise<Assessment> {
    const handle = canonicalHandle(value);
    const pending = this.#pending.get(handle);
    if (pending) return pending;
    const operation = this.#assess(handle, execution).finally(() => { this.#pending.delete(handle); });
    this.#pending.set(handle, operation);
    return operation;
  }

  async #assess(handle: string, execution?: AssessmentExecution): Promise<Assessment> {
    const existing = await this.get(handle);
    if (existing) return existing;
    const assessed = this.#unsaved.get(handle) ?? await this.#invoke(handle, execution);
    try {
      const saved = validateAssessment(await this.#repository.putIfAbsent(assessed));
      if (saved.handle !== handle || saved.provenance !== this.#provenance) throw new Error("Assessment storage provenance or handle mismatch.");
      this.#success.set(handle, saved);
      this.#unsaved.delete(handle);
      await execution?.assessmentPersisted(saved);
      return saved;
    } catch (error) {
      // Retry persistence, never a second paid assessment, after a successful provider result.
      this.#unsaved.set(handle, assessed);
      throw error;
    }
  }

  async #invoke(handle: string, execution?: AssessmentExecution): Promise<Assessment> {
    if (!this.#provider) throw new Error("Assessment generation is not configured; saved results remain available.");
    let xIdentity = this.#identities.get(handle);
    if (!xIdentity && this.#identityResolver) {
      await execution?.beforeDispatch("x-identity");
      xIdentity = validateXIdentity(await this.#identityResolver.resolve(handle, execution), handle);
      if (xIdentity.provenance !== this.#identityResolver.provenance) throw new Error("X resolver provenance mismatch.");
      this.#identities.set(handle, xIdentity);
      await execution?.identityVerified(xIdentity);
    }
    await execution?.beforeDispatch("grok");
    const raw = await (execution ? this.#provider.assess(handle, xIdentity, execution) : xIdentity ? this.#provider.assess(handle, xIdentity) : this.#provider.assess(handle));
    if (raw && "kind" in raw && raw.kind === "abstained") {
      const abstention = exactObject(raw, ["kind", "reason", "handle", "model", "providerResponseId", ...(xIdentity ? ["xUserId"] : [])], "provider abstention");
      if (abstention.handle !== handle || abstention.model !== this.#model || !["insufficient-evidence", "subject-unavailable", "provider-refusal"].includes(String(abstention.reason))
        || (xIdentity && abstention.xUserId !== xIdentity.userId)) throw new Error("Invalid provider abstention identity or reason.");
      validateProviderMetadata(abstention.model, abstention.providerResponseId, this.#provenance);
      await execution?.recordOutcome({ kind: "abstained", reason: raw.reason });
      throw new AssessmentAbstainedError(raw.reason);
    }
    const result = exactObject(raw, xIdentity ? [...PROVIDER_FIELDS, "xUserId"] : PROVIDER_FIELDS, "provider assessment");
    if (result.handle !== handle || !isMbti(result.mbti) || result.model !== this.#model) throw new Error("Provider assessment identity, type, or model mismatch.");
    if (xIdentity && result.xUserId !== xIdentity.userId) throw new Error("Provider assessment X account mismatch.");
    validateProviderMetadata(result.model, result.providerResponseId, this.#provenance);
    const sourceUrls = validateSourceUrls(result.sourceUrls, this.#provenance);
    const unsigned: Omit<NativeMbtiAssessment, "digest"> = {
      id: randomUUID(), handle, mbti: result.mbti,
      rendererVersion: RENDERER_VERSION, policyVersion: POLICY_VERSION,
      model: this.#model!, providerResponseId: result.providerResponseId as string, sourceUrls,
      createdAt: this.#now().toISOString(), provenance: this.#provenance,
      ...(xIdentity ? { xIdentity } : {}),
    };
    const assessed = validateAssessment({ ...unsigned, digest: assessmentDigest(unsigned) });
    await execution?.recordOutcome({ kind: "accepted" });
    return assessed;
  }

  readonly #unsaved = new Map<string, Assessment>();
}
