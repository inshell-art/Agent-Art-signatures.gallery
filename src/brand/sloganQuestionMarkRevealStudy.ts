import { SITE_FONT_PRELOAD } from "../v1/fonts.js";
import { FAVICON_LINK } from "./favicon.js";
import { INK_HOOK_QUESTION_MARK, REBALANCED_INK_HOOK_QUESTION_MARK, type QuestionMarkStudy } from "./sloganQuestionMark.js";
import { SLOGAN_MBTI_FRAMES, SLOGAN_MBTI_SOURCE } from "./sloganMbtiFrames.js";
import { SLOGAN_MBTI_HERO_LAYOUT } from "./sloganMbtiHero.js";

export const QUESTION_MARK_REVEAL_PATH = "/dev/question-mark-reveal";
export const QUESTION_MARK_REVEAL_CSS_PATH = `${QUESTION_MARK_REVEAL_PATH}.css`;

/** Historical punctuation selections and alternatives; the current title has no punctuation. */
export const REVEAL_QUESTION_MARK_OPTIONS: readonly QuestionMarkStudy[] = Object.freeze([
  INK_HOOK_QUESTION_MARK,
  REBALANCED_INK_HOOK_QUESTION_MARK,
  Object.freeze({
    id: "chisel-hook",
    label: "Chisel hook",
    rationale: "A cut shoulder, diagonal turn and wedge-shaped dot. Echoes the new capital letters’ sharper, broad-nib strokes.",
    svgMarkup: '<g fill="currentColor" aria-hidden="true"><path d="M2 14L8.5 3L17.4 0.8L24.6 3.9L28 11.4L25.9 18.4L17.8 28.1L14.8 38.8L11.8 38.4L12.8 28.4C13.1 24.8 17.3 21.5 19.7 17.3C21.1 14.8 21.6 11.3 19.4 8.7L16.6 7.1C12.8 7.8 10.5 12.2 8.9 18L2 14Z"/><path d="M11.3 44.8L17 47.1L13.2 52L8.9 48.5L11.3 44.8Z"/></g>',
  }),
  Object.freeze({
    id: "quiet-anchor",
    label: "Quiet anchor",
    rationale: "A compact, steady-weight hook and round dot. A calm, legible ending beside the expressive signature.",
    svgMarkup: '<g fill="currentColor" aria-hidden="true"><path d="M4 15C4 7.8 8.4 3.8 15 3.8C21.8 3.8 25.5 8 25.5 13.8C25.5 18.2 23 21.5 19.5 24.2C16.4 26.6 15 28.7 15 33.1L15 37L10.8 37L10.8 32.9C10.8 27.4 12.9 24.4 16.7 21.5C19.7 19.2 21.2 16.8 21.2 13.8C21.2 10.1 19.1 7.8 15 7.8C10.8 7.8 8.3 10.7 8.3 15L4 15Z"/><circle cx="12.9" cy="45.9" r="3.1"/></g>',
  }),
]);

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const QUESTION_MARK_REVEAL_CSS = `
.qm-reveal{margin:0;padding:28px 32px 64px;background:var(--paper);color:var(--ink)}
.qm-reveal main{width:100%;max-width:1024px;min-height:0;margin-inline:auto}
.qm-reveal nav{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:32px;color:var(--muted)}
.qm-reveal nav a,.qm-reveal-types a{color:inherit;text-decoration:none}
.qm-reveal nav a:hover{text-decoration:underline}
.qm-reveal h1{max-width:none;margin:0;font-size:28px;line-height:1.25;letter-spacing:-.025em}
.qm-reveal .qm-reveal-intro{margin:12px 0 6px;line-height:1.6;color:var(--muted)}
.qm-reveal-literal{margin:0;overflow-wrap:anywhere;line-height:1.6}
.qm-reveal-types{display:flex;flex-wrap:wrap;gap:6px 10px;margin:22px 0 28px}
.qm-reveal-types a{display:inline-flex;align-items:center;min-height:44px;padding:0 10px;border:1px solid var(--line);border-radius:2px}
.qm-reveal-types a[aria-current="true"]{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.qm-reveal-types a:hover{border-color:var(--ink)}
.qm-reveal a:focus-visible{outline:2px solid var(--blue);outline-offset:4px}
.qm-reveal-comparisons{scroll-margin-top:24px}
.qm-reveal-option{margin:0;padding:22px 0 18px;border-top:1px solid var(--line)}
.qm-reveal-option figcaption{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px 14px}
.qm-reveal-option h2{margin:0;font-size:16px;line-height:1.5}
.qm-reveal-number{color:var(--muted);font-variant-numeric:tabular-nums}
.qm-reveal-tag{color:var(--muted);margin-inline-start:auto}
.qm-reveal-option p{margin:6px 0 10px;color:var(--muted);line-height:1.6;max-width:780px}
.qm-reveal-option svg{display:block;width:100%;max-width:56rem;height:auto;margin:0 auto;overflow:hidden}
.qm-reveal-note{margin:22px 0 0;color:var(--muted);line-height:1.6}
@media(max-width:600px){.qm-reveal{padding:24px 20px 40px}.qm-reveal nav{margin-bottom:24px}.qm-reveal h1{font-size:24px}.qm-reveal-types{gap:6px}.qm-reveal-types a{padding:0 8px}.qm-reveal-option{padding:18px 0}.qm-reveal-option p{margin-bottom:18px}.qm-reveal-option svg{margin-bottom:8px}}
`;

