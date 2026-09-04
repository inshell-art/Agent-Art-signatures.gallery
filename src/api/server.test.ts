import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryArtifactStore } from "../v1/artifacts.js";
import { MemoryAuthState } from "../v1/authState.js";
import { seedDevelopmentFixtures } from "../v1/fixtures.js";
import { DEV_CARD_RENDERER_VERSION, DEV_RENDERER_VERSION, developmentFixtureRenderer, RendererRegistry } from "../v1/renderer.js";
import { MemorySignatureStore } from "../v1/store.js";
import { startServer } from "./server.js";

let server: ReturnType<typeof startServer>;
let store: MemorySignatureStore;
let baseUrl: string;

async function boot(seed = false) {
  store = new MemorySignatureStore();
  const artifacts = new MemoryArtifactStore();
  const auth = new MemoryAuthState();
  const renderers = new RendererRegistry([developmentFixtureRenderer]);
  if (seed) await seedDevelopmentFixtures({ store, artifacts, renderers, cardRendererVersion: DEV_CARD_RENDERER_VERSION }, auth);
  server = startServer({ store, artifacts, auth, renderers }, 0, { fixtureMode: true, activeRendererVersion: DEV_RENDERER_VERSION });
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
}

function closeServer(): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function post(path: string, body: URLSearchParams, cookie?: string) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: baseUrl,
      "Sec-Fetch-Site": "same-origin",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
  });
}

beforeEach(() => boot());
afterEach(() => closeServer());

describe("V1 previews", () => {
  it("serves the system-aware theme control under the site CSP", async () => {
    const page = await fetch(`${baseUrl}/`);
    const html = await page.text();
    expect(html).toContain('data-theme-value="auto"');
    expect(html).toContain('data-theme-value="light"');
    expect(html).toContain('data-theme-value="dark"');
    expect(html).toContain('<script src="/assets/theme.js"></script>');
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");

    const script = await fetch(`${baseUrl}/assets/theme.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(await script.text()).toContain("signatures-gallery-theme");
    const css = await fetch(`${baseUrl}/assets/site.css`);
    expect(await css.text()).toContain("prefers-color-scheme:dark");
  });

  it("canonicalizes handle and fixed-point gr0k without creating a signature", async () => {
    const response = await fetch(`${baseUrl}/s/%40Alice/0.5`, { redirect: "manual" });
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/s/alice/0.500000");
    expect(await store.listSignaturesForAccount("1234567890123456789")).toEqual([]);
  });

  it("renders canonical previews and card metadata without persistence", async () => {
    const response = await fetch(`${baseUrl}/s/alice/0.371924`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Unclaimed preview");
    expect(html).toContain("sg-renderer-dev-fixture");
    expect(html).toContain("twitter:card");
    expect(await store.listSignaturesForAccount("1234567890123456789")).toEqual([]);
  });

  it("supports side-effect-free HEAD and immutable render assets", async () => {
    const head = await fetch(`${baseUrl}/s/alice/0.371924`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const svg = await fetch(`${baseUrl}/renders/${DEV_RENDERER_VERSION}/alice/0.371924.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get("cache-control")).toContain("immutable");
    expect(await svg.text()).toContain("<svg");
    expect(await store.listSignaturesForAccount("1234567890123456789")).toEqual([]);
  });

  it("rejects invalid decimal grammar and encoded slash handles", async () => {
    expect((await fetch(`${baseUrl}/s/alice/1e-3`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/s/alice%2Fbob/0.500000`)).status).toBe(400);
  });

  it("retires the legacy routes with 410", async () => {
    expect((await fetch(`${baseUrl}/s/alice/hfwo/123`)).status).toBe(410);
    expect((await fetch(`${baseUrl}/c/alice`)).status).toBe(410);
    expect((await fetch(`${baseUrl}/v/1`)).status).toBe(410);
  });
});

describe("fixture account and claim flow", () => {
  it("shows seeded fixture signatures only after fixture login", async () => {
    await closeServer();
    await boot(true);
    expect((await fetch(`${baseUrl}/me`)).status).toBe(401);
    const login = await post("/dev/login", new URLSearchParams());
    expect(login.status).toBe(303);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const collection = await fetch(`${baseUrl}/me`, { headers: { Cookie: cookie } });
    expect(collection.status).toBe(200);
    const html = await collection.text();
    expect(html).toContain("Private account collection");
    expect((html.match(/class="signature-card"/g) ?? [])).toHaveLength(3);
  });

  it("allows the local fixture flow without external X authentication", async () => {
    const response = await fetch(`${baseUrl}/auth/x/start`, { method: "POST", redirect: "manual", body: new URLSearchParams({ purpose: "claim", handle: "alice", gr0k: "0.5" }) });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/claim/review");
  });

  it("creates nothing at OAuth callback or review and only claims on final POST", async () => {
    const start = await post("/auth/x/start", new URLSearchParams({ purpose: "claim", handle: "alice", gr0k: "0.500000" }));
    expect(start.status).toBe(303);
    const cookie = start.headers.get("set-cookie")!.split(";")[0];
    const reviewPath = start.headers.get("location")!;
    expect(await store.listSignaturesForAccount("1234567890123456789")).toHaveLength(0);
    const review = await fetch(`${baseUrl}${reviewPath}`, { headers: { Cookie: cookie } });
    expect(review.status).toBe(200);
    const html = await review.text();
    const flow = html.match(/name="flow" value="([^"]+)"/)![1];
    const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
    expect(await store.listSignaturesForAccount("1234567890123456789")).toHaveLength(0);
    const claim = await post("/api/v1/signatures", new URLSearchParams({ flow, csrf }), cookie);
    expect(claim.status).toBe(303);
    const signatures = await store.listSignaturesForAccount("1234567890123456789");
    expect(signatures).toHaveLength(1);
    expect(claim.headers.get("location")).toBe(`/signatures/${signatures[0].signatureId}`);
  });

  it("serves a stable permalink and immutable claimed artifacts", async () => {
    await closeServer();
    await boot(true);
    const login = await post("/dev/login", new URLSearchParams());
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const signatures = await store.listSignaturesForAccount("1234567890123456789");
    const signature = signatures[0];
    const page = await fetch(`${baseUrl}/signatures/${signature.signatureId}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Claimed via X");
    const svg = await fetch(`${baseUrl}/artifacts/${signature.signatureId}.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get("cache-control")).toContain("immutable");
    expect(cookie).toContain("sg_dev_session=");
  });
});
