export interface QuestionMarkStudy {
  readonly id: string;
  readonly label: string;
  readonly rationale: string;
  /** Font-free SVG group content in a 30 × 54 local coordinate frame. */
  readonly svgMarkup: string;
}

/**
 * Authored punctuation studies, not output from the signature renderer.
 * Each retains a readable hook and detached dot while echoing the slogan's
 * tapering ink. Open flow was selected for the homepage; its versioned outline
 * is shared with the study so both use exactly the same approved geometry.
 */
export const OPEN_FLOW_QUESTION_MARK = Object.freeze({
    id: "open-flow",
    version: "sg-question-mark-open-flow-1",
    label: "Open flow",
    rationale: "A rounded, open hook with a gently leaning stem. The thin-to-thick outline borrows the curve's ink weight while a round dot keeps the question unmistakable.",
    svgMarkup: '<g fill="currentColor" aria-hidden="true"><path d="M3.9 12.8C5 5.9 11.5 1.8 17.8 3.2C25.9 4.7 27.9 12.8 23.3 19C20.9 22.2 16.5 23.8 14.8 27.2C13.8 29.2 13.5 31.3 13.3 34L11.6 34C11.4 30.7 11.8 27.7 13.3 25.2C15.2 22 19.7 19.6 21.5 16.5C24.3 11.8 22.5 6.1 17.4 5C12.2 3.8 7.1 7 5.3 13.4Q4.9 14.8 4 14.1Q3.6 13.6 3.9 12.8Z"/><circle cx="12.5" cy="43" r="1.9"/></g>',
  });

export const QUESTION_MARK_STUDIES: readonly QuestionMarkStudy[] = Object.freeze([
  OPEN_FLOW_QUESTION_MARK,
  Object.freeze({
    id: "ribbon-turn",
    label: "Ribbon turn",
    rationale: "A slanted ribbon that turns into a small lifted terminal. Its irregular ink-drop dot and asymmetric shoulder echo handwriting without disguising the question mark.",
    svgMarkup: '<g fill="currentColor" aria-hidden="true"><path d="M4.6 12.9C5.5 7.5 10.4 3 16.2 2.8C22.8 2.6 27.3 7.1 25.3 13.3C24.1 17 20 19.2 16.4 21.8C12.8 24.4 10.4 27.8 11.2 31.9C11.5 33.6 12.3 34.6 13.7 35.3C11.6 35.2 9.7 33.5 9.4 31.5C8.5 26.5 11.6 22.9 15.4 19.9C18.6 17.4 21.8 15.6 22.7 12.5C24 8.2 21.4 4.4 16.7 4.4C11.7 4.3 7.8 8.4 6.1 13.4C5.7 14.5 4.4 14.4 4.6 12.9Z"/><path d="M10.5 41.2C11.8 40.6 13.3 41.7 13.2 43.2C13.2 44.6 11.8 45.3 10.6 44.7C9.4 44.1 9.2 42 10.5 41.2Z"/></g>',
  }),
]);
