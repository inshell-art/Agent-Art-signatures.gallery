import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SLOGAN_TOOLTIP_DELAY_MS, SLOGAN_TOOLTIP_HIT_PADDING_PX, SLOGAN_TOOLTIP_SCRIPT } from "./sloganTooltipScript.js";

function target() {
  const listeners = new Map<string, Array<(event: any) => void>>();
  return {
    addEventListener(name: string, fn: (event: any) => void) {
      const handlers = listeners.get(name) ?? [];
      handlers.push(fn);
      listeners.set(name, handlers);
    },
    fire(name: string, event: Record<string, unknown> = {}) {
      for (const fn of listeners.get(name) ?? []) fn(event);
    },
  };
}

function boot() {
  vi.useFakeTimers();
  let focusVisible = false;
  const drawings = [
    { left: 140, right: 620, top: 90, bottom: 185, width: 480, height: 95 },
    { left: 630, right: 660, top: 90, bottom: 190, width: 30, height: 100 },
    // The inactive responsive SVG must not enlarge the hit area toward (0, 0).
    { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 },
  ];
  const figure = {
    ...target(), dataset: {} as Record<string, string>,
    removeAttribute: vi.fn(),
    matches: () => focusVisible,
    querySelectorAll: () => drawings.map((box) => ({ getBoundingClientRect: () => box })),
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 600, bottom: 250 }),
  };
  const tip = {
    ...target(), hidden: true, textContent: "What_shape_do_you_go_by?",
    style: { left: "", top: "" },
    getBoundingClientRect: () => ({ width: 190, height: 30 }),
  };
  const document = {
    ...target(), hidden: false,
    documentElement: { clientWidth: 1000 },
    querySelector: () => figure,
    getElementById: () => tip,
  };
  const window = { ...target(), innerHeight: 800 };
  const context = { document, window, setTimeout, clearTimeout };
  runInNewContext(SLOGAN_TOOLTIP_SCRIPT, context);
  return { figure, tip, document, window, context, drawings, focus() { focusVisible = true; figure.fire("focus"); } };
}

const mouse = (x = 300, y = 100) => ({ pointerType: "mouse", clientX: x, clientY: y });
afterEach(() => vi.useRealTimers());

