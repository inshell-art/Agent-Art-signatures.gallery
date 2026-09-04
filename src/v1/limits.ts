export class SlidingWindowLimits {
  private readonly events = new Map<string, number[]>();

  consume(bucket: string, key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const mapKey = `${bucket}\u0000${key}`;
    const cutoff = now - windowMs;
    const recent = (this.events.get(mapKey) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= limit) {
      this.events.set(mapKey, recent);
      return false;
    }
    recent.push(now);
    this.events.set(mapKey, recent);
    if (this.events.size > 2_000) this.cleanup(cutoff);
    return true;
  }

  private cleanup(cutoff: number): void {
    for (const [key, timestamps] of this.events) {
      const recent = timestamps.filter((timestamp) => timestamp > cutoff);
      if (recent.length === 0) this.events.delete(key);
      else this.events.set(key, recent);
    }
  }
}

export class DailyCircuitBreaker {
  private day = "";
  private count = 0;

  constructor(private readonly limit: number) {}

  tryConsume(now = new Date()): boolean {
    const day = now.toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.count = 0;
    }
    if (this.count >= this.limit) return false;
    this.count += 1;
    return true;
  }

  usage(): { count: number; limit: number } {
    return { count: this.count, limit: this.limit };
  }
}
