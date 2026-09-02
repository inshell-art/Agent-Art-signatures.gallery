import { describe, expect, it } from "vitest";
import { MemoryAssetStore } from "./memoryAssetStore.js";

describe("MemoryAssetStore", () => {
  it("returns null for a key that was never stored", async () => {
    const store = new MemoryAssetStore();
    expect(await store.getSvg("missing")).toBeNull();
    expect(await store.getPng("missing")).toBeNull();
  });

  it("round-trips SVG and PNG independently under the same key", async () => {
    const store = new MemoryAssetStore();
    const png = Buffer.from([1, 2, 3]);
    await store.putSvg("instance:1", "<svg/>");
    await store.putPng("instance:1", png);

    expect(await store.getSvg("instance:1")).toBe("<svg/>");
    expect(await store.getPng("instance:1")).toEqual(png);
  });

  it("keeps distinct keys independent", async () => {
    const store = new MemoryAssetStore();
    await store.putSvg("a", "<svg>a</svg>");
    await store.putSvg("b", "<svg>b</svg>");
    expect(await store.getSvg("a")).toBe("<svg>a</svg>");
    expect(await store.getSvg("b")).toBe("<svg>b</svg>");
  });

  it("overwrites a previous value for the same key", async () => {
    const store = new MemoryAssetStore();
    await store.putSvg("k", "<svg>first</svg>");
    await store.putSvg("k", "<svg>second</svg>");
    expect(await store.getSvg("k")).toBe("<svg>second</svg>");
  });

  it("keeps separate instances independent", async () => {
    const a = new MemoryAssetStore();
    const b = new MemoryAssetStore();
    await a.putSvg("k", "<svg>a</svg>");
    expect(await b.getSvg("k")).toBeNull();
  });
});
