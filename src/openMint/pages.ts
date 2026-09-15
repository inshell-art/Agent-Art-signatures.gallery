import { SITE_FONT_PRELOAD } from "../v1/fonts.js";
import { SITE_CSS_URL } from "../v1/siteCss.js";
import { HOME_LINK } from "../v1/navigation.js";
import { FAVICON_LINK } from "../brand/favicon.js";
import { xProfileLink } from "../v1/xProfile.js";
import { SLOGAN_DISPLAY_TEXT, SLOGAN_SIGNATURE_SVG, SLOGAN_SIGNATURE_MOBILE_SVG } from "../brand/sloganSignature.js";
import { isMbti, MBTI_TYPES, preservedHandle, RENDERER_VERSION, type MBTI } from "./identity.js";

export interface OpenMintPageOptions {
  csrfToken?: string;
  wallet?: string | null;
  walletVerified?: boolean;
  chainId?: string;
  chainName?: string;
  contract?: string;
  rpcUrl?: string;
  publicOrigin?: string;
  clientScriptUrl?: string;
  stylesheetUrl?: string;
  development?: {
    fixture: boolean;
    localChain?: boolean;
    tools?: Array<{ label: string; href: string }>;
    notes?: string[];
  };
}

export interface MintPageState {
  state: "unminted" | "pending" | "minted";
  transactionHash?: string;
  tokenId?: string;
  wallet?: string;
  explorerUrl?: string;
}

export interface AssessmentPageModel {
  handle: string;
  renderHandle?: string;
  code: string;
  status: "pending" | "ready" | "failed";
  canMint: boolean;
  walletProvedForCode?: boolean;
  requestExpired?: boolean;
  mbti?: string;
  imageUrl?: string;
  svgUrl?: string;
  rendererVersion?: string;
  svgSha256?: string;
  pngSha256?: string;
  assessedAt?: string;
  sourceLabel?: string;
  error?: string;
  tokenId?: string;
  mint?: MintPageState;
}

export interface GalleryEntry {
  handle: string;
  renderHandle?: string;
  code: string;
  mbti: string;
  imageUrl: string;
  url?: string;
  mint?: MintPageState;
}

const escapeHtml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
const e = (value: unknown): string => escapeHtml(String(value ?? ""));
const safeUrl = (value: string | undefined, fallback = "#"): string => {
  if (!value) return fallback;
  if (/^\/(?!\/)/.test(value) && !/[\\\u0000-\u0020]/.test(value)) return value;
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.href : fallback; } catch { return fallback; }
};
export function canonicalPageHandle(value: string): string {
  const handle = value.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) throw new Error("Enter an X handle with 1–15 letters, numbers, or underscores.");
  return handle;
}
const mintPath = (handle: string): string => `/mint?handle=${encodeURIComponent(preservedHandle(handle))}`;
const signaturePath = (handle: string): string => `/signatures/${canonicalPageHandle(handle)}`;
const renderedPageHandle = (handle: string, renderHandle?: string): string => {
  const canonical = canonicalPageHandle(handle);
  const preserved = preservedHandle(renderHandle ?? canonical);
  if (canonicalPageHandle(preserved) !== canonical) throw new Error("The artwork handle does not match its identity.");
  return preserved;
};
const action = (label: string, attributes: string): string => `<button class="auth-action" type="button" ${attributes}><span>${e(label)}</span></button>`;

