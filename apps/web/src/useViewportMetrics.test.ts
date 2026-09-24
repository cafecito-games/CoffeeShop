import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useViewportMetrics } from "./useViewportMetrics.js";

class FakeVisualViewport extends EventTarget {
  height: number;
  offsetTop = 0;
  scale = 1;
  constructor(height: number) { super(); this.height = height; }
  resizeTo(height: number) { this.height = height; this.dispatchEvent(new Event("resize")); }
  zoomTo(scale: number, height: number) { this.scale = scale; this.height = height; this.dispatchEvent(new Event("resize")); }
}

function installViewport(height: number): FakeVisualViewport {
  const viewport = new FakeVisualViewport(height);
  Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
  return viewport;
}

/** Focuses a composer-like field so the hook treats later shrinkage as a keyboard. */
function focusTextField(): HTMLTextAreaElement {
  const field = document.createElement("textarea");
  document.body.append(field);
  field.focus();
  return field;
}

function publishedHeight(): string {
  return document.documentElement.style.getPropertyValue("--viewport-height");
}

function keyboardOpen(): boolean {
  return document.documentElement.hasAttribute("data-keyboard-open");
}

afterEach(() => {
  Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
  document.documentElement.removeAttribute("data-keyboard-open");
  document.documentElement.style.removeProperty("--viewport-height");
  document.body.replaceChildren();
});

describe("useViewportMetrics", () => {
  it("publishes the visible height while nothing overlays the viewport", () => {
    installViewport(800);
    renderHook(() => useViewportMetrics());
    expect(publishedHeight()).toBe("800px");
    expect(keyboardOpen()).toBe(false);
  });

  it("follows the visible height once a keyboard opens", () => {
    const viewport = installViewport(800);
    renderHook(() => useViewportMetrics());
    focusTextField();
    viewport.resizeTo(460);
    expect(publishedHeight()).toBe("460px");
    expect(keyboardOpen()).toBe(true);
  });

  it("still reports the keyboard when the layout viewport collapses with it", () => {
    const viewport = installViewport(800);
    renderHook(() => useViewportMetrics());
    focusTextField();
    // iOS shrinks window.innerHeight alongside the visual viewport the first time it presents a
    // keyboard, while viewport units keep ignoring the keyboard entirely.
    Object.defineProperty(window, "innerHeight", { value: 460, configurable: true });
    viewport.resizeTo(460);
    expect(publishedHeight()).toBe("460px");
    expect(keyboardOpen()).toBe(true);
  });

  it("ignores gaps small enough to be a collapsing browser toolbar", () => {
    const viewport = installViewport(800);
    renderHook(() => useViewportMetrics());
    focusTextField();
    viewport.resizeTo(720);
    expect(publishedHeight()).toBe("720px");
    expect(keyboardOpen()).toBe(false);
  });

  it("clears the keyboard state when the keyboard closes again", () => {
    const viewport = installViewport(800);
    renderHook(() => useViewportMetrics());
    const field = focusTextField();
    viewport.resizeTo(460);
    field.blur();
    viewport.resizeTo(800);
    expect(publishedHeight()).toBe("800px");
    expect(keyboardOpen()).toBe(false);
  });

  it("re-baselines a shorter viewport that no text field is responsible for", () => {
    const viewport = installViewport(800);
    renderHook(() => useViewportMetrics());
    viewport.resizeTo(360);
    expect(publishedHeight()).toBe("360px");
    expect(keyboardOpen()).toBe(false);
  });

  it("drops the keyboard state when focus leaves without a viewport event", () => {
    const viewport = installViewport(800);
    renderHook(() => useViewportMetrics());
    const field = focusTextField();
    viewport.resizeTo(460);
    expect(keyboardOpen()).toBe(true);
    field.remove();
    document.dispatchEvent(new Event("focusout"));
    expect(keyboardOpen()).toBe(false);
  });

  it("holds its last unzoomed height while the page is pinch zoomed", () => {
    const viewport = installViewport(800);
    renderHook(() => useViewportMetrics());
    viewport.zoomTo(2.5, 320);
    expect(publishedHeight()).toBe("800px");
    expect(keyboardOpen()).toBe(false);
  });

  it("stays inert where the browser exposes no visual viewport", () => {
    Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
    renderHook(() => useViewportMetrics());
    expect(publishedHeight()).toBe("");
  });

  it("removes its listeners and published state on unmount", () => {
    const viewport = installViewport(800);
    const { unmount } = renderHook(() => useViewportMetrics());
    focusTextField();
    viewport.resizeTo(460);
    unmount();
    expect(keyboardOpen()).toBe(false);
    expect(publishedHeight()).toBe("");
    viewport.resizeTo(460);
    expect(keyboardOpen()).toBe(false);
  });
});
