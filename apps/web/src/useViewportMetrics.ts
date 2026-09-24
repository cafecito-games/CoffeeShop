import { useEffect } from "react";

/** Shrinkage below this is layout rounding or a collapsing browser toolbar, not a keyboard. */
const keyboardThreshold = 120;
/** Pinch zoom shrinks the visual viewport too, and the shell must not follow it down. */
const zoomThreshold = 1.01;
/** Input types that never raise an on-screen keyboard. */
const keyboardlessInputTypes = new Set(["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"]);

function opensKeyboard(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  if (element instanceof HTMLTextAreaElement) return true;
  return element instanceof HTMLInputElement && !keyboardlessInputTypes.has(element.type);
}

/**
 * Publishes the height of the region the browser actually leaves visible as `--viewport-height`,
 * plus a `data-keyboard-open` attribute on the document element while an on-screen keyboard covers
 * part of it.
 *
 * The shell sizes itself to that height rather than to `100dvh`, because the two disagree whenever a
 * keyboard is up: viewport units ignore on-screen keyboards by design, and iOS additionally collapses
 * `window.innerHeight` along with the visual viewport the first time it presents one, so any inset
 * derived by subtracting the two measures reads as zero and leaves the composer under the keyboard.
 */
export function useViewportMetrics(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    // The tallest the visible viewport has been with nothing overlaying it.
    let restingHeight = viewport.height;

    function apply() {
      const current = viewport as VisualViewport;
      if (current.scale > zoomThreshold) return;
      const height = current.height;
      // With no text field focused there is no keyboard, so whatever is visible is the resting size.
      // That also re-baselines after a rotation, which changes the resting height permanently.
      restingHeight = opensKeyboard(document.activeElement) ? Math.max(restingHeight, height) : height;
      root.style.setProperty("--viewport-height", `${Math.round(height)}px`);
      if (restingHeight - height > keyboardThreshold) root.setAttribute("data-keyboard-open", "");
      else root.removeAttribute("data-keyboard-open");
    }

    apply();
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    // iOS does not always follow a focus change with a viewport event, and a keyboard left behind by
    // an unmounted field has to be reconciled from the focus side.
    document.addEventListener("focusin", apply);
    document.addEventListener("focusout", apply);
    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
      document.removeEventListener("focusin", apply);
      document.removeEventListener("focusout", apply);
      root.style.removeProperty("--viewport-height");
      root.removeAttribute("data-keyboard-open");
    };
  }, []);
}
