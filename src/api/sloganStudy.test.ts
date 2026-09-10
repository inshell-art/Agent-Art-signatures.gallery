import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryArtifactStore } from "../v1/artifacts.js";
import { MemoryAuthState } from "../v1/authState.js";
import { DEV_RENDERER_VERSION, developmentFixtureRenderer, RendererRegistry } from "../v1/renderer.js";
import { MemorySignatureStore } from "../v1/store.js";
import { startServer } from "./server.js";

const servers: ReturnType<typeof startServer>[] = [];
const routes = [
  { path: "/dev/slogan-study", contentType: "text/html; charset=utf-8" },
  { path: "/dev/slogan-study.css", contentType: "text/css; charset=utf-8" },
] as const;

async function boot(fixtureMode: boolean) {
  const store = new MemorySignatureStore();
  const artifacts = new MemoryArtifactStore();
  const auth = new MemoryAuthState();
  const renderers = new RendererRegistry([developmentFixtureRenderer]);
  const server = startServer({ store, artifacts, auth, renderers }, 0, {
    fixtureMode,
    activeRendererVersion: DEV_RENDERER_VERSION,
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { baseUrl, store, artifacts };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  vi.restoreAllMocks();
});

describe("local slogan study", () => {
  it.each(routes)("serves $path without caching or indexing in fixture mode", async ({ path, contentType }) => {
    const { baseUrl } = await boot(true);
    const response = await fetch(`${baseUrl}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(contentType);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("set-cookie")).toBeNull();
    const body = await response.text();
    if (path.endsWith(".css")) {
      expect(body).toContain(".study-shell");
    } else {
      expect(body).toContain('<meta name="robots" content="noindex,nofollow">');
      expect(body).toContain('href="/dev/slogan-study.css"');
      expect(body).toContain("What shape do you go by?");
      expect(body).toContain("What shape is your handle?");
      expect(body).toContain("data-mark-id=");
      expect(body).toContain('id="letter-case"');
      expect(body).toContain('data-source-literal="What_shape_do_you_go_by?"');
      expect(body).toContain('data-source-literal="What_Shape_Do_You_Go_By?"');
      expect(body).toContain('data-identical-shapes="false"');
      expect(body).toContain('data-renderer-input="What_shape_do_you_go_by?"');
      expect(body).toContain('data-renderer-input="What_Shape_Do_You_Go_By?"');
    }
  });

  it.each(routes)("returns headers but no body for HEAD $path", async ({ path, contentType }) => {
    const { baseUrl } = await boot(true);
    const response = await fetch(`${baseUrl}${path}`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(contentType);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await response.text()).toBe("");
  });

  it.each(routes)("hides GET and HEAD $path outside fixture mode", async ({ path }) => {
    const { baseUrl } = await boot(false);
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(`${baseUrl}${path}`, { method });
      expect(response.status).toBe(404);
      const body = await response.text();
      expect(body).not.toContain("data-mark-id=");
      expect(body).not.toContain(".study-shell");
      if (method === "HEAD") expect(body).toBe("");
    }
  });

  it.each([true, false])("rejects POST requests when fixtureMode is %s", async (fixtureMode) => {
    const { baseUrl } = await boot(fixtureMode);
    for (const { path } of routes) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: baseUrl },
        body: JSON.stringify({ accept: true, copy: "go-by" }),
      });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("data-mark-id=");
    }
  });

  it("does not change the homepage, claim records, or stored artifacts", async () => {
    const { baseUrl, store, artifacts } = await boot(true);
    const claim = vi.spyOn(store, "claim");
    const updateAccount = vi.spyOn(store, "updateExistingAccountLogin");
    const writeArtifact = vi.spyOn(artifacts, "putVerified");
    const deleteArtifact = vi.spyOn(artifacts, "delete");
    const releaseReference = vi.spyOn(artifacts, "releaseReference");
    const homeBefore = await (await fetch(`${baseUrl}/`)).text();
    const claimsBefore = await store.listSignaturesForAccount("study-observer");

    for (const { path } of routes) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(200);
      await response.text();
    }

    expect(await (await fetch(`${baseUrl}/`)).text()).toBe(homeBefore);
    expect(await store.listSignaturesForAccount("study-observer")).toEqual(claimsBefore);
    expect(claim).not.toHaveBeenCalled();
    expect(updateAccount).not.toHaveBeenCalled();
    expect(writeArtifact).not.toHaveBeenCalled();
    expect(deleteArtifact).not.toHaveBeenCalled();
    expect(releaseReference).not.toHaveBeenCalled();
  });
});
