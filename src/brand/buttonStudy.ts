import { layout } from "../v1/pages.js";
import { HOME_LINK } from "../v1/navigation.js";
import { RENDERER_VERSION } from "../v1/renderer.js";

export const BUTTON_STUDIES = [
  { id: "hairline", name: "Hairline", note: "A fine outline. Quiet, but unmistakably a control.", selected: true },
  { id: "solid", name: "Solid", note: "Ink against paper. The strongest separation from a tag.", selected: false },
  { id: "arrow", name: "Arrow", note: "An open label with a framed arrow. Direction gives it purpose.", selected: false },
  { id: "frame", name: "Open frame", note: "Brackets hold the action. More graphic, less conventional.", selected: false },
] as const;

type ButtonState = "ready" | "disabled" | "busy";
function button(label: string, state: ButtonState = "ready", tooltip = ""): string {
  return `<button class="bst-button" type="button"${tooltip ? ` data-action-tooltip="study-claim-tooltip" aria-describedby="study-claim-tooltip" title="${tooltip}"` : ""}${state !== "ready" ? " disabled" : ""}${state === "busy" ? ' aria-busy="true"' : ""}><span class="bst-button-label">${label}</span><span class="bst-button-arrow" aria-hidden="true">→</span></button>${tooltip ? `<span class="action-tooltip" id="study-claim-tooltip" role="tooltip" hidden>${tooltip}</span>` : ""}`;
}

/** Read-only design specimens. No form actions, authentication or persistence. */
export function buttonStudyPage(): string {
  const options = BUTTON_STUDIES.map((option, index) => `<article class="bst-candidate" data-button-variant="${option.id}" aria-labelledby="bst-title-${option.id}"><div class="bst-candidate-heading"><h2 id="bst-title-${option.id}">${String(index + 1).padStart(2, "0")} / ${option.name}</h2>${option.selected ? '<span class="bst-selection">Selected</span>' : ""}</div><p class="bst-description">${option.note}</p><div class="bst-tag-row" aria-label="Soft-filled status tags for comparison"><span class="signature-tag">Claimed</span><span class="signature-tag">Minted</span><span class="bst-caption">Status</span></div><div class="bst-primary-sample">${button("Claim with X")}</div><div class="bst-states"><div><span class="bst-caption">Default</span>${button("Claim this signature")}</div><div><span class="bst-caption">Disabled</span>${button("Claim this signature", "disabled")}</div><div><span class="bst-caption">Working</span>${button("Signing in…", "busy")}</div></div><a class="bst-context-link" href="#button-context" data-context-style="${option.id}">View ${option.name} in context <span aria-hidden="true">↓</span></a></article>`).join("");
  const picker = BUTTON_STUDIES.map(option => `<label><input type="radio" name="button-study-style" value="${option.id}"${option.selected ? " checked" : ""}><span>${option.name}</span></label>`).join("");
  const body = `${HOME_LINK}<article class="bst-page"><div class="bst-intro"><h1>Buttons, not labels.</h1><p>Hairline buttons, soft-filled status tags. Tags fit closely around their text; buttons keep more breathing room.</p></div><section class="bst-baseline" aria-label="Current treatment"><span class="bst-caption">Current</span><span class="signature-tag">Claimed</span><span class="signature-tag">Minted</span><button class="auth-action" type="button"><span>Claim this signature</span></button></section><div class="bst-grid">${options}</div><section class="bst-context" id="button-context" data-button-variant="hairline" aria-labelledby="bst-context-title"><div class="bst-context-heading"><h2 id="bst-context-title">On the signature page</h2><span class="bst-current" aria-live="polite" data-study-current>Hairline</span></div><fieldset class="bst-picker"><legend class="visually-hidden">Choose the button style for this preview</legend>${picker}</fieldset><div class="bst-artwork-context"><figure class="signature-art"><img src="/renders/${encodeURIComponent(RENDERER_VERSION)}/signatures/22.svg" alt="Signature renderer specimen for the handle signatures" width="672" height="672"></figure><div class="signature-record"><div class="signature-heading"><span>@signatures</span><span class="signature-gr0k">gr0k 22</span><span class="signature-tags"><span class="signature-tag">Unclaimed</span></span></div><div class="bst-claim">${button("Claim with X", "ready", "Signing in as @signatures will claim this signature for your collection and the public gallery. This does not mint a token. You can withdraw the claim before minting begins.")}</div></div></div></section></article>`;
  const html = layout({
    title: "Button study · Signatures Gallery",
    description: "Four button treatments compared with signature status tags.",
    body, bookPage: true, fixtureMode: true,
    preview: { state: "button-study", label: "Button study", description: "Hairline is applied to the site. The other button treatments remain here for comparison." },
    accountPanel: { fixtureMode: true, mintEnabled: false, mintChainId: "", previewOnly: true },
    developmentNotes: [{ title: "Button specimens", paragraphs: ["These buttons never sign in, claim, mint, or save a preference. Hover, press, or use Tab to inspect their affordances. The links and radio controls switch only the example below.", "All labels retain Instrument Sans at 14px / 400. Tags use 1px vertical / 3px horizontal padding; Hairline buttons keep 3px vertical / 7px horizontal padding. Both share the home tabs’ line height. Button outlines are 1px; tags have no border. The visible labels are compact, with 44px click targets around buttons. Colors follow your system theme."] }],
  });
  return html.replace("</head>", '<link rel="stylesheet" href="/dev/button-study.css"><script src="/dev/button-study.js" defer></script></head>');
}

