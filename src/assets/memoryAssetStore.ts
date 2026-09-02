/**
 * PLACEHOLDER. In-memory AssetStore, same spirit as MemoryStore in
 * store/memoryStore.ts — swap for object storage (S3-compatible, etc.)
 * behind the same interface when deploying for real.
 */

import type { AssetStore } from "./types.js";

export class MemoryAssetStore implements AssetStore {
  private svgs = new Map<string, string>();
  private pngs = new Map<string, Buffer>();

  async putSvg(key: string, svg: string): Promise<void> {
    this.svgs.set(key, svg);
  }

  async putPng(key: string, png: Buffer): Promise<void> {
    this.pngs.set(key, png);
  }

  async getSvg(key: string): Promise<string | null> {
    return this.svgs.get(key) ?? null;
  }

  async getPng(key: string): Promise<Buffer | null> {
    return this.pngs.get(key) ?? null;
  }
}
