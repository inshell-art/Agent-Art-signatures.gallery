/** Progressive enhancement: the native POST form remains the only delete path. */
export const WITHDRAW_CLAIM_DIALOG_SCRIPT = `(() => {
  if (typeof HTMLDialogElement === "undefined" || !HTMLDialogElement.prototype.showModal) return;
  document.querySelectorAll("[data-withdraw-control]").forEach(root => {
    const fallback = root.querySelector("details");
    const content = root.querySelector("[data-withdraw-confirmation]");
    const form = content.querySelector("form");
    const cancel = content.querySelector("[data-withdraw-cancel]");
    const confirm = content.querySelector("[name=confirm]");
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "auth-action auth-action-quiet";
    trigger.setAttribute("aria-haspopup", "dialog");
    const label = document.createElement("span");
    label.textContent = "Withdraw claim";
    trigger.append(label);
    const dialog = document.createElement("dialog");
    dialog.className = "withdraw-dialog";
    dialog.setAttribute("aria-labelledby", "withdraw-title");
    dialog.setAttribute("aria-describedby", "withdraw-work");
    let submitting = false;
    const close = () => { if (!submitting) dialog.close(); };
    trigger.addEventListener("click", () => { dialog.showModal(); cancel.focus(); });
    cancel.addEventListener("click", close);
    dialog.addEventListener("cancel", event => { if (submitting) event.preventDefault(); });
    dialog.addEventListener("close", () => { trigger.focus(); });
    form.addEventListener("submit", event => {
      if (submitting || !dialog.open || event.submitter !== confirm) { event.preventDefault(); return; }
      submitting = true;
      form.setAttribute("aria-busy", "true");
      cancel.disabled = true;
      // Keep the successful submitter enabled so its confirm=withdraw is posted.
      confirm.setAttribute("aria-disabled", "true");
    });
    window.addEventListener("pageshow", event => {
      if (!event.persisted) return;
      submitting = false;
      form.removeAttribute("aria-busy");
      cancel.disabled = false;
      confirm.removeAttribute("aria-disabled");
      if (dialog.open) dialog.close();
    });
    dialog.append(content);
    root.append(dialog);
    // Keep the native disclosure arrow; only its expanded CTA opens the dialog.
    fallback.append(trigger);
    cancel.hidden = false;
  });
})();`;