/** Extends the existing paper, type, navigation and hairline controls without replacing them. */
export const OPEN_MINT_CSS = `
.open-mint .open-preview-note a{color:var(--ink);text-underline-offset:.2em}.open-mint .open-preview-note a:focus-visible{outline:2px solid var(--blue);outline-offset:3px}.open-mint .open-preview-variations{padding:5rem var(--page-gutter) 3rem}.open-mint .open-preview-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1.5rem 1rem;list-style:none;margin:2rem 0;padding:0}.open-mint .open-preview-grid>li{min-width:0}.open-mint .open-preview-card{display:block;text-decoration:none}.open-mint .open-preview-card img{display:block;width:100%;height:auto;aspect-ratio:1;background:var(--art-paper)}.open-mint .open-preview-card .signature-tag{margin-top:.6rem}.open-mint .open-preview-card:hover .signature-tag{text-decoration:underline;text-underline-offset:.2em}.open-mint .open-preview-card:focus-visible{outline:2px solid var(--blue);outline-offset:4px}@media(max-width:600px){.open-mint .open-preview-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
.open-mint [hidden]{display:none!important}.open-mint .open-handle-form{display:flex;align-items:center;flex-wrap:wrap;gap:0 .65rem;max-width:28rem}.open-mint .open-handle-input{width:14rem;max-width:100%;min-width:0;margin:0;padding:7px 9px;border:1px solid var(--line);border-radius:2px;background:transparent;color:var(--ink);line-height:1.4}.open-mint .open-handle-input:focus-visible{outline:2px solid var(--ink);outline-offset:3px}.open-mint .open-intro{width:100%;max-width:42rem;margin-inline:auto}.open-mint .open-intro p{line-height:1.6}.open-mint .open-handoff{margin-top:.25rem}.open-mint .open-handoff>summary{color:var(--muted)}.open-mint .open-handoff textarea{min-height:10rem}.open-mint .open-art-waiting{display:grid;place-items:center;aspect-ratio:1;background:var(--art-paper);color:#625f59;text-align:center;padding:2rem}.open-mint .open-art-waiting p{max-width:22rem;line-height:1.6}.open-mint .open-mint-panel{scroll-margin-top:5rem;margin-top:.5rem;padding-top:.5rem;border-top:1px solid var(--line)}.open-mint .open-mint-panel .consent-line{margin:.8rem 0}.open-mint .open-mint-panel .signature-facts{margin:.5rem 0}.open-mint .open-feedback{margin:.25rem 0;min-height:0;color:var(--muted);line-height:1.5}.open-mint .open-feedback:empty{margin:0}.open-mint .open-wallet-address{overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.open-mint .open-mint-entry{margin-top:.3rem}.open-mint .open-mint-entry .auth-action{margin-inline-start:auto}.open-mint .open-mint-entry .signature-tag{margin-inline-end:auto}.open-mint .open-collection-wallet{display:flex;flex-wrap:wrap;align-items:center;gap:0 .75rem}.open-mint .open-dev-tools{display:flex;flex-wrap:wrap;gap:.5rem 1rem}.open-mint .open-poll-note{color:var(--muted)}
.open-mint .open-mint-form{display:grid;align-items:start;gap:1rem;max-width:35rem}.open-mint .open-mint-form>label{display:grid;gap:.45rem}.open-mint .open-mint-form .auth-actions{margin:0}.open-mint .open-mint-form p{margin:0;line-height:1.6}.open-mint .open-mint-explanation{max-width:35rem;line-height:1.6}.open-mint .open-mint-cost{color:var(--muted)}.open-mint .open-mint-progress{max-width:35rem}.open-mint .open-mint-progress>p{line-height:1.6}.open-mint .open-mint-progress form{margin-block:1rem}.open-mint .open-gallery-empty{margin-block:2rem;color:var(--muted)}.open-mint .open-preview-note{color:var(--muted);line-height:1.6}.open-mint .open-preview-bridge{margin-block:1rem}.open-mint .open-mint-form .open-wallet-address{margin-bottom:.4rem}
`;

