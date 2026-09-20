import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import canonicalize from "canonicalize";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { syntheticPublicAssessment } from "../fixtures/publicAssessment.js";
import { assessmentDigest, validateAssessment } from "../assessment.js";
import { preparePublicArtifact, type PreparedPublicArtifact, type PublicObject } from "../publicArtifacts.js";
import { publishPublicArtifact } from "../publicPublication.js";
import { disposablePostgres, installSchema } from "./fixtures/postgres.js";
import { PostgresPublicationJournal } from "./publication.js";
import { ExclusiveWriter, WriterUnavailableError } from "./writer.js";

describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1")("durable public artifact journal (isolated PostgreSQL)", () => {
  let cluster: ReturnType<typeof disposablePostgres>, admin: Client, writer: ExclusiveWriter, journal: PostgresPublicationJournal;
  let artifact: PreparedPublicArtifact, namespaceId: string;
  const factory = () => new Client(cluster.config);
  const profile = () => ({ namespaceId, origin: "https://gallery.example", destination: "pin-a", source: "reader-b" });
  async function seedAccepted(): Promise<void> {
    const attempt = randomUUID(), a = artifact.assessment;
    await admin.query("INSERT INTO open_mint.handle_guards VALUES ($1,$2)", [namespaceId, a.handle]);
    await admin.query("INSERT INTO open_mint.assessment_attempts(namespace_id,attempt_id,handle,profile_version,admitted_at) VALUES ($1,$2,$3,'synthetic-test',now())", [namespaceId, attempt, a.handle]);
    await admin.query("INSERT INTO open_mint.assessments(namespace_id,handle,assessment_id,attempt_id,digest,payload) VALUES ($1,$2,$3,$4,$5,$6)",
      [namespaceId, a.handle, a.id, attempt, a.digest, Buffer.from(JSON.stringify(a))]);
    await admin.query("UPDATE open_mint.assessment_attempts SET state = 'accepted' WHERE namespace_id = $1", [namespaceId]);
  }
  function transports() {
    const remote = new Map<string, Uint8Array>();
    return { artifact, journal, timeoutMs: 1000,
      uploader: { id: "pin-a", upload: vi.fn(async (object: PublicObject, bytes: Uint8Array) => { remote.set(object.uri, Uint8Array.from(bytes)); }) },
      reader: { id: "reader-b", retrieve: vi.fn(async (object: PublicObject) => remote.get(object.uri)!) } };
  }
  beforeAll(async () => {
    cluster = disposablePostgres(); admin = factory(); await admin.connect(); await installSchema(admin);
    await admin.query(readFileSync(new URL("./publication-schema.sql", import.meta.url), "utf8"));
    artifact = await preparePublicArtifact({ assessment: syntheticPublicAssessment(), origin: "https://gallery.example" });
  }, 30000);
  beforeEach(async () => {
    namespaceId = randomUUID();
    await admin.query("INSERT INTO open_mint.namespaces VALUES ($1,'local-real','grok',$2)", [namespaceId, artifact.assessment.policyVersion]);
    await admin.query("INSERT INTO open_mint.publication_profiles VALUES ($1,$2,'pin-a','reader-b')", [namespaceId, profile().origin]);
    writer = await ExclusiveWriter.acquire(factory); journal = await PostgresPublicationJournal.open(writer, profile());
  });
  afterEach(async () => { await writer?.close(); });
  afterAll(async () => { await admin?.end(); cluster?.stop(); });

  it("requires accepted assessment; staging is not mint authority", async () => {
    await expect(journal.stage(artifact)).rejects.toThrow("accepted assessment");
    await seedAccepted(); await journal.stage(artifact);
    expect(await journal.load(artifact.assessment.handle, true)).toBeUndefined();
    await expect(journal.complete(artifact.digest)).rejects.toThrow("evidence incomplete");
    expect(await journal.load("other")).toBeUndefined();
  });
  it("stages exact private backups, then completes only after six immutable observations", async () => {
    await seedAccepted(); const input = transports(); await publishPublicArtifact(input);
    const saved = await journal.load(artifact.assessment.handle, true); expect(saved).toEqual(artifact);
    expect((await admin.query("SELECT count(*)::int AS n FROM open_mint.publication_observations WHERE namespace_id=$1", [namespaceId])).rows[0].n).toBe(6);
    await publishPublicArtifact(input);
    expect((await admin.query("SELECT count(*)::int AS n FROM open_mint.completed_publications WHERE namespace_id=$1", [namespaceId])).rows[0].n).toBe(1);
  });
  it("restores identical bytes after writer restart without render/provider calls", async () => {
    await seedAccepted(); await journal.stage(artifact);
    await journal.uploaded(artifact.digest, artifact.svg.object, "pin-a");
    await writer.close(); writer = await ExclusiveWriter.acquire(factory); journal = await PostgresPublicationJournal.open(writer, profile());
    const saved = await journal.load(artifact.assessment.handle.toUpperCase()); expect(saved).toEqual(artifact);
    expect(await journal.load(artifact.assessment.handle, true)).toBeUndefined();
    await publishPublicArtifact({ ...transports(), artifact: saved! });
    expect(await journal.load(artifact.assessment.handle, true)).toEqual(artifact);
  });
  it.each(["origin", "source", "destination", "namespaceId"] as const)("rejects mismatching %s at startup", async field => {
    const changed = { ...profile(), [field]: field === "origin" ? "https://elsewhere.example" : field === "namespaceId" ? randomUUID() : "other" };
    await expect(PostgresPublicationJournal.open(writer, changed)).rejects.toThrow("profile mismatch");
  });
  it("rejects ambiguous identities and nonpublic origins", async () => {
    await expect(PostgresPublicationJournal.open(writer, { ...profile(), source: "pin-a" })).rejects.toThrow("identities");
    await expect(PostgresPublicationJournal.open(writer, { ...profile(), origin: "http://localhost" })).rejects.toThrow("origin");
  });
  it("rejects a different origin or assessment without replacing staged work", async () => {
    await seedAccepted(); await journal.stage(artifact);
    const elsewhere = await preparePublicArtifact({ assessment: artifact.assessment, origin: "https://elsewhere.example" });
    await expect(journal.stage(elsewhere)).rejects.toThrow("origin mismatch");
    const changed = { ...syntheticPublicAssessment(), mbti: "ISTJ" as const };
    const other = await preparePublicArtifact({ assessment: validateAssessment({ ...changed, digest: assessmentDigest(changed) }), origin: profile().origin });
    await expect(journal.stage(other)).rejects.toThrow("accepted assessment");
    expect(await journal.load(artifact.assessment.handle)).toEqual(artifact);
  });
  it("rejects wrong objects, identities and retrieval without upload", async () => {
    await seedAccepted(); await journal.stage(artifact);
    await expect(journal.beforeUpload(artifact.digest, { ...artifact.svg.object, byteLength: 1 })).rejects.toThrow("not bound");
    await expect(journal.uploaded(artifact.digest, artifact.svg.object, "wrong")).rejects.toThrow("identity mismatch");
    await expect(journal.retrieved(artifact.digest, artifact.svg.object, "reader-b")).rejects.toThrow("upload evidence");
    await expect(journal.beforeUpload(`0x${"01".repeat(32)}`, artifact.svg.object)).rejects.toThrow("not staged");
  });
  it("never marks complete on mismatching independent retrieval; exact backup remains reusable", async () => {
    await seedAccepted(); const input = transports(); input.reader.retrieve.mockResolvedValueOnce(Buffer.from("wrong"));
    await expect(publishPublicArtifact(input)).rejects.toThrow("descriptor");
    expect(await journal.load(artifact.assessment.handle, true)).toBeUndefined();
    expect(await journal.load(artifact.assessment.handle)).toEqual(artifact);
    await publishPublicArtifact(transports());
    expect(await journal.load(artifact.assessment.handle, true)).toEqual(artifact);
  });
  it("a stopped writer cannot upload after staging", async () => {
    await seedAccepted(); await journal.stage(artifact); await writer.close();
    const input = transports(); await expect(publishPublicArtifact(input)).rejects.toThrow(WriterUnavailableError);
    expect(input.uploader.upload).not.toHaveBeenCalled();
  });
  it("rolls back staging if object storage fails; no upload takes place", async () => {
    await seedAccepted();
    await admin.query(`CREATE FUNCTION open_mint.test_fail_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected storage failure'; END $$;
      CREATE TRIGGER test_fail_publication BEFORE INSERT ON open_mint.public_artifacts FOR EACH ROW EXECUTE FUNCTION open_mint.test_fail_publication()`);
    const input = transports();
    try { await expect(publishPublicArtifact(input)).rejects.toThrow("injected storage failure"); }
    finally { await admin.query("DROP TRIGGER test_fail_publication ON open_mint.public_artifacts; DROP FUNCTION open_mint.test_fail_publication()"); }
    expect(input.uploader.upload).not.toHaveBeenCalled(); expect(await journal.load(artifact.assessment.handle)).toBeUndefined();
  });
  it.each(["publication_profiles", "public_artifacts", "publication_observations", "completed_publications"])("rejects mutation/deletion of %s", async table => {
    await seedAccepted(); await publishPublicArtifact(transports());
    await expect(admin.query(`DELETE FROM open_mint.${table} WHERE namespace_id=$1`, [namespaceId])).rejects.toMatchObject({ code: "55000" });
    await expect(admin.query(`UPDATE open_mint.${table} SET namespace_id=namespace_id WHERE namespace_id=$1`, [namespaceId])).rejects.toMatchObject({ code: "55000" });
  });
  it("database also rejects forged receipt identity and premature completion", async () => {
    await seedAccepted(); await journal.stage(artifact);
    await expect(admin.query("INSERT INTO open_mint.publication_observations(namespace_id,digest,object_kind,phase,identity) VALUES ($1,$2,'svg','uploaded','wrong')", [namespaceId, artifact.digest])).rejects.toThrow("identity mismatch");
    await expect(admin.query("INSERT INTO open_mint.completed_publications(namespace_id,digest) VALUES ($1,$2)", [namespaceId, artifact.digest])).rejects.toThrow("evidence incomplete");
  });
  it.each(["digest", "assessment_id"] as const)("refuses a restored assessment with corrupted indexed %s", async field => {
    await seedAccepted(); await journal.stage(artifact);
    // Fault injection only in this disposable database, never an application migration.
    await admin.query("ALTER TABLE open_mint.assessments DISABLE TRIGGER immutable_assessment");
    try { await admin.query(`UPDATE open_mint.assessments SET ${field}=$2 WHERE namespace_id=$1`, [namespaceId, field === "digest" ? `0x${"01".repeat(32)}` : randomUUID()]); }
    finally { await admin.query("ALTER TABLE open_mint.assessments ENABLE TRIGGER immutable_assessment"); }
    await expect(journal.stage(artifact)).rejects.toThrow("exact accepted assessment");
    await expect(journal.load(artifact.assessment.handle)).rejects.toThrow("exact accepted assessment");
    await expect(journal.beforeUpload(artifact.digest, artifact.svg.object)).rejects.toThrow("exact accepted assessment");
  });
  it("rejects an internally consistent restored publication for a different assessment of the same handle", async () => {
    await seedAccepted();
    const changed = { ...artifact.assessment, mbti: "ISTJ" as const };
    const other = await preparePublicArtifact({ assessment: validateAssessment({ ...changed, digest: assessmentDigest(changed) }), origin: profile().origin });
    const { svg, png, metadata, ...rest } = other;
    await admin.query("INSERT INTO open_mint.public_artifacts(namespace_id,handle,digest,header,svg,png,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [namespaceId, other.assessment.handle, other.digest, Buffer.from(canonicalize({ ...rest, svg: svg.object, png: png.object, metadata: metadata.object })!), Buffer.from(svg.bytes), Buffer.from(png.bytes), Buffer.from(metadata.bytes)]);
    for (const kind of ["svg", "png", "metadata"]) for (const phase of ["uploaded", "retrieved"]) {
      await admin.query("INSERT INTO open_mint.publication_observations(namespace_id,digest,object_kind,phase,identity) VALUES ($1,$2,$3,$4,$5)",
        [namespaceId, other.digest, kind, phase, phase === "uploaded" ? "pin-a" : "reader-b"]);
    }
    await admin.query("INSERT INTO open_mint.completed_publications(namespace_id,digest) VALUES ($1,$2)", [namespaceId, other.digest]);
    await expect(journal.load(artifact.assessment.handle, true)).rejects.toThrow("exact accepted assessment");
  });
  it("rejects corrupted verification receipts even when completion exists", async () => {
    await seedAccepted(); await publishPublicArtifact(transports());
    await admin.query("ALTER TABLE open_mint.publication_observations DISABLE TRIGGER immutable_publication_observation");
    try { await admin.query("UPDATE open_mint.publication_observations SET identity='wrong' WHERE namespace_id=$1 AND phase='retrieved'", [namespaceId]); }
    finally { await admin.query("ALTER TABLE open_mint.publication_observations ENABLE TRIGGER immutable_publication_observation"); }
    await expect(journal.load(artifact.assessment.handle, true)).rejects.toThrow("evidence incomplete");
    await expect(journal.complete(artifact.digest)).rejects.toThrow("evidence incomplete");
  });
  it("restores exact frozen bytes and receipts from a database backup", async () => {
    await seedAccepted(); await publishPublicArtifact(transports()); await writer.close();
    const binary = (name: string) => process.env.OPEN_MINT_TEST_POSTGRES_BIN ? resolve(process.env.OPEN_MINT_TEST_POSTGRES_BIN, name) : name;
    const dump = execFileSync(binary("pg_dump"), ["--host", String(cluster.config.host), "--username", "open_mint_test", "--dbname", "postgres",
      "--schema", "open_mint", "--no-owner", "--no-privileges"], { maxBuffer: 32 * 1024 * 1024 });
    const restored = disposablePostgres(); let replacement: ExclusiveWriter | undefined;
    try {
      execFileSync(binary("psql"), ["--host", String(restored.config.host), "--username", "open_mint_test", "--dbname", "postgres", "--no-psqlrc", "--set", "ON_ERROR_STOP=1"],
        { input: dump, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
      replacement = await ExclusiveWriter.acquire(() => new Client(restored.config));
      const recovered = await PostgresPublicationJournal.open(replacement, profile());
      expect(await recovered.load(artifact.assessment.handle, true)).toEqual(artifact);
      await expect(recovered.stage(artifact)).resolves.toBeUndefined();
      const inspection = new Client(restored.config); await inspection.connect();
      try {
        expect((await inspection.query("SELECT count(*)::int AS n FROM open_mint.publication_observations WHERE namespace_id=$1", [namespaceId])).rows[0].n).toBe(6);
        await expect(inspection.query("DELETE FROM open_mint.public_artifacts WHERE namespace_id=$1", [namespaceId])).rejects.toMatchObject({ code: "55000" });
      } finally { await inspection.end(); }
    } finally { await replacement?.close(); restored.stop(); }
  }, 30000);
});
