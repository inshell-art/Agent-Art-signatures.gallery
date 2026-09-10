/**
 * A deliberately single-process rehearsal transaction boundary. All HTTP mint
 * mutations and indexer ticks share run(); checkpoint() is only called inside
 * an operation (not queued recursively) before handing out signing authority.
 */
export class LocalMintRuntime {
  private tail: Promise<unknown> = Promise.resolve();
  private failure: unknown = null;
  private running = false;

  constructor(private readonly adapters: {
    assertOwnership: () => void;
    persist: () => Promise<void>;
  }) {}

  assertHealthy(): void {
    if (this.failure) throw new Error("Local rehearsal persistence is unavailable; restart is required.", { cause: this.failure });
    try {
      this.adapters.assertOwnership();
    } catch (error) {
      this.failure = error;
      throw error;
    }
  }

  async checkpoint(): Promise<void> {
    this.assertHealthy();
    if (!this.running) throw new Error("Local rehearsal checkpoints must run inside the serialized operation boundary.");
    try {
      await this.adapters.persist();
      this.assertHealthy();
    } catch (error) {
      this.failure = error;
      throw error;
    }
  }

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      this.assertHealthy();
      this.running = true;
      try {
        let result: T;
        try {
          result = await operation();
        } catch (error) {
          // Failed proofs/uncertain signers also mutate durable safety state.
          await this.checkpoint();
          throw error;
        }
        await this.checkpoint();
        return result;
      } finally {
        this.running = false;
      }
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** Shutdown must finish the queue before releasing its database lock. */
  async drain(): Promise<void> {
    await this.tail;
  }

  /** Call after closing HTTP and stopping the poller. Freeze the block source
   * before the final verified/persisted scan so the saved cursor cannot lag it. */
  async settleForShutdown(stopMining: () => Promise<void>, reconcile: () => Promise<void>): Promise<void> {
    await this.drain();
    await stopMining();
    await this.run(reconcile);
  }
}