function layout(title: string, body: string, options: OpenMintPageOptions, description = "An X handle, an artist-defined system, and Grok’s reading become a signature."): string {
  const dev = options.development;
  const walletTools = dev?.localChain && (body.includes("data-mint-entry") || body.includes("data-assessment-code") || body.includes("data-collection-page")) ? `<section><h2>Local test wallet</h2><p>These controls use a public test key on the local chain.</p><div class="auth-actions">${action("Use local test wallet", "data-dev-wallet")}${body.includes("data-mint-form") ? action("Mint with local test wallet", "data-dev-mint disabled") : ""}</div><p class="open-feedback" data-dev-feedback role="status" aria-live="polite"></p></section>` : "";
  const overlay = dev ? `<aside class="rehearsal-watermark" aria-label="Developer overlay"><details class="rehearsal-disclosure"><summary aria-controls="open-dev-context"><span class="rehearsal-dev-badge">DEV</span><span>${dev.fixture ? "Fixture tools" : dev.localChain ? "Local chain" : "Developer tools"}</span></summary><div id="open-dev-context" class="rehearsal-context"><p class="rehearsal-context-heading">Developer overlay</p><section><h2>${dev.fixture ? "Simulated assessment" : "Assessment source"}</h2><p>${dev.fixture ? "Fixture results are simulated. Grok did not research these handles or choose these MBTI values." : "The backend calls Grok to research public X posts. Client input cannot choose the MBTI."}</p>${dev.localChain ? "<p>Local chain rehearsal. Public test funds have no value.</p>" : ""}</section>${dev.tools?.length ? `<section><h2>Tools</h2><div class="open-dev-tools">${dev.tools.map(tool => `<a href="${e(safeUrl(tool.href))}">${e(tool.label)}</a>`).join("")}</div></section>` : ""}${dev.notes?.length ? `<section><h2>Notes</h2>${dev.notes.map(note => `<p>${e(note)}</p>`).join("")}</section>` : ""}</div></details></aside>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${e(title === "Signatures Gallery" ? title : `${title} · Signatures Gallery`)}</title><meta name="description" content="${e(description)}">${FAVICON_LINK}${SITE_FONT_PRELOAD}<link rel="stylesheet" href="${e(safeUrl(options.stylesheetUrl, SITE_CSS_URL))}"><script src="${e(safeUrl(options.clientScriptUrl, "/assets/open-mint.js"))}" defer></script></head><body class="book-page open-mint" data-open-mint data-wallet-verified="${options.walletVerified ? "true" : "false"}" data-chain-id="${e(options.chainId)}" data-contract="${e(options.contract)}"${dev?.fixture ? ' data-fixture="true"' : ""}${dev?.localChain ? ' data-local-chain="true"' : ""}><main>${HOME_LINK}<a class="collection-shortcut" href="/me" aria-label="My Collection" title="My Collection"><span class="collection-shortcut-dot" aria-hidden="true"></span></a>${body}</main><footer><div class="footer-credit">by <a class="footer-agent" href="https://x.com/AgentArt_AA" target="_blank" rel="noopener noreferrer"><span>Agent Art</span><span aria-hidden="true">↗</span></a></div><a class="footer-about" href="/about">About the work</a></footer>${overlay.replace("</div></details></aside>", `${walletTools}</div></details></aside>`)}</body></html>`;
}

function walletControls(options: OpenMintPageOptions, proved = options.walletVerified): string {
  return `<div data-wallet-controls><p class="open-wallet-address" data-wallet-label>${options.wallet ? e(options.wallet) : "Connect the wallet that will receive the token."}</p><p class="open-mint-cost">Network: <span data-review-chain>${e(options.chainName ?? "Configured mint network")}</span></p><div class="auth-actions">${action(!options.wallet ? "Connect wallet" : proved ? "Change wallet" : "Verify wallet", "data-connect-wallet")}</div><p class="open-feedback" data-mint-feedback role="status" aria-live="polite"></p></div>`;
}

