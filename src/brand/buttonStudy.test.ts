import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { BUTTON_STUDIES, BUTTON_STUDY_CSS, BUTTON_STUDY_SCRIPT, buttonStudyPage } from "./buttonStudy.js";

describe("button design study", () => {
  it("compares four scoped options with soft-filled tags and the selected Hairline button", () => {
    const html = buttonStudyPage();
    expect(BUTTON_STUDIES).toHaveLength(4);
    expect(html.match(/class="bst-candidate"/g)).toHaveLength(4);
    expect(html).toContain('class="bst-baseline"');
    for (const option of BUTTON_STUDIES) {
      expect(html).toContain(`data-button-variant="${option.id}"`);
      expect(html).toContain(`data-context-style="${option.id}"`);
      expect(html).toContain(`<span>${option.name}</span></label>`);
    }
    expect(html.match(/>Selected</g)).toHaveLength(1);
    expect(BUTTON_STUDIES.filter(option => option.selected).map(option => option.id)).toEqual(["hairline"]);
    expect(html).toContain('id="button-context" data-button-variant="hairline"');
    expect(html).toContain('value="hairline" checked');
    expect(html).toContain("data-study-current>Hairline<");
    expect(html).toContain('href="/dev/button-study.css"');
    expect(html).toContain('src="/dev/button-study.js"');
  });

  it("shows one renderer artwork and an interactive context selector without real claim controls", () => {
    const html = buttonStudyPage();
    const study = html.match(/<article class="bst-page">([\s\S]*?)<\/article><\/main>/)![1];
    expect(study.match(/<img\b/g)).toHaveLength(1);
    expect(study).toContain('/signatures/0.500000.svg"');
    expect(study.match(/name="button-study-style"/g)).toHaveLength(4);
    expect(study.match(/aria-busy="true"/g)).toHaveLength(4);
    for (const button of study.match(/<button\b[^>]*>/g)!) expect(button).toContain('type="button"');
    expect(study).not.toMatch(/<form\b|action=|\/auth\/x|\/api\/v1\/signatures/);
    expect(study).not.toContain('<p>Signing in as');
    expect(study).toContain('data-action-tooltip="study-claim-tooltip" aria-describedby="study-claim-tooltip"');
    expect(study).toContain('id="study-claim-tooltip" role="tooltip" hidden>Signing in as @signatures');
    const overlay = html.slice(html.indexOf('<aside class="rehearsal-watermark"'));
    expect(overlay).toContain("Hairline is applied to the site");
    expect(overlay).toContain("never sign in, claim, mint");
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  it("keeps touch targets, keyboard focus, reduced motion and system-theme colors", () => {
    expect(BUTTON_STUDY_CSS).toContain("min-height:44px");
    expect(BUTTON_STUDY_CSS).toContain(".bst-button:focus-visible");
    expect(BUTTON_STUDY_CSS).toContain("prefers-reduced-motion:reduce");
    expect(BUTTON_STUDY_CSS).toContain("var(--ink)");
    expect(BUTTON_STUDY_CSS).toContain("var(--paper)");
    expect(BUTTON_STUDY_CSS).not.toMatch(/(?:^|})\s*\.auth-action\{/);
    expect(BUTTON_STUDY_SCRIPT).not.toMatch(/fetch\(|localStorage|sessionStorage|\.submit\(/);
  });

  it("switches only the context example using radio controls or anchored links", () => {
    const radios = BUTTON_STUDIES.map(option => ({ value: option.id, checked: option.selected, handlers: {} as Record<string, () => void>, addEventListener(type: string, handler: () => void) { this.handlers[type] = handler; } }));
    const links = BUTTON_STUDIES.map(option => ({ dataset: { contextStyle: option.id }, handlers: {} as Record<string, () => void>, addEventListener(type: string, handler: () => void) { this.handlers[type] = handler; } }));
    const current = { textContent: "Hairline" };
    const context = { dataset: { buttonVariant: "hairline" }, querySelector: () => current, querySelectorAll: () => radios };
    runInNewContext(BUTTON_STUDY_SCRIPT, { document: { querySelector: () => context, querySelectorAll: () => links } });
    radios[1].handlers.change();
    expect(context.dataset.buttonVariant).toBe("solid");
    expect(current.textContent).toBe("Solid");
    expect(radios.filter(radio => radio.checked).map(radio => radio.value)).toEqual(["solid"]);
    links[3].handlers.click();
    expect(context.dataset.buttonVariant).toBe("frame");
    expect(current.textContent).toBe("Open frame");
    expect(radios.filter(radio => radio.checked).map(radio => radio.value)).toEqual(["frame"]);
    Object.assign(links[0].dataset, { contextStyle: "__proto__" });
    links[0].handlers.click();
    expect(context.dataset.buttonVariant).toBe("frame");
  });
});
