import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useKeyboardInset } from "./useKeyboardInset.js";

class FakeVisualViewport extends EventTarget {
  height: number;
  offsetTop = 0;
  constructor(height: number) { super(); this.height = height; }
  resizeTo(height: number) { this.height = height; this.dispatchEvent(new Event("resize")); }
}

function installViewport(height: number): FakeVisualViewport {
  const viewport = new FakeVisualViewport(height);
  Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  return viewport;
}

afterEach(() => {
  Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
  document.documentElement.removeAttribute("data-keyboard-open");
  document.documentElement.style.removeProperty("--keyboard-inset");
});

describe("useKeyboardInset", () => {
  it("reports no inset while the viewport fills the window", () => {
    installViewport(800);
    renderHook(() => useKeyboardInset());
    expect(document.documentElement.style.getPropertyValue("--keyboard-inset")).toBe("0px");
    expect(document.documentElement.hasAttribute("data-keyboard-open")).toBe(false);
  });

  it("publishes the covered height once a keyboard opens", () => {
    const viewport = installViewport(800);
    renderHook(() => useKeyboardInset());
    viewport.resizeTo(460);
    expect(document.documentElement.style.getPropertyValue("--keyboard-inset")).toBe("340px");
    expect(document.documentElement.hasAttribute("data-keyboard-open")).toBe(true);
  });

  it("ignores gaps small enough to be a collapsing browser toolbar", () => {
    const viewport = installViewport(800);
    renderHook(() => useKeyboardInset());
    viewport.resizeTo(720);
    expect(document.documentElement.style.getPropertyValue("--keyboard-inset")).toBe("0px");
    expect(document.documentElement.hasAttribute("data-keyboard-open")).toBe(false);
  });

  it("clears the published state when the keyboard closes again", () => {
    const viewport = installViewport(800);
    renderHook(() => useKeyboardInset());
    viewport.resizeTo(460);
    viewport.resizeTo(800);
    expect(document.documentElement.style.getPropertyValue("--keyboard-inset")).toBe("0px");
    expect(document.documentElement.hasAttribute("data-keyboard-open")).toBe(false);
  });

  it("stays inert where the browser exposes no visual viewport", () => {
    Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
    renderHook(() => useKeyboardInset());
    expect(document.documentElement.style.getPropertyValue("--keyboard-inset")).toBe("");
  });

  it("removes its listeners and published state on unmount", () => {
    const viewport = installViewport(800);
    const { unmount } = renderHook(() => useKeyboardInset());
    viewport.resizeTo(460);
    unmount();
    expect(document.documentElement.hasAttribute("data-keyboard-open")).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--keyboard-inset")).toBe("");
    viewport.resizeTo(460);
    expect(document.documentElement.hasAttribute("data-keyboard-open")).toBe(false);
  });
});