export function handoffPrompt(publicOrigin?: string): string {
  const origin = safeUrl(publicOrigin, "https://signatures.gallery").replace(/\/$/, "");
  return `First, ask me which X handle I want to explore. Accept a handle containing 1–15 letters, numbers, or underscores. Preserve its exact spelling and capitalization; only remove the leading @. For example, @Alice_Bob_Key must become Alice_Bob_Key, not alice_bob_key. After I provide a valid handle, use the public X information available to you to assess an MBTI for that handle in this chat. Treat the MBTI as an artistic interpretation, not a psychological diagnosis. If you cannot find enough information, say so instead of inventing an assessment. Choose one of these uppercase types: ${MBTI_TYPES.join(", ")}. Then return: Check the signature of @<handle>: ${origin}/s/<handle>/<MBTI>. For example: ${origin}/s/Alice_Bob_Key/ENFP. Use the letters, not a number. This is an editable preview, not a mint authorization. Do not call the site to request an assessment or ask for a wallet; minting is a separate action on the site.`;
}

function handoff(options: OpenMintPageOptions): string {
  return `<details class="auth-disclosure open-handoff"><summary>Explore with Grok</summary><p>Give this prompt to Grok on X or Grok.com. It asks for a handle, interprets its MBTI, and returns a preview link.</p><textarea class="grok-prompt" readonly data-handoff-prompt aria-label="Prompt for Grok">${e(handoffPrompt(options.publicOrigin))}</textarea><div class="auth-actions">${action("Copy prompt", "data-copy-handoff")}<a class="auth-action" href="https://grok.com" target="_blank" rel="noopener noreferrer"><span>Open Grok ↗</span></a></div><p class="open-feedback" data-copy-feedback role="status" aria-live="polite"></p></details>`;
}

function galleryCards(entries: GalleryEntry[]): string {
  return `<div class="public-gallery-grid">${entries.map(entry => {
    const handle = renderedPageHandle(entry.handle, entry.renderHandle);
    return `<article class="gallery-item"><a class="gallery-card" href="${e(safeUrl(entry.url, signaturePath(handle)))}"><img src="${e(safeUrl(entry.imageUrl))}" alt="Signature for @${e(handle)}" loading="lazy"></a><div class="gallery-card-copy"><strong>${xProfileLink(handle)}</strong><span class="signature-tag">${e(entry.mbti)}</span></div></article>`;
  }).join("")}</div>`;
}

export function homePage(options: OpenMintPageOptions = {}, entries: GalleryEntry[] = []): string {
  const minted = entries.filter(entry => entry.mint?.state === "minted");
  const slogan = `<div class="slogan-lockup"><h1 class="visually-hidden">${e(SLOGAN_DISPLAY_TEXT)}</h1><figure class="slogan-signature" title="${e(SLOGAN_DISPLAY_TEXT)}" role="img" aria-label="${e(SLOGAN_DISPLAY_TEXT)}"><span class="slogan-signature-layout slogan-signature-desktop">${SLOGAN_SIGNATURE_SVG}</span><span class="slogan-signature-layout slogan-signature-mobile">${SLOGAN_SIGNATURE_MOBILE_SVG}</span></figure></div>`;
  const body = `<section class="home-grid"><div class="intro-panel">${slogan}</div><div class="gallery-shell"><section class="open-intro" aria-label="Mint a signature"><p>Any X handle. One minted signature.</p><div class="auth-actions"><a class="auth-action" href="/mint"><span>Mint a signature</span></a></div>${handoff(options)}</section>${minted.length ? galleryCards(minted) : '<p class="open-gallery-empty">No signatures minted yet.</p>'}</div></section>`;
  return layout("Signatures Gallery", body, options);
}

export function requestPage(handle: string, options: OpenMintPageOptions = {}): string {
  return mintPage(handle, options);
}

