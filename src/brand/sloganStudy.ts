import { formalSignatureRenderer } from "../v1/renderer.js";
import { SITE_FONT_PRELOAD } from "../v1/fonts.js";
import { FAVICON_LINK } from "./favicon.js";
import {
  captureSignatureComposition,
  restoreSignatureCompositionSnapshot,
  tokenizeSignatureWords,
  type CapturedSignatureGlyph,
} from "./signatureComposition.js";
import { OPEN_FLOW_QUESTION_MARK, QUESTION_MARK_STUDIES } from "./sloganQuestionMark.js";
import { SLOGAN_SHAPE_LOCK } from "./sloganShapeLock.js";
import { SLOGAN_SIGNATURE_SVG } from "./sloganSignature.js";

export const SLOGAN_COPY_STUDIES = [
  {
    id: "go-by",
    text: "What shape do you go by?",
    label: "Selected · sentence case on homepage",
    rationale: "A turn on ‘What name do you go by?’ It invites you to see a chosen public identifier as a mark, without claiming to reveal your whole identity.",
  },
  {
    id: "handle",
    text: "What shape is your handle?",
    label: "Literal direction",
    rationale: "Exact about the input. Clear for an X audience, though ‘handle’ makes the invitation feel more like a product prompt.",
  },
  {
    id: "name",
    text: "What shape is your name?",
    label: "Previous wording · comparison",
    rationale: "Warm and immediate. A handle can be an online name, but the wording can also suggest a personal name or a broader claim about identity.",
  },
] as const;

export const SLOGAN_CASE_STUDIES = [
  { id: "current", text: "What_shape_do_you_go_by?", label: "Selected · sentence case on homepage" },
  { id: "title-case", text: "What_Shape_Do_You_Go_By?", label: "Title case · comparison" },
] as const;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** A review-only rendering of an already validated capture. It deliberately
 * does not turn proposed hashes into an approved or persisted shape lock. */
function candidateSvg(glyph: CapturedSignatureGlyph, mark: string): string {
  const drawing = glyph.drawing;
  const paint = drawing.mode === "fill"
    ? 'fill="currentColor" stroke="none"'
    : `fill="none" stroke="currentColor" stroke-width="${drawing.strokeWidth}" stroke-linecap="${drawing.strokeLinecap}" stroke-linejoin="${drawing.strokeLinejoin}"`;
  const width = glyph.width - 50;
  return `<svg viewBox="35 145 ${width} 120" xmlns="http://www.w3.org/2000/svg" width="${Math.round(width * 3)}" height="360" aria-hidden="true"><g class="study-generated-shape"><path d="${drawing.d}" ${paint}/></g><g class="study-punctuation" transform="translate(${glyph.width - 47} 169)">${mark}</g></svg>`;
}

function specimen(svg: string, label: string, extraClass = ""): string {
  return `<figure class="study-specimen ${extraClass}" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${svg}</figure>`;
}

function caseStudy(): string {
  const current = restoreSignatureCompositionSnapshot(SLOGAN_SHAPE_LOCK);
  // Both spellings are fresh literal captures; the selected sentence case matches the homepage lock.
  const captures = SLOGAN_CASE_STUDIES.map((item) => captureSignatureComposition({
    id: `slogan-study-case-${item.id}`,
    displayText: item.text,
    gr0kRaw: current.gr0kRaw,
  }, formalSignatureRenderer));
  const identical = captures[0].glyphs[0].shapeSha256 === captures[1].glyphs[0].shapeSha256;
  const rows = SLOGAN_CASE_STUDIES.map((item, index) => {
    const glyph = captures[index].glyphs[0];
    return `<article class="study-case-row" data-case-id="${item.id}" data-source-literal="${escapeHtml(item.text)}" data-renderer-input="${escapeHtml(glyph.rendererInput)}" data-shape-sha256="${glyph.shapeSha256}"><span class="study-kicker">${escapeHtml(item.label)}</span><h3>${escapeHtml(item.text)}</h3>${specimen(candidateSvg(glyph, OPEN_FLOW_QUESTION_MARK.svgMarkup), item.text)}<p class="study-technical">Literal renderer input: <code>${escapeHtml(glyph.rendererInput)}</code></p><details><summary>Shape hash</summary><code class="study-technical">${glyph.shapeSha256}</code></details></article>`;
  }).join("");
  return `<section class="study-section" id="letter-case" aria-labelledby="letter-case-title" data-identical-shapes="${identical}"><div class="study-section-heading"><span class="study-kicker">03 / Letter case · corrected adapter</span><h2 id="letter-case-title">Let the algorithm read the capitals.</h2><p>The adapter now passes each literal unchanged in case. The algorithm itself gives capitals different seeded geometry and extra stroke weight. Both specimens below are fresh captures with the same gr0k, scale, and Open flow question mark.</p><p>The sentence-case version is now on the homepage. This comparison keeps the selected shape lock intact.</p></div>${rows}<p class="study-case-result">${identical ? "These literal inputs produced identical shape hashes." : "Different inputs. Different shapes. Case reaches the algorithm intact."}</p><details class="study-baseline"><summary>Compare the current homepage · sentence case</summary><p class="study-technical">Recorded renderer input: <code>${escapeHtml(current.glyphs[0].rendererInput)}</code></p>${specimen(SLOGAN_SIGNATURE_SVG, current.glyphs[0].rendererInput)}</details></section>`;
}

