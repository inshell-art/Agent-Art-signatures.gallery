import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryArtifactStore } from "../v1/artifacts.js";
import { MemoryAuthState } from "../v1/authState.js";
import { developmentFixtureRenderer, RendererRegistry } from "../v1/renderer.js";
import { MemorySignatureStore } from "../v1/store.js";
import { startServer } from "./server.js";

const servers: ReturnType<typeof startServer>[] = [];
const routes = [
  ["/dev/button-study", "text/html; charset=utf-8"],
  ["/dev/button-study.css", "text/css; charset=utf-8"],
  ["/dev/button-study.js", "application/javascript; charset=utf-8"],
] as const;

async function boot(fixtureMode: boolean) {
  const store = new MemorySignatureStore();
  const artifacts = new MemoryArtifactStore();
  const auth = new MemoryAuthState();
  const server = startServer({ store, artifacts, auth, renderers: new RendererRegistry([developmentFixtureRenderer]) }, 0, { fixtureMode });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store, artifacts, auth };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  vi.restoreAllMocks();
});

describe("development-only button study", () => {
  it.each(routes)("serves GET/HEAD %s without caching, indexing or creating a session", async (path, type) => {
    const { base } = await boot(true);
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(base + path, { method });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(type);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.get("set-cookie")).toBeNull();
      const body = await response.text();
      if (method === "HEAD") expect(body).toBe("");
      else expect(body.length).toBeGreaterThan(100);
    }
  });

  it.each(routes)("hides %s outside development and rejects writes", async path => {
    for (const fixtureMode of [true, false]) {
      const { base } = await boot(fixtureMode);
      for (const method of fixtureMode ? ["POST"] : ["GET", "HEAD", "POST"]) {
        const response = await fetch(base + path, { method });
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain('class="bst-candidate"');
      }
    }
  });

  it("leaves production pages, auth state, claims and artifacts unchanged", async () => {
    const { base, store, artifacts, auth } = await boot(true);
    const claim = vi.spyOn(store, "claim");
    const artifact = vi.spyOn(artifacts, "putVerified");
    const session = vi.spyOn(auth, "getOrCreateSession");
    const before = await (await fetch(base + "/s/alice/0.500000")).text();
    for (const [path] of routes) await (await fetch(base + path)).text();
    expect(await (await fetch(base + "/s/alice/0.500000")).text()).toBe(before);
    expect(claim).not.toHaveBeenCalled();
    expect(artifact).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
  });
});
