import { createHash } from "node:crypto";
import { SLOGAN_MBTI_FRAMES, SLOGAN_MBTI_SOURCE, SLOGAN_MBTI_LAYOUT } from "./sloganMbtiFrames.js";
import { INK_HOOK_QUESTION_MARK } from "./sloganQuestionMark.js";

/** Brand presentation only. No assessment, renderer, or network call at runtime. */
export const SLOGAN_MBTI_HERO_MANIFEST = Object.freeze({
  version: "sg-slogan-mbti-1.2.3",
  sourceRendererVersion: SLOGAN_MBTI_SOURCE.rendererVersion,
  displayText: SLOGAN_MBTI_SOURCE.displayText,
  frameCount: SLOGAN_MBTI_FRAMES.length,
  durationMs: 16_000,
  transitionMs: 1_000,
  initialOffsetMs: 1_000,
  punctuation: Object.freeze({ id: INK_HOOK_QUESTION_MARK.id, version: INK_HOOK_QUESTION_MARK.version }),
  runtimeBoundary: "checked-in-shape-lock",
  palette: "currentColor follows site theme; I/E twins share geometry",
  layout: SLOGAN_MBTI_LAYOUT,
  frames: Object.freeze(SLOGAN_MBTI_FRAMES.map(({ mbti, pairedMbti, sha256 }) => Object.freeze({ mbti, pairedMbti, sha256 }))),
});

// One coordinate frame for the whole loop: shapes never resize or jump between
// viewports. The separate, authored question mark remains a readable annotation.
// Keep the same crop padding and punctuation size; extend the horizontal frame
// by the upstream long-text canvas growth, never stretch the rendered curves.
export const SLOGAN_MBTI_HERO_LAYOUT = Object.freeze({
  viewBox: `35 145 ${SLOGAN_MBTI_LAYOUT.canonical_width - 40} 150`,
  width: (SLOGAN_MBTI_LAYOUT.canonical_width - 40) * 3,
  height: 450,
  punctuationTransform: `translate(${SLOGAN_MBTI_LAYOUT.canonical_width - 39} 195)`,
});
export const SLOGAN_MBTI_HERO_SVG = `<svg id="slogan-animation" viewBox="${SLOGAN_MBTI_HERO_LAYOUT.viewBox}" xmlns="http://www.w3.org/2000/svg" width="${SLOGAN_MBTI_HERO_LAYOUT.width}" height="${SLOGAN_MBTI_HERO_LAYOUT.height}" aria-hidden="true" focusable="false">${SLOGAN_MBTI_FRAMES.map(({ mbti, pairedMbti, d }, index) => `<g data-slogan-frame="${mbti}" data-mbti-pair="${mbti}/${pairedMbti}" class="slogan-mbti-frame slogan-mbti-frame-${index}"><path d="${d}" fill="currentColor"/></g>`).join("")}<g class="slogan-signature-punctuation" data-punctuation-id="${INK_HOOK_QUESTION_MARK.id}" transform="${SLOGAN_MBTI_HERO_LAYOUT.punctuationTransform}" aria-hidden="true">${INK_HOOK_QUESTION_MARK.svgMarkup}</g></svg>`;

// Begin at the first crossfade, skipping the initial hold without changing the loop cadence.
export const SLOGAN_MBTI_HERO_CSS = `
.slogan-loop{position:relative}
.slogan-mbti-frame{opacity:0}.slogan-mbti-frame:first-child{opacity:1}
.slogan-loop[data-slogan-ready="true"] .slogan-mbti-frame{animation:slogan-mbti-cycle ${SLOGAN_MBTI_HERO_MANIFEST.durationMs / 1_000}s linear infinite}
${SLOGAN_MBTI_FRAMES.map((_, index) => `.slogan-loop[data-slogan-ready="true"] .slogan-mbti-frame-${index}{animation-delay:-${((SLOGAN_MBTI_FRAMES.length - index) % SLOGAN_MBTI_FRAMES.length) * SLOGAN_MBTI_HERO_MANIFEST.durationMs / SLOGAN_MBTI_FRAMES.length / 1_000 + SLOGAN_MBTI_HERO_MANIFEST.initialOffsetMs / 1_000}s}`).join("\n")}
@keyframes slogan-mbti-cycle{0%,6.25%{opacity:1}12.5%,93.75%{opacity:0}100%{opacity:1}}
.slogan-loop[data-slogan-suspended="true"] .slogan-mbti-frame,.slogan-loop:hover .slogan-mbti-frame,.slogan-loop:focus-within .slogan-mbti-frame{animation-play-state:paused}
@media(prefers-reduced-motion:reduce){.slogan-loop[data-slogan-ready="true"] .slogan-mbti-frame{animation:none;opacity:0}.slogan-loop[data-slogan-ready="true"] .slogan-mbti-frame:first-child{opacity:1}}
`;

/** Enable motion with visibility suspension; no-JS stays on frame one. */
export const SLOGAN_MBTI_HERO_SCRIPT = `(() => {
  const loop = document.querySelector(".slogan-loop");
  if (!loop || loop.dataset.sloganReady === "true") return;
  let offscreen = false;
  const updateVisibility = () => {
    loop.dataset.sloganSuspended = String(document.hidden || offscreen);
  };
  document.addEventListener("visibilitychange", updateVisibility);
  if (typeof IntersectionObserver !== "undefined") {
    const observer = new IntersectionObserver((entries) => {
      offscreen = !entries[0].isIntersecting;
      updateVisibility();
    });
    observer.observe(loop);
  }
  updateVisibility();
  loop.dataset.sloganReady = "true";
})();`;

export const SLOGAN_MBTI_HERO_SCRIPT_URL = `/assets/slogan-motion-${createHash("sha256").update(SLOGAN_MBTI_HERO_SCRIPT).digest("hex").slice(0, 16)}.js`;
