/** The formal algorithm uses an unscaled integer seed, not a decimal ratio. */
export const GR0K_SCALE = 1 as const;
export const GR0K_MIN = 1 as const;
export const GR0K_MAX = 100 as const;
export const GR0K_DEFAULT = 22 as const;

export type InputErrorCode = "INVALID_HANDLE" | "INVALID_GR0K";

export class InputError extends Error {
  constructor(
    readonly code: InputErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InputError";
  }
}

function decodeOnce(segment: string, code: InputErrorCode, label: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new InputError(code, `${label} contains malformed percent encoding.`);
  }
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}

export interface NormalizedHandle {
  normalized: string;
  renderHandle: string;
  canonicalSegment: string;
  isCanonical: boolean;
}

/** Preserve spelling for the artwork; X-account comparison is separate. */
export function validateRenderHandle(value: string): string {
  const withoutPrefix = value.startsWith("@") ? value.slice(1) : value;
  if (!/^[A-Za-z0-9_]{1,15}$(?![\s\S])/.test(withoutPrefix)) {
    throw new InputError("INVALID_HANDLE", "Use an X handle with 1–15 letters, numbers, or underscores.");
  }
  return withoutPrefix;
}

export function normalizeHandleValue(value: string): string {
  return asciiLowercase(validateRenderHandle(value));
}

export function normalizeHandleSegment(segment: string): NormalizedHandle {
  const decoded = decodeOnce(segment, "INVALID_HANDLE", "Handle");
  const renderHandle = validateRenderHandle(decoded);
  const normalized = asciiLowercase(renderHandle);
  return {
    normalized,
    renderHandle,
    canonicalSegment: renderHandle,
    isCanonical: segment === renderHandle,
  };
}

export interface ParsedGr0k {
  raw: number;
  canonical: string;
  isCanonical: boolean;
}

export function formatGr0k(raw: number): string {
  if (!Number.isInteger(raw) || raw < GR0K_MIN || raw > GR0K_MAX) {
    throw new InputError("INVALID_GR0K", "gr0k must be an integer from 1 through 100.");
  }
  return String(raw);
}

export function parseGr0kValue(value: string): { raw: number; canonical: string } {
  if (!/^(?:[1-9]|[1-9][0-9]|100)$(?![\s\S])/.test(value)) {
    throw new InputError(
      "INVALID_GR0K",
      "Use an integer gr0k seed from 1 through 100, without leading zeros or decimals.",
    );
  }

  const raw = Number(value);
  const canonical = formatGr0k(raw);
  return { raw, canonical };
}

export function parseGr0kSegment(segment: string): ParsedGr0k {
  const decoded = decodeOnce(segment, "INVALID_GR0K", "gr0k");
  const { raw, canonical } = parseGr0kValue(decoded);
  return { raw, canonical, isCanonical: segment === canonical };
}