export function sloganStudyPage(): string {
  const current = restoreSignatureCompositionSnapshot(SLOGAN_SHAPE_LOCK);
  const marks = QUESTION_MARK_STUDIES.map((mark, index) => {
    const svg = candidateSvg(current.glyphs[0], mark.svgMarkup);
    const isolated = `<svg viewBox="0 0 30 54" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${mark.svgMarkup}</svg>`;
    return `<article class="study-mark-row" data-mark-id="${escapeHtml(mark.id)}"><div class="study-row-heading"><span class="study-kicker">0${index + 1}</span><h3>${escapeHtml(mark.label)}</h3></div>${specimen(svg, `Current slogan with ${mark.label} question mark`)}<div class="study-mark-foot"><p>${escapeHtml(mark.rationale)}</p><div class="study-sizes" aria-label="Question mark at 54 and 24 pixels high"><span class="study-mark-large">${isolated}<small>54px</small></span><span class="study-mark-small">${isolated}<small>24px</small></span></div></div></article>`;
  }).join("");

  const copy = SLOGAN_COPY_STUDIES.map((item) => {
    const rendererText = item.text.replaceAll(" ", "_");
    // Match the exact input, not the study label, so a new accepted lock
    // cannot silently relabel the previous drawing. Other language is captured
    // only on this local, explicit study route.
    const rendererInput = tokenizeSignatureWords(rendererText)[0].rendererInput;
    const glyph = current.glyphs.find((candidate) => candidate.rendererInput === rendererInput) ?? captureSignatureComposition({
      id: `slogan-study-${item.id}`,
      displayText: rendererText,
      gr0kRaw: 22,
    }, formalSignatureRenderer).glyphs[0];
    const mark = OPEN_FLOW_QUESTION_MARK;
    return `<article class="study-copy-row" data-copy-id="${item.id}" data-renderer-input="${escapeHtml(glyph.rendererInput)}" data-shape-sha256="${glyph.shapeSha256}"><span class="study-kicker">${escapeHtml(item.label)}</span><h3>${escapeHtml(item.text)}</h3><p>${escapeHtml(item.rationale)}</p>${specimen(candidateSvg(glyph, mark.svgMarkup), rendererText)}<details><summary>Renderer input &amp; shape hash</summary><p class="study-technical"><code>${escapeHtml(glyph.rendererInput)}</code><br><code>${glyph.shapeSha256}</code></p></details></article>`;
  }).join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Slogan study · Signatures Gallery</title>${FAVICON_LINK}${SITE_FONT_PRELOAD}<link rel="stylesheet" href="/assets/site.css"><link rel="stylesheet" href="/dev/slogan-study.css"></head><body class="study-page"><main class="study-shell"><nav class="study-nav" aria-label="Study navigation"><a href="/">← Back to gallery</a><span>Local design study · approved pair on homepage</span></nav><header class="study-intro"><p class="study-kicker">Signatures Gallery / Language &amp; form</p><h1>A question, in its own hand.</h1><p>“${escapeHtml(current.displayText)}” with the Open flow question mark is now on the homepage, with its exact spelling preserved. These comparisons keep the selected shape lock intact.</p><div class="study-jump"><a href="#punctuation">01 · The question mark</a><a href="#language">02 · The words</a><a href="#letter-case">03 · Letter case</a></div></header><section class="study-section" id="punctuation" aria-labelledby="punctuation-title"><div class="study-section-heading"><span class="study-kicker">01 / Punctuation</span><h2 id="punctuation-title">A hook, a turn, a dot.</h2><p>Keep the unmistakable structure of a question mark. Borrow the curve’s changing stroke weight, soft turns, and tapered release. These are authored vector outlines, not font glyphs or generated letters.</p></div><details class="study-baseline"><summary>Compare the approved homepage artwork</summary>${specimen(SLOGAN_SIGNATURE_SVG, "Approved slogan with Open flow question mark")}</details>${marks}</section><section class="study-section" id="language" aria-labelledby="language-title"><div class="study-section-heading"><span class="study-kicker">02 / Language</span><h2 id="language-title">A handle is a name you go by.<br>It is not your whole identity.</h2><p>‘Name’ is defensible, but broad. The approved poetic direction keeps the personal invitation; the literal direction names the exact input. Each drawing below comes from its own words, using the same renderer and gr0k.</p></div>${copy}</section>${caseStudy()}<aside class="study-note"><h2>What stays true</h2><p>The artist defines the system; the handle supplies its structure; Grok supplies gr0k, a rendering condition—not an identity or reputation score. The question mark is a readable companion to the generative shape, never presented as renderer output.</p><p>The selected wording and Open flow question mark are now on the homepage. Further studies do not mutate the accepted shape lock. For this study, gr0k is held at <code>22</code> · <code>sg-renderer-1.0.0</code> (formal Signature Algorithm v1.0.0).</p></aside></main></body></html>`;
}

export const SLOGAN_STUDY_CSS = `
.study-shell{width:min(100%,1024px);margin:auto;padding:24px 32px 96px}
.study-nav{display:flex;justify-content:space-between;gap:16px;color:var(--muted);line-height:1.5}.study-nav a{text-decoration:none}.study-nav a:hover{text-decoration:underline}
.study-intro{padding:88px 0 72px;max-width:760px}.study-kicker{display:block;color:var(--muted);line-height:1.5;letter-spacing:.1em;text-transform:uppercase}
.study-intro h1{max-width:none;line-height:1.5;letter-spacing:normal;margin:18px 0 24px}
.study-intro>p:last-of-type,.study-section-heading p{max-width:640px;color:var(--muted);line-height:1.65}.study-jump{display:flex;flex-wrap:wrap;gap:12px 24px;margin-top:28px}.study-jump a{line-height:1.5;text-underline-offset:4px}
.study-section{padding:36px 0 64px;border-top:1px solid var(--line);scroll-margin-top:24px}.study-section-heading h2{line-height:1.2;letter-spacing:normal;margin:14px 0 18px}
.study-baseline{margin:28px 0 0;color:var(--muted)}
.study-mark-row{border-bottom:1px solid var(--line);padding:32px 0}.study-row-heading{display:flex;align-items:baseline;gap:20px}.study-row-heading h3{margin:0;line-height:1.2}
.study-specimen{width:100%;max-width:672px;margin:28px auto;color:var(--blue);cursor:default}.study-specimen>svg{display:block;width:100%;height:auto;overflow:visible}
.study-mark-foot{display:flex;justify-content:space-between;gap:32px;align-items:center}.study-mark-foot>p{max-width:540px;margin:0;color:var(--muted);line-height:1.65}.study-sizes{display:flex;align-items:end;gap:28px;flex-shrink:0;color:var(--blue)}.study-sizes span{display:grid;justify-items:center;gap:8px;min-width:32px}.study-sizes small{color:var(--muted)}.study-mark-large svg{height:54px;width:30px}.study-mark-small svg{height:24px;width:13.333px}
.study-copy-row{padding:40px 0;border-bottom:1px solid var(--line)}.study-copy-row h3{line-height:1.2;letter-spacing:normal;margin:14px 0}.study-copy-row>p{max-width:660px;color:var(--muted);line-height:1.65}.study-copy-row details{margin-top:12px;color:var(--muted)}.study-technical{line-height:1.8;overflow-wrap:anywhere}
.study-case-row{padding:24px 0;border-bottom:1px solid var(--line)}.study-case-row h3{line-height:1.3;letter-spacing:normal;overflow-wrap:anywhere;margin:12px 0}.study-case-row .study-technical,.study-case-result{color:var(--muted);line-height:1.8}.study-case-result{margin-top:24px;overflow-wrap:anywhere}
.study-note{max-width:720px;padding:28px 0 0}.study-note p{color:var(--muted);line-height:1.7}.study-note code{overflow-wrap:anywhere}
@media(max-width:600px){.study-shell{padding:20px 20px 64px}.study-nav{flex-direction:column;gap:6px}.study-intro{padding:56px 0}.study-mark-foot{gap:24px;align-items:start;flex-direction:column}.study-specimen{margin:28px auto}.study-sizes{align-self:flex-end}}
`;
