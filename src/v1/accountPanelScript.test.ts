import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { ACCOUNT_PANEL_SCRIPT } from "./accountPanelScript.js";

function element() {
  const events = new Map<string, (event: Record<string, unknown>) => void>();
  return {
    dataset: {} as Record<string, string>, innerHTML: "", inert: false,
    setAttribute: vi.fn(), removeAttribute: vi.fn(), focus: vi.fn(),
    contains: () => false, matches: () => false, hasAttribute: () => false,
    addEventListener: (name: string, listener: (event: Record<string, unknown>) => void) => events.set(name, listener),
    fire: (name: string, event: Record<string, unknown> = {}) => events.get(name)?.(event),
  };
}

function boot(pathname: string, preview = false) {
  const link = element(), toggle = element(), body = element();
  const panel = { ...element(), querySelector: () => null };
  const menu = {
    ...element(), hasAttribute: () => preview,
    querySelector: (selector: string) => ({
      ".collection-shortcut": link, ".account-menu-toggle": toggle,
      ".account-panel": panel, "[data-account-panel-body]": body,
    })[selector],
  };
  const window = { ...element(), dispatchEvent: vi.fn() };
  const document = { ...element(), activeElement: null, querySelector: (selector: string) => selector === "[data-account-menu]" ? menu : null };
  const fetch = vi.fn(async (_path: string, _options: unknown) => ({ ok: true, json: async () => ({ html: "Fresh private account controls" }) }));
  runInNewContext(ACCOUNT_PANEL_SCRIPT, {
    document, window, location: { pathname, search: "?flow=private-value", hash: "#withdraw" },
    fetch, Event, setTimeout, clearTimeout,
  });
  return { menu, window, fetch, body };
}

describe("account panel refresh destination", () => {
  const signature = `/signatures/sg1_${"a".repeat(52)}`;
  it.each(["/me", signature, `${signature}/mint`])("keeps the exact safe %s action return after private refresh", async pathname => {
    const ui = boot(pathname);
    ui.menu.fire("pointerenter", { pointerType: "mouse" });
    await vi.waitFor(() => expect(ui.body.innerHTML).toBe("Fresh private account controls"));
    expect(ui.fetch).toHaveBeenCalledWith(`/api/v1/account-panel?return_to=${encodeURIComponent(pathname)}`, {
      credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" },
    });
    expect(ui.fetch.mock.calls[0]![0]).not.toMatch(/flow|private-value|withdraw|%23/);
  });

  it.each(["/", "/s/alice/22", "/dev/collection-states", `${signature}/withdraw`, "/signatures/sg1_invalid/mint", "//external.example", "/me?next=external", "/me/"])("falls back to /me for unapproved path %s", async pathname => {
    const ui = boot(pathname);
    ui.window.fire("dev-panel:open");
    await vi.waitFor(() => expect(ui.body.innerHTML).toBe("Fresh private account controls"));
    expect(ui.fetch.mock.calls[0]![0]).toBe("/api/v1/account-panel?return_to=%2Fme");
  });

  it("does not fetch or override presentation-only fixture controls", () => {
    const ui = boot(`${signature}/mint`, true);
    ui.menu.fire("pointerenter", { pointerType: "mouse" });
    ui.window.fire("dev-panel:open");
    expect(ui.fetch).not.toHaveBeenCalled();
  });
});
