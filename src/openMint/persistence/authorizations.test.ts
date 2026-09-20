import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import canonicalize from "canonicalize";
import { Client } from "pg";
import { decodeFunctionData, encodeFunctionResult, numberToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { syntheticPublicAssessment } from "../fixtures/publicAssessment.js";
import { preparePublicArtifact, type PreparedPublicArtifact } from "../publicArtifacts.js";
import { PUBLIC_CHAIN_READ_ABI, PublicChainGate } from "../publicChain.js";
import type { PublicChainRpc } from "../publicChainRpc.js";
import { openMintDigest, openMintHandleKey, openMintTokenURIHash, openMintTypedData, verifyOpenMintAuthorization } from "../authorization.js";
import { opaqueCode } from "../security.js";
import { PostgresAuthorizationIssuer, verifyReservedSignature, type IssuanceIntent, type ReservedAuthorizationSigner } from "./authorizations.js";
import { PostgresPublicationJournal } from "./publication.js";
import { OpenMintRepository, type PersistenceNamespace } from "./repository.js";
import { PostgresMintRequests, type DurableMintRequest } from "./requests.js";
import { capabilityHash, PostgresWalletSessions } from "./sessions.js";
import { ExclusiveWriter, WriterUnavailableError, type OwnershipConnection } from "./writer.js";
import { eligibilityFixture, chainHash } from "./fixtures/eligibility.js";
import { disposablePostgres, installSchema } from "./fixtures/postgres.js";
import { projectionRpcFixture } from "../fixtures/projectionRpc.js";
import { OpenMintProjection } from "../projection/postgres.js";
import { createProjectionCoordinator } from "../projection/coordinator.js";
import { createVerifiedArtworkReads } from "../projection/artwork.js";

// Real cryptography is exercised separately below with an existing public
// literal. Most DB tests stub verification; one explicit offline test uses
// the same public scalar-1 test account as authorization.test.ts. Never custody.
vi.mock("../authorization.js", async importOriginal => ({ ...await importOriginal<typeof import("../authorization.js")>(), verifyOpenMintAuthorization: vi.fn() }));
const actualAuthorization = await vi.importActual<typeof import("../authorization.js")>("../authorization.js");
const signature = "0x194368c98343eaf582ae494b38d5b6780c27398241b4902b8902485689c11ddc25ed91130926c61bef760d6685c4b3e5baef5a8c738742d8a02dce8fd4fd75851b";
const recipient = "0x3333333333333333333333333333333333333333" as Address;
const publicTestAccount = privateKeyToAccount(`0x${"0".repeat(63)}1`);
const privateBytes = (value: unknown): Buffer => Buffer.from(canonicalize(value)!);
const serial = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));

describe("reserved-signature real public-vector verification", () => {
  const value = { domain: { chainId: "31337", verifyingContract: "0x1111111111111111111111111111111111111111" as Address },
    authorizer: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf" as Address,
    authorization: { handleKey: openMintHandleKey("bigu"), recipient: "0x2222222222222222222222222222222222222222" as Address,
      assessmentDigest: chainHash("22"), artifactDigest: chainHash("33"), tokenURIHash: openMintTokenURIHash("ipfs://open-mint-vector/metadata.json"),
      nonce: chainHash("44"), issuedAt: "1800000000", deadline: "1800000900" } };
  beforeEach(() => { vi.mocked(verifyOpenMintAuthorization).mockImplementation(actualAuthorization.verifyOpenMintAuthorization); });
  it("verifies the existing literal without generating a key or signature", async () => {
    expect(await verifyReservedSignature(value, signature)).toBe(true);
    expect(verifyOpenMintAuthorization).toHaveBeenCalledWith(value.domain, value.authorization, signature, value.authorizer);
  });
  it.each(["authorizer", "domain", "nonce", "recipient", "artifact", "signature"])("rejects changed %s", async changed => {
    const copy = structuredClone(value); let result = signature;
    if (changed === "authorizer") copy.authorizer = recipient;
    else if (changed === "domain") copy.domain.chainId = "1";
    else if (changed === "nonce") copy.authorization.nonce = chainHash("99");
    else if (changed === "recipient") copy.authorization.recipient = recipient;
    else if (changed === "artifact") copy.authorization.artifactDigest = chainHash("99");
    else result = "0x00";
    expect(await verifyReservedSignature(copy, result)).toBe(false);
  });
});

