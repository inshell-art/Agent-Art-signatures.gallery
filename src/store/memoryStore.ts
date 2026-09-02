/**
 * In-memory implementation of the Store interface (types.ts).
 *
 * PLACEHOLDER. Enough to exercise the API layer and its tests without a
 * real database. Swap for a Postgres-backed implementation against
 * schema.sql when persistence is needed; the Store interface is the
 * contract, this file is not.
 */

import type { Account, Instance, NewInstance, Provenance, Store } from "./types.js";

export class MemoryStore implements Store {
  private accounts = new Map<string, Account>(); // keyed by xUserId
  private instances: Instance[] = [];
  private nextInstanceId = 1;

  async getAccountByXUserId(xUserId: string): Promise<Account | null> {
    return this.accounts.get(xUserId) ?? null;
  }

  async claimAccount(xUserId: string, handle: string): Promise<Account> {
    const existing = this.accounts.get(xUserId);
    if (existing) {
      // seedHandle is frozen at first claim (§10); only display updates.
      const updated: Account = { ...existing, currentHandle: handle };
      this.accounts.set(xUserId, updated);
      return updated;
    }
    const account: Account = { xUserId, seedHandle: handle, currentHandle: handle, claimedAt: new Date() };
    this.accounts.set(xUserId, account);
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
      id: String(this.nextInstanceId++),
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

  async updateProvenance(instanceId: string, provenance: Provenance): Promise<void> {
    const instance = this.instances.find((i) => i.id === instanceId);
    if (instance) instance.provenance = provenance;
  }
}