/** Read-only comparison. All four rows share the exact locked slogan and scale. */
export function questionMarkRevealStudyPage(stylesheetUrl: string, shape = "INFP"): string {
  const frame = SLOGAN_MBTI_FRAMES.find(item => item.mbti === shape);
  if (!frame) throw new Error("Unknown question-mark study option.");
  const shapes = SLOGAN_MBTI_FRAMES.map(item => `<a href="${QUESTION_MARK_REVEAL_PATH}?shape=${item.mbti}#comparisons" aria-current="${item.mbti === frame.mbti}" aria-label="Compare ${item.mbti} and ${item.pairedMbti} shape">${item.mbti} / ${item.pairedMbti}</a>`).join("");
  const rows = REVEAL_QUESTION_MARK_OPTIONS.map((mark, index) => `<figure class="qm-reveal-option" data-candidate="${mark.id}"><figcaption><span class="qm-reveal-number">0${index}</span><h2>${index === 0 ? "Previous ink hook" : escape(mark.label)}</h2><span class="qm-reveal-tag">${mark.id === REBALANCED_INK_HOOK_QUESTION_MARK.id ? "Historical selection" : index === 0 ? "Previous" : "Alternative"}</span></figcaption><p>${index === 0 ? "The previous mark, kept at the same scale as a reference." : escape(mark.rationale)}</p><svg data-context="${mark.id}" data-shape="${frame.mbti}" viewBox="${SLOGAN_MBTI_HERO_LAYOUT.viewBox}" width="${SLOGAN_MBTI_HERO_LAYOUT.width}" height="${SLOGAN_MBTI_HERO_LAYOUT.height}" role="img" aria-label="${escape(SLOGAN_MBTI_SOURCE.displayText)} — ${escape(mark.label)}"><path d="${frame.d}" fill="currentColor"/><g data-context-mark="${mark.id}" transform="${SLOGAN_MBTI_HERO_LAYOUT.punctuationTransform}">${mark.svgMarkup}</g></svg></figure>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Question mark comparisons · Signatures Gallery</title>${FAVICON_LINK}${SITE_FONT_PRELOAD}<link rel="stylesheet" href="${escape(stylesheetUrl)}"><link rel="stylesheet" href="${QUESTION_MARK_REVEAL_CSS_PATH}"></head><body class="qm-reveal"><main><nav><a href="/">← Back to home</a><span>Earlier punctuation study</span></nav><header><h1>Three endings. One slogan.</h1><p class="qm-reveal-intro">Compare the historical Rebalanced ink hook selection with the previous mark and alternatives. Choose a shape; every row uses the same artwork at the same scale.</p><p class="qm-reveal-literal">${escape(SLOGAN_MBTI_SOURCE.displayText)}</p></header><div class="qm-reveal-types" aria-label="Compare all eight slogan shapes">${shapes}</div><section class="qm-reveal-comparisons" id="comparisons" aria-label="Question marks with the slogan">${rows}</section><p class="qm-reveal-note">The homepage title is ${escape(SLOGAN_MBTI_SOURCE.displayText)}, with no punctuation. These historical marks are authored punctuation, not changes to the renderer. Colors follow your site theme.</p></main></body></html>`;
}
