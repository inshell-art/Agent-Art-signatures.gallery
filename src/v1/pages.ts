import { formatGr0k } from "./input.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

interface LayoutOptions {
  title: string;
  description: string;
  body: string;
  fixtureMode?: boolean;
  robots?: "index" | "noindex";
  ogImage?: string;
}

export function layout(options: LayoutOptions): string {
  const title = escapeHtml(options.title);
  const description = escapeHtml(options.description);
  const fixtureBanner = options.fixtureMode
    ? '<div class="fixture-banner">Development fixture · renderer and account data are not production records</div>'
    : "";
  const og = options.ogImage
    ? `<meta property="og:image" content="${escapeHtml(options.ogImage)}"><meta name="twitter:card" content="summary_large_image">`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="${options.robots ?? "index"}"><title>${title}</title><meta name="description" content="${description}"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}">${og}<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml"><script src="/assets/theme.js"></script><link rel="stylesheet" href="/assets/site.css"></head><body>${fixtureBanner}<header class="site-header"><a class="wordmark" href="/">SIGNATURES<span>.GALLERY</span></a><div class="header-actions"><nav><a href="/">Gallery</a><a href="/me">My collection</a></nav><fieldset class="theme-switcher"><legend>Color theme</legend><button class="theme-option" type="button" data-theme-value="auto" aria-pressed="true">Auto</button><button class="theme-option" type="button" data-theme-value="light" aria-pressed="false">Light</button><button class="theme-option" type="button" data-theme-value="dark" aria-pressed="false">Dark</button></fieldset></div></header><main>${options.body}</main><footer><span>Signatures Gallery · V1</span><span>Private reading, public acceptance.</span></footer></body></html>`;
}

export function homePage(fixtureMode: boolean): string {
  const demo = fixtureMode
    ? '<div class="fixture-links"><span>Try the development flow</span><a href="/s/alice/0.371924">Preview @alice · 0.371924 →</a><a href="/s/charlie_7/0.820000">Preview @charlie_7 · 0.820000 →</a></div>'
    : '<form method="post" action="/auth/x/start"><input type="hidden" name="purpose" value="account_login"><button class="button secondary" type="submit">Sign in with X</button></form>';
  const body = `<section class="home-grid"><div class="intro-panel"><p class="eyebrow">Gallery of signatures</p><h1>A signature shaped by a private reading.</h1><p class="lede">Ask Grok for one environmental value, preview the resulting work, then claim it through your X account.</p><ol class="steps"><li><span>01</span><div><strong>Ask privately</strong><p>Open Grok in X and ask it to read your recent public posts.</p></div></li><li><span>02</span><div><strong>Open the preview</strong><p>Grok returns a link containing your handle and a six-place <code>gr0k</code> value.</p></div></li><li><span>03</span><div><strong>Claim with X</strong><p>Review the exact work, authenticate the matching account, and claim explicitly.</p></div></li></ol><details><summary>Copy the Grok instruction</summary><pre>Review the recent public X posts by @HANDLE. Based on your reading, select one value called gr0k from 0.000000 through 1.000000. Treat gr0k as an environmental condition for the signature, not as a mood, score, probability, or judgment of the person. Return this canonical URL using six decimal places:\n\nhttps://signatures.gallery/s/HANDLE/GR0K</pre></details></div><aside class="gallery-shell"><div class="gallery-index"><span>PUBLIC GALLERY</span><span>V1 / 000</span></div><div class="empty-frame"><div class="empty-mark">∅</div><h2>No signatures are on display.</h2><p>Claims remain in private account collections in V1.</p></div>${demo}</aside></section>`;
  return layout({ title: "Signatures Gallery", description: "Preview and claim a signature shaped by a private Grok reading.", body, fixtureMode });
}

