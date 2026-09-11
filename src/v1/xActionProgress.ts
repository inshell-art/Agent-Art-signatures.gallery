/** Explain an action's X redirect without changing the native OAuth POST. */
export const X_ACTION_PROGRESS_SCRIPT = `(() => {
  const pending = new Map();
  const restoreAttribute = (element, name, value) => {
    if (!element) return;
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  };
  const reset = form => {
    const state = pending.get(form);
    if (!state) return;
    clearTimeout(state.timer);
    restoreAttribute(state.submitter, "aria-busy", state.busy);
    restoreAttribute(state.submitter, "aria-disabled", state.disabled);
    state.feedback.textContent = state.text;
    pending.delete(form);
  };
  document.addEventListener("submit", event => {
    const form = event.target;
    if (event.defaultPrevented || !form?.matches?.("form[data-x-action-form]")) return;
    const submitter = event.submitter;
    const method = submitter?.getAttribute("formmethod") || form.getAttribute("method") || "get";
    if (method.toLowerCase() !== "post") return;
    let action;
    // The hidden input named "action" shadows HTMLFormElement.action in a
    // real browser. Read attributes, not named form properties.
    try { action = new URL(submitter?.getAttribute("formaction") || form.getAttribute("action") || location.href, location.href); }
    catch { return; }
    if (action.origin !== location.origin || action.pathname !== "/auth/x/start") return;
    const purposes = new FormData(form).getAll("purpose");
    if (purposes.length !== 1 || purposes[0] !== "sensitive_action") return;
    const feedback = form.querySelector("[data-x-action-feedback]");
    if (!feedback) return;
    if (pending.has(form)) { event.preventDefault(); return; }
    const state = {
      feedback, submitter, text: feedback.textContent,
      busy: submitter?.getAttribute("aria-busy") ?? null,
      disabled: submitter?.getAttribute("aria-disabled") ?? null,
      timer: null,
    };
    pending.set(form, state);
    // Keep busy on the button, not the form containing the live status region.
    submitter?.setAttribute("aria-busy", "true");
    // Never disable a successful submitter: its name/value belongs in the POST.
    submitter?.setAttribute("aria-disabled", "true");
    feedback.textContent = "Opening X to confirm your identity…";
    // Native navigation starts immediately. Recover if the user stops it.
    state.timer = setTimeout(() => reset(form), 15000);
  });
  window.addEventListener("pageshow", event => {
    if (event.persisted) [...pending.keys()].forEach(reset);
  });
})();`;
