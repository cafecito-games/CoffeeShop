import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PwaInstallControl } from "./PwaInstall.js";

class InstallPromptEvent extends Event {
  prompt = vi.fn(async () => undefined);
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;

  constructor(outcome: "accepted" | "dismissed") {
    super("beforeinstallprompt", { cancelable: true });
    this.userChoice = Promise.resolve({ outcome, platform: "web" });
  }
}

function setBrowser({ secure = true, standalone = false, userAgent = "Desktop Browser", touchPoints = 0, hostname = "localhost" } = {}) {
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: secure });
  vi.stubGlobal("location", { hostname });
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: userAgent });
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: touchPoints });
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    matches: standalone,
    media: "(display-mode: standalone)",
    onchange: null,
    addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener)),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn()
  } as unknown as MediaQueryList;
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  return { media, listeners };
}

describe("PWA install control", () => {
  it.each(["accepted", "dismissed"] as const)("uses a captured one-shot prompt only on user action and renders %s", async (outcome) => {
    setBrowser();
    const event = new InstallPromptEvent(outcome);
    render(<PwaInstallControl />);
    act(() => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(event.prompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Install PWA" }));
    await waitFor(() => expect(event.prompt).toHaveBeenCalledOnce());
    expect(await screen.findByRole("dialog", { name: "Install Coffee Shop" })).toHaveTextContent(outcome === "accepted" ? "Installation accepted" : "Installation dismissed");
    fireEvent.click(screen.getByRole("button", { name: "Close install guidance" }));
    fireEvent.click(screen.getByRole("button", { name: "Install PWA" }));
    expect(event.prompt).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog", { name: "Install Coffee Shop" })).toHaveTextContent(/isn't available from this browser context right now/);
  });

  it("reacts to appinstalled without claiming the current browser tab is standalone", () => {
    setBrowser();
    render(<PwaInstallControl />);
    act(() => window.dispatchEvent(new Event("appinstalled")));
    expect(screen.getByRole("button", { name: "Installation completed" })).toBeDisabled();
    expect(screen.queryByText(/running as an installed app in this window/)).not.toBeInTheDocument();
  });

  it("detects an initially standalone context", () => {
    setBrowser({ standalone: true });
    render(<PwaInstallControl />);
    expect(screen.getByRole("button", { name: "Installed in this window" })).toBeDisabled();
    expect(screen.getByText(/running as an installed app in this window/)).toBeInTheDocument();
  });

  it("reacts when the current context enters standalone display mode", () => {
    const { listeners } = setBrowser();
    render(<PwaInstallControl />);
    act(() => listeners.forEach((listener) => listener({ matches: true } as MediaQueryListEvent)));
    expect(screen.getByRole("button", { name: "Installed in this window" })).toBeDisabled();
  });

  it("falls back honestly when a captured browser prompt fails", async () => {
    setBrowser();
    const event = new InstallPromptEvent("accepted");
    event.prompt.mockRejectedValueOnce(new DOMException("No longer eligible", "NotAllowedError"));
    render(<PwaInstallControl />);
    act(() => window.dispatchEvent(event));
    fireEvent.click(screen.getByRole("button", { name: "Install PWA" }));
    expect(await screen.findByRole("dialog", { name: "Install Coffee Shop" })).toHaveTextContent(/isn't available from this browser context right now/);
  });

  it.each([
    ["iPhone", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)", touchPoints: 5 }, /Share.*Add to Home Screen/],
    ["iPadOS", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)", touchPoints: 5 }, /Share.*Add to Home Screen/],
    ["insecure", { secure: false, hostname: "coffee.example" }, /secure HTTPS connection/],
    ["unsupported", {}, /isn't available from this browser context right now/]
  ] as const)("shows honest %s guidance when no prompt exists", (_name, environment, copy) => {
    setBrowser(environment);
    render(<PwaInstallControl />);
    const trigger = screen.getByRole("button", { name: "Install PWA" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Install Coffee Shop" });
    expect(dialog).toHaveTextContent(copy);
    expect(screen.getByRole("button", { name: "Close install guidance" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Install Coffee Shop" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("registers listeners once and cleans them up on unmount", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { media } = setBrowser();
    const rendered = render(<PwaInstallControl />);
    expect(add.mock.calls.filter(([type]) => type === "beforeinstallprompt")).toHaveLength(1);
    expect(add.mock.calls.filter(([type]) => type === "appinstalled")).toHaveLength(1);
    rendered.unmount();
    expect(remove.mock.calls.filter(([type]) => type === "beforeinstallprompt")).toHaveLength(1);
    expect(remove.mock.calls.filter(([type]) => type === "appinstalled")).toHaveLength(1);
    expect(media.removeEventListener).toHaveBeenCalledOnce();
    add.mockRestore();
    remove.mockRestore();
  });
});
