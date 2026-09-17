import { INK_HOOK_QUESTION_MARK, type QuestionMarkStudy } from "./sloganQuestionMark.js";

/**
 * V2 punctuation study. Ink hook is selected; the alternatives remain proposals.
 * These are authored outlines, not renderer output or a font glyph. Each uses
 * the same 30 × 54 frame so comparisons do not quietly resize a candidate.
 */
export const QUESTION_MARK_V2_CANDIDATES: readonly QuestionMarkStudy[] = Object.freeze([
  INK_HOOK_QUESTION_MARK,
  Object.freeze({
    id: "ribbon-fold",
    label: "Ribbon turn",
    rationale: "A cut-edged ribbon bends into a hairline tail. Its asymmetric shoulder and diamond-like dot pick up v2's sharp turns; the most calligraphic option.",
    svgMarkup: '<g fill="currentColor" aria-hidden="true"><path d="M3.6 13.5L8.6 4.1C12.8 1.9 19.4 1.8 23.6 5.1L26.7 11.7C26.1 17.2 20.5 21 16.1 25L13.1 35L11.6 34.6L11.5 26.5C14.1 22.5 18.6 18.5 20.5 14.6C22.1 11.2 20.9 6.5 17.9 5.2C13.9 4.3 10.6 9.4 8.9 16.3L3.6 13.5Z"/><path d="M11.3 40.7L15.2 42.5L13.2 46L9.5 43.9L11.3 40.7Z"/></g>',
  }),
  Object.freeze({
    id: "quiet-solid",
    label: "Quiet solid",
    rationale: "A compact, steady-weight hook and circular dot give the clearest small-size reading. It is a calm punctuation anchor beside the changing signature.",
    svgMarkup: '<g fill="currentColor" aria-hidden="true"><path d="M3.8 13.7C4.1 6.4 9.1 2.7 15.7 2.7C22.6 2.7 26.4 6.7 26.4 12.6C26.4 17.1 23.6 20.3 20.1 22.9C16.8 25.3 15.3 27.3 15.3 31.4L15.3 35L11 35L11 30.9C11 25.5 13.4 22.8 16.8 20.1C20 17.7 21.6 15.5 21.6 12.6C21.6 9 19.4 6.7 15.6 6.7C11.4 6.7 8.8 9.4 8.4 13.7L3.8 13.7Z"/><circle cx="13.15" cy="43.3" r="2.5"/></g>',
  }),
]);
