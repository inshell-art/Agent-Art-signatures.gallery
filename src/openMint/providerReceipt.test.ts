import { describe, expect, it } from "vitest";
import { providerReceipt } from "./providerReceipt.js";
import { validateProviderReceipt } from "./assessmentOperations.js";

function receipt(usage?: unknown, extra = {}) {
  return providerReceipt({ leg: "grok", startedAt: 10, completedAt: 20, category: "success",
    response: new Response("{}", { headers: { "x-request-id": "req-123", "set-cookie": "private-cookie" } }),
    payload: { id: "response-123", model: "grok-returned", usage, ...extra } });
}
describe("bounded provider accounting evidence", () => {
  it("retains only allowlisted usage, actual model, references and exact integer USD ticks", () => {
    const value = receipt({ input_tokens: 131, output_tokens: 624, total_tokens: 755,
      input_tokens_details: { cached_tokens: 128, secret: "private" }, output_tokens_details: { reasoning_tokens: 246 },
      num_server_side_tools_used: 3, server_side_tool_usage_details: { x_search_calls: 2, web_search_calls: 1 }, num_sources_used: 27, cost_in_usd_ticks: 37756000, private_dump: "secret" },
    { output: [{ type: "reasoning", text: "hidden-reasoning" }], citations: ["https://x.com/private"] });
    expect(value).toEqual({ leg: "grok", startedAt: 10, completedAt: 20, category: "success", httpStatus: 200,
      requestId: "req-123", responseId: "response-123", model: "grok-returned", usageStatus: "valid",
      usage: { inputTokens: 131, outputTokens: 624, totalTokens: 755, cachedInputTokens: 128, reasoningTokens: 246,
        serverSideToolCalls: 3, searchCalls: 2, costInUsdTicks: "37756000" }, cost: { status: "actual", currency: "USD", scale: 10, amount: "37756000" } });
    expect(validateProviderReceipt(value)).toEqual(value);
    expect(JSON.stringify(value)).not.toMatch(/private|secret|reasoning"|citations|num_sources/);
  });
  it.each([undefined, null, {}, { unrelated: 1 }, { num_sources_used: 99 }, { cost_in_usd_ticks: null, cost_in_nano_usd: null }])("keeps missing billing unknown for %j", usage => {
    expect(receipt(usage)).toMatchObject({ usageStatus: "missing", cost: { status: "unknown", currency: "USD", scale: 10 } });
    expect(receipt(usage).usage).toBeUndefined();
  });
  it("never fills omitted token metrics or costs with zero", () => {
    expect(receipt({ input_tokens: 0 })).toMatchObject({ usageStatus: "valid", usage: { inputTokens: 0 }, cost: { status: "unknown" } });
    expect(receipt({ input_tokens: 0 }).usage).not.toHaveProperty("outputTokens");
    expect(receipt({ input_tokens: 0 }).cost).not.toHaveProperty("amount");
    expect(receipt({ cost_in_usd_ticks: 0 }).cost).toEqual({ status: "actual", currency: "USD", scale: 10, amount: "0" });
  });
  it.each([-1, 1.5, "1", Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, null])("rejects malformed numeric usage %j", input_tokens => {
    const value = receipt({ input_tokens });
    expect(value).toMatchObject({ usageStatus: "invalid", cost: { status: "unknown" } });
    expect(value.usage).toBeUndefined();
    expect(validateProviderReceipt(value)).toEqual(value);
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "-1", "01", "1.2", "1e5", "9".repeat(31)])("rejects malformed or imprecise cost %j", cost_in_usd_ticks => {
    expect(receipt({ cost_in_usd_ticks })).toMatchObject({ usageStatus: "invalid", cost: { status: "unknown" } });
  });
  it("retains canonical decimal ticks without floating point conversion", () => {
    expect(receipt({ cost_in_usd_ticks: "9007199254740993" }).cost.amount).toBe("9007199254740993");
  });
  it.each([0, 1, 3775600, Number.MAX_SAFE_INTEGER])("converts documented nano-USD cost %j into exact ticks", nano => {
    const amount = String(BigInt(nano) * 10n);
    expect(receipt({ cost_in_nano_usd: nano })).toMatchObject({ usageStatus: "valid", usage: { costInUsdTicks: amount }, cost: { status: "actual", amount } });
    expect(receipt({ cost_in_nano_usd: nano, cost_in_usd_ticks: amount }).cost.amount).toBe(amount);
  });
  it.each([
    { cost_in_nano_usd: -1 }, { cost_in_nano_usd: 0.1 }, { cost_in_nano_usd: "1" }, { cost_in_nano_usd: Number.MAX_SAFE_INTEGER + 1 },
    { cost_in_usd_ticks: 99, cost_in_nano_usd: 10 }, { cost_in_usd_ticks: -1, cost_in_nano_usd: 10 }, { cost_in_usd_ticks: 100, cost_in_nano_usd: "10" },
  ])("keeps malformed or conflicting billing fields unknown: %j", usage => {
    expect(receipt(usage)).toMatchObject({ usageStatus: "invalid", cost: { status: "unknown" } });
    expect(receipt(usage).cost).not.toHaveProperty("amount");
  });
  it.each([
    [], "private dump", { input_tokens_details: [] }, { output_tokens_details: { reasoning_tokens: "3" } },
    { input_tokens: 10, input_tokens_details: { cached_tokens: 11 } },
    { output_tokens: 10, output_tokens_details: { reasoning_tokens: 11 } },
    { input_tokens: 10, output_tokens: 20, total_tokens: 29 }, { num_server_side_tools_used: -1 },
    { num_server_side_tools_used: 1, server_side_tool_usage_details: { x_search_calls: 2 } },
  ])("does not trust malformed usage containers or inconsistent metrics: %j", usage => {
    expect(receipt(usage).usageStatus).toBe("invalid");
    expect(receipt(usage).usage).toBeUndefined();
  });
  it("retains independently validated cost even if another usage metric is malformed", () => {
    const value = receipt({ input_tokens: -1, cost_in_usd_ticks: 25 });
    expect(value).toMatchObject({ usageStatus: "invalid", cost: { status: "actual", amount: "25" } });
    expect(validateProviderReceipt(value)).toEqual(value);
  });
  it("discards malformed or oversized references and never replaces actual model with requested model", () => {
    const value = providerReceipt({ leg: "grok", startedAt: 10, completedAt: 20, category: "success",
      response: new Response("{}", { headers: { "x-request-id": "bad id" } }), payload: { id: "x".repeat(257), model: "bad model" } });
    expect(value).not.toHaveProperty("requestId");
    expect(value).not.toHaveProperty("responseId");
    expect(value).not.toHaveProperty("model");
  });
  it("does not infer X billing from a returned user or unverified usage properties", () => {
    const value = providerReceipt({ leg: "x-identity", startedAt: 10, completedAt: 20, category: "success",
      response: new Response("{}"), payload: { data: { id: "1", name: "private" }, usage: { cost_in_usd_ticks: 0 } } });
    expect(value).toEqual({ leg: "x-identity", startedAt: 10, completedAt: 20, category: "success", httpStatus: 200,
      usageStatus: "missing", cost: { status: "unknown", currency: "USD", scale: 10 } });
  });
});
