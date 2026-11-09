interface CommandLine {
  hasSwitch(name: string): boolean;
  appendSwitch(name: string, value: string): void;
}

/** Use the session's Secret Service on desktops Chromium does not recognize. */
export function configureLinuxPasswordStore(commandLine: CommandLine, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): void {
  if (platform !== "linux" || commandLine.hasSwitch("password-store")) return;
  // Preserve Chromium's version-specific KWallet choice on KDE/Plasma. Other
  // desktops use the standard Secret Service interface (also implemented by
  // KeePassXC). Missing or locked services still fail the secure-storage guard.
  const desktop = `${env.XDG_CURRENT_DESKTOP ?? ""}:${env.DESKTOP_SESSION ?? ""}`;
  if (/(?:^|[:\s/_-])(?:kde\d*|plasma\d*)(?:$|[:\s/_-])/i.test(desktop)
    || env.KDE_FULL_SESSION === "true" || Boolean(env.KDE_SESSION_VERSION)) return;
  commandLine.appendSwitch("password-store", "gnome-libsecret");
}
