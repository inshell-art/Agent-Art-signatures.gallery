import { describe, expect, it } from "vitest";
import { openMintSupportUrl } from "./supportUrl.js";

describe("optional support destination", () => {
  it("has no destination by default", () => {
    expect(openMintSupportUrl(undefined)).toBeUndefined();
    expect(openMintSupportUrl("")).toBeUndefined();
  });
  it("accepts static HTTPS configuration without adding request data", () => {
    expect(openMintSupportUrl("https://HELP.example.test/request?source=mint#contact"))
      .toBe("https://help.example.test/request?source=mint#contact");
  });
  it.each([null, 1, " ", "not-a-url", "/support", "//help.example.test", "javascript:alert(1)",
    "http://help.example.test", "mailto:operator@example.test", "https://user:secret@example.test/help",
    "https://user@example.test", "https://:secret@example.test", "https://example.test/\\private",
    "https://example.test/\nprivate", `https://example.test/${"x".repeat(2048)}`])("rejects unsafe or malformed configuration: %s", value => {
    expect(() => openMintSupportUrl(value)).toThrow("OPEN_MINT_SUPPORT_URL must be an HTTPS URL without credentials.");
  });
});
