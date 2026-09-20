import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AssessmentProvider } from "../assessment.js";
import { verifyOpenMintAuthorization } from "../authorization.js";
import { preparePublicArtifact } from "../publicArtifacts.js";
import { publishPublicArtifact } from "../publicPublication.js";
import type { XIdentityResolver } from "../xIdentity.js";
import { PostgresAssessmentWorker, type AssessmentWorkerIntent } from "./assessmentWorker.js";
import { PostgresAuthorizationIssuer, type IssuanceIntent, type ReservedAuthorizationSigner } from "./authorizations.js";
import { identity, namespace, receipt } from "./fixtures/data.js";
import { eligibilityFixture } from "./fixtures/eligibility.js";
import { disposablePostgres, installSchema } from "./fixtures/postgres.js";
import { PostgresPublicationJournal } from "./publication.js";
import { OpenMintRepository } from "./repository.js";
import { PostgresMintRequests } from "./requests.js";
import { PostgresWalletSessions } from "./sessions.js";
import { ExclusiveWriter } from "./writer.js";

// Public scalar-1/scalar-2 test accounts; never live custody or a chain write.
const authorizer = privateKeyToAccount(`0x${"0".repeat(63)}1`);
const wallet = privateKeyToAccount(`0x${"0".repeat(63)}2`);

describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1")("durable preparation pipeline composition (offline mocks, actual PostgreSQL and ECDSA)", () => {
  let cluster: ReturnType<typeof disposablePostgres>, admin: Client, writer: ExclusiveWriter | undefined;
  const factory = () => new Client(cluster.config);
  beforeAll(async () => {
    cluster = disposablePostgres(); admin = factory(); await admin.connect(); await installSchema(admin);
    for (const file of ["requests-schema.sql", "publication-schema.sql", "authorization-schema.sql"]) {
      await admin.query(readFileSync(new URL(file, import.meta.url), "utf8"));
    }
  }, 30000);
  afterAll(async () => { await writer?.close(); await admin?.end(); cluster?.stop(); });

  it("accepts once, blocks incomplete publication, signs once, and reuses exact bytes after writer restart", async () => {
    const ns = { ...namespace(), profile: "local-real" as const, provenance: "grok" as const };
    const deploymentId = randomUUID(), gate = eligibilityFixture(ns.id, deploymentId);
    const p = { ...gate.profile, authorizer: authorizer.address.toLowerCase() };
    const witness = () => gate.witness("alice", wallet.address, { authorizer: authorizer.address });
    // Only isolated test configuration is seeded. Results, requests, proofs,
    // receipts, publication observations and signatures use the actual APIs.
    await admin.query("INSERT INTO open_mint.namespaces VALUES($1,$2,$3,$4)", [ns.id, ns.profile, ns.provenance, ns.policyVersion]);
    await admin.query(`INSERT INTO open_mint.budget_policies(namespace_id,profile_version,expected_model,generation_enabled,valid_until,max_total,max_daily,max_active,max_queued,reservation_usd_ticks,max_exposure_usd_ticks)
      VALUES($1,'offline-pipeline-test','grok-offline-test',true,'2099-01-01',1,1,1,1,100,1000)`, [ns.id]);
    await admin.query("INSERT INTO open_mint.session_profiles VALUES($1,$2,31337)", [ns.id, p.origin]);
    await admin.query(`INSERT INTO open_mint.request_profiles(namespace_id,deployment_id,chain_id,contract_address,genesis_hash,runtime_code_hash,authorizer,deployment_block,deployment_block_hash,max_evidence_age_ms,max_block_age_ms,max_future_skew_ms)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [ns.id, deploymentId, p.chain_id, p.contract_address, p.genesis_hash,
      p.runtime_code_hash, p.authorizer, p.deployment_block, p.deployment_block_hash, p.max_evidence_age_ms, p.max_block_age_ms, p.max_future_skew_ms]);
    await admin.query("INSERT INTO open_mint.publication_profiles VALUES($1,$2,'mock-upload','mock-independent-reader')", [ns.id, p.origin]);
    await admin.query("INSERT INTO open_mint.issuance_profiles VALUES($1,$2,true,600,5000,10000,120000,5000)", [ns.id, deploymentId]);

    writer = await ExclusiveWriter.acquire(factory);
    let repository = await OpenMintRepository.open(writer, ns);
    let requests = await PostgresMintRequests.open(repository, deploymentId);
    const sessionConfig = { namespaceId: ns.id, origin: p.origin, chainId: 31337 };
    let sessions = await PostgresWalletSessions.open({ ...sessionConfig, writer });
    let session = (await sessions.session()).session;
    const challenge = await sessions.challenge(session.id, wallet.address);
    await sessions.verify(session.id, challenge.challengeId, await wallet.signMessage({ message: challenge.message }));
    session = (await sessions.session(sessions.cookie(session))).session;
    const request = await requests.create({ sessionToken: session.id, sessionGeneration: session.generation,
      origin: p.origin, csrf: session.csrf, recipient: wallet.address, handle: "Alice", eligibility: await witness() });
    const intent = async (): Promise<AssessmentWorkerIntent> => ({ code: request.code, sessionToken: session.id,
      sessionGeneration: session.generation, origin: p.origin, csrf: session.csrf, eligibility: await witness() });
    const issuerIntent = async (): Promise<IssuanceIntent> => ({ ...await intent(), consent: true });
    const resolver: XIdentityResolver = { provenance: "x-api", resolve: vi.fn<XIdentityResolver["resolve"]>(async (handle, execution) => {
      await execution!.recordReceipt(receipt("x-identity", "1"));
      return { ...identity(handle), username: "Alice", provenance: "x-api" };
    }) };
    const provider: AssessmentProvider = { provenance: "grok", model: "grok-offline-test", assess: vi.fn<AssessmentProvider["assess"]>(async (handle, snapshot, execution) => {
      await execution!.recordReceipt(receipt("grok", "1"));
      return { handle, mbti: "INTJ", model: "grok-offline-test", providerResponseId: "offline-pipeline-test",
        sourceUrls: ["https://x.com/Alice"], xUserId: snapshot!.userId };
    }) };
    const worker = new PostgresAssessmentWorker(requests, { timeoutMs: 10000, provider, identityResolver: resolver, refreshEligibility: witness });
    const result = await worker.run(await intent());
    expect(result.kind).toBe("accepted"); if (result.kind !== "accepted") throw new Error("Offline assessment not accepted");
    expect((await requests.get(request.code, session.id)).status).toBe("assessment-accepted");
    const assessmentBytes = (await admin.query<{ payload: Buffer }>("SELECT payload FROM open_mint.assessments WHERE namespace_id=$1", [ns.id])).rows[0].payload;
    expect(JSON.parse(assessmentBytes.toString())).toEqual(result.assessment);
    const artifact = await preparePublicArtifact({ assessment: result.assessment, origin: p.origin });
    let journal = await PostgresPublicationJournal.open(writer, { namespaceId: ns.id, origin: p.origin,
      destination: "mock-upload", source: "mock-independent-reader" });
    let issuer = await PostgresAuthorizationIssuer.open(requests, journal);
    const signer: ReservedAuthorizationSigner = { address: authorizer.address, signTypedData: vi.fn(data => authorizer.signTypedData(data)) };
    const remote = new Map<string, Uint8Array>();
    let corruptRead = true;
    const uploader = { id: "mock-upload", upload: vi.fn(async (object: { uri: string }, bytes: Uint8Array) => { remote.set(object.uri, Uint8Array.from(bytes)); }) };
    const reader = { id: "mock-independent-reader", retrieve: vi.fn(async (object: { uri: string }) => {
      const saved = remote.get(object.uri); if (!saved) throw new Error("Missing offline object");
      const bytes = Uint8Array.from(saved); if (corruptRead) bytes[0] ^= 1; return bytes;
    }) };
    await expect(publishPublicArtifact({ artifact, journal, uploader, reader, timeoutMs: 1000 })).rejects.toThrow();
    await expect(issuer.issue(await issuerIntent(), signer)).rejects.toThrow();
    expect(signer.signTypedData).not.toHaveBeenCalled();
    corruptRead = false;
    await publishPublicArtifact({ artifact, journal, uploader, reader, timeoutMs: 1000 });
    const issued = await issuer.issue(await issuerIntent(), signer);
    expect(issued.reservation.authorization.assessmentDigest).toBe(result.assessment.digest);
    expect(issued.reservation.authorization.artifactDigest).toBe(artifact.digest);
    expect(issued.reservation.tokenURI).toBe(artifact.metadata.object.uri);
    expect(await verifyOpenMintAuthorization(issued.reservation.domain, issued.reservation.authorization,
      issued.signature, authorizer.address)).toBe(true);

    // Restart just this disposable writer; no active application/pilot is used.
    await writer.close(); writer = await ExclusiveWriter.acquire(factory);
    repository = await OpenMintRepository.open(writer, ns); requests = await PostgresMintRequests.open(repository, deploymentId);
    sessions = await PostgresWalletSessions.open({ ...sessionConfig, writer });
    expect((await sessions.session(sessions.cookie(session))).session).toEqual(session);
    await admin.query("UPDATE open_mint.budget_policies SET generation_enabled=false WHERE namespace_id=$1", [ns.id]);
    const reused = await new PostgresAssessmentWorker(requests, { timeoutMs: 10000 }).run(await intent());
    expect(reused).toEqual({ ...result, reused: true });
    journal = await PostgresPublicationJournal.open(writer, { namespaceId: ns.id, origin: p.origin,
      destination: "mock-upload", source: "mock-independent-reader" });
    issuer = await PostgresAuthorizationIssuer.open(requests, journal);
    expect(await issuer.issue(await issuerIntent(), signer)).toEqual(issued);
    const saved = await journal.load(artifact.assessment.handle, true);
    expect(saved).toEqual(artifact);
    if (!saved) throw new Error("Completed offline publication missing");
    expect(saved.assessment).toEqual(result.assessment);
    expect((await admin.query<{ payload: Buffer }>("SELECT payload FROM open_mint.assessments WHERE namespace_id=$1", [ns.id])).rows[0].payload).toEqual(assessmentBytes);
    expect(provider.assess).toHaveBeenCalledOnce(); expect(resolver.resolve).toHaveBeenCalledOnce();
    expect(signer.signTypedData).toHaveBeenCalledOnce();
    for (const table of ["assessment_attempts", "budget_reservations", "assessments", "authorization_signatures"]) {
      expect((await admin.query(`SELECT count(*)::int AS n FROM open_mint.${table} WHERE namespace_id=$1`, [ns.id])).rows[0].n).toBe(1);
    }
  }, 30000);
});