export function previewPage(params: { handle: string; gr0kRaw: number; rendererVersion: string; imageUrl: string; fixtureMode: boolean }): string {
  const handle = escapeHtml(params.handle);
  const gr0k = formatGr0k(params.gr0kRaw);
  const svgUrl = escapeHtml(params.imageUrl.replace(/\.png$/, ".svg"));
  const body = `<section class="preview-grid"><div class="art-stage"><div class="art-label"><span>UNCLAIMED PREVIEW</span><span>${escapeHtml(params.rendererVersion)}</span></div><img src="${svgUrl}" alt="Signature preview for @${handle}"></div><div class="claim-panel"><p class="eyebrow">Unclaimed preview</p><h1>@${handle}</h1><div class="gr0k-readout"><span>gr0k</span><strong>${gr0k}</strong></div><p class="trust-copy">In the intended workflow, gr0k is selected in a private Grok conversation. Signatures Gallery cannot independently verify that private step.</p><form method="post" action="/auth/x/start"><input type="hidden" name="purpose" value="claim"><input type="hidden" name="handle" value="${handle}"><input type="hidden" name="gr0k" value="${gr0k}"><button class="button" type="submit">${params.fixtureMode ? "Try demo claim" : "Claim with X"}</button></form><p class="fine-print">Opening this page creates nothing. A signature is created only after X authentication and your final confirmation.</p></div></section>`;
  return layout({ title: `@${params.handle} · gr0k ${gr0k}`, description: `Unclaimed signature preview for @${params.handle} at gr0k ${gr0k}.`, body, fixtureMode: params.fixtureMode, robots: "noindex", ogImage: params.imageUrl });
}

export interface SignatureView {
  signatureId: string;
  handleAtClaim: string;
  gr0kRaw: number;
  rendererVersion: string;
  svgSha256: string;
  pngSha256: string;
  cardRendererVersion: string;
  xAuthenticatedAt: Date;
  claimedAt: Date;
  publicAccountId: string;
}

export function reviewPage(params: {
  handle: string;
  gr0kRaw: number;
  rendererVersion: string;
  imageUrl: string;
  flowId: string;
  csrfToken: string;
  fixtureMode: boolean;
}): string {
  const handle = escapeHtml(params.handle);
  const gr0k = formatGr0k(params.gr0kRaw);
  const body = `<section class="review-wrap"><div class="review-art"><img src="${escapeHtml(params.imageUrl.replace(/\.png$/, ".svg"))}" alt="Signature for @${handle}"></div><div class="review-copy"><p class="eyebrow">Authenticated review</p><h1>Claim this exact signature?</h1><dl class="facts"><div><dt>X account</dt><dd>@${handle}</dd></div><div><dt>gr0k</dt><dd>${gr0k}</dd></div><div><dt>Renderer</dt><dd>${escapeHtml(params.rendererVersion)}</dd></div></dl><div class="notice"><strong>What this proves</strong><p>X authenticated the account controlling @${handle}. It does not prove that Grok created this URL or selected the value.</p></div><p>Claiming creates a durable, public-by-link record. It cannot be edited through the site.</p><form method="post" action="/api/v1/signatures"><input type="hidden" name="flow" value="${escapeHtml(params.flowId)}"><input type="hidden" name="csrf" value="${escapeHtml(params.csrfToken)}"><button class="button" type="submit">Claim this signature</button></form><a class="quiet-link" href="/s/${handle}/${gr0k}">Cancel and return to preview</a></div></section>`;
  return layout({ title: `Review @${params.handle} signature`, description: "Review and explicitly claim this signature.", body, fixtureMode: params.fixtureMode, robots: "noindex" });
}