export function mintPage(handle = "", options: OpenMintPageOptions = {}): string {
  const spelling = handle ? preservedHandle(handle.trim()) : "";
  return layout("Mint & reveal", `<section class="auth-page" data-mint-entry data-wallet-verified="${options.walletVerified ? "true" : "false"}"><div class="auth-sheet"><h1>Mint &amp; reveal</h1><form class="open-mint-form" data-assessment-request><label for="open-handle">X handle<input class="open-handle-input" id="open-handle" name="handle" value="${e(spelling)}" placeholder="@handle" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="16" pattern="@?[A-Za-z0-9_]{1,15}" required aria-describedby="mint-explanation request-feedback"></label>${walletControls(options)}<p id="mint-explanation" class="open-mint-explanation">Grok chooses the final signature. It may differ from your preview. Reveal after minting.</p><p class="open-mint-cost">No mint fee. You pay network gas. Minting creates a permanent public token.</p><div class="auth-actions"><button class="auth-action" type="submit" data-request-submit${options.walletVerified ? "" : " disabled"}><span>Mint &amp; reveal</span></button></div><p class="open-feedback" id="request-feedback" data-request-feedback role="status" aria-live="polite"></p></form></div></section>`, options);
}

export function previewPage(handle: string, mbti: MBTI, options: OpenMintPageOptions = {}): string {
  const spelling = preservedHandle(handle);
  if (!isMbti(mbti)) throw new Error("Choose one of the 16 MBTI types, such as ENFP.");
  const image = `/preview/${spelling}/${mbti}.svg?renderer=${RENDERER_VERSION}`;
  return layout(`@${spelling} · ${mbti} preview`, `<article class="signature-page" data-preview-page><div class="signature-sheet"><figure class="signature-art"><img src="${e(image)}" alt="${e(mbti)} signature preview for @${e(spelling)}"></figure><div class="signature-record"><div class="signature-heading"><h1>${xProfileLink(spelling)}</h1><span class="signature-tag">${e(mbti)}</span><span class="signature-tag">Preview</span></div><p class="open-preview-note">A playful preview. Change the MBTI in the URL to explore. <a href="/s/${e(spelling)}/variations">View all 16 variations</a>.</p><div class="auth-actions open-preview-bridge"><a class="auth-action" href="${e(mintPath(spelling))}"><span>Mint for this handle →</span></a></div></div></div></article>`, options, "An editable signature preview. Minting uses an independent Grok assessment.");
}

export function previewVariationsPage(handle: string, options: OpenMintPageOptions = {}): string {
  const spelling = preservedHandle(handle);
  const cards = MBTI_TYPES.map(mbti => `<li><a class="open-preview-card" href="/s/${e(spelling)}/${mbti}" aria-label="Explore ${mbti} for @${e(spelling)}"><img src="/preview/${e(spelling)}/${mbti}.svg?renderer=${RENDERER_VERSION}" alt="${mbti} signature preview for @${e(spelling)}" width="400" height="400"><span class="signature-tag">${mbti}</span></a></li>`).join("");
  return layout(`@${spelling} · 16 variations`, `<section class="open-preview-variations" data-preview-variations><header class="signature-heading"><h1>16 variations</h1>${xProfileLink(spelling)}<span class="signature-tag">Preview</span></header><p class="open-preview-note">One handle, all 16 MBTI interpretations. Choose a variation to explore.</p><ul class="open-preview-grid" aria-label="MBTI preview variations">${cards}</ul><div class="auth-actions open-preview-bridge"><a class="auth-action" href="${e(mintPath(spelling))}"><span>Mint for this handle →</span></a></div></section>`, options, "Explore all 16 editable MBTI signature previews for one handle. Minting uses an independent Grok assessment.");
}

