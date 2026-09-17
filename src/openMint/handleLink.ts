import { preservedHandle } from "./identity.js";

/** Product navigation: a displayed artwork handle always opens its 16 variations.
 * Keep the rendering spelling, not the lowercase token identity, in preview URLs.
 */
export function handleVariationsPath(handle: string): string {
  return `/p/${preservedHandle(handle)}/variations`;
}

/** Validation restricts both URL and text to safe ASCII handle characters. */
export function handleLink(handle: string): string {
  const spelling = preservedHandle(handle);
  return `<a class="gallery-handle" href="${handleVariationsPath(spelling)}">@${spelling}</a>`;
}
