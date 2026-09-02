import { afterEach, describe, expect, it, vi } from "vitest";
import { RealXApiClient } from "./xApiClient.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("RealXApiClient.verifyMention", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = new RealXApiClient({ bearerToken: "test-token" });

  it("returns true when the author matches and the agent is mentioned", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: { author_id: "1", entities: { mentions: [{ username: "grok" }] } },
          includes: { users: [{ id: "1", username: "alice" }] },
        }),
      ),
    );
    const result = await client.verifyMention({ postId: "123", handle: "alice", agentHandle: "grok" });
    expect(result).toBe(true);
  });

  it("is case-insensitive on both handle and agentHandle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: { author_id: "1", entities: { mentions: [{ username: "GROK" }] } },
          includes: { users: [{ id: "1", username: "Alice" }] },
        }),
      ),
    );
    const result = await client.verifyMention({ postId: "123", handle: "alice", agentHandle: "grok" });
    expect(result).toBe(true);
  });

  it("sends the bearer token and expected query params", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      jsonResponse({ data: { author_id: "1", entities: { mentions: [{ username: "grok" }] } }, includes: { users: [{ id: "1", username: "alice" }] } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await client.verifyMention({ postId: "123", handle: "alice", agentHandle: "grok" });

    const [url, init] = fetchMock.mock.calls[0];
    const headers = init!.headers as Record<string, string>;
    expect(String(url)).toContain("https://api.x.com/2/tweets/123");
    expect(String(url)).toContain("expansions=author_id");
    expect(headers.Authorization).toBe("Bearer test-token");
  });

  it("returns false when the post doesn't exist (non-2xx)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ errors: ["not found"] }, 404)));
    const result = await client.verifyMention({ postId: "999", handle: "alice", agentHandle: "grok" });
    expect(result).toBe(false);
  });

  it("returns false when the response has no data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));
    const result = await client.verifyMention({ postId: "123", handle: "alice", agentHandle: "grok" });
    expect(result).toBe(false);
  });

  it("returns false when the author doesn't match the expected handle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: { author_id: "1", entities: { mentions: [{ username: "grok" }] } },
          includes: { users: [{ id: "1", username: "someone_else" }] },
        }),
      ),
    );
    const result = await client.verifyMention({ postId: "123", handle: "alice", agentHandle: "grok" });
    expect(result).toBe(false);
  });

  it("returns false when the agent isn't mentioned", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: { author_id: "1", entities: { mentions: [{ username: "someone_else" }] } },
          includes: { users: [{ id: "1", username: "alice" }] },
        }),
      ),
    );
    const result = await client.verifyMention({ postId: "123", handle: "alice", agentHandle: "grok" });
    expect(result).toBe(false);
  });

  it("returns false when there are no entities/mentions at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: { author_id: "1" }, includes: { users: [{ id: "1", username: "alice" }] } })),
    );
    const result = await client.verifyMention({ postId: "123", handle: "alice", agentHandle: "grok" });
    expect(result).toBe(false);
  });
});
