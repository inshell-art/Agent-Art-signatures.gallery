import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryArtifactStore } from "../v1/artifacts.js";
import { MemoryAuthState } from "../v1/authState.js";
import { COLLECTION_STATE_FIXTURES } from "../v1/collectionStateFixtures.js";
import { RENDERER_VERSION, formalSignatureRenderer, RendererRegistry } from "../v1/renderer.js";
import { MemorySignatureStore } from "../v1/store.js";
import { SITE_CSS, SITE_CSS_URL } from "../v1/siteCss.js";
import { startServer } from "./server.js";
import { xProfileLink } from "../v1/xProfile.js";

const servers: ReturnType<typeof startServer>[] = [];
async function boot(fixtureMode: boolean, localChainRehearsal = false) {
  const store = new MemorySignatureStore();
  const artifacts = new MemoryArtifactStore();
  const auth = new MemoryAuthState();
  const server = startServer({ store, artifacts, auth, renderers: new RendererRegistry([formalSignatureRenderer]) }, 0, { fixtureMode, localChainRehearsal, activeRendererVersion: RENDERER_VERSION });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store, artifacts, auth };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); })));
  vi.restoreAllMocks();
});

describe("read-only collection state fixtures", () => {
  it.each([[true, false], [false, true], [false, false]])("serves current versioned CSS without development caching (fixture=%s, local=%s)", async (fixture, local) => {
    const { base } = await boot(fixture, local);
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(base + SITE_CSS_URL, { method });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe(fixture || local ? "no-store" : "public, max-age=300");
      expect(await response.text()).toBe(method === "HEAD" ? "" : SITE_CSS);
    }
    expect(await (await fetch(base + "/me")).text()).toContain(`href="${SITE_CSS_URL}"`);
  });

  it.each([[true, false], [false, true], [false, false]])("serves the overlay enhancement only in development (fixture=%s, local=%s)", async (fixture, local) => {
    const { base } = await boot(fixture, local);
    const response = await fetch(`${base}/assets/rehearsal-overlay.js`);
    expect(response.status).toBe(fixture || local ? 200 : 404);
    expect(response.headers.get("set-cookie")).toBeNull();
    if (fixture || local) {
      expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(await response.text()).toContain('document.addEventListener("click"');
    }
  });

  it.each(COLLECTION_STATE_FIXTURES)("renders $key using the shared collection/account components", async ({ key, label }) => {
    const { base } = await boot(true);
    const response = await fetch(`${base}/dev/collection-states?state=${key}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("set-cookie")).toBeNull();
    const html = await response.text();
    expect(html).toContain('class="book-page" data-state-preview');
    expect(html).toContain(`Fixture · ${label}`);
    expect(html).toContain(`data-fixture-state="${key}"`);
    expect(html).toContain("This status is forced by the URL, not your live collection.");
    expect(html).not.toMatch(/class="(?:collection-state-nav|fixture-links)"/);
    const switcher = html.match(/<nav class="rehearsal-fixture-links"[\s\S]*?<\/nav>/)![0];
    expect(switcher.match(/<a\b/g)).toHaveLength(COLLECTION_STATE_FIXTURES.length);
    expect(switcher.match(/aria-current="page"/g)).toHaveLength(1);
    expect(switcher).toContain(`href="/dev/collection-states?state=${key}" aria-current="page"`);
    expect(html.match(/<main>[\s\S]*?<\/main>/)![0]).not.toContain('class="rehearsal-fixture-links"');
    expect(html.match(/<main>[\s\S]*?<\/main>/)![0]).not.toContain("Read-only UI fixture");
    expect(html).toContain('data-account-preview');
    expect(html).toContain('<fieldset class="preview-controls" disabled>');
    expect(html).not.toContain('/assets/mint.js');
    expect(html).not.toContain('data-advance-rehearsal');
    expect(html).not.toContain('data-local-mint-pending');
    expect(html).not.toContain('data-local-transfer');
    expect(html).not.toMatch(/href="\/signatures\//);
    expect(html).not.toMatch(/src="\/artifacts\//);
    expect(html.match(/class="rehearsal-watermark"/g)).toHaveLength(1);
    const empty = ["empty", "wrong-claimant", "signed-out", "gallery-claimed-empty", "gallery-minted-empty"].includes(key);
    expect(html.includes("data-grok-handoff")).toBe(empty);
    expect(html.includes("/assets/grok-prompt.js")).toBe(empty);
    if (empty) expect(html).toContain(`${base}/s/${key === "empty" ? "newcomer" : key === "wrong-claimant" ? "bob" : "HANDLE"}/GR0K`);
    if (!empty) expect(html).toContain('class="collection-card"');
  });

  it.each([false, true])("never changes records, artifacts, sessions, or live identity in local-chain=%s mode", async (local) => {
    const { base, store, artifacts, auth } = await boot(true, local);
    const claim = vi.spyOn(store, "claim");
    const account = vi.spyOn(store, "updateExistingAccountLogin");
    const put = vi.spyOn(artifacts, "putVerified");
    const session = vi.spyOn(auth, "getOrCreateSession");
    const homeBefore = await (await fetch(base)).text();
    for (const { key } of COLLECTION_STATE_FIXTURES) {
      await fetch(`${base}/dev/collection-states?state=${key}`, { headers: { Cookie: "sg_dev_session=not-a-real-session" } });
    }
    const artwork = await fetch(`${base}/dev/collection-states/artwork.svg`);
    expect(artwork.status).toBe(200);
    expect(artwork.headers.get("content-type")).toBe("image/svg+xml");
    expect(await artwork.text()).toContain("<svg");
    expect(await (await fetch(base)).text()).toBe(homeBefore);
    for (const spy of [claim, account, put, session]) expect(spy).not.toHaveBeenCalled();
    expect(await store.listClaimedSignatures(100)).toEqual([]);
  });

  it("has distinct mint, transfer, pause, rename, and action-confirmation views", async () => {
    const { base } = await boot(true);
    const page = async (state: string) => (await fetch(`${base}/dev/collection-states?state=${state}`)).text();
    expect(await page("minted")).toContain("Current holder · 0x11111…11111");
    expect(await page("transferred")).toContain("Current holder · 0x22222…22222");
    expect(await page("transferred")).toContain("@alice");
    expect(await page("confirming")).toContain('class="signature-tag">Confirming<');
    expect(await page("mint-paused")).toContain("Minting paused");
    expect(await page("reauthenticate")).not.toMatch(/Replace wallet|Revoke wallet|Link wallet|data-link-wallet/);
    expect(await page("reauthenticate")).not.toContain("Wallet management is available after reauthentication");
    const renamed = await page("renamed");
    expect(renamed).toContain("@alice_studio");
    expect(renamed).toContain(`<strong>${xProfileLink("alice")}</strong>`);
  });

  it.each([
    ["signed-out", "sign-in"], ["claimed", "wallet"], ["wallet-linked", "wallet"], ["recipient-verified", "ready"], ["authorized", "pending"],
    ["submitted", "pending"], ["confirming", "pending"], ["validation-pending", "pending"], ["wrong-claimant", "wrong-account"],
    ["mint-paused", "paused"], ["reauthenticate", "wallet"], ["renamed", "wallet"],
  ])("previews the next mint step from %s without enabling writes", async (state, stage) => {
    const { base, store } = await boot(true);
    const response = await fetch(`${base}/dev/collection-states?state=${state}&view=mint`);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain(`data-mint-entry="${stage}"`);
    expect(html).toContain('<fieldset class="preview-controls" disabled>');
    expect(html).not.toContain('/assets/mint.js');
    expect(html).not.toContain('class="mint-authorization-form"');
    expect(html).toContain(`href="/dev/collection-states?state=${state}"`);
    expect(await store.listClaimedSignatures(100)).toEqual([]);
    if (!["signed-out", "wrong-claimant", "authorized", "submitted", "confirming", "validation-pending"].includes(state)) {
      const collection = await (await fetch(`${base}/dev/collection-states?state=${state}`)).text();
      expect(collection).toContain(`href="/dev/collection-states?state=${state}&amp;view=mint"`);
    }
  });

  it("does not turn an earlier recipient into a new mint approval", async () => {
    const { base } = await boot(true);
    const html = await (await fetch(`${base}/dev/collection-states?state=wallet-linked&view=mint`)).text();
    expect(html).toContain('data-mint-entry="wallet"');
    expect(html).not.toContain('name="action" value="mint_recipient"');
    expect(html).toContain('<span>Connect wallet</span>');
    expect(html).toContain('data-link-wallet');
    expect(html).toContain('data-wallet-provider');
    expect(html).not.toContain('class="mint-authorization-form"');
    expect(html).toContain('This new mint still requires a fresh wallet proof, without another X sign-in for an active claimant session.');
  });

  it("supports HEAD, rejects unknown/duplicate states and POST, and keeps fixtures out of production", async () => {
    const { base } = await boot(true);
    for (const path of ["/dev/collection-states", "/dev/collection-states/artwork.svg", "/assets/grok-prompt.js", "/assets/rehearsal-overlay.js"]) {
      const head = await fetch(base + path, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(head.headers.get("set-cookie")).toBeNull();
      expect((await fetch(base + path, { method: "POST" })).status).toBe(404);
    }
    for (const query of ["?state=not-a-state", "?state=empty&state=minted", "?state=%3Cscript%3E", "?state=claimed&view=bad", "?state=claimed&view=mint&view=mint", "?state=empty&view=mint", "?state=minted&view=mint"]) expect((await fetch(base + "/dev/collection-states" + query)).status).toBe(404);
    const production = await boot(false);
    for (const path of ["/dev/collection-states", "/dev/collection-states?state=empty", "/dev/collection-states/artwork.svg", "/assets/rehearsal-overlay.js"]) {
      for (const method of ["GET", "HEAD"]) expect((await fetch(production.base + path, { method })).status).toBe(404);
    }
    expect(await (await fetch(production.base)).text()).not.toContain("/dev/collection-states");
    expect((await fetch(production.base + "/assets/grok-prompt.js")).status).toBe(200);
  });
});
