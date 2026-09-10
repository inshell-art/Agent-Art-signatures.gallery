import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { REHEARSAL_OVERLAY_SCRIPT } from "./rehearsalOverlayScript.js";

type OverlayEvent = { target?: unknown; key?: string; preventDefault?: () => void };

function setup(present = true) {
  const inside = {};
  const outside = {};
  const trigger = { focus: vi.fn() };
  const toggleListeners = new Map<string, () => void>();
  const disclosure = { open: false, querySelector: () => trigger, addEventListener: (type: string, listener: () => void) => toggleListeners.set(type, listener) };
  const overlay = { querySelector: () => disclosure, contains: (target: unknown) => target === inside || target === trigger };
  const listeners = new Map<string, (event: OverlayEvent) => void>();
  const document = { activeElement: outside as unknown, querySelector: () => present ? overlay : null, addEventListener: (type: string, listener: (event: OverlayEvent) => void) => listeners.set(type, listener) };
  const dispatchEvent = vi.fn();
  runInNewContext(REHEARSAL_OVERLAY_SCRIPT, { document, window: { dispatchEvent }, Event });
  return { document, disclosure, trigger, listeners, inside, outside, toggleListeners, dispatchEvent };
}

describe("DEV overlay dismissal", () => {
  it("does nothing when the DEV overlay is absent", () => {
    expect(setup(false).listeners.size).toBe(0);
  });
  it("refreshes private developer tools only when the overlay opens", () => {
    const ui = setup();
    ui.toggleListeners.get("toggle")!();
    expect(ui.dispatchEvent).not.toHaveBeenCalled();
    ui.disclosure.open = true;
    ui.toggleListeners.get("toggle")!();
    expect(ui.dispatchEvent.mock.calls[0]![0].type).toBe("dev-panel:open");
  });
  it("collapses on an outside click without cancelling it or stealing focus", () => {
    const ui = setup();
    ui.disclosure.open = true;
    const preventDefault = vi.fn();
    ui.listeners.get("click")!({ target: ui.outside, preventDefault });
    expect(ui.disclosure.open).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(ui.trigger.focus).not.toHaveBeenCalled();
  });
  it("leaves internal text, fixture links, and the native toggle alone", () => {
    const ui = setup();
    ui.disclosure.open = true;
    for (const target of [ui.inside, ui.trigger]) {
      ui.listeners.get("click")!({ target });
      expect(ui.disclosure.open).toBe(true);
    }
    ui.disclosure.open = false;
    ui.listeners.get("click")!({ target: ui.outside });
    expect(ui.disclosure.open).toBe(false);
  });
  it.each([true, false])("closes on Escape and restores focus only when it was inside (inside=%s)", inside => {
    const ui = setup();
    ui.disclosure.open = true;
    ui.document.activeElement = inside ? ui.inside : ui.outside;
    ui.listeners.get("keydown")!({ key: "Escape" });
    expect(ui.disclosure.open).toBe(false);
    expect(ui.trigger.focus).toHaveBeenCalledTimes(inside ? 1 : 0);
  });
  it("does not interfere with other keys or a closed disclosure", () => {
    const ui = setup();
    ui.disclosure.open = true;
    ui.listeners.get("keydown")!({ key: "Tab" });
    expect(ui.disclosure.open).toBe(true);
    ui.disclosure.open = false;
    ui.listeners.get("keydown")!({ key: "Escape" });
    expect(ui.trigger.focus).not.toHaveBeenCalled();
  });
});
