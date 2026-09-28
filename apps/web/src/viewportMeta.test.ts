import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const parsed = new DOMParser().parseFromString(readFileSync(resolve(process.cwd(), "index.html"), "utf8"), "text/html");
const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

/**
 * Both settings make an installed iOS web app paint from the top of the screen while reporting a
 * viewport one status-bar inset shorter than it, and the leftover strip is clipped rather than
 * merely unstyled. The bottom navigation then cannot reach the bottom of the screen, so the shell
 * relies on iOS insetting the web view itself.
 */
describe("iOS standalone viewport", () => {
  it("does not opt into the display cutout", () => {
    const viewport = parsed.querySelector('meta[name="viewport"]');
    expect(viewport).not.toBeNull();
    expect(viewport?.getAttribute("content")).not.toContain("viewport-fit");
  });

  it("does not make the status bar translucent", () => {
    expect(parsed.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')).toBeNull();
  });

  it("keeps the crowded phone navigation icon-only with full-size targets", () => {
    expect(styles).toContain("@media (max-width: 520px)");
    expect(styles).toContain(".bottom-nav { grid-template-columns: repeat(auto-fit,minmax(44px,1fr)); }");
    expect(styles).toContain(".bottom-nav button > span:not(.unread) { display: none; }");
  });
});
