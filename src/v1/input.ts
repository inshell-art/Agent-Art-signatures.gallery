export const GR0K_SCALE = 1_000_000 as const;

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
  canonicalSegment: string;
  isCanonical: boolean;
}

export function normalizeHandleValue(value: string): string {
  const withoutPrefix = value.startsWith("@") ? value.slice(1) : value;
  if (!/^[A-Za-z0-9_]{1,15}$/.test(withoutPrefix)) {
    throw new InputError("INVALID_HANDLE", "Use an X handle with 1–15 letters, numbers, or underscores.");
  }
  return asciiLowercase(withoutPrefix);
}

export function normalizeHandleSegment(segment: string): NormalizedHandle {
  const decoded = decodeOnce(segment, "INVALID_HANDLE", "Handle");
  const normalized = normalizeHandleValue(decoded);
  return {
    normalized,
    canonicalSegment: normalized,
    isCanonical: segment === normalized,
  };
}

export interface ParsedGr0k {
  raw: number;
  canonical: string;
  isCanonical: boolean;
}

export function formatGr0k(raw: number): string {
  if (!Number.isInteger(raw) || raw < 0 || raw > GR0K_SCALE) {
    throw new InputError("INVALID_GR0K", "gr0k must be between 0.000000 and 1.000000.");
  }
  if (raw === GR0K_SCALE) return "1.000000";
  return `0.${String(raw).padStart(6, "0")}`;
}

export function parseGr0kValue(value: string): { raw: number; canonical: string } {
  if (!/^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?)$/.test(value)) {
    throw new InputError(
      "INVALID_GR0K",
      "Use a decimal gr0k value from 0 through 1 with no more than six decimal places.",
    );
  }

  const [integerPart, fractionalPart = ""] = value.split(".");
  let raw = integerPart === "1" ? GR0K_SCALE : 0;
  if (integerPart === "0") {
    const padded = fractionalPart.padEnd(6, "0");
    for (let index = 0; index < padded.length; index += 1) {
      raw = raw * 10 + (padded.charCodeAt(index) - 48);
    }
  }

  const canonical = formatGr0k(raw);
  return { raw, canonical };
}

export function parseGr0kSegment(segment: string): ParsedGr0k {
  const decoded = decodeOnce(segment, "INVALID_GR0K", "gr0k");
  const { raw, canonical } = parseGr0kValue(decoded);
  return { raw, canonical, isCanonical: segment === canonical };
}
