import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { WITHDRAW_CLAIM_DIALOG_SCRIPT } from "./withdrawClaimDialog.js";

function element() {
  const handlers = new Map<string, (event: any) => void>();
  return { hidden: false, disabled: false, open: false, type: "", className: "", textContent: "",
    append: vi.fn(), setAttribute: vi.fn(), removeAttribute: vi.fn(), focus: vi.fn(),
    addEventListener: (type: string, listener: (event: any) => void) => handlers.set(type, listener),
    fire: (type: string, event: any = {}) => handlers.get(type)?.(event) };
}
function boot(supportsDialog: boolean | "missing-method" = true) {
  const trigger = element(), label = element(), fallback = element(), form = element();
  const cancel = element(), confirm = element(), window = element();
  cancel.hidden = true;
  const dialog = { ...element(), showModal: vi.fn(() => { dialog.open = true; }), close: vi.fn(() => { dialog.open = false; dialog.fire("close"); }) };
  const content = { querySelector: (selector: string) => selector === "form" ? form : selector === "[data-withdraw-cancel]" ? cancel : confirm };
  const root = { append: vi.fn(), insertBefore: vi.fn(), querySelector: (selector: string) => selector === "details" ? fallback : content };
  const document = { querySelectorAll: () => [root], createElement: (tag: string) => tag === "button" ? trigger : tag === "dialog" ? dialog : label };
  const fetch = vi.fn();
  runInNewContext(WITHDRAW_CLAIM_DIALOG_SCRIPT, { document, window, fetch, HTMLDialogElement: supportsDialog === "missing-method" ? { prototype: {} } : supportsDialog ? { prototype: { showModal() {} } } : undefined });
  return { trigger, label, content, fallback, form, cancel, confirm, dialog, root, window, fetch };
}

