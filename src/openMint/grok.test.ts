import { describe, expect, it, vi } from "vitest";
import { DevelopmentAssessmentProvider, GROK_DEFAULT_MODEL, GROK_MAX_RESPONSE_BYTES, GROK_RESPONSES_ENDPOINT, GrokAssessmentProvider, validateGrokResponse } from "./grok.js";

function validResponse() {
  return {
    id: "response-123", model: GROK_DEFAULT_MODEL, status: "completed", error: null, incomplete_details: null,
    citations: ["https://x.com/alice/status/12345", "https://example.org/source"],
    output: [
      { type: "x_search_call", id: "search-1", status: "completed" },
      { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify({ handle: "alice", mbti: "INTJ" }), annotations: [] }] },
    ],
  };
}
function stubFetch(value: unknown = validResponse()) {
  return vi.fn(async () => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

describe("trusted direct Grok X Search assessment", () => {
  it("sends a fresh native X Search request with server schema and returns provider citations", async () => {
    const transport = stubFetch();
    const provider = new GrokAssessmentProvider({ apiKey: "test-server-key", fetch: transport });
    const result = await provider.assess("@ALICE");
    expect(result).toEqual({ handle: "alice", mbti: "INTJ", model: GROK_DEFAULT_MODEL, providerResponseId: "response-123", sourceUrls: ["https://example.org/source", "https://x.com/alice/status/12345"] });
    const [url, options] = vi.mocked(transport).mock.calls[0];
    expect(url).toBe(GROK_RESPONSES_ENDPOINT);
    expect(options?.redirect).toBe("error");
    const body = JSON.parse(String(options?.body));
    expect(body.tools).toEqual([{ type: "x_search", allowed_x_handles: ["alice"] }]);
    expect(body.model).toBe(GROK_DEFAULT_MODEL);
    expect(body.text.format.strict).toBe(true);
    expect(body.text.format.schema.additionalProperties).toBe(false);
    expect(body.text.format.schema.properties.handle.const).toBe("alice");
    expect(body.previous_response_id).toBeUndefined();
    expect(body.store).toBe(false);
    expect(JSON.stringify(result)).not.toContain("test-server-key");
  });

  const invalid: [string, (value: ReturnType<typeof validResponse>) => void][] = [
    ["failed response", (r) => { r.status = "failed"; }],
    ["truncated response", (r) => { r.status = "incomplete"; }],
    ["error envelope", (r) => { Object.assign(r, { error: { message: "provider failure" } }); }],
    ["incomplete details", (r) => { Object.assign(r, { incomplete_details: { reason: "max_output_tokens" } }); }],
    ["missing provider ID", (r) => { r.id = ""; }],
    ["fixture provider ID", (r) => { r.id = "development-fixture:123"; }],
    ["wrong model", (r) => { r.model = "client-chosen-model"; }],
    ["no X Search execution", (r) => { r.output.shift(); }],
    ["failed X Search", (r) => { r.output[0].status = "failed"; }],
    ["unproved X Search", (r) => { delete (r.output[0] as { status?: string }).status; }],
    ["web search is not X Search", (r) => { r.output[0].type = "web_search_call"; }],
    ["no citations", (r) => { r.citations = []; }],
    ["no X sources", (r) => { r.citations = ["https://example.com/alice"]; }],
    ["misleading X host", (r) => { r.citations = ["https://x.com.evil.example/alice"]; }],
    ["unsafe source scheme", (r) => { r.citations = ["javascript:alert(1)"]; }],
    ["wrong account replay", (r) => { r.output[1].content![0].text = '{"handle":"bob","mbti":"INTJ"}'; }],
    ["wrong casing", (r) => { r.output[1].content![0].text = '{"handle":"ALICE","mbti":"INTJ"}'; }],
    ["invalid MBTI", (r) => { r.output[1].content![0].text = '{"handle":"alice","mbti":"XXXX"}'; }],
    ["extra client seed", (r) => { r.output[1].content![0].text = '{"handle":"alice","mbti":"INTJ","seed":99}'; }],
    ["model authored citations", (r) => { r.output[1].content![0].text = '{"handle":"alice","mbti":"INTJ","sourceUrls":["https://x.com/alice"]}'; }],
    ["refusal content", (r) => { r.output[1].content![0].type = "refusal"; }],
    ["malformed JSON", (r) => { r.output[1].content![0].text = '{"handle":"alice",'; }],
    ["multiple conclusions", (r) => { r.output.push(r.output[1]); }],
  ];
  it.each(invalid)("rejects %s", (_, alter) => {
    const response = validResponse(); alter(response);
    expect(() => validateGrokResponse(response, "alice", GROK_DEFAULT_MODEL)).toThrow();
  });

  it("accepts documented provider url citation annotations", () => {
    const response = validResponse(); response.citations = [];
    Object.assign(response.output[1].content![0], { annotations: [{ type: "url_citation", url: "https://x.com/i/status/123" }] });
    expect(validateGrokResponse(response, "alice", GROK_DEFAULT_MODEL).sourceUrls).toEqual(["https://x.com/i/status/123"]);
  });

  it("rejects public object payloads before spending a provider call", async () => {
    const transport = stubFetch();
    const provider = new GrokAssessmentProvider({ apiKey: "server-key", fetch: transport });
    await expect(provider.assess({ handle: "alice", mbti: "INTJ", model: "evil" } as never)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not retry or fall back after transport failure and does not leak secrets", async () => {
    const transport = vi.fn(async () => { throw new Error("transport-secret-key"); }) as unknown as typeof fetch;
    const provider = new GrokAssessmentProvider({ apiKey: "transport-secret-key", fetch: transport });
    await expect(provider.assess("alice")).rejects.toThrow("Grok transport failed.");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(provider.provenance).toBe("grok");
  });

  it("fails HTTP errors without returning upstream bodies", async () => {
    const transport = vi.fn(async () => new Response("private provider message", { status: 401 })) as unknown as typeof fetch;
    const provider = new GrokAssessmentProvider({ apiKey: "key", fetch: transport });
    await expect(provider.assess("alice")).rejects.toThrow("Grok request failed (HTTP 401).");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("bounds the complete transport operation even when fetch ignores cancellation", async () => {
    const transport = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
    const provider = new GrokAssessmentProvider({ apiKey: "key", fetch: transport, timeoutMs: 10 });
    await expect(provider.assess("alice")).rejects.toThrow("timed out");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transport).mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it.each([true, false])("bounds oversized provider body with content-length=%s", async (declared) => {
    const transport = vi.fn(async () => new Response("x".repeat(GROK_MAX_RESPONSE_BYTES + 1), {
      headers: declared ? { "content-length": String(GROK_MAX_RESPONSE_BYTES + 1) } : {},
    })) as unknown as typeof fetch;
    await expect(new GrokAssessmentProvider({ apiKey: "key", fetch: transport }).assess("alice")).rejects.toThrow("size limit");
  });

  it("requires explicit fixture construction and marks its outputs", async () => {
    expect(() => new GrokAssessmentProvider({ apiKey: "" })).toThrow("API key");
    const fixture = new DevelopmentAssessmentProvider();
    expect(fixture.provenance).toBe("development-fixture");
    expect(await fixture.assess("@ALICE")).toEqual(await fixture.assess("alice"));
    expect((await fixture.assess("alice")).providerResponseId).toMatch(/^development-fixture:/);
  });
});
