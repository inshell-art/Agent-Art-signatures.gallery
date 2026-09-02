/** Row types mirroring schema.sql — handoff §7. */

import type { OffsetVector } from "../algorithm.js";
import type { Reading, ReadingCode } from "../reading.js";

export interface Account {
  xUserId: string;
  seedHandle: string;
  currentHandle: string;
  claimedAt: Date | null;
}

export type Provenance = "verified" | "unverified";

export interface Instance {
  id: string;
  xUserId: string | null;
  seedHandle: string;
  readingCode: ReadingCode;
  readingJson: Reading;
  rationale: string | null;
  sourcePostId: string;
  offsetVector: OffsetVector;
  specVersion: string;
  mapVersion: string;
  schemaVersion: string;
  provenance: Provenance;
  createdAt: Date;
  sequence: number;
  supersedes: string | null;
}

/** Fields the store fills in on insert: id, createdAt, sequence. */
export type NewInstance = Omit<Instance, "id" | "createdAt" | "sequence">;

/**
 * Store interface the API layer codes against. `MemoryStore` (memoryStore.ts)
 * is a placeholder implementation; a Postgres-backed implementation of this
 * same interface, against schema.sql, is the natural next swap.
 */
export interface Store {
  getAccountByXUserId(xUserId: string): Promise<Account | null>;

  /**
   * Handoff §10: bind to the numeric ID, never the handle string. On first
   * claim, freezes `seedHandle` to `handle`. On a later claim by the same
   * `xUserId` (e.g. after a rename), only `currentHandle` is updated —
   * `seedHandle` never changes post-claim.
   */
  claimAccount(xUserId: string, handle: string): Promise<Account>;

  /** Idempotency lookup per §7/§9.1: (seed_handle, source_post_id). */
  findInstanceByIdempotencyKey(seedHandle: string, sourcePostId: string): Promise<Instance | null>;

  /** Assigns id, createdAt and the next `sequence` for the handle's cluster. */
  insertInstance(data: NewInstance): Promise<Instance>;

  /** Ordered by `sequence`, per §9.2. */
  listInstancesForHandle(seedHandle: string): Promise<Instance[]>;

  getInstanceById(id: string): Promise<Instance | null>;
}
