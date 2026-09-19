import { SITE_FONT_PRELOAD } from "../v1/fonts.js";
import { SLOGAN_MBTI_HERO_CSS, SLOGAN_MBTI_HERO_SCRIPT_URL } from "./sloganMbtiHero.js";
import { SLOGAN_WORDING_CANDIDATES } from "./sloganWordingFrames.js";

export const SLOGAN_WORDING_PATH = "/dev/slogan-wording";
export const SLOGAN_WORDING_CSS_PATH = `${SLOGAN_WORDING_PATH}.css`;
export const SLOGAN_WORDING_CSS = `${SLOGAN_MBTI_HERO_CSS}
.wording-study{margin:0;padding:28px 24px 60px;background:var(--paper);color:var(--ink)}
.wording-study main{max-width:1024px;min-height:0;margin:auto}
.wording-study nav{margin-bottom:28px}.wording-study a{color:inherit}
.wording-study h1{font-size:24px;margin:0 0 10px}.wording-study p{color:var(--muted);line-height:1.5}
.wording-study figure{margin:0;padding:24px 0;border-top:1px solid var(--line)}
.wording-study figcaption{display:flex;gap:20px;align-items:baseline;font-size:16px}
.wording-study figcaption span{color:var(--muted)}
.wording-study svg{display:block;width:100%;max-width:56rem;height:auto;margin:16px auto 0}
.wording-study .slogan-loop{margin-top:28px}
.wording-study .slogan-loop:hover .slogan-mbti-frame{animation-play-state:paused}
`;

export function sloganWordingStudyPage(cssUrl: string): string {
  // A shared canvas preserves the same geometric scale across all three inputs.
  const canvas = Math.max(...SLOGAN_WORDING_CANDIDATES.map(candidate => candidate.layout.canonical_width));
  const rows = SLOGAN_WORDING_CANDIDATES.map((candidate, index) => {
    // Independently rendered words retain their aspect ratio and share baseline
    // 220. Fit the four-word composition into the same comparison-row width.
    const wordScale = (canvas - 100) / (4 * 350 + 3 * 40);
    const frames = candidate.frames.map((frame, i) => {
      const paths = candidate.words.length
        ? candidate.words.map((word, w) => `<g data-word="${word.source.displayText}" transform="translate(${50 + w * 390 * wordScale} ${220 * (1 - wordScale)}) scale(${wordScale}) translate(-35 0)"><path d="${word.frames[i]!.d}" fill="currentColor"/></g>`).join("")
        : `<path d="${frame.d}" fill="currentColor"/>`;
      return `<g class="slogan-mbti-frame slogan-mbti-frame-${i}" data-slogan-frame="${frame.mbti}">${paths}</g>`;
    }).join("");
    const shift = candidate.words.length ? 0 : (canvas - candidate.layout.canonical_width) / 2;
    return `<figure data-wording="${index + 1}"><figcaption><span>0${index + 1}</span><strong>${candidate.source.displayText}</strong></figcaption><svg viewBox="35 145 ${canvas - 70} 150" role="img" aria-label="${candidate.source.displayText}"><g transform="translate(${shift} 0)">${frames}</g></svg></figure>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Slogan comparison · Signatures Gallery</title>${SITE_FONT_PRELOAD}<link rel="stylesheet" href="${cssUrl}"><link rel="stylesheet" href="${SLOGAN_WORDING_CSS_PATH}"><script defer src="${SLOGAN_MBTI_HERO_SCRIPT_URL}"></script></head><body class="wording-study"><main><nav><a href="/">← Home</a></nav><h1>The First Agent Artwork</h1><p>Three treatments, synchronized across eight MBTI shapes. The third renders each word separately, fitted to the row. No punctuation.<br>1000ms fade + 1000ms hold. Hover over the comparison to hold all three.</p><section class="slogan-loop" tabindex="0" aria-label="Three slogan candidates">${rows}</section></main></body></html>`;
}
