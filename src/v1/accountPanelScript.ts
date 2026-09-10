/** Keep the collection link native; only the adjacent panel is enhanced. */
export const ACCOUNT_PANEL_SCRIPT = `(() => {
  const menu = document.querySelector("[data-account-menu]");
  if (!menu) return;
  const link = menu.querySelector(".collection-shortcut");
  const toggle = menu.querySelector(".account-menu-toggle");
  const panel = menu.querySelector(".account-panel");
  const body = menu.querySelector("[data-account-panel-body]");
  const devTools = document.querySelector("[data-dev-account-tools]");
  let closeTimer;
  let requestId = 0;
  let suppressFocus = false;
  menu.dataset.panelReady = "true";

  const refresh = async () => {
    if (menu.hasAttribute("data-account-preview")) return;
    const id = ++requestId;
    body.setAttribute("aria-busy", "true");
    body.inert = true;
    if (devTools) devTools.inert = true;
    try {
      const response = await fetch("/api/v1/account-panel", {credentials:"same-origin",cache:"no-store",headers:{Accept:"application/json"}});
      const payload = await response.json();
      if (!response.ok || typeof payload.html !== "string") throw new Error("Account controls unavailable");
      if (id !== requestId) return;
      // The same-origin endpoint renders escaped HTML, never third-party markup.
      body.innerHTML = payload.html;
      if (devTools) devTools.innerHTML = typeof payload.developmentHtml === "string" ? payload.developmentHtml : "";
      window.dispatchEvent(new Event("account-panel:ready"));
    } catch {
      if (id !== requestId) return;
      if (devTools) devTools.innerHTML = '<p>Test wallet controls could not be loaded. Close and reopen DEV to retry.</p>';
      body.innerHTML = '<p class="auth-note">Could not load account controls.</p><a class="auth-action" href="/me"><span>Open My Collection to try again</span></a>';
    } finally {
      if (id === requestId) {
        body.removeAttribute("aria-busy");
        body.inert = false;
        if (devTools) devTools.inert = false;
      }
    }
  };
  const close = () => {
    clearTimeout(closeTimer);
    menu.dataset.open = "false";
    link.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-expanded", "false");
  };
  const open = () => {
    clearTimeout(closeTimer);
    if (menu.dataset.open === "true") return;
    menu.dataset.open = "true";
    link.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-expanded", "true");
    void refresh();
  };
  menu.addEventListener("pointerenter", event => { if (event.pointerType !== "touch") open(); });
  menu.addEventListener("pointerleave", event => {
    if (event.pointerType !== "touch" && !menu.contains(document.activeElement)) closeTimer = setTimeout(close, 180);
  });
  menu.addEventListener("focusin", () => { if (!suppressFocus) open(); });
  menu.addEventListener("focusout", event => { if (!menu.contains(event.relatedTarget) && !menu.matches(":hover")) close(); });
  toggle.addEventListener("pointerdown", event => event.preventDefault());
  toggle.addEventListener("click", () => { if (menu.dataset.open === "true") close(); else open(); });
  menu.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" && (event.target === link || event.target === toggle)) {
      event.preventDefault();
      open();
      panel.querySelector("button,a,summary")?.focus();
    }
  });
  document.addEventListener("keydown", event => {
    // Escape also dismisses a hover-open panel while focus is elsewhere.
    if (event.key === "Escape" && menu.dataset.open === "true") {
      event.preventDefault();
      close();
      suppressFocus = true;
      link.focus();
      suppressFocus = false;
    }
  });
  document.addEventListener("pointerdown", event => { if (!menu.contains(event.target)) close(); });
  window.addEventListener("pageshow", event => { if (event.persisted) { close(); ++requestId; } });
  window.addEventListener("dev-panel:open", () => { void refresh(); });
  window.addEventListener("focus", () => { if (menu.dataset.open === "true" && !panel.querySelector("button:disabled") && !panel.contains(document.activeElement)) void refresh(); });
})();`;