describe("slogan cursor tooltip", () => {
  it.each([[110, 100], [690, 100], [300, 60], [300, 230]])("ignores the blank SVG canvas at (%i, %i)", (x, y) => {
    const { figure, tip } = boot();
    figure.fire("pointerenter", mouse(x, y));
    vi.advanceTimersByTime(500);
    expect(tip.hidden).toBe(true);
    expect(figure.dataset.tooltipHover).not.toBe("true");
  });

  it("starts the delay on reaching the artwork, not on entering the canvas", () => {
    const { figure, tip } = boot();
    figure.fire("pointerenter", mouse(300, 60));
    vi.advanceTimersByTime(500);
    figure.fire("pointermove", mouse());
    expect(figure.dataset.tooltipHover).toBe("true");
    vi.advanceTimersByTime(119);
    expect(tip.hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tip.hidden).toBe(false);
  });

  it("includes the question mark with only an 8px buffer, independent of scale", () => {
    const { figure, tip, drawings } = boot();
    expect(SLOGAN_TOOLTIP_HIT_PADDING_PX).toBe(8);
    for (const box of drawings) {
      for (const key of Object.keys(box) as Array<keyof typeof box>) box[key] /= 2;
    }
    figure.fire("pointerenter", mouse(338, 103));
    vi.advanceTimersByTime(120);
    expect(tip.hidden).toBe(false);
    figure.fire("pointermove", mouse(339, 103));
    expect(figure.dataset.tooltipHover).toBe("false");
    vi.advanceTimersByTime(100);
    expect(tip.hidden).toBe(true);
  });

  it("cancels a pending tip when moving back into blank canvas", () => {
    const { figure, tip } = boot();
    figure.fire("pointerenter", mouse());
    vi.advanceTimersByTime(60);
    figure.fire("pointermove", mouse(300, 60));
    vi.advanceTimersByTime(500);
    expect(tip.hidden).toBe(true);
    expect(figure.dataset.tooltipHover).toBe("false");
  });

  it("does not create a pointer target if no artwork is visible", () => {
    const { figure, tip, drawings } = boot();
    drawings.length = 0;
    figure.fire("pointerenter", mouse());
    vi.advanceTimersByTime(500);
    expect(tip.hidden).toBe(true);
  });

  it("shows after 120ms without restarting the delay on pointer movement", () => {
    const { figure, tip } = boot();
    expect(SLOGAN_TOOLTIP_DELAY_MS).toBe(120);
    expect(figure.removeAttribute).toHaveBeenCalledWith("title");
    figure.fire("pointerenter", mouse());
    vi.advanceTimersByTime(60);
    figure.fire("pointermove", mouse(320, 110));
    vi.advanceTimersByTime(59);
    expect(tip.hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tip.hidden).toBe(false);
    expect(tip.style).toEqual({ left: "332px", top: "122px" });
    expect(tip.textContent).toBe("What_shape_do_you_go_by?");
  });

  it("cancels a pending tip when the pointer leaves quickly", () => {
    const { figure, tip } = boot();
    figure.fire("pointerenter", mouse());
    vi.advanceTimersByTime(60);
    figure.fire("pointerleave");
    vi.advanceTimersByTime(500);
    expect(tip.hidden).toBe(true);
  });

  it("allows hovering the tooltip across the small pointer gap", () => {
    const { figure, tip } = boot();
    figure.fire("pointerenter", mouse());
    vi.advanceTimersByTime(120);
    figure.fire("pointerleave");
    vi.advanceTimersByTime(60);
    tip.fire("pointerenter");
    vi.advanceTimersByTime(500);
    expect(tip.hidden).toBe(false);
    tip.fire("pointerleave");
    vi.advanceTimersByTime(100);
    expect(tip.hidden).toBe(true);
  });

  it("shows immediately for keyboard focus and hides on blur", () => {
    const { figure, tip, focus } = boot();
    focus();
    expect(tip.hidden).toBe(false);
    expect(tip.style).toEqual({ left: "412px", top: "202px" });
    figure.fire("blur");
    expect(tip.hidden).toBe(true);
  });

  it("dismisses on Escape until the next hover or focus session", () => {
    const { figure, tip, document } = boot();
    figure.fire("pointerenter", mouse());
    vi.advanceTimersByTime(120);
    document.fire("keydown", { key: "Escape" });
    figure.fire("pointermove", mouse(330, 110));
    vi.advanceTimersByTime(500);
    expect(tip.hidden).toBe(true);
    figure.fire("pointerleave");
    figure.fire("pointerenter", mouse());
    vi.advanceTimersByTime(120);
    expect(tip.hidden).toBe(false);
  });

  it("flips and clamps the tip inside a narrow viewport", () => {
    const { figure, tip, document, window, drawings } = boot();
    drawings.splice(0, drawings.length, { left: 200, right: 320, top: 350, bottom: 400, width: 120, height: 50 });
    document.documentElement.clientWidth = 320;
    window.innerHeight = 400;
    figure.fire("pointerenter", mouse(315, 395));
    vi.advanceTimersByTime(120);
    expect(tip.style).toEqual({ left: "113px", top: "353px" });
    document.documentElement.clientWidth = 200;
    window.fire("resize");
    expect(tip.style.left).toBe("8px");
  });

  it("ignores touch hover and non-keyboard focus", () => {
    const { figure, tip } = boot();
    figure.fire("pointerenter", { ...mouse(), pointerType: "touch" });
    figure.fire("focus");
    vi.advanceTimersByTime(500);
    expect(tip.hidden).toBe(true);
  });

  it.each(["scroll", "blur"])("clears visible and pending tips on window %s", (event) => {
    const { figure, tip, window } = boot();
    figure.fire("pointerenter", mouse());
    window.fire(event);
    vi.advanceTimersByTime(500);
    expect(tip.hidden).toBe(true);
    figure.fire("pointerleave");
    figure.fire("pointerenter", mouse());
    vi.advanceTimersByTime(120);
    window.fire(event);
    expect(tip.hidden).toBe(true);
  });

  it("does not bind duplicate handlers on repeated script execution", () => {
    const { figure, context } = boot();
    runInNewContext(SLOGAN_TOOLTIP_SCRIPT, context);
    expect(figure.removeAttribute).toHaveBeenCalledTimes(1);
  });

  it("does nothing on a page without the slogan", () => {
    const context = { document: { querySelector: () => null, getElementById: () => null } };
    expect(() => runInNewContext(SLOGAN_TOOLTIP_SCRIPT, context)).not.toThrow();
  });
});
