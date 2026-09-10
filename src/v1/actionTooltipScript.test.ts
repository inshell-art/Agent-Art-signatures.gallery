import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTION_TOOLTIP_SCRIPT } from "./actionTooltipScript.js";

function target() {
  const listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  return {
    addEventListener(name: string, fn: (event: Record<string, unknown>) => void) {
      listeners.set(name, [...listeners.get(name) ?? [], fn]);
    },
    fire(name: string, event: Record<string, unknown> = {}) {
      for (const fn of listeners.get(name) ?? []) fn(event);
    },
  };
}
function boot() {
  vi.useFakeTimers();
  const trigger = { ...target(), dataset: { actionTooltip: "hint" } as Record<string, string>,
    removeAttribute: vi.fn(), matches: () => true,
    getBoundingClientRect: () => ({ left: 20, top: 400, bottom: 444 }) };
  const tip = { ...target(), hidden: true, style: { left: "", top: "" },
    getBoundingClientRect: () => ({ width: 320, height: 120 }) };
  const document = { ...target(), hidden: false, documentElement: { clientWidth: 390 },
    querySelectorAll: () => [trigger], getElementById: () => tip };
  const window = { ...target(), innerHeight: 600 };
  runInNewContext(ACTION_TOOLTIP_SCRIPT, { document, window, setTimeout, clearTimeout });
  return { trigger, tip, document, window };
}
const mouse = { pointerType: "mouse", clientX: 360, clientY: 550 };
afterEach(() => vi.useRealTimers());

describe("claim action tooltip", () => {
  it("stays hidden until hover, then fits beside the cursor within the viewport", () => {
    const { trigger, tip } = boot();
    expect(tip.hidden).toBe(true);
    expect(trigger.removeAttribute).toHaveBeenCalledWith("title");
    trigger.fire("pointerenter", mouse);
    vi.advanceTimersByTime(119);
    expect(tip.hidden).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tip.hidden).toBe(false);
    expect(tip.style).toEqual({ left: "62px", top: "418px" });
  });
  it("allows crossing into the tooltip, then hides on leaving both", () => {
    const { trigger, tip } = boot();
    trigger.fire("pointerenter", mouse);
    vi.advanceTimersByTime(120);
    trigger.fire("pointerleave");
    vi.advanceTimersByTime(50);
    tip.fire("pointerenter");
    vi.advanceTimersByTime(1000);
    expect(tip.hidden).toBe(false);
    tip.fire("pointerleave");
    vi.advanceTimersByTime(100);
    expect(tip.hidden).toBe(true);
  });
  it("shows on keyboard focus and dismisses with Escape until re-entry", () => {
    const { trigger, tip, document } = boot();
    trigger.fire("focus");
    expect(tip.hidden).toBe(false);
    document.fire("keydown", { key: "Escape" });
    trigger.fire("pointermove", mouse);
    expect(tip.hidden).toBe(true);
    trigger.fire("blur");
    trigger.fire("focus");
    expect(tip.hidden).toBe(false);
    trigger.fire("blur");
    vi.advanceTimersByTime(100);
    expect(tip.hidden).toBe(true);
  });
  it("does not show for touch or block the CTA, and closes on scroll", () => {
    const { trigger, tip, window } = boot();
    trigger.fire("pointerenter", { ...mouse, pointerType: "touch" });
    vi.advanceTimersByTime(500);
    expect(tip.hidden).toBe(true);
    trigger.fire("pointerenter", mouse);
    vi.advanceTimersByTime(120);
    trigger.fire("pointerdown");
    expect(tip.hidden).toBe(true);
    trigger.fire("pointerleave");
    trigger.fire("pointerenter", mouse);
    vi.advanceTimersByTime(120);
    window.fire("scroll");
    expect(tip.hidden).toBe(true);
    expect(ACTION_TOOLTIP_SCRIPT).not.toMatch(/preventDefault|fetch\(|\.submit\(/);
  });
});
