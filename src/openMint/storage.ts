import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  entries<T>(prefix: string): Promise<Array<[string, T]>>;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export class MemoryKeyValueStore implements KeyValueStore {
  protected data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { const value = this.data.get(key); return value === undefined ? undefined : clone(value) as T; }
  async put<T>(key: string, value: T): Promise<void> { this.data.set(key, clone(value)); }
  async entries<T>(prefix: string): Promise<Array<[string, T]>> { return [...this.data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, clone(value) as T]); }
}

/** One durable file per key; atomic replacement plus fsync before an authorization is released. */
export class FileKeyValueStore implements KeyValueStore {
  private constructor(readonly directory: string) {}
  static async create(directory: string): Promise<FileKeyValueStore> { await mkdir(directory, { recursive: true, mode: 0o700 }); return new FileKeyValueStore(directory); }
  path(key: string): string {
    if (!/^[a-z]+:[A-Za-z0-9_-]{1,100}$/.test(key)) throw new Error("Invalid storage key.");
    return join(this.directory, `${key.replace(":", "-")}.json`);
  }
  async get<T>(key: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(this.path(key), "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async put<T>(key: string, value: T): Promise<void> {
    const path = this.path(key);
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(this.directory, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async entries<T>(prefix: string): Promise<Array<[string, T]>> {
    const { readdir } = await import("node:fs/promises");
    if (!/^[a-z]+:$/.test(prefix)) throw new Error("Invalid storage prefix.");
    const names = (await readdir(this.directory)).filter(name => name.startsWith(prefix.replace(":", "-")) && name.endsWith(".json"));
    const entries: Array<[string, T]> = [];
    for (const name of names.sort()) { const key = name.slice(0, -5).replace("-", ":"); const value = await this.get<T>(key); if (value !== undefined) entries.push([key, value]); }
    return entries;
  }
}

/** Acquire before loading any state. A stale lock is intentionally fail-closed and never stolen. */
export async function acquireProcessLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "writer.lock");
  const file = await open(path, "wx", 0o600);
  await file.writeFile(String(process.pid)); await file.close();
  let released = false;
  return async () => { if (!released) { released = true; await unlink(path); } };
}

export class SerialKeys {
  readonly #pending = new Map<string, Promise<unknown>>();
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#pending.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    this.#pending.set(key, result);
    try { return await result; } finally { if (this.#pending.get(key) === result) this.#pending.delete(key); }
  }
}
