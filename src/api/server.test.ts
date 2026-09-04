import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryAssetStore } from "../assets/memoryAssetStore.js";
import type { XOAuthClient, XUser } from "../claim/xOAuthClient.js";
import { MemoryStore } from "../store/memoryStore.js";
import type { XApiClient } from "../verification/xApiClient.js";
import { startServer, type AppOptions } from "./server.js";

let server: ReturnType<typeof startServer>;
let store: MemoryStore;
let assetStore: MemoryAssetStore;
let baseUrl: string;

async function boot(options: AppOptions = {}) {
  store = new MemoryStore();
  assetStore = new MemoryAssetStore();
  server = startServer(store, assetStore, 0, options);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://localhost:${port}`;
}

beforeEach(() => boot());
afterEach(() => server.close());

describe("GET /s/{handle}/{code}/{post_id}", () => {
  it("400s on an invalid handle", async () => {
    const res = await fetch(`${baseUrl}/s/not a handle/hfwo/123`);
    expect(res.status).toBe(400);
  });

  it("400s on an out-of-vocabulary reading code (§4.4: failed read, not a novel value)", async () => {
    const res = await fetch(`${baseUrl}/s/alice/zzzz/123`);
    expect(res.status).toBe(400);
  });

  it("issues a new instance: renders, rasterizes, persists, and serves an og:image", async () => {
    const res = await fetch(`${baseUrl}/s/alice/hfwo/123`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('og:image" content="http://localhost');
    expect(html).toContain("/i/instance/1.png");

    const instances = await store.listInstancesForHandle("alice");
    expect(instances).toHaveLength(1);
    expect(instances[0].readingCode).toBe("hfwo");

    const imageRes = await fetch(`${baseUrl}/i/instance/${instances[0].id}.png`);
    expect(imageRes.status).toBe(200);
    expect(imageRes.headers.get("content-type")).toBe("image/png");
  });

  it("is idempotent: a pre-existing instance for (handle, post_id) is served, not re-issued", async () => {
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
    expect(html).toContain(`/i/instance/1.png`);
  });

  it("429s once the per-handle rate limit is exceeded", async () => {
    // Distinct post_ids so each request is a distinct (would-be) issue, not
    // an idempotent re-fetch.
    const requests = Array.from({ length: 31 }, (_, i) => fetch(`${baseUrl}/s/bob/hfwo/${i}`));
    const results = await Promise.all(requests);
    const statuses = results.map((r) => r.status);
    expect(statuses).toContain(429);
    expect(statuses.filter((s) => s !== 429).every((s) => s === 200)).toBe(true);
  });
});

const JSON_ACCEPT = { headers: { Accept: "application/json" } };

describe("GET /c/{handle}", () => {
  it("lists instances ordered by sequence, with a canonical image URL (JSON on request)", async () => {
    const res = await fetch(`${baseUrl}/c/alice`, JSON_ACCEPT);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      handle: "alice",
      canonical: { image: `${baseUrl}/i/canonical/alice.png` },
      instances: [],
    });
  });

  it("renders an HTML page by default", async () => {
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

    const res = await fetch(`${baseUrl}/c/alice`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("@alice");
    expect(html).toContain("quick and dense");
    expect(html).toContain("/i/canonical/alice.png");
    expect(html).toContain("/i/instance/1.png");
  });

  it("400s on an invalid handle", async () => {
    const res = await fetch(`${baseUrl}/c/not a handle`);
    expect(res.status).toBe(400);
  });
});

describe("GET /v/{instance_id}", () => {
  it("404s for an unknown instance", async () => {
    const res = await fetch(`${baseUrl}/v/999`);
    expect(res.status).toBe(404);
  });

  it("returns everything needed to recompute the instance independently, including the spec hash (§9.4, JSON on request)", async () => {
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

    const res = await fetch(`${baseUrl}/v/${instance.id}`, JSON_ACCEPT);
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
    expect(typeof body.specHash).toBe("string");
    expect(body.specHash.length).toBeGreaterThan(0);
  });

  it("renders an HTML page by default", async () => {
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
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("hfwo");
    expect(html).toContain("spec_hash");
  });
});

