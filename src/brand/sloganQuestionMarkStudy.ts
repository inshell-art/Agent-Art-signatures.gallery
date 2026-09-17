import { SITE_FONT_PRELOAD } from "../v1/fonts.js";
import { FAVICON_LINK } from "./favicon.js";
import { OPEN_FLOW_QUESTION_MARK } from "./sloganQuestionMark.js";
import { QUESTION_MARK_V2_CANDIDATES } from "./sloganQuestionMarkCandidates.js";
import { SLOGAN_MBTI_FRAMES, SLOGAN_MBTI_SOURCE } from "./sloganMbtiFrames.js";
import { SLOGAN_MBTI_HERO_LAYOUT } from "./sloganMbtiHero.js";

export const QUESTION_MARK_STUDY_PATH = "/dev/question-mark-study";
export const QUESTION_MARK_STUDY_CSS_PATH = `${QUESTION_MARK_STUDY_PATH}.css`;
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const studyLink = (mark: string, shape: string) => `${QUESTION_MARK_STUDY_PATH}?mark=${encodeURIComponent(mark)}&amp;shape=${encodeURIComponent(shape)}#context`;

export const QUESTION_MARK_STUDY_CSS = `
.question-study{max-width:1184px;margin:auto;padding:28px 32px 56px}
.question-study main{min-height:0}.question-study nav{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:44px;font-size:14px;color:var(--muted)}
.question-study nav a{text-decoration:none}.question-study nav a:hover{text-decoration:underline}
.question-study h1{font-size:clamp(28px,4vw,46px);font-weight:500;line-height:1.1;letter-spacing:-.035em}
.question-study h2,.question-study h3{margin:0;font-size:17px;font-weight:500;line-height:1.4}
.qm-intro{max-width:680px;margin:18px 0 32px;line-height:1.65;color:var(--muted)}
.qm-options{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.qm-option{display:flex;flex-direction:column;text-decoration:none;border:1px solid var(--line);padding:24px;min-width:0;position:relative}
.qm-option[aria-current="true"]{border-color:var(--ink)}.qm-option:hover{background:var(--white)}
.qm-option:focus-visible,.qm-types a:focus-visible,.question-study nav a:focus-visible{outline:2px solid var(--blue);outline-offset:4px}
.qm-option-top{display:flex;justify-content:space-between;align-items:center;gap:8px;color:var(--muted);font-size:12px}
.qm-tag{background:var(--paper-2);border-radius:4px;padding:1px 3px;color:var(--ink)}
.qm-glyphs{display:flex;align-items:baseline;justify-content:center;gap:36px;padding:22px 0 18px}
.qm-glyph-large{width:60px;height:108px}.qm-glyph-small{width:18px;height:32.4px}
.qm-option p{margin:10px 0 18px;color:var(--muted);font-size:14px;line-height:1.55;flex:1}
.qm-preview-label{font-size:13px;text-decoration:underline;text-underline-offset:4px}
.qm-context{margin-top:44px;scroll-margin-top:24px}.qm-context-heading{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap}
.qm-context-heading p{margin:0;font-size:13px;color:var(--muted)}
.qm-types{display:flex;flex-wrap:wrap;gap:10px 12px;margin:20px 0 24px}.qm-types a{font-size:13px;text-decoration:none;padding:5px 7px;border:1px solid var(--line);border-radius:2px}.qm-types a[aria-current="true"]{color:var(--paper);background:var(--ink);border-color:var(--ink)}
.qm-comparison{display:grid;grid-template-columns:1fr 1fr;gap:24px}.qm-comparison figure{margin:0;min-width:0;border-top:1px solid var(--line);padding-top:16px}
.qm-comparison figcaption{display:flex;justify-content:space-between;gap:12px;font-size:13px;color:var(--muted)}
.qm-comparison svg{width:100%;height:auto;display:block;margin-top:18px;overflow:hidden}
.qm-recommendation{margin-top:28px;padding-top:24px;border-top:1px solid var(--line);max-width:750px;line-height:1.65;font-size:14px;color:var(--muted)}
.qm-recommendation strong{font-weight:500;color:var(--ink)}.qm-footnote{margin:20px 0 0;font-size:12px;line-height:1.6;color:var(--muted)}
@media(max-width:700px){.question-study{padding:24px 20px 40px}.question-study nav{margin-bottom:32px}.qm-options{grid-template-columns:1fr}.qm-option{padding:20px}.qm-glyphs{justify-content:flex-start;padding:18px 0;gap:40px}.qm-comparison{grid-template-columns:1fr}.qm-comparison svg{margin:8px 0}.qm-context{margin-top:32px}}
`;

