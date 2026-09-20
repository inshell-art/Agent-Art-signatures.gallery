import { performance } from "node:perf_hooks";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { preparePublicArtifact, type PreparedPublicArtifact, type PublicObject } from "./publicArtifacts.js";
import { publishPublicArtifact, type PublicPublicationJournal } from "./publicPublication.js";
import { syntheticPublicAssessment } from "./fixtures/publicAssessment.js";

describe("explicit immutable publication pass (mock transports)", () => {
  let artifact: PreparedPublicArtifact;
  beforeAll(async () => { artifact = await preparePublicArtifact({ assessment: syntheticPublicAssessment(), origin: "https://gallery.example" }); });
  function setup() {
    const remote = new Map<string, Uint8Array>(), calls: string[] = [];
    const journal: PublicPublicationJournal = {
      stage: vi.fn(async () => { calls.push("stage"); }),
      beforeUpload: vi.fn(async () => { calls.push("ownership"); }),
      uploaded: vi.fn(async () => { calls.push("upload-saved"); }),
      retrieved: vi.fn(async () => { calls.push("retrieval-saved"); }),
      complete: vi.fn(async () => { calls.push("complete"); }),
    };
    const uploader = { id: "pin-a", upload: vi.fn(async (object: PublicObject, bytes: Uint8Array, _signal: AbortSignal) => { calls.push("upload"); remote.set(object.uri, Uint8Array.from(bytes)); }) };
    const reader = { id: "independent-gateway-b", retrieve: vi.fn(async (object: PublicObject, _options: { signal: AbortSignal; maxBytes: number }) => { calls.push("retrieve"); return remote.get(object.uri)!; }) };
    return { artifact, timeoutMs: 1000, uploader, reader, journal, calls, remote };
  }
  it("stages exact bytes first and requires all independent retrievals before completing", async () => {
    const input = setup();
    await expect(publishPublicArtifact(input)).resolves.toEqual({ artifactDigest: artifact.digest, tokenURI: artifact.metadata.object.uri });
    expect(input.calls).toEqual(["stage", ...Array(3).fill(["ownership", "upload", "upload-saved", "retrieve", "retrieval-saved"]).flat(), "complete"]);
    expect(input.uploader.upload).toHaveBeenCalledTimes(3);
    expect(input.reader.retrieve).toHaveBeenCalledTimes(3);
    expect(input.remote.size).toBe(3);
    // Explicit repeat is identical-byte/idempotent transport work, not a new assessment or binding.
    await publishPublicArtifact(input); expect(input.remote.size).toBe(3);
  });
  it.each([0, -1, 60_001, NaN, 1.2])("rejects invalid deadline %s before touching storage", async timeoutMs => {
    const input = { ...setup(), timeoutMs };
    await expect(publishPublicArtifact(input)).rejects.toThrow("deadline");
    expect(input.calls).toEqual([]);
  });
  it.each(["pin-a", "bad/identity", ""]) ("rejects ambiguous retrieval identity %s", async id => {
    const input = setup(); input.reader.id = id;
    await expect(publishPublicArtifact(input)).rejects.toThrow("identities"); expect(input.calls).toEqual([]);
  });
  it.each(["stage", "beforeUpload", "uploaded", "retrieved", "complete"] as const)("fails closed at durable %s without a second upload pass", async method => {
    const input = setup(); vi.mocked(input.journal[method]).mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(publishPublicArtifact(input)).rejects.toThrow("storage unavailable");
    expect(input.uploader.upload.mock.calls.length).toBe(method === "stage" || method === "beforeUpload" ? 0 : method === "complete" ? 3 : 1);
    if (method !== "complete") expect(input.journal.complete).not.toHaveBeenCalled();
  });
  it("does not mark a successful upload verified when retrieved bytes differ", async () => {
    const input = setup(); input.reader.retrieve.mockResolvedValueOnce(Buffer.from("not the object"));
    await expect(publishPublicArtifact(input)).rejects.toThrow("descriptor");
    expect(input.journal.retrieved).not.toHaveBeenCalled(); expect(input.journal.complete).not.toHaveBeenCalled();
  });
  it("does not retry a rejected upload or read", async () => {
    const input = setup(); input.uploader.upload.mockRejectedValueOnce(new Error("upload rejected"));
    await expect(publishPublicArtifact(input)).rejects.toThrow("upload rejected");
    expect(input.uploader.upload).toHaveBeenCalledTimes(1); expect(input.reader.retrieve).not.toHaveBeenCalled();
    const second = setup(); second.reader.retrieve.mockRejectedValueOnce(new Error("read failed"));
    await expect(publishPublicArtifact(second)).rejects.toThrow("read failed");
    expect(second.reader.retrieve).toHaveBeenCalledTimes(1); expect(second.journal.complete).not.toHaveBeenCalled();
  });
  it("aborts a hung upload and ignores late success", async () => {
    const input = setup(); input.timeoutMs = 10;
    let release!: () => void;
    input.uploader.upload.mockImplementationOnce(async (_object, _bytes, signal: AbortSignal) => {
      await new Promise<void>(resolve => { release = resolve; }); expect(signal.aborted).toBe(true);
    });
    await expect(publishPublicArtifact(input)).rejects.toThrow("timed out"); release();
    await Promise.resolve(); expect(input.reader.retrieve).not.toHaveBeenCalled(); expect(input.journal.complete).not.toHaveBeenCalled();
  });
  it("aborts a hung independent read without recording verification", async () => {
    const input = setup(); input.timeoutMs = 10;
    input.reader.retrieve.mockImplementationOnce(() => new Promise(() => {}));
    await expect(publishPublicArtifact(input)).rejects.toThrow("timed out");
    expect(input.journal.retrieved).not.toHaveBeenCalled(); expect(input.journal.complete).not.toHaveBeenCalled();
  });
  it("does not persist late upload success when microtasks have starved the timeout timer", async () => {
    const input = setup(); input.timeoutMs = 1; let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    input.uploader.upload.mockImplementationOnce(async () => { now = 2; });
    try { await expect(publishPublicArtifact(input)).rejects.toThrow("timed out"); }
    finally { clock.mockRestore(); }
    expect(input.journal.uploaded).not.toHaveBeenCalled(); expect(input.journal.complete).not.toHaveBeenCalled();
  });
  it("snapshots caller and adapter buffers across asynchronous work", async () => {
    const input = setup(), caller = structuredClone(artifact); input.artifact = caller;
    input.uploader.upload.mockImplementationOnce(async (object, bytes) => {
      input.remote.set(object.uri, Uint8Array.from(bytes)); bytes[0] ^= 1; Object.assign(object, { sha256: "changed" });
    });
    const result = publishPublicArtifact(input);
    caller.svg.bytes[0] ^= 1;
    await expect(result).resolves.toMatchObject({ artifactDigest: artifact.digest });
  });
  it("pins transport identities, references and timeout before asynchronous work", async () => {
    const input = setup(), originalUploader = input.uploader, originalReader = input.reader, originalJournal = input.journal;
    const alternate = setup();
    originalUploader.upload.mockImplementationOnce(async (object, bytes) => {
      input.remote.set(object.uri, Uint8Array.from(bytes));
      originalReader.id = originalUploader.id;
      originalUploader.id = "renamed";
      input.uploader = alternate.uploader; input.reader = alternate.reader; input.journal = alternate.journal;
      input.timeoutMs = 0;
    });
    await publishPublicArtifact(input);
    expect(originalUploader.upload).toHaveBeenCalledTimes(3);
    expect(originalReader.retrieve).toHaveBeenCalledTimes(3);
    expect(alternate.calls).toEqual([]);
    for (const call of vi.mocked(originalJournal.uploaded).mock.calls) expect(call[2]).toBe("pin-a");
    for (const call of vi.mocked(originalJournal.retrieved).mock.calls) expect(call[2]).toBe("independent-gateway-b");
  });
  it("rejects corrupted input before any upload or stage", async () => {
    const input = setup(); input.artifact = structuredClone(artifact); input.artifact.metadata.bytes[0] ^= 1;
    await expect(publishPublicArtifact(input)).rejects.toThrow(); expect(input.calls).toEqual([]);
  });
});
