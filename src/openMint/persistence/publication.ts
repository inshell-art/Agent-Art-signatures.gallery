import canonicalize from "canonicalize";
import type { Hex } from "viem";
import { validateAssessment } from "../assessment.js";
import { canonicalHandle } from "../identity.js";
import { POLICY_VERSION } from "../identity.js";
import { publicArtworkOrigin, verifyPreparedPublicArtifact, type PreparedPublicArtifact, type PublicObject } from "../publicArtifacts.js";
import type { PublicPublicationJournal } from "../publicPublication.js";
import { ExclusiveWriter, PersistenceConflictError, type OwnershipConnection } from "./writer.js";

const kinds = ["svg", "png", "metadata"] as const;
type Kind = typeof kinds[number];
type Transaction = Pick<OwnershipConnection, "query">;
interface Stored { handle: string; digest: Hex; header: Buffer; svg: Buffer; png: Buffer; metadata: Buffer }
interface Profile { namespaceId: string; origin: string; destination: string; source: string }
type Header = Omit<PreparedPublicArtifact, Kind> & Record<Kind, PublicObject>;
const json = (value: unknown): Buffer => Buffer.from(canonicalize(value)!);
function header(artifact: PreparedPublicArtifact): Buffer {
  return json({ assessment: artifact.assessment, origin: artifact.origin, commitment: artifact.commitment, digest: artifact.digest,
    svg: artifact.svg.object, png: artifact.png.object, metadata: artifact.metadata.object });
}
function decode(row: Stored): PreparedPublicArtifact {
  const value: Header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(row.header));
  if (row.digest !== value.digest || row.handle !== value.commitment.canonicalHandle) throw new PersistenceConflictError("Publication row mismatch.");
  return { ...value, svg: { object: value.svg, bytes: Uint8Array.from(row.svg) },
    png: { object: value.png, bytes: Uint8Array.from(row.png) }, metadata: { object: value.metadata, bytes: Uint8Array.from(row.metadata) } };
}
function objectKind(row: Stored, object: PublicObject): Kind {
  const value = decode(row), kind = kinds.find(key => json(value[key].object).equals(json(object)));
  if (!kind) throw new PersistenceConflictError("Object is not bound to this staged publication.");
  return kind;
}

/** Durable private backups and immutable evidence. This is not a publisher,
 * signer, migration runner or permission to enable a public runtime. */