describe.skipIf(process.env.OPEN_MINT_TEST_POSTGRES !== "1")("reserve-before-signing foundation (isolated PostgreSQL; offline signers)", () => {
  let cluster: ReturnType<typeof disposablePostgres>, admin: Client, writer: ExclusiveWriter, namespace: PersistenceNamespace,
    gate: ReturnType<typeof eligibilityFixture>, deploymentId: string, repository: OpenMintRepository, journal: PostgresPublicationJournal,
    requests: PostgresMintRequests, issuer: PostgresAuthorizationIssuer, artifact: PreparedPublicArtifact, request: DurableMintRequest,
    token: string, csrf: string, generation: string;
  const factory = () => new Client(cluster.config);
  const signer = (work: ReservedAuthorizationSigner["signTypedData"] = async () => signature) => ({ address: gate.config.authorizer, signTypedData: vi.fn(work) });
  async function witness(nonce = chainHash("33"), observedClock: () => number = Date.now) {
    const c = { ...gate.config, evidenceTtlMs: 60000, maxBlockAgeMs: 3600000 }, timestamp = BigInt(Math.floor(observedClock() / 1000));
    const rpc = (id: string): PublicChainRpc => ({ id, async request(method, params) {
      if (method === "eth_chainId") return numberToHex(c.chainId);
      if (method === "eth_getBlockByNumber") { const n = BigInt(params[0] as string); return { number: numberToHex(n), hash: n === 0n ? c.genesisHash : n === 2n ? c.deploymentBlock.hash : chainHash("10"), timestamp: numberToHex(timestamp) }; }
      if (method === "eth_getCode") return params[0] === c.contract ? "0x60006000" : "0x";
      const name = decodeFunctionData({ abi: PUBLIC_CHAIN_READ_ABI, data: (params[0] as { data: Hex }).data }).functionName;
      const result = name === "eip712Domain" ? ["0x0f", "SignaturesOpenMint", "1", c.chainId, c.contract, chainHash("00"), []] : name === "trustedAuthorizer" ? c.authorizer : false;
      return encodeFunctionResult({ abi: PUBLIC_CHAIN_READ_ABI, functionName: name, result } as Parameters<typeof encodeFunctionResult>[0]);
    } });
    return new PublicChainGate(c, [rpc("mock-one"), rpc("mock-two")], observedClock).preflight({ block: { number: 10n, hash: chainHash("10") }, handle: artifact.assessment.handle, recipient, nonce });
  }
  async function intent(changes: Partial<IssuanceIntent> = {}): Promise<IssuanceIntent> {
    return { code: request.code, sessionToken: token, sessionGeneration: generation, origin: gate.profile.origin, csrf, consent: true, eligibility: await witness(), ...changes };
  }
  async function startIssuer(): Promise<void> {
    repository = await OpenMintRepository.open(writer, namespace); requests = await PostgresMintRequests.open(repository, deploymentId);
    journal = await PostgresPublicationJournal.open(writer, { namespaceId: namespace.id, origin: gate.profile.origin, destination: "mock-upload", source: "mock-reader" });
    issuer = await PostgresAuthorizationIssuer.open(requests, journal);
  }
  async function counts() {
    const result: Record<string, number> = {};
    for (const table of ["authorizations", "authorization_heads", "authorization_signatures"]) result[table] = (await admin.query(`SELECT count(*)::int AS n FROM open_mint.${table} WHERE namespace_id=$1`, [namespace.id])).rows[0].n;
    return result;
  }
  async function state(): Promise<string | undefined> { return (await admin.query("SELECT state FROM open_mint.authorizations WHERE namespace_id=$1", [namespace.id])).rows[0]?.state; }
  async function createRequest(): Promise<DurableMintRequest> {
    return requests.create({ sessionToken: token, origin: gate.profile.origin, csrf, sessionGeneration: generation, recipient,
      handle: artifact.assessment.handle, eligibility: await witness() });
  }
  async function reprove(code?: string): Promise<void> {
    generation = (BigInt(generation) + 1n).toString();
    await admin.query("UPDATE open_mint.sessions SET generation=$3,proof_wallet=NULL,proof_code_hash=NULL,proof_expires_at=NULL WHERE namespace_id=$1 AND session_hash=$2", [namespace.id, capabilityHash(token), generation]);
    await admin.query("UPDATE open_mint.sessions SET proof_wallet=$3,proof_code_hash=$4,proof_expires_at=clock_timestamp()+interval '10 minutes' WHERE namespace_id=$1 AND session_hash=$2", [namespace.id, capabilityHash(token), recipient, code ? capabilityHash(code) : null]);
  }
  async function logout(): Promise<void> {
    const sessions = await PostgresWalletSessions.open({ writer, namespaceId: namespace.id, origin: gate.profile.origin, chainId: 31337 });
    await sessions.logout(token);
  }
  beforeAll(async () => {
    cluster = disposablePostgres(); admin = factory(); await admin.connect(); await installSchema(admin);
    for (const file of ["requests-schema.sql", "publication-schema.sql", "authorization-schema.sql"]) await admin.query(readFileSync(new URL(file, import.meta.url), "utf8"));
    await admin.query(readFileSync(new URL("../projection/projection-schema.sql", import.meta.url), "utf8"));
    await admin.query(readFileSync(new URL("../projection/projection-v2.sql", import.meta.url), "utf8"));
    artifact = await preparePublicArtifact({ assessment: syntheticPublicAssessment(), origin: "https://signatures.example" });
  }, 30000);
  beforeEach(async () => {
    vi.mocked(verifyOpenMintAuthorization).mockReset().mockResolvedValue(true);
    namespace = { id: randomUUID(), profile: "local-real", provenance: "grok", policyVersion: artifact.assessment.policyVersion };
    deploymentId = randomUUID(); gate = eligibilityFixture(namespace.id, deploymentId); token = opaqueCode(); csrf = opaqueCode(); generation = "1";
    gate = { ...gate, config: { ...gate.config, authorizer: publicTestAccount.address }, profile: { ...gate.profile, authorizer: publicTestAccount.address.toLowerCase() } };
    await admin.query("INSERT INTO open_mint.namespaces VALUES($1,'local-real','grok',$2)", [namespace.id, namespace.policyVersion]);
    await admin.query("INSERT INTO open_mint.session_profiles VALUES($1,$2,31337)", [namespace.id, gate.profile.origin]);
    const p = gate.profile;
    await admin.query(`INSERT INTO open_mint.request_profiles(namespace_id,deployment_id,chain_id,contract_address,genesis_hash,runtime_code_hash,authorizer,deployment_block,deployment_block_hash,max_evidence_age_ms,max_block_age_ms,max_future_skew_ms)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [namespace.id, deploymentId, p.chain_id, p.contract_address, p.genesis_hash, p.runtime_code_hash, p.authorizer, p.deployment_block, p.deployment_block_hash, p.max_evidence_age_ms, p.max_block_age_ms, p.max_future_skew_ms]);
    await admin.query("INSERT INTO open_mint.publication_profiles VALUES($1,$2,'mock-upload','mock-reader')", [namespace.id, gate.profile.origin]);
    await admin.query("INSERT INTO open_mint.issuance_profiles VALUES($1,$2,true,600,500,10000,120000,5000)", [namespace.id, deploymentId]);
    await admin.query(`INSERT INTO open_mint.sessions(namespace_id,session_hash,csrf,expires_at,generation,wallet,proof_wallet,proof_expires_at)
      VALUES($1,$2,$3,clock_timestamp()+interval '1 day',1,$4,$4,clock_timestamp()+interval '10 minutes')`, [namespace.id, capabilityHash(token), csrf, recipient]);
    const attempt = randomUUID(), a = artifact.assessment;
    await admin.query("INSERT INTO open_mint.handle_guards VALUES($1,$2)", [namespace.id, a.handle]);
    await admin.query("INSERT INTO open_mint.assessment_attempts(namespace_id,attempt_id,handle,profile_version,admitted_at) VALUES($1,$2,$3,'synthetic-test',now())", [namespace.id, attempt, a.handle]);
    await admin.query("INSERT INTO open_mint.assessments(namespace_id,handle,assessment_id,attempt_id,digest,payload) VALUES($1,$2,$3,$4,$5,$6)", [namespace.id, a.handle, a.id, attempt, a.digest, Buffer.from(JSON.stringify(a))]);
    await admin.query("UPDATE open_mint.assessment_attempts SET state='accepted' WHERE namespace_id=$1", [namespace.id]);
    writer = await ExclusiveWriter.acquire(factory); await startIssuer();
    await journal.stage(artifact);
    for (const kind of ["svg", "png", "metadata"] as const) { await journal.uploaded(artifact.digest, artifact[kind].object, "mock-upload"); await journal.retrieved(artifact.digest, artifact[kind].object, "mock-reader"); }
    await journal.complete(artifact.digest); request = await createRequest();
  });
  afterEach(async () => { await writer?.close(); });
  afterAll(async () => { await admin?.end(); cluster?.stop(); });

  it("commits immutable exact reservation/head and signing fence before the injected signer", async () => {
    const sign = signer(async typedData => {
      expect(await counts()).toEqual({ authorizations: 1, authorization_heads: 1, authorization_signatures: 0 }); expect(await state()).toBe("signing");
      expect(Object.isFrozen(typedData)).toBe(true); expect(Object.isFrozen(typedData.message)).toBe(true);
      expect(typedData.message.artifactDigest).toBe(artifact.digest); expect(typedData.message.assessmentDigest).toBe(artifact.assessment.digest);
      return signature;
    });
    const result = await issuer.issue(await intent(), sign);
    expect(result.signature).toBe(signature); expect(result.reservation.digest).toBe(openMintDigest(result.reservation.domain, result.reservation.authorization));
    expect(await state()).toBe("signed"); expect((await counts()).authorization_signatures).toBe(1);
    expect(verifyOpenMintAuthorization).toHaveBeenCalledWith(result.reservation.domain, result.reservation.authorization, signature, gate.config.authorizer);
    const saved = (await admin.query("SELECT payload FROM open_mint.authorizations WHERE namespace_id=$1", [namespace.id])).rows[0].payload.toString();
    expect(saved).not.toContain(token); expect(saved).not.toContain(request.code);
  });
  it("issues and replays a real verified signature using only the existing public test account offline", async () => {
    vi.mocked(verifyOpenMintAuthorization).mockImplementation(actualAuthorization.verifyOpenMintAuthorization);
    const sign = signer(async typedData => {
      expect(await state()).toBe("signing");
      return publicTestAccount.signTypedData(typedData);
    });
    const first = await issuer.issue(await intent(), sign);
    expect(await actualAuthorization.verifyOpenMintAuthorization(first.reservation.domain, first.reservation.authorization, first.signature, publicTestAccount.address)).toBe(true);
    expect(first.reservation.tokenURI).toBe(artifact.metadata.object.uri);
    const second = await issuer.issue(await intent(), sign);
    expect(second).toEqual(first); expect(sign.signTypedData).toHaveBeenCalledOnce();
  });
  it("resolves historical projection evidence with real cryptography after logout and issuance shutdown, without signing again", async () => {
    vi.mocked(verifyOpenMintAuthorization).mockImplementation(actualAuthorization.verifyOpenMintAuthorization);
    const sign = signer(typedData => publicTestAccount.signTypedData(typedData));
    const saved = await issuer.issue(await intent(), sign);
    await logout(); await admin.query("UPDATE open_mint.issuance_profiles SET enabled=false WHERE namespace_id=$1", [namespace.id]);
    await writer.close(); writer = await ExclusiveWriter.acquire(factory); await startIssuer();
    const before = await counts();
    const result = await issuer.projectionEvidence({ handle: saved.reservation.handle, nonce: saved.reservation.authorization.nonce, authorizationDigest: saved.reservation.digest }, new AbortController().signal);
    expect(result?.reservation).toEqual(saved.reservation); expect(result?.signature).toBe(saved.signature); expect(result?.artifact).toEqual(artifact);
    expect(sign.signTypedData).toHaveBeenCalledOnce(); expect(await counts()).toEqual(before);
  });
  it("composes actual durable signed publication → observer → projection → exact saved reveal, including writer restart", async () => {
    vi.mocked(verifyOpenMintAuthorization).mockImplementation(actualAuthorization.verifyOpenMintAuthorization);
    const sign = signer(typedData => publicTestAccount.signTypedData(typedData)), signed = await issuer.issue(await intent(), sign);
    const rpc = await projectionRpcFixture({ evidence: { ...signed, artifact }, config: gate.config, runtime: "0x60006000" });
    const compose = async () => {
      const p = await OpenMintProjection.open(writer, rpc.options.deployment);
      const coordinator = createProjectionCoordinator(p, { ...rpc.options, resolveMint: issuer.projectionEvidence.bind(issuer) });
      const reads = createVerifiedArtworkReads({ projection: coordinator, journal, namespaceId: namespace.id, origin: artifact.origin, timeoutMs: 2000 });
      return { coordinator, reads, p };
    };
    let { coordinator, reads, p } = await compose(); const signal = () => new AbortController().signal;
    await expect(reads.detail(artifact.assessment.handle, signal())).rejects.toThrow();
    expect(await coordinator.sync(signal())).toBe("observed");
    // Numeric block order must survive digit boundaries (not text "9" > "12").
    expect((await p.chainCursor()).tail.map(pin => pin.number)).toEqual(["7", "8", "9", "10", "11", "12"]);
    expect((await reads.detail(artifact.assessment.handle, signal())).mint?.state).toBe("confirming");
    expect((await coordinator.gallery({ filter: { kind: "home" }, limit: 10 })).items).toHaveLength(0);
    rpc.setFinalized(11); expect(await coordinator.sync(signal())).toBe("observed");
    expect((await reads.media(artifact.assessment.handle, artifact.digest, "png", signal())).bytes).toEqual(artifact.png.bytes);
    expect((await coordinator.gallery({ filter: { kind: "home" }, limit: 10 })).items).toHaveLength(1);
    await writer.close(); writer = await ExclusiveWriter.acquire(factory); await startIssuer(); ({ coordinator, reads } = await compose());
    await expect(reads.detail(artifact.assessment.handle, signal())).rejects.toThrow();
    expect(await coordinator.sync(signal())).toBe("observed");
    expect((await reads.detail(artifact.assessment.handle, signal())).mint?.state).toBe("minted");
    expect(sign.signTypedData).toHaveBeenCalledOnce(); expect(await counts()).toEqual({ authorizations: 1, authorization_heads: 1, authorization_signatures: 1 });
  });
  it.each(["unknown", "reserved", "wrong-nonce", "wrong-digest", "invalid-signature", "cancelled", "missing-publication", "invalid-key"])("projection evidence refuses %s without issuing new authority", async kind => {
    const i = await intent(), sign = signer();
    const reservation = kind === "reserved" ? await issuer.reserve(i) : (await issuer.issue(i, sign)).reservation;
    const log = { handle: reservation.handle, nonce: reservation.authorization.nonce, authorizationDigest: reservation.digest };
    const controller = new AbortController();
    if (kind === "unknown") log.handle = "notminted";
    if (kind === "wrong-nonce") log.nonce = chainHash("99");
    if (kind === "wrong-digest") log.authorizationDigest = chainHash("99");
    if (kind === "invalid-signature") vi.mocked(verifyOpenMintAuthorization).mockResolvedValue(false);
    if (kind === "cancelled") controller.abort();
    if (kind === "missing-publication") vi.spyOn(journal, "load").mockResolvedValue(undefined);
    if (kind === "invalid-key") log.nonce = "invalid" as Hex;
    const before = await counts(), calls = sign.signTypedData.mock.calls.length;
    const result = issuer.projectionEvidence(log, controller.signal);
    if (["invalid-signature", "cancelled", "invalid-key"].includes(kind)) await expect(result).rejects.toThrow();
    else expect(await result).toBeUndefined();
    expect(await counts()).toEqual(before); expect(sign.signTypedData).toHaveBeenCalledTimes(calls);
  });
  it("defaults issuance profiles to disabled and refuses the explicit kill switch before reservation", async () => {
    const defaultValue = (await admin.query("SELECT column_default FROM information_schema.columns WHERE table_schema='open_mint' AND table_name='issuance_profiles' AND column_name='enabled'")).rows[0].column_default;
    expect(defaultValue).toBe("false");
    await admin.query("UPDATE open_mint.issuance_profiles SET enabled=false WHERE namespace_id=$1", [namespace.id]);
    const sign = signer(); await expect(issuer.issue(await intent(), sign)).rejects.toMatchObject({ code: "ISSUANCE_DISABLED" });
    expect(sign.signTypedData).not.toHaveBeenCalled(); expect((await counts()).authorizations).toBe(0);
  });
  it("reuses only the identical saved signature through restart without another signer call", async () => {
    const first = await issuer.issue(await intent(), signer()); await writer.close(); writer = await ExclusiveWriter.acquire(factory); await startIssuer();
    const secondSigner = signer(); const second = await issuer.issue(await intent(), secondSigner);
    expect(second).toEqual(first); expect(secondSigner.signTypedData).not.toHaveBeenCalled(); expect((await counts()).authorizations).toBe(1);
  });
  it("can claim the same untouched reserved payload after writer restart", async () => {
    const reserved = await issuer.reserve(await intent()); await writer.close(); writer = await ExclusiveWriter.acquire(factory); await startIssuer();
    const result = await issuer.issue(await intent(), signer()); expect(result.reservation).toEqual(reserved);
  });
  it("concurrent same-handle issuance dispatches at most one signer", async () => {
    let release!: (value: string) => void, started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const sign = signer(async () => { started(); return new Promise(resolve => { release = resolve; }); });
    const input = await intent(), first = issuer.issue(input, sign); await ready;
    await expect(issuer.issue(input, sign)).rejects.toMatchObject({ code: "SIGNING_UNCERTAIN" });
    release(signature); await first; expect(sign.signTypedData).toHaveBeenCalledTimes(1);
  });
  it.each(["consent", "csrf", "origin", "generation", "invalid-generation", "forged-witness", "recipient"])("refuses %s before any reservation or signing", async failure => {
    let input = await intent();
    if (failure === "consent") input = { ...input, consent: false };
    else if (failure === "csrf") input = { ...input, csrf: opaqueCode() };
    else if (failure === "origin") input = { ...input, origin: "https://other.example" };
    else if (failure === "generation") input = { ...input, sessionGeneration: "2" };
    else if (failure === "invalid-generation") input = { ...input, sessionGeneration: "-1" };
    else if (failure === "forged-witness") input = { ...input, eligibility: {} };
    else await admin.query("UPDATE open_mint.sessions SET wallet=$3 WHERE namespace_id=$1 AND session_hash=$2", [namespace.id, capabilityHash(token), gate.config.authorizer]);
    const sign = signer(); await expect(issuer.issue(input, sign)).rejects.toThrow(); expect(sign.signTypedData).not.toHaveBeenCalled(); expect((await counts()).authorizations).toBe(0);
  });
  it("allows a new matching code-scoped generation, not a different code's proof", async () => {
    await reprove(opaqueCode()); const sign = signer(); await expect(issuer.issue(await intent(), sign)).rejects.toMatchObject({ code: "WALLET_PROOF_REQUIRED" });
    await reprove(request.code); const result = await issuer.issue(await intent(), sign); expect(result.reservation.generation).toBe(generation);
    expect(generation).toBe("3"); expect(sign.signTypedData).toHaveBeenCalledOnce();
  });
  it("blocks expired proof and request without signing or modifying saved work", async () => {
    await admin.query("UPDATE open_mint.sessions SET proof_expires_at=clock_timestamp()-interval '1 second' WHERE namespace_id=$1", [namespace.id]);
    const sign = signer(); await expect(issuer.issue(await intent(), sign)).rejects.toMatchObject({ code: "WALLET_PROOF_REQUIRED" }); await reprove();
    await admin.query("ALTER TABLE open_mint.requests DISABLE TRIGGER immutable_request");
    try { await admin.query(`WITH t AS (SELECT clock_timestamp()-interval '16 minutes' AS created)
      UPDATE open_mint.requests SET created_at=t.created,expires_at=t.created+interval '15 minutes',
      preflight_observed_at=t.created-interval '1 second',preflight_valid_until=t.created+interval '1 second'
      FROM t WHERE namespace_id=$1`, [namespace.id]); }
    finally { await admin.query("ALTER TABLE open_mint.requests ENABLE TRIGGER immutable_request"); }
    await expect(issuer.issue(await intent(), sign)).rejects.toThrow(); expect(sign.signTypedData).not.toHaveBeenCalled(); expect((await counts()).authorizations).toBe(0);
  });
  it("rejects missing completed-publication evidence before reserving", async () => {
    await admin.query("ALTER TABLE open_mint.completed_publications DISABLE TRIGGER immutable_completed_publication");
    try { await admin.query("DELETE FROM open_mint.completed_publications WHERE namespace_id=$1", [namespace.id]); }
    finally { await admin.query("ALTER TABLE open_mint.completed_publications ENABLE TRIGGER immutable_completed_publication"); }
    const sign = signer(); await expect(issuer.issue(await intent(), sign)).rejects.toMatchObject({ code: "NOT_READY" }); expect(sign.signTypedData).not.toHaveBeenCalled();
  });
  it("checks exact publication again inside reservation after load validation", async () => {
    const load = journal.load.bind(journal);
    vi.spyOn(journal, "load").mockImplementationOnce(async (...args) => {
      const saved = await load(...args);
      await admin.query("ALTER TABLE open_mint.publication_observations DISABLE TRIGGER immutable_publication_observation");
      try { await admin.query("UPDATE open_mint.publication_observations SET identity='wrong' WHERE namespace_id=$1 AND phase='retrieved'", [namespace.id]); }
      finally { await admin.query("ALTER TABLE open_mint.publication_observations ENABLE TRIGGER immutable_publication_observation"); }
      return saved;
    });
    const sign = signer(); await expect(issuer.issue(await intent(), sign)).rejects.toMatchObject({ code: "NOT_READY" }); expect((await counts()).authorizations).toBe(0);
  });
  it("checks independently stored freshness limits despite a longer-lived opaque gate", async () => {
    const sign = signer(), old = await witness(chainHash("33"), () => Date.now() - 20000);
    await expect(issuer.issue(await intent({ eligibility: old }), sign)).rejects.toMatchObject({ code: "CHAIN_UNAVAILABLE" }); expect(sign.signTypedData).not.toHaveBeenCalled();
  });
  it("applies stricter issuance freshness independently of a valid request profile", async () => {
    // Operator-level fixture mutation models a profile installed with a stricter
    // immutable limit; runtime has no permission/API to change this field.
    await admin.query("ALTER TABLE open_mint.issuance_profiles DISABLE TRIGGER guard_issuance_profile");
    try { await admin.query("UPDATE open_mint.issuance_profiles SET max_evidence_age_ms=1000 WHERE namespace_id=$1", [namespace.id]); }
    finally { await admin.query("ALTER TABLE open_mint.issuance_profiles ENABLE TRIGGER guard_issuance_profile"); }
    const old = await witness(chainHash("33"), () => Date.now() - 2000), sign = signer();
    await expect(issuer.issue(await intent({ eligibility: old }), sign)).rejects.toMatchObject({ code: "CHAIN_UNAVAILABLE" });
    expect(sign.signTypedData).not.toHaveBeenCalled(); expect((await counts()).authorizations).toBe(0);
  });
  it("rejects changed nonce or request while preserving the same per-handle head", async () => {
    const original = await issuer.reserve(await intent());
    await expect(issuer.reserve(await intent({ eligibility: await witness(chainHash("44")) }))).rejects.toMatchObject({ code: "CHAIN_UNAVAILABLE" });
    const other = await createRequest(); await expect(issuer.reserve(await intent({ code: other.code }))).rejects.toMatchObject({ code: "MINT_RESERVED" });
    expect(await issuer.reserve(await intent())).toEqual(original); expect((await counts()).authorizations).toBe(1);
  });
  it("keeps a durable unknown fence after signer rejection, malformed signature or timeout", async () => {
    const sign = signer(async () => { throw new Error("private signer URL/token must not leak"); });
    await expect(issuer.issue(await intent(), sign)).rejects.toMatchObject({ code: "SIGNING_UNCERTAIN", message: "The signing result is unavailable or invalid; its reservation is preserved." });
    expect(await state()).toBe("unknown"); await expect(issuer.issue(await intent(), sign)).rejects.toMatchObject({ code: "SIGNING_UNCERTAIN" }); expect(sign.signTypedData).toHaveBeenCalledOnce();
  });
  it("real invalid signature rejection persists uncertainty and returns no authority", async () => {
    vi.mocked(verifyOpenMintAuthorization).mockImplementation(actualAuthorization.verifyOpenMintAuthorization);
    const sign = signer(); await expect(issuer.issue(await intent(), sign)).rejects.toMatchObject({ code: "SIGNING_UNCERTAIN" });
    expect(await state()).toBe("unknown"); expect((await counts()).authorization_signatures).toBe(0);
  });
  it("rejects a signer completion past its monotonic deadline even before timers run", async () => {
    const input = await intent(); let elapsed = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    try {
      const sign = signer(async () => { elapsed = 1000; return signature; });
      await expect(issuer.issue(input, sign)).rejects.toMatchObject({ code: "SIGNING_UNCERTAIN" });
      expect(sign.signTypedData).toHaveBeenCalledOnce();
      expect(await state()).toBe("unknown"); expect((await counts()).authorization_signatures).toBe(0);
    } finally { clock.mockRestore(); }
  });
  it("times out a hung signer and ignores a late valid-looking result", async () => {
    let release!: (value: string) => void, signal: AbortSignal | undefined;
    const sign = signer(async (_data, inputSignal) => { signal = inputSignal; return new Promise(resolve => { release = resolve; }); });
    await expect(issuer.issue(await intent(), sign)).rejects.toMatchObject({ code: "SIGNING_UNCERTAIN" });
    expect(signal?.aborted).toBe(true); release(signature); await Promise.resolve();
    expect(await state()).toBe("unknown"); expect((await counts()).authorization_signatures).toBe(0);
  });
  it("persists a returned signature but never releases it after logout", async () => {
    const sign = signer(async () => { await logout(); return signature; });
    await expect(issuer.issue(await intent(), sign)).rejects.toMatchObject({ code: "SESSION_REQUIRED" });
    expect(await state()).toBe("signed"); expect((await counts()).authorization_signatures).toBe(1);
  });
  it("fences a same-wallet fresh proof generation after signing without releasing or replacing the reservation", async () => {
    const sign = signer(async () => { await reprove(request.code); return signature; });
    await expect(issuer.issue(await intent(), sign)).rejects.toMatchObject({ code: "WALLET_CHANGED" });
    expect(await state()).toBe("signed");
    await expect(issuer.issue(await intent(), sign)).rejects.toMatchObject({ code: "MINT_RESERVED" });
    expect(sign.signTypedData).toHaveBeenCalledOnce(); expect((await counts()).authorizations).toBe(1);
  });
  it("does not release when the issuance kill switch changes during signing", async () => {
    const sign = signer(async () => { await admin.query("UPDATE open_mint.issuance_profiles SET enabled=false WHERE namespace_id=$1", [namespace.id]); return signature; });
    await expect(issuer.issue(await intent(), sign)).rejects.toMatchObject({ code: "ISSUANCE_DISABLED" }); expect(await state()).toBe("signed");
  });
  it("rolls back a reservation/head write fault before any signer call", async () => {
    await admin.query(`CREATE FUNCTION open_mint.fail_head() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'head write fault'; END $$;
      CREATE TRIGGER fail_head BEFORE INSERT ON open_mint.authorization_heads FOR EACH ROW EXECUTE FUNCTION open_mint.fail_head()`);
    const sign = signer();
    try { await expect(issuer.issue(await intent(), sign)).rejects.toThrow("head write fault"); }
    finally { await admin.query("DROP TRIGGER fail_head ON open_mint.authorization_heads; DROP FUNCTION open_mint.fail_head()"); }
    expect(sign.signTypedData).not.toHaveBeenCalled(); expect((await counts()).authorizations).toBe(0);
  });
  it("keeps signing uncertainty if signature persistence fails; no automatic redispatch", async () => {
    await admin.query(`CREATE FUNCTION open_mint.fail_signature() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'signature write fault'; END $$;
      CREATE TRIGGER fail_signature BEFORE INSERT ON open_mint.authorization_signatures FOR EACH ROW EXECUTE FUNCTION open_mint.fail_signature()`);
    const sign = signer();
    try { await expect(issuer.issue(await intent(), sign)).rejects.toThrow("signature write fault"); }
    finally { await admin.query("DROP TRIGGER fail_signature ON open_mint.authorization_signatures; DROP FUNCTION open_mint.fail_signature()"); }
    expect(await state()).toBe("signing"); await writer.close(); writer = await ExclusiveWriter.acquire(factory); await startIssuer();
    await expect(issuer.issue(await intent(), sign)).rejects.toMatchObject({ code: "SIGNING_UNCERTAIN" }); expect(sign.signTypedData).toHaveBeenCalledOnce();
  });
  it("never releases after writer ownership is lost during signing", async () => {
    const sign = signer(async () => { await writer.close(); return signature; });
    await expect(issuer.issue(await intent(), sign)).rejects.toThrow(WriterUnavailableError);
    writer = await ExclusiveWriter.acquire(factory); await startIssuer(); expect(await state()).toBe("signing");
    await expect(issuer.issue(await intent(), signer())).rejects.toMatchObject({ code: "SIGNING_UNCERTAIN" });
  });
  it.each(["reservation", "claim", "signature"])("losing the %s COMMIT acknowledgement never dispatches/retries or releases authority", async boundary => {
    await writer.close();
    const connection = factory(), query = connection.query.bind(connection) as OwnershipConnection["query"];
    let commitTarget = false;
    connection.query = (async (sql: string, values?: unknown[]) => {
      const result = await query(sql, values);
      if ((boundary === "reservation" && sql.startsWith("INSERT INTO open_mint.authorizations("))
        || (boundary === "claim" && sql.startsWith("UPDATE open_mint.authorizations SET state='signing'"))
        || (boundary === "signature" && sql.startsWith("INSERT INTO open_mint.authorization_signatures("))) commitTarget = true;
      if (sql === "COMMIT" && commitTarget) throw new Error("synthetic committed reply loss");
      return result;
    }) as typeof connection.query;
    writer = await ExclusiveWriter.acquire(() => connection); await startIssuer();
    const sign = signer(); await expect(issuer.issue(await intent(), sign)).rejects.toThrow(WriterUnavailableError);
    expect(sign.signTypedData).toHaveBeenCalledTimes(boundary === "signature" ? 1 : 0);
    expect(await state()).toBe(boundary === "reservation" ? "reserved" : boundary === "claim" ? "signing" : "signed");
    await expect(issuer.issue(await intent(), sign)).rejects.toThrow(WriterUnavailableError);
    await writer.close(); writer = await ExclusiveWriter.acquire(factory); await startIssuer();
    if (boundary === "claim") await expect(issuer.issue(await intent(), signer())).rejects.toMatchObject({ code: "SIGNING_UNCERTAIN" });
    if (boundary === "signature") {
      const replaySigner = signer(); await expect(issuer.issue(await intent(), replaySigner)).resolves.toMatchObject({ signature });
      expect(replaySigner.signTypedData).not.toHaveBeenCalled();
    }
  });
  it.each([true, false])("accepts only identical pre-existing signature bytes (identical=%s)", async identical => {
    const sign = signer(async () => {
      await admin.query("INSERT INTO open_mint.authorization_signatures(namespace_id,authorization_id,signature) SELECT namespace_id,authorization_id,$2 FROM open_mint.authorizations WHERE namespace_id=$1", [namespace.id, identical ? signature : `0x00${signature.slice(4)}`]);
      return signature;
    });
    if (identical) await expect(issuer.issue(await intent(), sign)).resolves.toMatchObject({ signature });
    else await expect(issuer.issue(await intent(), sign)).rejects.toThrow("Conflicting immutable signature");
    expect(await state()).toBe(identical ? "signed" : "signing"); expect(sign.signTypedData).toHaveBeenCalledOnce();
  });
  it("does not release or replace an expired preserved reservation", async () => {
    await issuer.reserve(await intent()); const row = (await admin.query("SELECT payload FROM open_mint.authorizations WHERE namespace_id=$1", [namespace.id])).rows[0];
    const value = JSON.parse(row.payload.toString()), seconds = Math.floor(Date.now() / 1000);
    value.authorization.issuedAt = String(seconds - 100); value.authorization.deadline = String(seconds - 1);
    value.digest = openMintDigest(value.domain, value.authorization); value.typedData = serial(openMintTypedData(value.domain, value.authorization));
    await admin.query("ALTER TABLE open_mint.authorizations DISABLE TRIGGER guard_authorization");
    try { await admin.query("UPDATE open_mint.authorizations SET issued_at=$2,deadline=$3,authorization_digest=$4,payload=$5 WHERE namespace_id=$1", [namespace.id, value.authorization.issuedAt, value.authorization.deadline, value.digest, privateBytes(value)]); }
    finally { await admin.query("ALTER TABLE open_mint.authorizations ENABLE TRIGGER guard_authorization"); }
    await expect(issuer.issue(await intent(), signer())).rejects.toMatchObject({ code: "AUTHORIZATION_EXPIRED" });
    const other = await createRequest(); await expect(issuer.reserve(await intent({ code: other.code }))).rejects.toMatchObject({ code: "MINT_RESERVED" });
    expect((await counts()).authorizations).toBe(1);
  });
  it("rejects immutable reservation/head/signature rewrites at database boundary", async () => {
    await issuer.issue(await intent(), signer());
    for (const table of ["authorizations", "authorization_heads", "authorization_signatures"]) await expect(admin.query(`DELETE FROM open_mint.${table} WHERE namespace_id=$1`, [namespace.id])).rejects.toMatchObject({ code: "55000" });
    await expect(admin.query("UPDATE open_mint.authorizations SET nonce=$2 WHERE namespace_id=$1", [namespace.id, chainHash("99")])).rejects.toMatchObject({ code: "55000" });
    await expect(admin.query("UPDATE open_mint.authorization_signatures SET signature=$2 WHERE namespace_id=$1", [namespace.id, signature])).rejects.toMatchObject({ code: "55000" });
  });
  it("does not grant PUBLIC execution of additive trigger functions", async () => {
    const rows = (await admin.query(`SELECT p.proname, EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='open_mint'
      AND p.proname IN ('guard_issuance_profile','guard_authorization_change','guard_signature_insert')`)).rows;
    expect(rows).toHaveLength(3); expect(rows.every(row => row.public_execute === false)).toBe(true);
  });
  it("refuses wrong signer identity before reads and public-mode issuers at startup", async () => {
    const sign = { ...signer(), address: recipient }; await expect(issuer.issue(await intent(), sign)).rejects.toMatchObject({ code: "SIGNER_MISMATCH" }); expect(sign.signTypedData).not.toHaveBeenCalled();
    const wrong = { ...requests, repository: { ...repository, writer, namespace: { ...namespace, profile: "production" } } } as unknown as PostgresMintRequests;
    await expect(PostgresAuthorizationIssuer.open(wrong, journal)).rejects.toMatchObject({ code: "ISSUANCE_DISABLED" });
  });
});
