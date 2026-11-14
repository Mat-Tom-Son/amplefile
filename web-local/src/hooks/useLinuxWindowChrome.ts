import { useEffect, useState } from "react";
import {
  fallbackWindowButtonLayout,
  parseGnomeButtonLayout,
  parseLinuxWindowChromeState,
  type LinuxWindowChromeState,
} from "../../../src/shared/linux-desktop-appearance.js";
import { previewPlatform } from "../lib/platform";

/**
 * The inert Linux preview (`/?fixture=connected-folder&platform=linux`) draws
 * the title bar the desktop app draws. `&buttonLayout=` takes a GNOME
 * `button-layout` value such as `close,minimize:appmenu`, `&maximized=1`
 * draws the restore button, and `&windowFocused=0` the unfocused window.
 */
function previewChromeState(): LinuxWindowChromeState | null {
  if (previewPlatform() !== "linux") return null;
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("buttonLayout");
  return {
    buttonLayout: requested === null ? fallbackWindowButtonLayout : parseGnomeButtonLayout(requested) ?? fallbackWindowButtonLayout,
    maximized: params.get("maximized") === "1",
    fullScreen: false,
    focused: params.get("windowFocused") !== "0",
    highContrast: false,
  };
}

/** The Linux window's buttons and state from the desktop host, or null on other platforms. */
export function useLinuxWindowChrome(): LinuxWindowChromeState | null {
  const [state, setState] = useState<LinuxWindowChromeState | null>(() => {
    if (typeof window === "undefined") return null;
    if (window.ampleFileDesktop) {
      // Before the host answers, draw the layout Electron's overlay used to draw.
      return window.ampleFileDesktop.app?.platform === "linux" && window.ampleFileDesktop.window?.getChromeState
        ? { buttonLayout: fallbackWindowButtonLayout, maximized: false, fullScreen: false, focused: true, highContrast: false } : null;
    }
    return previewChromeState();
  });

  useEffect(() => {
    const desktop = window.ampleFileDesktop;
    if (desktop?.app?.platform !== "linux" || !desktop.window?.getChromeState) return;
    let live = true;
    let revision = 0;
    const apply = (value: unknown) => {
      if (!live) return;
      const parsed = parseLinuxWindowChromeState(value);
      if (parsed) setState(parsed);
    };
    const request = ++revision;
    void desktop.window.getChromeState().then((value) => { if (request === revision) apply(value); }).catch(() => {});
    const unsubscribe = desktop.window.onChromeStateChanged?.((value) => { revision += 1; apply(value); });
    return () => { live = false; unsubscribe?.(); };
  }, []);

  return state;
}
