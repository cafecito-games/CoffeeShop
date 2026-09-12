import { Check, Desktop, ShareNetwork, WarningCircle, X } from "@phosphor-icons/react";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AccessibleDialog } from "../AccessibleDialog.js";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

type InstallState = "available" | "idle" | "installed" | "standalone";
type Guidance = "accepted" | "dismissed" | "ios" | "insecure" | "unavailable";
type PwaInstallController = ReturnType<typeof usePwaInstall>;

const PwaInstallContext = createContext<PwaInstallController | undefined>(undefined);

function isStandalone() {
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.("(display-mode: standalone)").matches === true || navigatorWithStandalone.standalone === true;
}

function isLocalHostname() {
  return location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.hostname === "[::1]";
}

function isSecureInstallContext() {
  return window.isSecureContext === true || isLocalHostname();
}

function isIphoneOrIpad() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

export function usePwaInstall() {
  const initialStandalone = isStandalone();
  const [state, setState] = useState<InstallState>(initialStandalone ? "standalone" : "idle");
  const [guidance, setGuidance] = useState<Guidance>();
  const promptRef = useRef<BeforeInstallPromptEvent | undefined>(undefined);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const displayMode = window.matchMedia?.("(display-mode: standalone)");

    function onBeforeInstallPrompt(nativeEvent: Event) {
      const event = nativeEvent as BeforeInstallPromptEvent;
      event.preventDefault();
      if (stateRef.current === "installed" || stateRef.current === "standalone") return;
      promptRef.current = event;
      setGuidance(undefined);
      setState("available");
    }

    function onAppInstalled() {
      promptRef.current = undefined;
      setGuidance(undefined);
      setState("installed");
    }

    function onDisplayModeChange(event: MediaQueryListEvent) {
      if (event.matches) {
        promptRef.current = undefined;
        setGuidance(undefined);
        setState("standalone");
      } else if (stateRef.current === "standalone") {
        setState("idle");
      }
    }

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    if (displayMode?.addEventListener) displayMode.addEventListener("change", onDisplayModeChange);
    else displayMode?.addListener(onDisplayModeChange);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
      if (displayMode?.removeEventListener) displayMode.removeEventListener("change", onDisplayModeChange);
      else displayMode?.removeListener(onDisplayModeChange);
      promptRef.current = undefined;
    };
  }, []);

  async function requestInstall() {
    const prompt = promptRef.current;
    if (prompt) {
      promptRef.current = undefined;
      setState("idle");
      try {
        await prompt.prompt();
        const choice = await prompt.userChoice;
        setGuidance(choice.outcome);
      } catch {
        setGuidance("unavailable");
      }
      return;
    }
    if (!isSecureInstallContext()) setGuidance("insecure");
    else if (isIphoneOrIpad()) setGuidance("ios");
    else setGuidance("unavailable");
  }

  return { state, guidance, requestInstall, closeGuidance: () => setGuidance(undefined) };
}

export function PwaInstallProvider({ children }: { children: ReactNode }) {
  return <PwaInstallContext.Provider value={usePwaInstall()}>{children}</PwaInstallContext.Provider>;
}

function GuidanceCopy({ guidance }: { guidance: Guidance }) {
  if (guidance === "accepted") return <><Check size={22} /><h3>Installation accepted</h3><p>Your browser accepted the request and is finishing the installation. It may open Coffee Shop in a separate app window.</p></>;
  if (guidance === "dismissed") return <><Desktop size={22} /><h3>Installation dismissed</h3><p>The one-time browser prompt was dismissed. You can use your browser menu to install later, or try again if the browser offers a new prompt.</p></>;
  if (guidance === "ios") return <><ShareNetwork size={22} /><h3>Add from the share menu</h3><p>Open this browser’s Share menu, then choose Add to Home Screen. The exact menu position varies by browser and iPhone or iPad version.</p></>;
  if (guidance === "insecure") return <><WarningCircle size={22} /><h3>A secure connection is required</h3><p>Installation needs a secure HTTPS connection (except when developing on localhost). Reopen Coffee Shop over HTTPS to check eligibility.</p></>;
  return <><WarningCircle size={22} /><h3>Install prompt unavailable</h3><p>Installation isn't available from this browser context right now. The browser may not support a prompt, or Coffee Shop may not currently meet its eligibility rules. Check the browser menu for an install or add-to-home-screen action.</p></>;
}

export function PwaInstallControl() {
  const controller = useContext(PwaInstallContext);
  if (!controller) return <PwaInstallProvider><PwaInstallControl /></PwaInstallProvider>;
  const { state, guidance, requestInstall, closeGuidance } = controller;
  const completed = state === "installed" || state === "standalone";
  const label = state === "standalone" ? "Installed in this window" : state === "installed" ? "Installation completed" : "Install PWA";

  return (
    <>
      <div className="install-control">
        <button onClick={() => void requestInstall()} disabled={completed}>{label}</button>
        {state === "standalone" && <small className="install-context-note">Coffee Shop is running as an installed app in this window.</small>}
      </div>
      {guidance && (
        <AccessibleDialog labelledBy="pwa-install-title" onClose={closeGuidance} className="install-dialog">
          <header><div><small>Installable app</small><h2 id="pwa-install-title">Install Coffee Shop</h2></div><button className="icon-btn" aria-label="Close install guidance" onClick={closeGuidance} data-dialog-initial-focus><X size={17} /></button></header>
          <div className={`install-guidance install-guidance-${guidance}`}><GuidanceCopy guidance={guidance} /></div>
          <footer><button onClick={closeGuidance}>Done</button></footer>
        </AccessibleDialog>
      )}
    </>
  );
}