function mintControls(model: AssessmentPageModel, options: OpenMintPageOptions): string {
  const mint = model.mint?.state ?? "unminted";
  const explorerUrl = safeUrl(model.mint?.explorerUrl, "");
  if (mint === "minted") return `<div class="auth-actions open-mint-entry"><span class="signature-tag" data-mint-state-label>Minted</span>${explorerUrl ? `<a class="auth-action" href="${e(explorerUrl)}" target="_blank" rel="noopener noreferrer"><span>View token ↗</span></a>` : ""}</div>`;
  if (mint === "pending") return `<p class="open-feedback" data-mint-feedback role="status" aria-live="polite">Waiting for the transaction to be confirmed.</p>`;
  if (model.requestExpired) return `<p class="auth-note">This mint request has expired.</p><div class="auth-actions"><a class="auth-action" href="${e(mintPath(renderedPageHandle(model.handle, model.renderHandle)))}"><span>Return to mint</span></a></div>`;
  if (model.status === "failed") return `<p class="open-feedback" data-mint-feedback role="status" aria-live="polite">${e(model.error ?? "The assessment could not be completed. No mint transaction was submitted.")}</p>`;
  if (model.status === "ready" && !model.canMint) return `<p class="auth-note">This mint request is not available in this browser.</p><div class="auth-actions"><a class="auth-action" href="${e(mintPath(renderedPageHandle(model.handle, model.renderHandle)))}"><span>Return to mint</span></a></div>`;
  return `${walletControls(options, model.walletProvedForCode)}<form data-mint-form${model.status === "pending" ? " hidden" : ""}><button class="auth-action" type="submit" data-submit-mint disabled><span>Continue mint</span></button></form>`;
}

export function assessmentPage(model: AssessmentPageModel, options: OpenMintPageOptions = {}): string {
  const canonical = canonicalPageHandle(model.handle);
  const handle = renderedPageHandle(model.handle, model.renderHandle);
  const attributes = `data-assessment-code="${e(model.code)}" data-assessment-handle="${e(canonical)}" data-assessment-state="${e(model.status)}" data-can-mint="${model.canMint ? "true" : "false"}" data-wallet-proved="${model.walletProvedForCode ? "true" : "false"}" data-mint-state="${e(model.mint?.state ?? "unminted")}" data-token-id="${e(model.tokenId ?? model.mint?.tokenId)}"`;
  if (model.mint?.state !== "minted") {
    const progress = model.mint?.state === "pending" ? "Mint submitted. Waiting to reveal your signature…" : model.status === "failed" ? "The assessment could not be completed." : model.status === "pending" ? "Preparing your signature…" : "Your signature is ready to mint. Approve the transaction in your wallet to reveal it.";
    return layout(`Mint & reveal · @${handle}`, `<section class="auth-page" ${attributes}><div class="auth-sheet open-mint-progress"><h1>Mint &amp; reveal</h1><p>${xProfileLink(handle)}</p><p data-assessment-status role="status" aria-live="polite">${progress}</p><p class="open-mint-explanation">Grok chooses the final signature. It may differ from your preview. Reveal after minting.</p><p class="open-mint-cost">No mint fee. You pay network gas. Minting creates a permanent public token.</p>${mintControls(model, options)}<p class="open-feedback" data-poll-feedback role="status" aria-live="polite"></p></div></section>`, options);
  }
  const image = safeUrl(model.svgUrl ?? model.imageUrl);
  const fixture = Boolean(options.development?.fixture);
  const art = image !== "#" ? `<img src="${e(image)}" alt="Signature for @${e(handle)}">` : `<div class="open-art-waiting"><p role="status">The minted artwork is temporarily unavailable.</p></div>`;
  const facts: Array<[string, unknown]> = [["Handle", `@${handle}`], ["Assessment", fixture ? undefined : model.sourceLabel ?? "Grok · public X research"], ["MBTI", model.mbti], ["Renderer", model.rendererVersion], ["SVG SHA-256", model.svgSha256], ["PNG SHA-256", model.pngSha256], [fixture ? "Created" : "Assessed", model.assessedAt], ["Token", model.mint?.tokenId ?? model.tokenId], ["Transaction", model.mint?.transactionHash]];
  const provenance = `<div class="signature-tools"><details class="signature-provenance"><summary>Provenance</summary><div class="signature-provenance-body"><p>${fixture ? "The MBTI shapes the signature’s expression. It is an artistic input, not a psychological diagnosis." : "The backend asked Grok to research public X posts and select an MBTI for this handle. The classification is an artistic input, not a psychological diagnosis."}</p><p>The handle identifies the token. Anyone can request a signature for a handle; holding its token does not establish control of the X account.</p><dl class="signature-facts">${facts.filter(([, value]) => value !== undefined && value !== "").map(([label, value]) => `<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`).join("")}</dl></div></details>${model.status === "ready" && model.svgUrl ? `<a class="signature-svg" href="${e(safeUrl(model.svgUrl))}" target="_blank" rel="noopener noreferrer" aria-label="Open original SVG">SVG ↗</a>` : ""}</div>`;
  return layout(`@${handle}${model.mbti ? ` · ${model.mbti}` : ""}`, `<article class="signature-page" data-mint-state="minted"><div class="signature-sheet"><figure class="signature-art">${art}</figure><div class="signature-record"><div class="signature-heading"><h1>${xProfileLink(handle)}</h1>${model.mbti ? `<span class="signature-tag">${e(model.mbti)}</span>` : ""}</div>${mintControls(model, options)}${provenance}</div></div></article>`, options);
}