describe("GET /i/instance/{id}.png", () => {
  it("404s when no asset has been stored for that id", async () => {
    const res = await fetch(`${baseUrl}/i/instance/999.png`);
    expect(res.status).toBe(404);
  });

  it("serves the stored PNG bytes", async () => {
    const png = Buffer.from([137, 80, 78, 71]); // PNG magic bytes
    await assetStore.putPng("instance:1", png);
    const res = await fetch(`${baseUrl}/i/instance/1.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png);
  });
});

describe("GET /i/canonical/{handle}.png", () => {
  it("renders and caches the canonical mark on first request", async () => {
    const res = await fetch(`${baseUrl}/i/canonical/alice.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const png = Buffer.from(await res.arrayBuffer());
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(await assetStore.getPng("canonical:alice")).toEqual(png);
  });

  it("400s on an invalid handle", async () => {
    const res = await fetch(`${baseUrl}/i/canonical/not a handle.png`);
    expect(res.status).toBe(400);
  });
});

describe("provenance verification (§9.3)", () => {
  it("issues and responds before verification resolves, then flips provenance to verified", async () => {
    let resolveVerification!: (value: boolean) => void;
    const verifyMention = vi.fn(() => new Promise<boolean>((resolve) => (resolveVerification = resolve)));
    const xApiClient: XApiClient = { verifyMention };
    await server.close();
    await boot({ xApiClient, agentHandle: "grok" });

    const res = await fetch(`${baseUrl}/s/alice/hfwo/123`);
    expect(res.status).toBe(200);

    // The response already completed, but verifyMention's promise is still
    // pending — the issue route never awaited it.
    let instances = await store.listInstancesForHandle("alice");
    expect(instances[0].provenance).toBe("unverified");

    resolveVerification(true);
    await vi.waitFor(async () => {
      instances = await store.listInstancesForHandle("alice");
      expect(instances[0].provenance).toBe("verified");
    });

    expect(verifyMention).toHaveBeenCalledWith({ postId: "123", handle: "alice", agentHandle: "grok" });
  });

  it("leaves provenance unverified when the X API can't confirm the mention", async () => {
    const xApiClient: XApiClient = { verifyMention: vi.fn(async () => false) };
    await server.close();
    await boot({ xApiClient, agentHandle: "grok" });

    await fetch(`${baseUrl}/s/alice/hfwo/123`);
    await vi.waitFor(async () => {
      expect(xApiClient.verifyMention).toHaveBeenCalled();
    });
    const instances = await store.listInstancesForHandle("alice");
    expect(instances[0].provenance).toBe("unverified");
  });

  it("skips verification entirely when no xApiClient is configured", async () => {
    const res = await fetch(`${baseUrl}/s/alice/hfwo/123`);
    expect(res.status).toBe(200);
    const instances = await store.listInstancesForHandle("alice");
    expect(instances[0].provenance).toBe("unverified");
  });
});

describe("GET /claim/start and /claim/callback", () => {
  it("501s when no oauth client is configured", async () => {
    const res = await fetch(`${baseUrl}/claim/start`, { redirect: "manual" });
    expect(res.status).toBe(501);
  });

  it("redirects to the authorize URL, then binds the account on callback", async () => {
    const mockClient: XOAuthClient = {
      getAuthorizeUrl: vi.fn((state) => `https://twitter.com/i/oauth2/authorize?state=${state}`),
      exchangeCode: vi.fn(async () => "mock-access-token"),
      getUser: vi.fn(async (): Promise<XUser> => ({ id: "999", username: "alice" })),
    };
    await server.close();
    await boot({ oauthClient: mockClient });

    const startRes = await fetch(`${baseUrl}/claim/start`, { redirect: "manual" });
    expect(startRes.status).toBe(302);
    const location = new URL(startRes.headers.get("location")!);
    const state = location.searchParams.get("state")!;
    expect(state).toBeTruthy();

    const callbackRes = await fetch(`${baseUrl}/claim/callback?code=abc&state=${state}`);
    expect(callbackRes.status).toBe(200);
    const body = await callbackRes.json();
    expect(body).toEqual({ xUserId: "999", seedHandle: "alice", currentHandle: "alice" });

    const account = await store.getAccountByXUserId("999");
    expect(account?.seedHandle).toBe("alice");
  });

  it("400s on a callback with an unknown state", async () => {
    const mockClient: XOAuthClient = {
      getAuthorizeUrl: vi.fn(() => "https://example.com"),
      exchangeCode: vi.fn(async () => "token"),
      getUser: vi.fn(async (): Promise<XUser> => ({ id: "1", username: "x" })),
    };
    await server.close();
    await boot({ oauthClient: mockClient });

    const res = await fetch(`${baseUrl}/claim/callback?code=abc&state=forged`);
    expect(res.status).toBe(400);
  });
});