export function signaturePage(signature: SignatureView, fixtureMode: boolean): string {
  const handle = escapeHtml(signature.handleAtClaim);
  const gr0k = formatGr0k(signature.gr0kRaw);
  const body = `<section class="signature-page"><div class="signature-art"><div class="art-label"><span>CLAIMED VIA X</span><span>${escapeHtml(signature.signatureId.slice(0, 13))}…</span></div><img src="/artifacts/${escapeHtml(signature.signatureId)}.svg" alt="Claimed signature for @${handle}"></div><article class="signature-record"><p class="eyebrow">Claimed signature</p><h1>@${handle}</h1><div class="gr0k-readout"><span>gr0k</span><strong>${gr0k}</strong></div><p class="claim-line">Claimed via X on <time>${escapeHtml(signature.claimedAt.toISOString())}</time>.</p><p class="trust-copy">X reported this account as @${handle} at ${escapeHtml(signature.xAuthenticatedAt.toISOString())}. The private Grok step cannot be independently verified.</p><details class="provenance"><summary>Technical provenance</summary><dl class="facts"><div><dt>Account reference</dt><dd>${escapeHtml(signature.publicAccountId)}</dd></div><div><dt>Renderer</dt><dd>${escapeHtml(signature.rendererVersion)}</dd></div><div><dt>SVG SHA-256</dt><dd>${escapeHtml(signature.svgSha256)}</dd></div><div><dt>Card renderer</dt><dd>${escapeHtml(signature.cardRendererVersion)}</dd></div><div><dt>PNG SHA-256</dt><dd>${escapeHtml(signature.pngSha256)}</dd></div></dl></details><a class="button secondary" href="/artifacts/${escapeHtml(signature.signatureId)}.svg">Open exact SVG</a></article></section>`;
  return layout({ title: `@${signature.handleAtClaim} · claimed signature`, description: `A signature claimed via X by @${signature.handleAtClaim}.`, body, fixtureMode, robots: "noindex", ogImage: `/artifacts/${signature.signatureId}.png` });
}

export function collectionPage(params: {
  currentHandle: string;
  signatures: SignatureView[];
  csrfToken: string;
  fixtureMode: boolean;
}): string {
  const cards = params.signatures.length === 0
    ? '<div class="collection-empty"><h2>No signatures yet.</h2><p>Open a private-Grok preview to begin.</p></div>'
    : params.signatures.map((signature) => `<a class="signature-card" href="/signatures/${escapeHtml(signature.signatureId)}"><img src="/artifacts/${escapeHtml(signature.signatureId)}.svg" alt="Signature claimed as @${escapeHtml(signature.handleAtClaim)}"><div><strong>@${escapeHtml(signature.handleAtClaim)}</strong><span>gr0k ${formatGr0k(signature.gr0kRaw)}</span><time>${escapeHtml(signature.claimedAt.toISOString().slice(0, 10))}</time></div></a>`).join("");
  const body = `<section class="collection-head"><div><p class="eyebrow">Private account collection</p><h1>@${escapeHtml(params.currentHandle)}</h1><p>Every claimed signature has equal status. Dates are presentation order only.</p></div><form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${escapeHtml(params.csrfToken)}"><button class="button secondary" type="submit">Log out</button></form></section><section class="collection-grid">${cards}</section>`;
  return layout({ title: `@${params.currentHandle} · My collection`, description: "Your claimed signatures.", body, fixtureMode: params.fixtureMode, robots: "noindex" });
}

export function signInRequiredPage(fixtureMode: boolean): string {
  const fixtureAction = fixtureMode ? '<form method="post" action="/dev/login"><button class="button" type="submit">Open fixture collection</button></form>' : '<form method="post" action="/auth/x/start"><input type="hidden" name="purpose" value="account_login"><button class="button" type="submit">Sign in with X</button></form>';
  return layout({ title: "Sign in · Signatures Gallery", description: "Sign in to view your collection.", fixtureMode, robots: "noindex", body: `<section class="message-page"><p class="eyebrow">Private collection</p><h1>Sign in to continue.</h1><p>Your collection is grouped by your numeric X account ID, not by a changeable handle.</p>${fixtureAction}</section>` });
}

export function errorPage(status: number, code: string, message: string, fixtureMode = false): string {
  const body = `<section class="message-page"><p class="eyebrow">${escapeHtml(code)}</p><h1>${status}</h1><p>${escapeHtml(message)}</p><a class="button secondary" href="/">Return home</a></section>`;
  return layout({ title: `${status} · ${code}`, description: message, body, fixtureMode, robots: "noindex" });
}

export function gonePage(fixtureMode = false): string {
  return errorPage(410, "LEGACY_ROUTE_RETIRED", "This legacy signature route has been retired. Start again with the private Grok instructions.", fixtureMode);
}
