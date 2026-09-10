import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAIM_NOTICE_SCRIPT, CLAIM_SUCCESS_MESSAGE, CLAIM_TOAST_DURATION_MS, claimNoticeShell } from "./claimNotice.js";
import { SITE_CSS } from "./siteCss.js";

function events() {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  return { addEventListener: (name: string, fn: (event: Record<string, unknown>) => void) => handlers.set(name, fn),
    fire: (name: string, event: Record<string, unknown> = {}) => handlers.get(name)?.(event) };
}
async function boot(show: unknown = true, fails = false, initiallyActive = true) {
  vi.useFakeTimers();
  const message = { textContent: "" };
  const close = events();
  const document = { ...events(), hidden: false, hasFocus: () => initiallyActive, activeElement: null as unknown, querySelector: () => toast };
  const toast = { ...events(), hidden: true, dataset: { claimNotice: "/notice" },
    contains: (node: unknown) => node === close,
    querySelector: (selector: string) => selector === "[data-notice-message]" ? message : close };
  const window = events();
  const fetch = vi.fn(async () => { if (fails) throw new Error("offline"); return { ok: true, json: async () => ({ show }) }; });
  runInNewContext(CLAIM_NOTICE_SCRIPT, { document, window, fetch, performance: { now: () => Date.now() }, requestAnimationFrame: (fn: () => void) => fn(), setTimeout, clearTimeout });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  return { toast, message, close, document, window, fetch };
}
afterEach(() => vi.useRealTimers());

describe("claim success toast", () => {
  it("uses a hidden polite live region outside layout, not an intrusive alert", () => {
    const html = claimNoticeShell("sg1_" + "a".repeat(52));
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(html).toContain('hidden>');
    expect(html).toContain('aria-label="Dismiss notification"');
    expect(html).not.toContain(CLAIM_SUCCESS_MESSAGE);
    expect(html).not.toContain('role="alert"');
    expect(claimNoticeShell('\"><script>')).toBe("");
    expect(SITE_CSS).toMatch(/\.claim-toast\{[^}]*position:fixed/);
  });
  it("shows verified feedback without moving focus, then disappears after five seconds", async () => {
    const { toast, message, document, fetch } = await boot();
    expect(fetch).toHaveBeenCalledWith("/notice", { credentials: "same-origin", cache: "no-store" });
    expect(toast.hidden).toBe(false);
    expect(message.textContent).toBe(CLAIM_SUCCESS_MESSAGE);
    expect(document.activeElement).toBeNull();
    expect(CLAIM_TOAST_DURATION_MS).toBe(5000);
    vi.advanceTimersByTime(4999);
    expect(toast.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(toast.hidden).toBe(true);
  });
  it("pauses while hovered or focused and supports explicit dismissal", async () => {
    const { toast, close, document } = await boot();
    toast.fire("pointerenter");
    vi.advanceTimersByTime(20000);
    expect(toast.hidden).toBe(false);
    document.activeElement = close;
    toast.fire("focusin");
    toast.fire("pointerleave");
    vi.advanceTimersByTime(20000);
    expect(toast.hidden).toBe(false);
    close.fire("click");
    expect(toast.hidden).toBe(true);
  });
  it.each(["hover", "focus", "window", "tab"])("resumes the remaining time after %s, without restarting a full five seconds", async kind => {
    const { toast, close, document, window } = await boot();
    vi.advanceTimersByTime(2000);
    if (kind === "hover") toast.fire("pointerenter");
    if (kind === "focus") { document.activeElement = close; toast.fire("focusin"); }
    if (kind === "window") window.fire("blur");
    if (kind === "tab") { document.hidden = true; document.fire("visibilitychange"); }
    vi.advanceTimersByTime(20000);
    expect(toast.hidden).toBe(false);
    if (kind === "hover") toast.fire("pointerleave");
    if (kind === "focus") { document.activeElement = null; toast.fire("focusout"); vi.advanceTimersByTime(0); }
    if (kind === "window") window.fire("focus");
    if (kind === "tab") { document.hidden = false; document.fire("visibilitychange"); }
    vi.advanceTimersByTime(2999);
    expect(toast.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(toast.hidden).toBe(true);
  });
  it("waits for the window to become active before starting the clock", async () => {
    const { toast, window } = await boot(true, false, false);
    vi.advanceTimersByTime(20000);
    expect(toast.hidden).toBe(false);
    window.fire("focus");
    vi.advanceTimersByTime(5000);
    expect(toast.hidden).toBe(true);
  });
  it.each(["Escape", "back-forward"])("dismisses on %s", async kind => {
    const { toast, document, window } = await boot();
    if (kind === "Escape") document.fire("keydown", { key: "Escape" });
    else window.fire("pageshow", { persisted: true });
    expect(toast.hidden).toBe(true);
  });
  it.each([false, "true", null])("does not fabricate success for response %s", async show => {
    expect((await boot(show)).toast.hidden).toBe(true);
  });
  it("quietly tolerates an unavailable notification endpoint", async () => {
    expect((await boot(true, true)).toast.hidden).toBe(true);
  });
});
