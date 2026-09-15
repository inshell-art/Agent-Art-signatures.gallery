import { randomUUID } from "node:crypto";
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { canonicalHandle, isMbti, MAPPING_VERSION, POLICY_VERSION, RENDERER_VERSION, seedForMbti, type MBTI } from "./identity.js";

export type AssessmentProvenance = "grok" | "development-fixture";
export interface Assessment {
  readonly id: string;
  readonly handle: string;
  readonly mbti: MBTI;
  readonly seed: number;
  readonly rendererVersion: typeof RENDERER_VERSION;
  readonly mappingVersion: typeof MAPPING_VERSION;
  readonly policyVersion: typeof POLICY_VERSION;
  readonly model: string;
  readonly providerResponseId: string;
  readonly sourceUrls: readonly string[];
  readonly createdAt: string;
  readonly provenance: AssessmentProvenance;
  readonly digest: Hex;
}

/** This interface is injected at server startup, never constructed from a public request. */
export interface AssessmentProvider {
  readonly provenance: AssessmentProvenance;
  readonly model: string;
  assess(handle: string): Promise<ProviderAssessment>;
}
export interface ProviderAssessment {
  readonly handle: string;
  readonly mbti: MBTI;
  readonly model: string;
  readonly providerResponseId: string;
  readonly sourceUrls: readonly string[];
}
export interface AssessmentRepository {
  get(handle: string): Promise<Assessment | undefined>;
  putIfAbsent(value: Assessment): Promise<Assessment>;
}

const FIELDS = ["id", "handle", "mbti", "seed", "rendererVersion", "mappingVersion", "policyVersion", "model", "providerResponseId", "sourceUrls", "createdAt", "provenance", "digest"];
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

export function assessmentDigest(value: Omit<Assessment, "digest">): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "string" }, { type: "string" }, { type: "string" }, { type: "string" }, { type: "uint16" },
      { type: "string" }, { type: "string" }, { type: "string" }, { type: "string" }, { type: "string" },
      { type: "string[]" }, { type: "string" }, { type: "string" }],
    ["signatures.gallery/open-assessment/v1", value.id, value.handle, value.mbti, value.seed,
      value.rendererVersion, value.mappingVersion, value.policyVersion, value.model, value.providerResponseId,
      [...value.sourceUrls], value.createdAt, value.provenance],
  ));
}

/** Validates saved data on every read. A digest detects corruption, it is not provider authentication. */
export function validateAssessment(value: unknown): Assessment {
  const record = exactObject(value, FIELDS, "assessment");
  if (canonicalHandle(record.handle) !== record.handle || !isMbti(record.mbti) || record.seed !== seedForMbti(record.mbti)) throw new Error("Invalid assessment identity or artwork mapping.");
  if (record.rendererVersion !== RENDERER_VERSION || record.mappingVersion !== MAPPING_VERSION || record.policyVersion !== POLICY_VERSION) throw new Error("Unsupported assessment version.");
  if (record.provenance !== "grok" && record.provenance !== "development-fixture") throw new Error("Invalid assessment provenance.");
  if (typeof record.id !== "string" || !/^[a-f0-9-]{36}$/.test(record.id)) throw new Error("Invalid assessment identifier.");
  validateProviderMetadata(record.model, record.providerResponseId, record.provenance);
  if (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt)) || new Date(record.createdAt).toISOString() !== record.createdAt) throw new Error("Invalid assessment timestamp.");
  const sourceUrls = validateSourceUrls(record.sourceUrls, record.provenance);
  if (JSON.stringify(sourceUrls) !== JSON.stringify(record.sourceUrls)) throw new Error("Assessment sources are not canonical.");
  const assessment = { ...record, sourceUrls } as unknown as Assessment;
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
  readonly #provider: AssessmentProvider;
  readonly #repository: AssessmentRepository;
  readonly #now: () => Date;
  readonly #pending = new Map<string, Promise<Assessment>>();
  readonly #success = new Map<string, Assessment>();
  readonly #provenance: AssessmentProvenance;
  readonly #model: string;

  constructor(options: { provider: AssessmentProvider; repository: AssessmentRepository; now?: () => Date }) {
    this.#provider = options.provider;
    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date());
    this.#provenance = options.provider.provenance;
    this.#model = options.provider.model;
    if (!["grok", "development-fixture"].includes(this.#provenance)) throw new Error("Unsupported assessment provider.");
  }

  async get(value: unknown): Promise<Assessment | undefined> {
    const handle = canonicalHandle(value);
    const result = this.#success.get(handle) ?? await this.#repository.get(handle);
    if (!result) return undefined;
    const saved = validateAssessment(result);
    if (saved.handle !== handle || saved.provenance !== this.#provenance) throw new Error("Assessment storage provenance or handle mismatch.");
    this.#success.set(handle, saved);
    return saved;
  }

  assess(value: unknown): Promise<Assessment> {
    const handle = canonicalHandle(value);
    const pending = this.#pending.get(handle);
    if (pending) return pending;
    const operation = this.#assess(handle).finally(() => { this.#pending.delete(handle); });
    this.#pending.set(handle, operation);
    return operation;
  }

  async #assess(handle: string): Promise<Assessment> {
    const existing = await this.get(handle);
    if (existing) return existing;
    const assessed = this.#unsaved.get(handle) ?? await this.#invoke(handle);
    try {
      const saved = validateAssessment(await this.#repository.putIfAbsent(assessed));
      if (saved.handle !== handle || saved.provenance !== this.#provenance) throw new Error("Assessment storage provenance or handle mismatch.");
      this.#success.set(handle, saved);
      this.#unsaved.delete(handle);
      return saved;
    } catch (error) {
      // Retry persistence, never a second paid assessment, after a successful provider result.
      this.#unsaved.set(handle, assessed);
      throw error;
    }
  }

  async #invoke(handle: string): Promise<Assessment> {
    const result = exactObject(await this.#provider.assess(handle), PROVIDER_FIELDS, "provider assessment");
    if (result.handle !== handle || !isMbti(result.mbti) || result.model !== this.#model) throw new Error("Provider assessment identity, type, or model mismatch.");
    validateProviderMetadata(result.model, result.providerResponseId, this.#provenance);
    const sourceUrls = validateSourceUrls(result.sourceUrls, this.#provenance);
    const unsigned: Omit<Assessment, "digest"> = {
      id: randomUUID(), handle, mbti: result.mbti, seed: seedForMbti(result.mbti),
      rendererVersion: RENDERER_VERSION, mappingVersion: MAPPING_VERSION, policyVersion: POLICY_VERSION,
      model: this.#model, providerResponseId: result.providerResponseId as string, sourceUrls,
      createdAt: this.#now().toISOString(), provenance: this.#provenance,
    };
    return validateAssessment({ ...unsigned, digest: assessmentDigest(unsigned) });
  }

  readonly #unsaved = new Map<string, Assessment>();
}
