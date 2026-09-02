/**
 * In-memory implementation of the Store interface (types.ts).
 *
 * PLACEHOLDER. Enough to exercise the API layer and its tests without a
 * real database. Swap for a Postgres-backed implementation against
 * schema.sql when persistence is needed; the Store interface is the
 * contract, this file is not.
 */

import type { Account, Instance, NewInstance, Store } from "./types.js";

let nextInstanceId = 1;

export class MemoryStore implements Store {
  private accounts = new Map<string, Account>(); // keyed by seedHandle
  private instances: Instance[] = [];

  async getOrCreateAccount(seedHandle: string, xUserId?: string): Promise<Account | null> {
    const existing = this.accounts.get(seedHandle);
    if (existing) return existing;
    if (!xUserId) return null;
    const account: Account = { xUserId, seedHandle, currentHandle: seedHandle, claimedAt: null };
    this.accounts.set(seedHandle, account);
    return account;
  }

  async findInstanceByIdempotencyKey(seedHandle: string, sourcePostId: string): Promise<Instance | null> {
    return (
      this.instances.find((i) => i.seedHandle === seedHandle && i.sourcePostId === sourcePostId) ?? null
    );
  }

  async insertInstance(data: NewInstance): Promise<Instance> {
    const sequence = this.instances.filter((i) => i.seedHandle === data.seedHandle).length + 1;
    const instance: Instance = {
      ...data,
      id: String(nextInstanceId++),
      createdAt: new Date(),
      sequence,
    };
    this.instances.push(instance);
    return instance;
  }

  async listInstancesForHandle(seedHandle: string): Promise<Instance[]> {
    return this.instances
      .filter((i) => i.seedHandle === seedHandle)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async getInstanceById(id: string): Promise<Instance | null> {
    return this.instances.find((i) => i.id === id) ?? null;
  }
}
