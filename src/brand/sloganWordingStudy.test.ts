import { describe, it, expect } from "vitest";
import { sloganWordingStudyPage } from "./sloganWordingStudy.js";
import { SLOGAN_WORDING_CANDIDATES } from "./sloganWordingFrames.js";

describe("slogan wording comparison", () => {
  it("compares all three exact inputs with eight distinct paired shapes each", () => {
    expect(SLOGAN_WORDING_CANDIDATES.map(c => c.source.displayText)).toEqual([
      "TheFirstAgentArtwork", "The_First_Agent_Artwork", "The First Agent Artwork",
    ]);
    for (const candidate of SLOGAN_WORDING_CANDIDATES) {
      expect(candidate.frames).toHaveLength(8);
      expect(new Set(candidate.frames.map(f => f.sha256)).size).toBe(8);
    }
  });
  it("uses one synchronized loop, three artworks, and no question mark", () => {
    const html = sloganWordingStudyPage("/site.css");
    expect(html.match(/class="slogan-loop"/g)).toHaveLength(1);
    expect(html.match(/<svg /g)).toHaveLength(3);
    expect(html.match(/data-slogan-frame=/g)).toHaveLength(24);
    expect(html.match(/data-word=/g)).toHaveLength(32);
    expect(SLOGAN_WORDING_CANDIDATES[2].words.map(w => w.source.displayText)).toEqual(["The", "First", "Agent", "Artwork"]);
    expect(SLOGAN_WORDING_CANDIDATES[0].words).toHaveLength(0);
    expect(SLOGAN_WORDING_CANDIDATES[1].words).toHaveLength(0);
    expect(html).not.toContain("data-punctuation");
    expect(html).toContain('name="robots" content="noindex,nofollow"');
  });
});
