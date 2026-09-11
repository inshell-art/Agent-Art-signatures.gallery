import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { X_ACTION_PROGRESS_SCRIPT } from "./xActionProgress.js";

function element(initial: Record<string, string> = {}) {
  const attrs = new Map(Object.entries(initial));
  return {
    textContent: "", disabled: false,
    getAttribute: (name: string) => attrs.get(name) ?? null,
    setAttribute: vi.fn((name: string, value: string) => { attrs.set(name, value); }),
    removeAttribute: vi.fn((name: string) => { attrs.delete(name); }),
  };
}

function actionForm() {
  const feedback = element(), submitter = element();
  const attributes = element();
  let method = "post", action = "/auth/x/start";
  const fields = new Map<string, string[]>([
    ["purpose", ["sensitive_action"]], ["action", ["claim_withdraw"]],
    ["csrf", ["original-csrf"]], ["signature_id", ["signature-id"]],
    ["claim_instance", ["claim-instance"]], ["return_to", ["/signatures/signature-id"]],
  ]);
  const form = {
    ...attributes, fields, marked: true,
    get method() { return method; }, set method(value: string) { method = value; },
    get action() { return action; }, set action(value: string) { action = value; },
    getAttribute: (name: string) => name === "action" ? action : name === "method" ? method : attributes.getAttribute(name),
    matches: (selector: string) => form.marked && selector === "form[data-x-action-form]",
    querySelector: (selector: string) => selector === "[data-x-action-feedback]" ? feedback : null,
    submit: vi.fn(), requestSubmit: vi.fn(),
  };
  return { form, feedback, submitter };
}

function boot() {
  vi.useFakeTimers();
  const handlers = new Map<string, (event: any) => void>();
  const document = { addEventListener: (type: string, listener: (event: any) => void) => handlers.set(type, listener) };
  const window = { addEventListener: (type: string, listener: (event: any) => void) => handlers.set(type, listener) };
  const fetch = vi.fn();
  class FormData {
    constructor(private form: ReturnType<typeof actionForm>["form"]) {}
    getAll(name: string) { return this.form.fields.get(name) ?? []; }
  }
  runInNewContext(X_ACTION_PROGRESS_SCRIPT, {
    document, window, URL, FormData, fetch, setTimeout, clearTimeout,
    location: { href: "https://signatures.test/me", origin: "https://signatures.test" },
  });
  return {
    fetch,
    submit: (f: ReturnType<typeof actionForm>, override: Record<string, unknown> = {}) => {
      const event = { target: f.form, submitter: f.submitter, defaultPrevented: false, preventDefault: vi.fn(), ...override };
      handlers.get("submit")?.(event);
      return event;
    },
    pageshow: (persisted: boolean) => handlers.get("pageshow")?.({ persisted }),
  };
}

afterEach(() => vi.useRealTimers());

