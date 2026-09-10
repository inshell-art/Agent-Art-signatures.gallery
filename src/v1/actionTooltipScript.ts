/** Cursor-adjacent action hints; never intercepts or submits the action. */
export const ACTION_TOOLTIP_SCRIPT = `(() => {
  for (const trigger of document.querySelectorAll("[data-action-tooltip]")) {
    const tip = document.getElementById(trigger.dataset.actionTooltip);
    if (!tip || trigger.dataset.tooltipReady) continue;
    let overTrigger = false, overTip = false, focused = false, dismissed = false;
    let showTimer, hideTimer;
    const hide = () => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      tip.hidden = true;
    };
    const position = (event) => {
      const frame = trigger.getBoundingClientRect();
      const bounds = tip.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const height = window.innerHeight;
      const x = event ? event.clientX : frame.left;
      const y = event ? event.clientY : frame.bottom;
      const top = y + 12 + bounds.height > height - 8 ? (event ? y : frame.top) - bounds.height - 12 : y + 12;
      tip.style.left = Math.max(8, Math.min(x + 12, width - bounds.width - 8)) + "px";
      tip.style.top = Math.max(8, Math.min(top, height - bounds.height - 8)) + "px";
    };
    const show = (event) => {
      if (dismissed || (!overTrigger && !focused)) return;
      tip.hidden = false;
      position(event);
    };
    const leave = () => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      if (!overTrigger && !overTip && !focused) hideTimer = setTimeout(hide, 100);
    };
    const dismiss = () => { dismissed = true; hide(); };
    trigger.addEventListener("pointerenter", event => {
      if (event.pointerType === "touch") return;
      overTrigger = true;
      dismissed = false;
      clearTimeout(hideTimer);
      clearTimeout(showTimer);
      showTimer = setTimeout(() => show(event), 120);
    });
    trigger.addEventListener("pointermove", event => {
      if (event.pointerType !== "touch" && !tip.hidden) position(event);
    });
    trigger.addEventListener("pointerleave", () => { overTrigger = false; leave(); });
    tip.addEventListener("pointerenter", () => { overTip = true; clearTimeout(hideTimer); });
    tip.addEventListener("pointerleave", () => { overTip = false; leave(); });
    trigger.addEventListener("focus", () => {
      if (!trigger.matches(":focus-visible")) return;
      focused = true;
      dismissed = false;
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      show();
    });
    trigger.addEventListener("blur", () => { focused = false; leave(); });
    trigger.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", event => { if (event.key === "Escape") dismiss(); });
    window.addEventListener("scroll", dismiss, { passive: true, capture: true });
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    document.addEventListener("visibilitychange", () => { if (document.hidden) dismiss(); });
    // Native title remains the no-JavaScript fallback; avoid two competing tips.
    trigger.removeAttribute("title");
    trigger.dataset.tooltipReady = "true";
  }
})();`;