export class PostgresPublicationJournal implements PublicPublicationJournal {
  private constructor(readonly writer: ExclusiveWriter, private readonly profile: Readonly<Profile>) {}
  get namespaceId(): string { return this.profile.namespaceId; }
  get origin(): string { return this.profile.origin; }
  static async open(writer: ExclusiveWriter, input: Profile): Promise<PostgresPublicationJournal> {
    const profile = Object.freeze({ ...input });
    publicArtworkOrigin(profile.origin);
    const id = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
    if (!id.test(profile.source) || !id.test(profile.destination) || profile.source === profile.destination) throw new PersistenceConflictError("Invalid publication identities.");
    await writer.transaction(async tx => {
      const row = (await tx.query<{ origin: string; destination: string; source: string; provenance: string; policy_version: string }>(`SELECT p.*, n.provenance, n.policy_version
        FROM open_mint.publication_profiles p JOIN open_mint.namespaces n USING(namespace_id) WHERE namespace_id = $1`, [profile.namespaceId])).rows[0];
      if (!row || row.origin !== profile.origin || row.destination !== profile.destination || row.source !== profile.source || row.provenance !== "grok" || row.policy_version !== POLICY_VERSION) {
        throw new PersistenceConflictError("Publication namespace/profile mismatch.");
      }
    });
    return new PostgresPublicationJournal(writer, profile);
  }
  async #row(tx: Transaction, digest: Hex): Promise<Stored> {
    const row = (await tx.query<Stored>("SELECT handle, digest, header, svg, png, metadata FROM open_mint.public_artifacts WHERE namespace_id = $1 AND digest = $2", [this.profile.namespaceId, digest])).rows[0];
    if (!row) throw new PersistenceConflictError("Publication is not staged in this namespace.");
    return row;
  }
  async #accepted(tx: Transaction, artifact: PreparedPublicArtifact): Promise<void> {
    const saved = (await tx.query<{ payload: Buffer; digest: string; assessment_id: string; handle: string; policy_version: string; provenance: string }>(`SELECT s.payload,s.digest,s.assessment_id,s.handle,n.policy_version,n.provenance
      FROM open_mint.assessments s JOIN open_mint.assessment_attempts a USING(namespace_id,attempt_id)
      JOIN open_mint.namespaces n USING(namespace_id)
      WHERE s.namespace_id=$1 AND s.handle=$2 AND a.state='accepted'`, [this.profile.namespaceId, artifact.assessment.handle])).rows[0];
    if (!saved) throw new PersistenceConflictError("Publication requires the exact accepted assessment.");
    const accepted = validateAssessment(JSON.parse(saved.payload.toString("utf8")));
    if (accepted.id !== saved.assessment_id || accepted.digest !== saved.digest || accepted.handle !== saved.handle
      || accepted.policyVersion !== saved.policy_version || accepted.provenance !== saved.provenance
      || !json(accepted).equals(json(artifact.assessment))) throw new PersistenceConflictError("Publication requires the exact accepted assessment.");
  }
  async stage(value: PreparedPublicArtifact): Promise<void> {
    const artifact = structuredClone(value);
    await verifyPreparedPublicArtifact(artifact);
    if (artifact.origin !== this.profile.origin) throw new PersistenceConflictError("Publication origin mismatch.");
    const exactHeader = header(artifact);
    await this.writer.transaction(async tx => {
      await this.#accepted(tx, artifact);
      await tx.query(`INSERT INTO open_mint.public_artifacts(namespace_id, handle, digest, header, svg, png, metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (namespace_id,handle) DO NOTHING`,
      [this.profile.namespaceId, artifact.assessment.handle, artifact.digest, exactHeader, Buffer.from(artifact.svg.bytes), Buffer.from(artifact.png.bytes), Buffer.from(artifact.metadata.bytes)]);
      const row = await this.#row(tx, artifact.digest);
      if (!row.header.equals(exactHeader) || kinds.some(kind => !row[kind].equals(Buffer.from(artifact[kind].bytes)))) throw new PersistenceConflictError("Conflicting immutable public artifact.");
    });
  }
  beforeUpload(digest: Hex, object: PublicObject): Promise<void> {
    const exactObject = structuredClone(object);
    return this.writer.transaction(async tx => {
      const row = await this.#row(tx, digest); await this.#accepted(tx, decode(row)); objectKind(row, exactObject);
    });
  }
  #observe(digest: Hex, object: PublicObject, identity: string, phase: "uploaded" | "retrieved"): Promise<void> {
    const exactObject = structuredClone(object);
    return this.writer.transaction(async tx => {
      const expected = phase === "uploaded" ? this.profile.destination : this.profile.source;
      if (identity !== expected) throw new PersistenceConflictError("Publication observation identity mismatch.");
      const row = await this.#row(tx, digest); await this.#accepted(tx, decode(row));
      const kind = objectKind(row, exactObject);
      await tx.query(`INSERT INTO open_mint.publication_observations(namespace_id,digest,object_kind,phase,identity)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [this.profile.namespaceId, digest, kind, phase, identity]);
    });
  }
  uploaded(digest: Hex, object: PublicObject, destination: string): Promise<void> { return this.#observe(digest, object, destination, "uploaded"); }
  retrieved(digest: Hex, object: PublicObject, source: string): Promise<void> { return this.#observe(digest, object, source, "retrieved"); }
  async #evidence(tx: Transaction, digest: Hex): Promise<void> {
    const row = (await tx.query<{ count: number }>(`SELECT count(*)::int AS count FROM open_mint.publication_observations
      WHERE namespace_id=$1 AND digest=$2 AND ((phase='uploaded' AND identity=$3) OR (phase='retrieved' AND identity=$4))`,
    [this.profile.namespaceId, digest, this.profile.destination, this.profile.source])).rows[0];
    if (row?.count !== 6) throw new PersistenceConflictError("Publication evidence incomplete or inconsistent.");
  }
  complete(digest: Hex): Promise<void> {
    return this.writer.transaction(async tx => {
      await this.#accepted(tx, decode(await this.#row(tx, digest)));
      await this.#evidence(tx, digest);
      await tx.query("INSERT INTO open_mint.completed_publications(namespace_id,digest) VALUES ($1,$2) ON CONFLICT DO NOTHING", [this.profile.namespaceId, digest]);
    });
  }
  /** Private exact-byte recovery, never re-rendering or public JSON serialization. */
  async load(handle: string, requireComplete = false): Promise<PreparedPublicArtifact | undefined> {
    const canonical = canonicalHandle(handle);
    const row = await this.writer.transaction(async tx => {
      const found = (await tx.query<Stored>(`SELECT a.handle,a.digest,a.header,a.svg,a.png,a.metadata
        FROM open_mint.public_artifacts a WHERE a.namespace_id = $1 AND a.handle = $2 AND (NOT $3::boolean OR EXISTS
        (SELECT 1 FROM open_mint.completed_publications c WHERE c.namespace_id = a.namespace_id AND c.digest = a.digest))`,
      [this.profile.namespaceId, canonical, requireComplete])).rows[0];
      if (found) {
        await this.#accepted(tx, decode(found));
        if (requireComplete) await this.#evidence(tx, found.digest);
      }
      return found;
    });
    if (!row) return undefined;
    const artifact = decode(row);
    await verifyPreparedPublicArtifact(artifact);
    if (artifact.origin !== this.profile.origin) throw new PersistenceConflictError("Stored publication origin mismatch.");
    this.writer.assertHealthy();
    return artifact;
  }
}
