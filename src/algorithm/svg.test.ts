import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "./settings.js";
import { pointsForSettings, renderSvgForText } from "./svg.js";

function withMode(mode: Settings["path"]["mode"]): Settings {
  return { ...DEFAULT_SETTINGS, path: { ...DEFAULT_SETTINGS.path, mode } };
}

describe("renderSvgForText", () => {
  it("renders a fill-based path for the default variable_bezier_outline mode", () => {
    const { svg, metadata } = renderSvgForText("grok", withMode("variable_bezier_outline"));
    expect(svg).toContain('fill="#11110f"');
    expect(svg).toContain('stroke="none"');
    expect(metadata.pathMode).toBe("variable_bezier_outline");
  });

  it("renders a fill-based path for variable_sampled_outline (untested path-mode branch)", () => {
    const { svg, metadata } = renderSvgForText("grok", withMode("variable_sampled_outline"));
    expect(svg).toContain('fill="#11110f"');
    expect(svg).toContain('stroke="none"');
    expect(metadata.pathMode).toBe("variable_sampled_outline");
  });

  it("renders a stroked, unfilled path for pure_cubic_bezier_stroke (untested path-mode branch)", () => {
    const { svg, metadata } = renderSvgForText("grok", withMode("pure_cubic_bezier_stroke"));
    expect(svg).toContain('fill="none"');
    expect(svg).toContain('stroke="#11110f"');
    expect(svg).toContain("stroke-linecap=\"round\"");
    expect(metadata.pathMode).toBe("pure_cubic_bezier_stroke");
  });

  it("all three path modes produce well-formed, non-empty SVG with the displayed handle", () => {
    for (const mode of ["variable_bezier_outline", "variable_sampled_outline", "pure_cubic_bezier_stroke"] as const) {
      const { svg } = renderSvgForText("grok", withMode(mode));
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg.endsWith("</svg>")).toBe(true);
      expect(svg).toContain(">@grok<");
    }
  });

  it("escapes a handle containing XML-significant characters in the displayed text", () => {
    // Not reachable through the HTTP layer's handle validation, but svg.ts
    // shouldn't emit broken/unsafe markup if ever called with one directly.
    const { svg } = renderSvgForText('<x>&"\'', DEFAULT_SETTINGS);
    expect(svg).toContain("&lt;x&gt;&amp;&quot;&#x27;");
    expect(svg).not.toContain("<x>&\"'");
  });

  it("reports metadata: character/anchor/curve counts", () => {
    const { metadata } = renderSvgForText("grok", DEFAULT_SETTINGS);
    expect(metadata.characterCount).toBe(4);
    expect(metadata.anchorCount).toBeGreaterThan(0);
    expect(metadata.curveCount).toBe(metadata.anchorCount - 1);
    expect(metadata.handle).toBe("grok");
    expect(metadata.displayedHandle).toBe("@grok");
  });
});

describe("pointsForSettings", () => {
  it("produces one point per character for a handle with no digits", () => {
    expect(pointsForSettings("grok", DEFAULT_SETTINGS)).toHaveLength(4);
  });
});
