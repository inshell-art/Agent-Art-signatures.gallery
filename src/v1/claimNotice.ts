export const CLAIM_SUCCESS_MESSAGE = "Claimed. Added to your collection and the public gallery.";
// Radix defaults to 5s; Carbon permits 5s for non-actionable toast feedback.
// The persistent Claimed tag retains the outcome; top navigation opens the
// collection and gallery without duplicate CTAs below the artwork.
export const CLAIM_TOAST_DURATION_MS = 5000;

/** Only the private, session-bound notice endpoint can trigger success feedback. */
export const CLAIM_NOTICE_SCRIPT = `(() => {
  const toast = document.querySelector("[data-claim-notice]");
  if (!toast) return;
  const message = toast.querySelector("[data-notice-message]");
  const close = toast.querySelector("[data-notice-dismiss]");
  let timer, startedAt = null, remaining = ${CLAIM_TOAST_DURATION_MS};
  let hovered = false, windowActive = document.hasFocus(), dismissed = false;
  const pause = () => {
    clearTimeout(timer);
    if (startedAt !== null) remaining = Math.max(0, remaining - (performance.now() - startedAt));
    startedAt = null;
  };
  const hide = () => { pause(); dismissed = true; toast.hidden = true; message.textContent = ""; };
  const schedule = () => {
    pause();
    if (dismissed || toast.hidden || hovered || !windowActive || document.hidden || toast.contains(document.activeElement)) return;
    startedAt = performance.now();
    timer = setTimeout(hide, remaining);
  };
  close.addEventListener("click", hide);
  toast.addEventListener("pointerenter", () => { hovered = true; pause(); });
  toast.addEventListener("pointerleave", () => { hovered = false; schedule(); });
  toast.addEventListener("focusin", pause);
  toast.addEventListener("focusout", () => setTimeout(schedule, 0));
  window.addEventListener("blur", () => { windowActive = false; pause(); });
  window.addEventListener("focus", () => { windowActive = true; schedule(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause();
    else { windowActive = document.hasFocus(); schedule(); }
  });
  document.addEventListener("keydown", event => { if (event.key === "Escape") hide(); });
  window.addEventListener("pageshow", event => { if (event.persisted) hide(); });
  fetch(toast.dataset.claimNotice, { credentials: "same-origin", cache: "no-store" })
    .then(response => response.ok ? response.json() : null)
    .then(result => {
      if (result?.show !== true || dismissed) return;
      toast.hidden = false;
      // Populate the live region after it becomes visible; do not move focus.
      requestAnimationFrame(() => {
        if (dismissed) return;
        message.textContent = ${JSON.stringify(CLAIM_SUCCESS_MESSAGE)};
        schedule();
      });
    })
    .catch(() => { /* The permanent Claimed tag remains authoritative. */ });
})();`;

export function claimNoticeShell(signatureId: string): string {
  if (!/^sg1_[a-z2-7]{52}$/.test(signatureId)) return "";
  return `<div class="claim-toast" data-claim-notice="/api/v1/signatures/${signatureId}/claim-notice" hidden><p role="status" aria-live="polite" aria-atomic="true" data-notice-message></p><button type="button" data-notice-dismiss aria-label="Dismiss notification">×</button></div>`;
}
