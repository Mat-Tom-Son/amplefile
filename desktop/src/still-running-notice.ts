/**
 * The one-time notice that AmpleFile kept running after its window went away.
 *
 * Windows shows it when the window closes to the tray. Linux shows it when
 * the last window closes, because the host stays up for accepted work and
 * many Linux desktops (stock GNOME among them) show no tray icon that would
 * say so. macOS needs none: the Dock shows the app still running.
 * A desktop notification works with or without a tray.
 */

export interface StillRunningNotice {
  title: string;
  body: string;
}

export function stillRunningNotice(platform: NodeJS.Platform, productName: string): StillRunningNotice | null {
  const title = `${productName} is still running`;
  if (platform === "win32") {
    return {
      title,
      body: `Your Workers and the AmpleFile Agent can keep working in the background. Use the tray icon to reopen or quit ${productName}, or change this in Settings.`,
    };
  }
  if (platform === "linux") {
    return {
      title,
      body: `Your Workers and the AmpleFile Agent can keep working in the background. Open ${productName} again to bring back its window, or choose File → Quit to end it.`,
    };
  }
  return null;
}

/** Whether a closed last window tells the person, given that an explicit Quit or an update restart needs no notice. */
export function closedLastWindowNeedsNotice(options: {
  platform: NodeJS.Platform;
  quitting: boolean;
  alreadyShown: boolean;
}): boolean {
  return options.platform === "linux" && !options.quitting && !options.alreadyShown;
}