/** Read-only, local-fixture proposal page. Selecting an option never changes home. */
export function questionMarkStudyPage(stylesheetUrl: string, markId = "ink-hook", shape = "INFP"): string {
  const selected = QUESTION_MARK_V2_CANDIDATES.find(mark => mark.id === markId);
  const frame = SLOGAN_MBTI_FRAMES.find(item => item.mbti === shape);
  if (!selected || !frame) throw new Error("Unknown question-mark study option.");
  const glyph = (markup: string, className: string) => `<svg class="${className}" viewBox="0 0 30 54" aria-hidden="true" focusable="false">${markup}</svg>`;
  const context = (markup: string, id: string) => `<svg data-context="${id}" data-shape="${frame.mbti}" viewBox="${SLOGAN_MBTI_HERO_LAYOUT.viewBox}" width="${SLOGAN_MBTI_HERO_LAYOUT.width}" height="${SLOGAN_MBTI_HERO_LAYOUT.height}" role="img" aria-label="${escape(SLOGAN_MBTI_SOURCE.displayText)} — ${escape(id)} question mark"><path d="${frame.d}" fill="currentColor"/><g data-context-mark="${id}" transform="${SLOGAN_MBTI_HERO_LAYOUT.punctuationTransform}">${markup}</g></svg>`;
  const cards = QUESTION_MARK_V2_CANDIDATES.map((mark, index) => `<a class="qm-option" data-candidate="${mark.id}" aria-current="${mark.id === selected.id}" href="${studyLink(mark.id, frame.mbti)}"><div class="qm-option-top"><span>0${index + 1}</span>${index === 0 ? '<span class="qm-tag">On home</span>' : '<span>Proposal</span>'}</div><div class="qm-glyphs">${glyph(mark.svgMarkup, "qm-glyph-large")}${glyph(mark.svgMarkup, "qm-glyph-small")}</div><h2>${escape(mark.label)}</h2><p>${escape(mark.rationale)}</p><span class="qm-preview-label">${mark.id === selected.id ? "Shown below" : "Compare with previous"}</span></a>`).join("");
  const shapes = SLOGAN_MBTI_FRAMES.map(item => `<a href="${studyLink(selected.id, item.mbti)}" aria-current="${item.mbti === frame.mbti}" aria-label="Compare ${item.mbti} and ${item.pairedMbti} shape">${item.mbti} / ${item.pairedMbti}</a>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Question mark study · Signatures Gallery</title>${FAVICON_LINK}${SITE_FONT_PRELOAD}<link rel="stylesheet" href="${escape(stylesheetUrl)}"><link rel="stylesheet" href="${QUESTION_MARK_STUDY_CSS_PATH}"></head><body class="question-study"><main><nav><a href="/">← Back to home</a><span>V2 / Punctuation study</span></nav><header><h1>A stronger ending.</h1><p class="qm-intro">The new slogan moves between broad ink and fine edges. The earlier Open flow question mark stays thin. Ink hook is now selected for home. The alternatives remain here for comparison.</p></header><section class="qm-options" aria-label="Question mark proposals">${cards}</section><section class="qm-context" id="context" aria-labelledby="context-heading"><div class="qm-context-heading"><h2 id="context-heading">In context · ${escape(selected.label)}</h2><p>Same shape. Same scale. Only the question mark changes.</p></div><div class="qm-types" aria-label="Compare across all eight slogan shapes">${shapes}</div><div class="qm-comparison"><figure><figcaption><span>Previous · Open flow</span><span>${frame.mbti}</span></figcaption>${context(OPEN_FLOW_QUESTION_MARK.svgMarkup, "previous")}</figure><figure><figcaption><span>Preview · ${escape(selected.label)}</span><span>${frame.mbti}</span></figcaption>${context(selected.svgMarkup, selected.id)}</figure></div></section><p class="qm-recommendation"><strong>Selected: Ink hook.</strong> A weighted shoulder relates to the slogan’s broad strokes; the taper keeps the ending light. Ribbon turn is more expressive. Quiet solid is the most restrained and legible at small sizes.</p><p class="qm-footnote">Ink hook is now on home. This study only previews alternatives. These are authored vector marks, not renderer output. I/E pairs share geometry. Colors follow your site theme.</p></main></body></html>`;
}
