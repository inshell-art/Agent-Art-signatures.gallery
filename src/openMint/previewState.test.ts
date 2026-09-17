import { describe, expect, it, vi } from "vitest";
import { RENDERER_VERSION } from "./identity.js";
import { publicPreviewState } from "./previewState.js";
import type { OpenMintService } from "./service.js";

function service(state: "unminted" | "pending" | "minted" = "unminted") {
  const status = vi.fn(async () => ({ state }));
  const artifact = vi.fn(async () => ({ renderHandle: "Alice_Bob_Key", svgSha256: "a".repeat(64),
    assessment: { handle: "alice_bob_key", mbti: "INTJ", rendererVersion: RENDERER_VERSION } }));
  const value = { options: { fixture: false }, network: {}, state: status, artifact } as unknown as OpenMintService;
  return { value, status, artifact };
}

describe("read-only public preview state", () => {
  it.each(["unminted", "pending"] as const)("returns only %s, without reading a hidden assessment or saved spelling", async state => {
    const test = service(state);
    expect(await publicPreviewState(test.value, "ALICE_BOB_KEY")).toEqual({ state });
    expect(test.status).toHaveBeenCalledWith("alice_bob_key");
    expect(test.artifact).not.toHaveBeenCalled();
  });

  it("exposes only confirmed saved identity, type, renderer, and archived image", async () => {
    const test = service("minted");
    expect(await publicPreviewState(test.value, "ALICE_BOB_KEY")).toEqual({
      state: "minted", renderHandle: "Alice_Bob_Key", mbti: "INTJ", rendererVersion: RENDERER_VERSION,
      imageUrl: `/artifacts/${"a".repeat(64)}.svg`, url: "/signatures/alice_bob_key",
    });
  });

  it("preserves the original lowercase spelling of records predating renderHandle", async () => {
    const test = service("minted");
    const saved = await test.artifact();
    test.artifact.mockResolvedValue({ ...saved, renderHandle: undefined } as unknown as typeof saved);
    expect(await publicPreviewState(test.value, "ALICE_BOB_KEY")).toMatchObject({ state: "minted", renderHandle: "alice_bob_key" });
  });

  it("treats network or committed-artifact failure as unknown, never available to mint", async () => {
    const test = service("minted");
    test.status.mockRejectedValueOnce(new Error("RPC unavailable"));
    expect(await publicPreviewState(test.value, "alice_bob_key")).toEqual({ state: "unavailable" });
    expect(test.artifact).not.toHaveBeenCalled();
    test.artifact.mockRejectedValueOnce(new Error("Commitment mismatch"));
    expect(await publicPreviewState(test.value, "alice_bob_key")).toEqual({ state: "unavailable" });
    test.artifact.mockResolvedValueOnce(undefined as never);
    expect(await publicPreviewState(test.value, "alice_bob_key")).toEqual({ state: "unavailable" });
  });

  it("does not infer unminted state from a missing chain", async () => {
    const test = service();
    const offline = { ...test.value, network: undefined } as OpenMintService;
    expect(await publicPreviewState(offline, "grok", true)).toEqual({ state: "unavailable" });
    expect(test.status).not.toHaveBeenCalled();
    expect(test.artifact).not.toHaveBeenCalled();
  });

  it("isolates exact-spelling simulated fixtures from real identity and chain state", async () => {
    const test = service();
    const offline = { ...test.value, options: { fixture: true }, network: undefined } as OpenMintService;
    expect(await publicPreviewState(offline, "0xCryptoWizzy", true)).toMatchObject({ state: "fixture", renderHandle: "0xCryptoWizzy", mbti: "ESFJ", url: "/signatures/0xcryptowizzy" });
    expect(await publicPreviewState(offline, "0XCRYPTOWIZZY", true)).toEqual({ state: "unavailable" });
    expect(await publicPreviewState(offline, "0xCryptoWizzy", false)).toEqual({ state: "unavailable" });
    expect(test.status).not.toHaveBeenCalled();
    expect(test.artifact).not.toHaveBeenCalled();
    const online = { ...offline, network: {} } as OpenMintService;
    expect(await publicPreviewState(online, "0xCryptoWizzy", true)).toEqual({ state: "unminted" });
  });
});