describe("withdrawal confirmation dialog", () => {
  it("moves only confirmation content, preserving the disclosure for the warning and CTA", () => {
    const f = boot();
    expect(f.dialog.append.mock.calls).toEqual([[f.content]]);
    expect(f.root.append.mock.calls).toEqual([[f.dialog]]);
    expect(f.fallback.append.mock.calls).toEqual([[f.trigger]]);
    expect(f.trigger.setAttribute).toHaveBeenCalledWith("aria-haspopup", "dialog");
    expect(f.dialog.setAttribute).toHaveBeenCalledWith("aria-labelledby", "withdraw-title");
    expect(f.label.textContent).toBe("Withdraw claim");
  });

  it("is a no-op on pages without owner withdrawal controls", () => {
    const document = { querySelectorAll: vi.fn(() => []), createElement: vi.fn() };
    expect(() => runInNewContext(WITHDRAW_CLAIM_DIALOG_SCRIPT, {
      document, HTMLDialogElement: { prototype: { showModal() {} } },
    })).not.toThrow();
    expect(document.createElement).not.toHaveBeenCalled();
  });

  it.each(["cancel", "unrelated", "missing"] as const)("rejects a %s submitter without locking the form", (kind) => {
    const f = boot(), preventDefault = vi.fn();
    f.trigger.fire("click");
    const submitter = kind === "cancel" ? f.cancel : kind === "unrelated" ? element() : undefined;
    f.form.fire("submit", { submitter, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(f.form.setAttribute).not.toHaveBeenCalled();
    expect(f.cancel.disabled).toBe(false);
    f.form.fire("submit", { submitter: f.confirm, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(f.form.setAttribute).toHaveBeenCalledWith("aria-busy", "true");
  });

  it("allows reopening after cancellation but still requires an explicit confirmation", () => {
    const f = boot(), preventDefault = vi.fn();
    for (let i = 0; i < 3; i++) {
      f.trigger.fire("click");
      f.cancel.fire("click");
      f.form.fire("submit", { submitter: f.confirm, preventDefault });
    }
    expect(preventDefault).toHaveBeenCalledTimes(3);
    expect(f.form.setAttribute).not.toHaveBeenCalled();
    expect(f.trigger.focus).toHaveBeenCalledTimes(3);
    f.trigger.fire("click");
    f.form.fire("submit", { submitter: f.confirm, preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(3);
  });

  it("does not unlock an in-flight submission on an ordinary pageshow event", () => {
    const f = boot(), preventDefault = vi.fn();
    f.trigger.fire("click");
    f.form.fire("submit", { submitter: f.confirm, preventDefault });
    f.window.fire("pageshow", { persisted: false });
    expect(f.cancel.disabled).toBe(true);
    expect(f.dialog.open).toBe(true);
    expect(f.form.removeAttribute).not.toHaveBeenCalled();
    f.form.fire("submit", { submitter: f.confirm, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  });
  it("opens without submitting and focuses the non-destructive option", () => {
    const f = boot();
    expect(f.trigger.type).toBe("button");
    expect(f.fallback.hidden).toBe(false);
    expect(f.fallback.open).toBe(false);
    expect(f.fallback.append).toHaveBeenCalledWith(f.trigger);
    expect(f.root.insertBefore).not.toHaveBeenCalled();
    expect(f.cancel.hidden).toBe(false);
    expect(f.dialog.open).toBe(false);
    expect(f.dialog.setAttribute).toHaveBeenCalledWith("aria-describedby", "withdraw-work");
    expect(f.dialog.setAttribute).not.toHaveBeenCalledWith("aria-describedby", expect.stringContaining("withdraw-description"));
    f.trigger.fire("click");
    expect(f.dialog.open).toBe(true);
    expect(f.cancel.focus).toHaveBeenCalledOnce();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.form.setAttribute).not.toHaveBeenCalled();
    expect(WITHDRAW_CLAIM_DIALOG_SCRIPT).not.toMatch(/fetch\(|\.submit\(|requestSubmit\(/);
  });
  it("cancels without a write and returns focus to the original trigger", () => {
    const f = boot();
    f.trigger.fire("click"); f.cancel.fire("click");
    expect(f.dialog.open).toBe(false);
    expect(f.trigger.focus).toHaveBeenCalledOnce();
    expect(f.form.setAttribute).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("allows native Escape before confirmation", () => {
    const f = boot(), preventDefault = vi.fn();
    f.trigger.fire("click"); f.dialog.fire("cancel", { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });
  it("only allows the explicit confirm submitter from an open dialog", () => {
    const f = boot(), preventDefault = vi.fn();
    f.form.fire("submit", { submitter: f.confirm, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    f.trigger.fire("click");
    f.form.fire("submit", { submitter: null, preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(2);
    f.form.fire("submit", { submitter: f.confirm, preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(f.form.setAttribute).toHaveBeenCalledWith("aria-busy", "true");
    expect(f.cancel.disabled).toBe(true);
    expect(f.confirm.disabled).toBe(false); // Keep confirm=withdraw in native form data.
  });
  it("blocks duplicate submission and cannot pretend to cancel a submitted request", () => {
    const f = boot(), preventDefault = vi.fn();
    f.trigger.fire("click"); f.form.fire("submit", { submitter: f.confirm, preventDefault });
    f.form.fire("submit", { submitter: f.confirm, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    f.cancel.fire("click"); expect(f.dialog.open).toBe(true);
    f.dialog.fire("cancel", { preventDefault }); expect(preventDefault).toHaveBeenCalledTimes(2);
  });
  it("resets a restored browser-history page to require confirmation again", () => {
    const f = boot();
    f.trigger.fire("click"); f.form.fire("submit", { submitter: f.confirm, preventDefault: vi.fn() });
    f.window.fire("pageshow", { persisted: true });
    expect(f.dialog.open).toBe(false); expect(f.cancel.disabled).toBe(false);
    expect(f.form.removeAttribute).toHaveBeenCalledWith("aria-busy");
    f.trigger.fire("click"); const preventDefault = vi.fn();
    f.form.fire("submit", { submitter: f.confirm, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });
  it.each([false, "missing-method"] as const)("keeps the explicit inline fallback with dialog support %s", (support) => {
    const f = boot(support);
    expect(f.fallback.hidden).toBe(false);
    expect(f.root.insertBefore).not.toHaveBeenCalled();
    expect(f.cancel.hidden).toBe(true);
    expect(f.dialog.append).not.toHaveBeenCalled();
    expect(f.fallback.append).not.toHaveBeenCalled();
  });
});
