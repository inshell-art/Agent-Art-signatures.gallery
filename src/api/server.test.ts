import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../store/memoryStore.js";
import { startServer } from "./server.js";

let server: ReturnType<typeof startServer>;
let store: MemoryStore;
let baseUrl: string;

beforeEach(async () => {
  store = new MemoryStore();
  server = startServer(store, 0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://localhost:${port}`;
});

afterEach(() => {
  server.close();
});

describe("GET /s/{handle}/{code}/{post_id}", () => {
  it("400s on an invalid handle", async () => {
    const res = await fetch(`${baseUrl}/s/not a handle/hfwo/123`);
    expect(res.status).toBe(400);
  });

  it("400s on an out-of-vocabulary reading code (§4.4: failed read, not a novel value)", async () => {
    const res = await fetch(`${baseUrl}/s/alice/zzzz/123`);
    expect(res.status).toBe(400);
  });

  it("501s for a new instance — blocked on the algorithm, not the pipeline around it", async () => {
    const res = await fetch(`${baseUrl}/s/alice/hfwo/123`);
    expect(res.status).toBe(501);
  });

  it("is idempotent: a pre-existing instance for (handle, post_id) is served, not re-minted", async () => {
    await store.insertInstance({
      xUserId: null,
      seedHandle: "alice",
      readingCode: "hfwo" as any,
      readingJson: { tempo: "hurried", weight: "firm", steadiness: "wavering", reach: "open" },
      rationale: "quick and dense",
      sourcePostId: "123",
      offsetVector: { tempo: 1, weight: 1, steadiness: 0, reach: 1 },
      specVersion: "test-v0",
      mapVersion: "readings.map.v0-placeholder",
      schemaVersion: "reading.v1",
      provenance: "unverified",
      supersedes: null,
    });

    const res = await fetch(`${baseUrl}/s/alice/hfwo/123`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("quick and dense");
  });
});

describe("GET /c/{handle}", () => {
  it("lists instances ordered by sequence", async () => {
    const res = await fetch(`${baseUrl}/c/alice`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ handle: "alice", canonical: null, instances: [] });
  });
});

describe("GET /v/{instance_id}", () => {
  it("404s for an unknown instance", async () => {
    const res = await fetch(`${baseUrl}/v/999`);
    expect(res.status).toBe(404);
  });

  it("returns everything needed to recompute the instance independently (§9.4)", async () => {
    const instance = await store.insertInstance({
      xUserId: null,
      seedHandle: "alice",
      readingCode: "hfwo" as any,
      readingJson: { tempo: "hurried", weight: "firm", steadiness: "wavering", reach: "open" },
      rationale: null,
      sourcePostId: "123",
      offsetVector: { tempo: 1, weight: 1, steadiness: 0, reach: 1 },
      specVersion: "test-v0",
      mapVersion: "readings.map.v0-placeholder",
      schemaVersion: "reading.v1",
      provenance: "unverified",
      supersedes: null,
    });

    const res = await fetch(`${baseUrl}/v/${instance.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      seedHandle: "alice",
      readingCode: "hfwo",
      sourcePostId: "123",
      specVersion: "test-v0",
      mapVersion: "readings.map.v0-placeholder",
      schemaVersion: "reading.v1",
    });
  });
});
