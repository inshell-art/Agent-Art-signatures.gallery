import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalHandle } from "./identity.js";
import { validateAssessment, type Assessment, type AssessmentRepository } from "./assessment.js";

const MAX_SAVED_BYTES = 512 * 1024;
function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Server-owned directory; one immutable file per handle. Never overwrites a canonical result. */
export class FileAssessmentRepository implements AssessmentRepository {
  readonly directory: string;
  constructor(directory: string) {
    if (!directory || !isAbsolute(directory) || resolve(directory) === "/") throw new Error("Assessment storage requires a dedicated absolute directory.");
    this.directory = resolve(directory);
  }

  async #ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Assessment storage must be a real directory.");
  }

  async get(value: string): Promise<Assessment | undefined> {
    const handle = canonicalHandle(value);
    await this.#ensureDirectory();
    let file;
    try { file = await open(join(this.directory, `${handle}.json`), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (isCode(error, "ENOENT")) return undefined; throw error; }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_SAVED_BYTES) throw new Error("Invalid assessment storage file.");
      const buffer = Buffer.alloc(MAX_SAVED_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_SAVED_BYTES) throw new Error("Assessment storage file exceeds size limit.");
      let parsed: unknown;
      try { parsed = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")); }
      catch { throw new Error("Invalid assessment storage JSON."); }
      const assessment = validateAssessment(parsed);
      if (assessment.handle !== handle) throw new Error("Assessment storage handle mismatch.");
      return assessment;
    } finally { await file.close(); }
  }

  async putIfAbsent(value: Assessment): Promise<Assessment> {
    const assessment = validateAssessment(value);
    const existing = await this.get(assessment.handle);
    if (existing) return existing;
    const destination = join(this.directory, `${assessment.handle}.json`);
    const temporary = join(this.directory, `.${assessment.handle}.${randomUUID()}.tmp`);
    const encoded = JSON.stringify(assessment) + "\n";
    if (Buffer.byteLength(encoded) > MAX_SAVED_BYTES) throw new Error("Assessment exceeds storage size limit.");
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(encoded, "utf8"); await file.sync(); }
    finally { await file.close(); }
    try {
      // Hard-link publication is atomic and fails with EEXIST instead of replacing a winner.
      try { await link(temporary, destination); }
      catch (error) { if (!isCode(error, "EEXIST")) throw error; }
      const directory = await open(this.directory, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
      const saved = await this.get(assessment.handle);
      if (!saved) throw new Error("Assessment publication failed.");
      return saved;
    } finally { await unlink(temporary); }
  }

  async list(): Promise<readonly Assessment[]> {
    await this.#ensureDirectory();
    const names = (await readdir(this.directory)).filter((name) => /^[a-z0-9_]{1,15}\.json$/.test(name)).sort();
    const results = await Promise.all(names.map((name) => this.get(name.slice(0, -5))));
    return results.filter((item): item is Assessment => item !== undefined);
  }
}

export class MemoryAssessmentRepository implements AssessmentRepository {
  readonly #values = new Map<string, Assessment>();
  async get(value: string): Promise<Assessment | undefined> { return this.#values.get(canonicalHandle(value)); }
  async putIfAbsent(value: Assessment): Promise<Assessment> {
    const assessment = validateAssessment(value);
    const existing = this.#values.get(assessment.handle);
    if (existing) return existing;
    this.#values.set(assessment.handle, assessment);
    return assessment;
  }
  async list(): Promise<readonly Assessment[]> { return [...this.#values.values()]; }
}