describe("X action redirect progress", () => {
  it("reads the endpoint attribute when the action input shadows the native form property", () => {
    const app = boot(), f = actionForm();
    Object.defineProperty(f.form, "action", { value: { name: "action", value: "wallet_link" } });
    expect(app.submit(f).preventDefault).not.toHaveBeenCalled();
    expect(f.feedback.textContent).toBe("Opening X to confirm your identity…");
  });
  it("shows progress only after submitting, preserving the native form and CTA", () => {
    const app = boot(), f = actionForm();
    f.submitter.textContent = "Withdraw claim";
    const fields = [...f.form.fields.entries()];
    expect(f.feedback.textContent).toBe("");
    expect(f.form.submit).not.toHaveBeenCalled();
    expect(f.form.requestSubmit).not.toHaveBeenCalled();
    const event = app.submit(f);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(f.feedback.textContent).toBe("Opening X to confirm your identity…");
    expect(f.form.getAttribute("aria-busy")).toBeNull();
    expect(f.submitter.getAttribute("aria-busy")).toBe("true");
    expect(f.submitter.getAttribute("aria-disabled")).toBe("true");
    expect(f.submitter.disabled).toBe(false);
    expect(f.submitter.textContent).toBe("Withdraw claim");
    expect([...f.form.fields.entries()]).toEqual(fields);
    expect(f.form.action).toBe("/auth/x/start");
    expect(f.form.method).toBe("post");
    expect(app.fetch).not.toHaveBeenCalled();
    expect(f.form.submit).not.toHaveBeenCalled();
    expect(f.form.requestSubmit).not.toHaveBeenCalled();
    expect(X_ACTION_PROGRESS_SCRIPT).not.toMatch(/fetch\(|\.submit\(|requestSubmit\(|location\.(?:assign|replace)\(/);
  });

  it.each(["wallet_link", "wallet_revoke", "claim_withdraw"])("enhances the %s action after an account-panel refresh", action => {
    const app = boot(); // The form is inserted only after the script has loaded.
    const refreshed = actionForm();
    refreshed.form.fields.set("action", [action]);
    app.submit(refreshed);
    expect(refreshed.feedback.textContent).toBe("Opening X to confirm your identity…");
  });

  it.each(["account_login", "claim", "", "logout"])("does not enhance the %s purpose", purpose => {
    const app = boot(), f = actionForm();
    f.form.fields.set("purpose", [purpose]);
    expect(app.submit(f).preventDefault).not.toHaveBeenCalled();
    expect(f.feedback.textContent).toBe("");
    expect(f.form.setAttribute).not.toHaveBeenCalled();
  });

  it.each([
    "/signatures/signature-id/withdraw", "/auth/logout", "/auth/x/callback",
    "https://other.test/auth/x/start", "javascript:alert(1)", "http://[",
  ])("does not enhance another endpoint: %s", action => {
    const app = boot(), f = actionForm();
    f.form.action = action;
    expect(app.submit(f).preventDefault).not.toHaveBeenCalled();
    expect(f.feedback.textContent).toBe("");
    expect(f.form.setAttribute).not.toHaveBeenCalled();
  });

  it("ignores unmarked, non-POST, duplicate-purpose, and already canceled submissions", () => {
    const app = boot();
    for (const mode of ["unmarked", "get", "duplicates", "canceled"]) {
      const f = actionForm();
      if (mode === "unmarked") f.form.marked = false;
      if (mode === "get") f.form.method = "get";
      if (mode === "duplicates") f.form.fields.set("purpose", ["sensitive_action", "account_login"]);
      app.submit(f, { defaultPrevented: mode === "canceled" });
      expect(f.feedback.textContent).toBe("");
    }
  });

  it.each([
    ["formmethod", "get"], ["formaction", "/signatures/signature-id/withdraw"],
    ["formaction", "https://other.test/auth/x/start"],
  ])("honors the submitter's effective %s before enhancing", (name, value) => {
    const app = boot(), f = actionForm();
    f.submitter.setAttribute(name, value);
    app.submit(f);
    expect(f.feedback.textContent).toBe("");
    expect(f.form.setAttribute).not.toHaveBeenCalled();
  });

  it("allows keyboard submission without a submitter", () => {
    const app = boot(), f = actionForm();
    expect(app.submit(f, { submitter: null }).preventDefault).not.toHaveBeenCalled();
    expect(f.feedback.textContent).toBe("Opening X to confirm your identity…");
    expect(f.submitter.setAttribute).not.toHaveBeenCalled();
  });

  it("blocks only repeated submission of the same pending form", () => {
    const app = boot(), f = actionForm(), other = actionForm();
    expect(app.submit(f).preventDefault).not.toHaveBeenCalled();
    expect(app.submit(f).preventDefault).toHaveBeenCalledOnce();
    expect(app.submit(other).preventDefault).not.toHaveBeenCalled();
    app.pageshow(false);
    expect(app.submit(f).preventDefault).toHaveBeenCalledOnce();
  });

  it("clears transient progress on back/forward restoration and allows a new explicit submission", () => {
    const app = boot(), f = actionForm();
    app.submit(f);
    app.pageshow(true);
    expect(f.feedback.textContent).toBe("");
    expect(f.form.getAttribute("aria-busy")).toBeNull();
    expect(f.submitter.getAttribute("aria-busy")).toBeNull();
    expect(f.submitter.getAttribute("aria-disabled")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(app.submit(f).preventDefault).not.toHaveBeenCalled();
    expect(f.feedback.textContent).toBe("Opening X to confirm your identity…");
  });

  it("recovers if navigation was stopped, restoring existing accessibility values", () => {
    const app = boot(), f = actionForm();
    f.submitter.setAttribute("aria-busy", "false");
    f.submitter.setAttribute("aria-disabled", "false");
    app.submit(f);
    vi.advanceTimersByTime(14999);
    expect(f.feedback.textContent).toBe("Opening X to confirm your identity…");
    vi.advanceTimersByTime(1);
    expect(f.feedback.textContent).toBe("");
    expect(f.submitter.getAttribute("aria-busy")).toBe("false");
    expect(f.submitter.getAttribute("aria-disabled")).toBe("false");
    expect(app.submit(f).preventDefault).not.toHaveBeenCalled();
  });
});
