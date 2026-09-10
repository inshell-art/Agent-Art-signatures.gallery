import { validateRenderHandle } from "./input.js";

export const GROK_URL = "https://x.com/i/grok";

/** Provisional participation copy, kept here for later replacement.
 * V1 handoff §6.2: the site supplies instructions, never the gr0k value. */
export function grokPrompt(handle?: string, publicOrigin = "https://signatures.gallery"): string {
  const renderHandle = handle === undefined ? undefined : validateRenderHandle(handle);
  const origin = new URL(publicOrigin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password
    || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("The Grok handoff requires a plain HTTP(S) site origin.");
  const account = renderHandle ? `@${renderHandle}` : "the X handle I provide";
  const identify = renderHandle ? "" : "First, ask me for my X handle. Do not assume my identity or generate a preview link until I provide it. Use my handle without the @ prefix, preserving its exact uppercase and lowercase letters, in place of HANDLE in the URL below.\n\n";
  return `${identify}Review the recent public X posts by ${account}. Based on your reading, select one integer seed called gr0k from 1 through 100. Treat gr0k as an environmental condition for the signature, not as a mood, score, probability, or judgment of the person. The formal Signature Algorithm v1.0.0 is case-sensitive: preserve the handle's exact uppercase and lowercase letters. If you cannot access the posts, ask me for public post links or text instead of inventing a reading. Return this canonical URL, replacing GR0K with your selected integer without decimals or leading zeros:

${origin.origin}/s/${renderHandle ?? "HANDLE"}/GR0K

After the link, guide me through these next steps in a short numbered list:
1. Open the link to preview my signature.
2. Read the explanation and click "Claim with X". This authorizes a public claim, not a minted token. Sign in with the matching X account, ${account}.
3. X will return you directly to the permanent signature page with the claim already completed. Look for "Claimed"; no second confirmation is needed. If saving fails, the page will offer "Retry claim".
4. Open My Collection to see the claimed signature: ${origin.origin}/me

Remind me that opening a preview or using ordinary account sign-in creates no claim. No wallet is needed to claim; a wallet is only needed if I later choose to mint. The gallery cannot independently verify this private Grok conversation or who selected gr0k. Keep the reply concise, and give me the link and these instructions together so I can follow them from this conversation.`;
}

export const GROK_PROMPT_SCRIPT = `(() => {
  const region = document.querySelector("[data-grok-handoff]");
  if (!region) return;
  const button = region.querySelector("[data-copy-grok-prompt]");
  const prompt = region.querySelector("[data-grok-prompt]");
  const feedback = region.querySelector("[data-copy-feedback]");
  button.hidden = false;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(prompt.value);
      feedback.textContent = "Copied.";
    } catch {
      region.querySelector("details").open = true;
      prompt.focus();
      prompt.select();
      feedback.textContent = "Copy the selected text.";
    } finally { button.disabled = false; }
  });
})();`;
