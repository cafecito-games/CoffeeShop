import { useEffect } from "react";

/** Gaps below this are layout rounding or a collapsing browser toolbar, not a keyboard. */
const keyboardThreshold = 120;

function measureInset(viewport: VisualViewport): number {
  const covered = window.innerHeight - viewport.height - viewport.offsetTop;
  return covered > keyboardThreshold ? Math.round(covered) : 0;
}

/**
 * Tracks how much of the layout viewport the on-screen keyboard covers and publishes it as the
 * `--keyboard-inset` custom property plus a `data-keyboard-open` attribute on the document element,
 * so the composer can sit above the keyboard instead of being pushed off-screen.
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;

    function apply() {
      const inset = measureInset(viewport as VisualViewport);
      root.style.setProperty("--keyboard-inset", `${inset}px`);
      if (inset > 0) root.setAttribute("data-keyboard-open", "");
      else root.removeAttribute("data-keyboard-open");
    }

    apply();
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
      root.style.removeProperty("--keyboard-inset");
      root.removeAttribute("data-keyboard-open");
    };
  }, []);
}