export function collectionPage(entries: GalleryEntry[] = [], options: OpenMintPageOptions = {}): string {
  const wallet = options.wallet;
  const minted = entries.filter(entry => entry.mint?.state === "minted");
  const body = `<section class="collection-page" data-collection-page><div class="collection-intro"><h1>My Collection</h1><div class="open-collection-wallet"><p class="open-wallet-address" data-wallet-label>${wallet ? e(wallet) : "Connect your wallet to see the signatures it holds."}</p>${action(wallet ? "Change wallet" : "Connect wallet", "data-connect-wallet")}${wallet ? action("Disconnect", "data-disconnect-wallet") : ""}</div><p class="open-feedback" data-mint-feedback role="status" aria-live="polite"></p></div>${minted.length ? galleryCards(minted) : `<div class="collection-empty signed-out-participation"><p>${wallet ? "This wallet has no minted signatures yet." : "Your collection follows your wallet."}</p><a class="auth-action" href="/mint"><span>Mint a signature</span></a></div>`}</section>`;
  return layout("My Collection", body, options);
}

export function aboutPage(options: OpenMintPageOptions = {}): string {
  return layout("About the work", `<article class="about-page"><div class="about-sheet"><h1>About the work</h1><p>Signatures Gallery turns an X handle into a handwriting-like mark. A public identifier becomes a drawn signature.</p><section><h2>Explore</h2><p>Ask Grok on X or Grok.com to interpret a handle’s MBTI and share a preview link. A preview combines the handle and the MBTI in its URL. You can change either to play with the result. Preview pages do not call our assessment service or authorize a mint.</p><p>The MBTI is an artistic input, not a diagnosis or a fact about the person behind an account.</p></section><section><h2>Mint &amp; reveal</h2><p>Anyone can mint for any handle. Connect a wallet, enter a handle, and choose Mint &amp; reveal. Our backend asks Grok to independently research public X posts and choose the MBTI. It does not accept the preview’s MBTI. The final signature may differ from your preview.</p><p>The first accepted assessment is kept for that handle; cancelling a transaction does not create another result. The artwork is prepared before the wallet transaction and revealed on the site after the mint is confirmed. This is a reveal experience, not cryptographic secrecy.</p><p>No mint fee. You pay network gas. A token is identified by the canonical handle, regardless of letter case: one minted token per handle. A token can move between wallets; holding one does not prove control of the X account. Minting leaves a permanent public record.</p></section><section><h2>Agent Art</h2><p>Project 01 by <a href="https://x.com/AgentArt_AA" target="_blank" rel="noopener noreferrer">Agent Art ↗</a>.</p></section></div></article>`, options);
}

export function errorPage(message: string, options: OpenMintPageOptions = {}): string {
  return layout("Unable to open this page", `<section class="auth-page"><div class="auth-sheet"><h1>Unable to open this page</h1><p role="alert">${e(message)}</p><a class="auth-action" href="/"><span>Back to gallery</span></a></div></section>`, options);
}
