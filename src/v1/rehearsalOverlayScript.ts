/** Enhance the native DEV disclosure without intercepting product navigation. */
export const REHEARSAL_OVERLAY_SCRIPT = `(() => {
  const overlay = document.querySelector(".rehearsal-watermark");
  const disclosure = overlay?.querySelector(".rehearsal-disclosure");
  if (!disclosure) return;
  const trigger = disclosure.querySelector("summary");
  disclosure.addEventListener("toggle", () => {
    if (disclosure.open) window.dispatchEvent(new Event("dev-panel:open"));
  });

  document.addEventListener("click", event => {
    if (disclosure.open && !overlay.contains(event.target)) disclosure.open = false;
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !disclosure.open) return;
    const returnFocus = overlay.contains(document.activeElement);
    disclosure.open = false;
    if (returnFocus) trigger.focus();
  });
})();`;
