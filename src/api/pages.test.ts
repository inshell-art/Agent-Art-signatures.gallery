import { describe, expect, it } from "vitest";
import type { Instance } from "../store/types.js";
import { renderClusterPage, renderVerifyPage } from "./pages.js";

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: "1",
    xUserId: null,
    seedHandle: "alice",
    readingCode: "hfwo" as any,
    readingJson: { tempo: "hurried", weight: "firm", steadiness: "wavering", reach: "open" },
    rationale: null,
    sourcePostId: "123",
    offsetVector: { tempo: 1, weight: 1, steadiness: 0, reach: 1 },
    specVersion: "test-v0",
    mapVersion: "test-map-v0",
    schemaVersion: "reading.v1",
    provenance: "unverified",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    sequence: 1,
    supersedes: null,
    ...overrides,
  };
}

describe("renderClusterPage", () => {
  it("shows a placeholder when there are no instances", () => {
    const html = renderClusterPage("alice", "/i/canonical/alice.png", []);
    expect(html).toContain("No instances yet.");
    expect(html).toContain("@alice");
    expect(html).toContain("/i/canonical/alice.png");
  });

  it("lists each instance with its code, provenance, and a verify link", () => {
    const html = renderClusterPage("alice", "/i/canonical/alice.png", [
      makeInstance({ id: "1", sequence: 1, readingCode: "hfwo" as any, provenance: "verified" }),
      makeInstance({ id: "2", sequence: 2, readingCode: "smuc" as any, provenance: "unverified" }),
    ]);
    expect(html).toContain("/i/instance/1.png");
    expect(html).toContain("/i/instance/2.png");
    expect(html).toContain("hfwo");
    expect(html).toContain("smuc");
    expect(html).toContain('class="provenance-verified"');
    expect(html).toContain('class="provenance-unverified"');
    expect(html).toContain('href="/v/1"');
    expect(html).toContain('href="/v/2"');
  });

  it("omits the rationale line entirely when rationale is null (§8: never synthesize one)", () => {
    const html = renderClusterPage("alice", "/i/canonical/alice.png", [makeInstance({ rationale: null })]);
    // No stray empty <div></div> left behind where the rationale would go.
    expect(html).not.toMatch(/<div><\/div>/);
  });

  it("escapes a handle containing HTML-significant characters", () => {
    const html = renderClusterPage('<img src=x onerror=alert(1)>', "/i/canonical/x.png", []);
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes untrusted rationale text (§8: agent output is untrusted, never parsed for control flow)", () => {
    const html = renderClusterPage("alice", "/i/canonical/alice.png", [
      makeInstance({ rationale: '<script>alert("xss")</script>' }),
    ]);
    expect(html).not.toContain("<script>alert(");
    expect(html).toContain("&lt;script&gt;");
  });

  it("URL-encodes instance ids used in hrefs/srcs", () => {
    const html = renderClusterPage("alice", "/i/canonical/alice.png", [makeInstance({ id: "a b/c" })]);
    expect(html).toContain(encodeURIComponent("a b/c"));
    expect(html).not.toContain('href="/v/a b/c"');
  });
});

describe("renderVerifyPage", () => {
  it("includes every field handoff §9.4 requires, plus the spec hash", () => {
    const instance = makeInstance({
      seedHandle: "alice",
      readingCode: "hfwo" as any,
      sourcePostId: "123",
      specVersion: "spec-v1",
      mapVersion: "map-v1",
      schemaVersion: "schema-v1",
    });
    const html = renderVerifyPage(instance, "abc123hash");
    for (const needle of [
      "alice",
      "hfwo",
      "123",
      "spec-v1",
      "map-v1",
      "schema-v1",
      "abc123hash",
      "spec_hash",
      "offset_vector",
      "reading",
    ]) {
      expect(html).toContain(needle);
    }
  });

  it("escapes the seed handle in the title/heading", () => {
    const instance = makeInstance({ seedHandle: '"><script>alert(1)</script>' });
    const html = renderVerifyPage(instance, "hash");
    expect(html).not.toContain('"><script>alert(1)</script>');
  });

  it("links back to the instance's cluster", () => {
    const instance = makeInstance({ seedHandle: "alice" });
    const html = renderVerifyPage(instance, "hash");
    expect(html).toContain('href="/c/alice"');
  });
});
