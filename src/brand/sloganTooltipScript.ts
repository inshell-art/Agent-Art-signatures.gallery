import { createHash } from "node:crypto";

export const SLOGAN_TOOLTIP_DELAY_MS = 120;
export const SLOGAN_TOOLTIP_HIT_PADDING_PX = 8;

/** Progressive enhancement: the server's title remains the no-JS fallback. */
export const SLOGAN_TOOLTIP_SCRIPT = `(() => {
  const figure = document.querySelector(".slogan-signature");
  const tip = document.getElementById("slogan-tooltip");
  if (!figure || !tip || figure.dataset.tooltipReady) return;

  let showTimer;
  let hideTimer;
  let overInk = false;
  let overTip = false;
  let keyboardFocus = false;
  let dismissed = false;
  let point = null;

  // Measure the visible artwork, not its intentionally roomy SVG viewBox.
  // Client rects include presentation transforms and responsive scaling.
  const inkBounds = () => {
    const boxes = Array.from(figure.querySelectorAll("svg path, svg circle"))
      .map((drawing) => drawing.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0);
    if (!boxes.length) return null;
    const left = Math.min(...boxes.map((box) => box.left));
    const right = Math.max(...boxes.map((box) => box.right));
    const top = Math.min(...boxes.map((box) => box.top));
    const bottom = Math.max(...boxes.map((box) => box.bottom));
    return { left, right, top, bottom, width: right - left, height: bottom - top };
  };
  const nearInk = (position) => {
    const bounds = inkBounds();
    const padding = ${SLOGAN_TOOLTIP_HIT_PADDING_PX};
    return bounds && position.x >= bounds.left - padding && position.x <= bounds.right + padding
      && position.y >= bounds.top - padding && position.y <= bounds.bottom + padding;
  };
  const setHover = (value) => {
    overInk = value;
    figure.dataset.tooltipHover = String(value);
  };
  const cancelShow = () => { clearTimeout(showTimer); showTimer = undefined; };
  const cancelHide = () => { clearTimeout(hideTimer); hideTimer = undefined; };
  const hide = () => {
    cancelShow();
    cancelHide();
    tip.hidden = true;
  };
  const position = () => {
    const frame = inkBounds() || figure.getBoundingClientRect();
    const anchor = point || { x: frame.left + frame.width / 2, y: frame.bottom };
    const bounds = tip.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const height = window.innerHeight;
    let x = anchor.x + 12;
    let y = anchor.y + 12;
    if (x + bounds.width > width - 8) x = anchor.x - bounds.width - 12;
    if (y + bounds.height > height - 8) y = anchor.y - bounds.height - 12;
    tip.style.left = Math.max(8, Math.min(x, width - bounds.width - 8)) + "px";
    tip.style.top = Math.max(8, Math.min(y, height - bounds.height - 8)) + "px";
  };
  const show = () => {
    showTimer = undefined;
    if (dismissed || (!overInk && !keyboardFocus)) return;
    tip.hidden = false;
    position();
  };
  const scheduleHide = () => {
    cancelShow();
    cancelHide();
    // Let the pointer cross the small gap into the tooltip without a flicker.
    if (!overInk && !overTip && !keyboardFocus) hideTimer = setTimeout(hide, 100);
  };

  const trackPointer = (event) => {
    if (event.pointerType === "touch") return;
    if (!nearInk({ x: event.clientX, y: event.clientY })) {
      if (overInk) { setHover(false); scheduleHide(); }
      return;
    }
    point = { x: event.clientX, y: event.clientY };
    if (!overInk) {
      setHover(true);
      dismissed = false;
      cancelHide();
      cancelShow();
      if (tip.hidden) showTimer = setTimeout(show, ${SLOGAN_TOOLTIP_DELAY_MS});
    }
    if (!tip.hidden) position();
  };
  figure.addEventListener("pointerenter", trackPointer);
  figure.addEventListener("pointermove", trackPointer);
  figure.addEventListener("pointerleave", () => {
    setHover(false);
    scheduleHide();
  });
  tip.addEventListener("pointerenter", () => { overTip = true; cancelHide(); });
  tip.addEventListener("pointerleave", () => { overTip = false; scheduleHide(); });
  figure.addEventListener("focus", () => {
    // A tap or mouse click is not keyboard focus and must not create a sticky tip.
    if (!figure.matches(":focus-visible")) return;
    keyboardFocus = true;
    dismissed = false;
    point = null;
    cancelShow();
    cancelHide();
    show();
  });
  figure.addEventListener("blur", () => {
    keyboardFocus = false;
    if (!overInk && !overTip) hide();
  });
  const dismiss = () => { dismissed = true; hide(); };
  figure.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch") dismiss();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") dismiss();
  });
  window.addEventListener("scroll", dismiss, { passive: true, capture: true });
  window.addEventListener("resize", () => {
    if (overInk && point && !nearInk(point)) { setHover(false); scheduleHide(); }
    if (!tip.hidden) position();
  });
  window.addEventListener("blur", dismiss);
  document.addEventListener("visibilitychange", () => { if (document.hidden) dismiss(); });

  figure.removeAttribute("title");
  figure.dataset.tooltipReady = "true";
})();`;

export const SLOGAN_TOOLTIP_SCRIPT_URL = `/assets/slogan-tooltip-${createHash("sha256").update(SLOGAN_TOOLTIP_SCRIPT).digest("hex").slice(0, 16)}.js`;