// Scoped to this study. None of these selectors changes live site controls.
export const BUTTON_STUDY_CSS = `
.bst-page{padding:88px var(--page-gutter) 96px;line-height:1.5}
.bst-intro{margin-bottom:32px}.bst-intro h1{margin:0;line-height:1.5;letter-spacing:normal}.bst-intro p{margin:12px 0 0;color:var(--muted)}
.bst-baseline{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:48px}.bst-baseline>.bst-caption{margin-right:12px}.bst-baseline .auth-action{margin-left:12px}
.bst-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:48px 56px}
.bst-candidate{min-width:0;padding-top:20px;border-top:1px solid var(--line)}.bst-candidate-heading{display:flex;justify-content:space-between;align-items:baseline;gap:16px}.bst-candidate h2{margin:0}.bst-selection,.bst-caption,.bst-description,.bst-current{color:var(--muted)}.bst-description{min-height:42px;margin:12px 0 24px}.bst-tag-row{display:flex;align-items:center;gap:8px}.bst-tag-row>.bst-caption{margin-left:8px}.bst-primary-sample{margin-top:20px}
.bst-states{display:flex;align-items:start;flex-wrap:wrap;gap:16px;margin-top:24px}.bst-states>div{display:grid;justify-items:start;gap:8px}.bst-caption{display:block}.bst-context-link{display:inline-flex;align-items:center;gap:8px;min-height:44px;margin-top:16px;text-decoration:none}.bst-context-link:hover{text-decoration:underline;text-underline-offset:4px}
.bst-button{--bst-fill:transparent;--bst-text:var(--ink);appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:16px;min-width:44px;min-height:44px;max-width:100%;padding:0;border:0;border-radius:2px;background:transparent;color:var(--ink);font:inherit;line-height:var(--control-line-height);text-align:center;cursor:pointer;position:relative;vertical-align:middle;transition:background-color 120ms,color 120ms,border-color 120ms,transform 120ms}
.bst-button-label{display:inline-flex;align-items:center;justify-content:center;min-width:0;padding:var(--control-padding);border:1px solid transparent;border-radius:2px;background:var(--bst-fill);color:var(--bst-text);overflow-wrap:anywhere;transition:background-color 120ms,color 120ms}.bst-button-arrow{display:none}.bst-button:not(:disabled):active{transform:translateY(1px)}.bst-button:focus-visible,.bst-context-link:focus-visible,.bst-picker input:focus-visible{outline:2px solid var(--ink);outline-offset:4px}.bst-button:disabled{opacity:.4;cursor:not-allowed}.bst-button[aria-busy=true]{opacity:.6;cursor:progress}
[data-button-variant=hairline] .bst-button-label{border-color:var(--ink)}[data-button-variant=hairline] .bst-button:not(:disabled):hover{--bst-fill:var(--ink);--bst-text:var(--paper)}
[data-button-variant=solid] .bst-button{--bst-fill:var(--ink);--bst-text:var(--paper)}[data-button-variant=solid] .bst-button-label{border-color:var(--ink)}[data-button-variant=solid] .bst-button:not(:disabled):hover{--bst-fill:var(--paper);--bst-text:var(--ink)}
[data-button-variant=arrow] .bst-button{justify-content:space-between;padding:0 0 0 2px;gap:12px;border:0;border-radius:0;text-align:start}[data-button-variant=arrow] .bst-button-label{padding:var(--control-padding);border:0}[data-button-variant=arrow] .bst-button-arrow{display:grid;place-items:center;flex:0 0 36px;width:36px;height:36px;border:1px solid var(--ink);border-radius:50%;transition:background-color 120ms,color 120ms}[data-button-variant=arrow] .bst-button:not(:disabled):hover .bst-button-arrow{background:var(--ink);color:var(--paper)}[data-button-variant=arrow] .bst-button:not(:disabled):hover .bst-button-label{text-decoration:underline;text-underline-offset:4px}
[data-button-variant=frame] .bst-button{border:0;border-radius:0;padding:0}[data-button-variant=frame] .bst-button::before,[data-button-variant=frame] .bst-button::after{content:"";position:absolute;top:5px;bottom:5px;width:7px;border-block:1px solid var(--ink);pointer-events:none}[data-button-variant=frame] .bst-button::before{left:0;border-left:1px solid var(--ink)}[data-button-variant=frame] .bst-button::after{right:0;border-right:1px solid var(--ink)}[data-button-variant=frame] .bst-button:not(:disabled):hover{--bst-fill:var(--paper-2)}
.bst-context{max-width:42rem;margin:80px auto 0;padding-top:24px;border-top:1px solid var(--line);scroll-margin-top:72px}.bst-context-heading{display:flex;justify-content:space-between;gap:16px}.bst-context h2{margin:0}.bst-picker{display:flex;flex-wrap:wrap;gap:0 24px;min-width:0;border:0;padding:0;margin:12px 0 28px}.bst-picker label{display:flex;align-items:center;gap:8px;min-height:44px;cursor:pointer}.bst-picker input{width:14px;height:14px;margin:0;accent-color:var(--ink)}.bst-artwork-context{min-width:0}.bst-claim p{margin:12px 0 20px}.bst-current{white-space:nowrap}
@media(max-width:820px){.bst-grid{gap:40px 24px}.bst-states{gap:12px}.bst-description{min-height:63px}}
@media(max-width:650px){.bst-grid{grid-template-columns:minmax(0,1fr);gap:40px}.bst-description{min-height:0}.bst-context{margin-top:56px}.bst-page{padding-top:80px}.bst-candidate-heading{gap:8px}.bst-baseline{gap:8px}.bst-baseline>.bst-caption{margin-right:4px}.bst-baseline .auth-action{margin-left:4px}}
@media(prefers-reduced-motion:reduce){.bst-button,.bst-button-label,.bst-button-arrow{transition:none}.bst-button:not(:disabled):active{transform:none}}
`;

export const BUTTON_STUDY_SCRIPT = `(() => {
  const context = document.querySelector(".bst-context");
  if (!context) return;
  const names = ${JSON.stringify(Object.fromEntries(BUTTON_STUDIES.map(option => [option.id, option.name])))};
  const select = value => {
    if (!Object.prototype.hasOwnProperty.call(names, value)) return;
    context.dataset.buttonVariant = value;
    context.querySelector("[data-study-current]").textContent = names[value];
    for (const radio of context.querySelectorAll('input[name="button-study-style"]')) radio.checked = radio.value === value;
  };
  for (const radio of context.querySelectorAll('input[name="button-study-style"]')) radio.addEventListener("change", () => select(radio.value));
  for (const link of document.querySelectorAll("[data-context-style]")) link.addEventListener("click", () => select(link.dataset.contextStyle));
})();`;
