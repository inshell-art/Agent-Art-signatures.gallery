export const THEME_SCRIPT = `(() => {
  const storageKey = "signatures-gallery-theme";
  const choices = new Set(["auto", "light", "dark"]);
  let preference = "auto";

  try {
    const stored = localStorage.getItem(storageKey);
    if (stored && choices.has(stored)) preference = stored;
  } catch {}

  const apply = () => {
    if (preference === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", preference);
    document.documentElement.setAttribute("data-theme-setting", preference);
    document.querySelectorAll("[data-theme-value]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-theme-value") === preference));
    });
  };

  apply();
  addEventListener("DOMContentLoaded", () => {
    apply();
    document.querySelectorAll("[data-theme-value]").forEach((button) => {
      button.addEventListener("click", () => {
        const next = button.getAttribute("data-theme-value");
        if (!next || !choices.has(next)) return;
        preference = next;
        try { localStorage.setItem(storageKey, preference); } catch {}
        apply();
      });
    });
  });
})();`;
