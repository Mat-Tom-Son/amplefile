import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  emptyLinuxDesktopAppearance,
  fallbackWindowButtonLayout,
  isKdeDesktop,
  isPortalOwnerAppearedLine,
  parseGnomeButtonLayout,
  parseKdeButtonLayout,
  parsePortalReadOutput,
  parseSettingChangedLine,
  portalAccentColor,
  portalColorScheme,
  portalHighContrast,
  sameButtonLayout,
  type LinuxDesktopAppearance,
} from "../../src/shared/linux-desktop-appearance.js";

const portalDestination = "org.freedesktop.portal.Desktop";
const portalPath = "/org/freedesktop/portal/desktop";
const appearanceNamespace = "org.freedesktop.appearance";
const wmNamespace = "org.gnome.desktop.wm.preferences";
const readTimeoutMs = 3_000;
const monitorRestartDelaysMs = [2_000, 10_000, 30_000];

/**
 * The monitor runs under a small shell that also watches its own stdin: if
 * AmpleFile ends without stopping it (a crash), the pipe closes and the shell
 * stops `gdbus monitor` instead of leaving it behind. (Background jobs read
 * /dev/null unless redirected, hence the explicit descriptor.)
 */
const monitorScript = 'exec 3<&0; gdbus "$@" </dev/null & child=$!; ( read -r _ <&3; kill "$child" 2>/dev/null ) & exec 3<&-; wait "$child"';

export interface LinuxDesktopSettingsOptions {
  env?: NodeJS.ProcessEnv;
  /** Runs `gdbus` with arguments and resolves stdout; rejects on failure (a missing gdbus rejects with code ENOENT). */
  gdbus?: (args: string[]) => Promise<string>;
  /** Starts the long-lived signal monitor. */
  spawnMonitor?: (args: string[]) => ChildProcess;
  readTextFile?: (path: string) => Promise<string>;
  onChange: (appearance: LinuxDesktopAppearance, previous: LinuxDesktopAppearance) => void;
  log?: (message: string) => void;
}

function defaultGdbus(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gdbus", args, { timeout: readTimeoutMs, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function defaultSpawnMonitor(args: string[]): ChildProcess {
  return spawn("/bin/sh", ["-c", monitorScript, "sh", ...args], { stdio: ["pipe", "pipe", "ignore"] });
}

function readArgs(method: "ReadOne" | "Read", namespace: string, key: string): string[] {
  return ["call", "--session", "--timeout", "3", "--dest", portalDestination, "--object-path", portalPath,
    "--method", `org.freedesktop.portal.Settings.${method}`, namespace, key];
}

const monitorArgs = ["monitor", "--session", "--dest", portalDestination, "--object-path", portalPath];

/**
 * Follows the Linux desktop's accent, light/dark preference, contrast and
 * window-button layout through the XDG settings portal (`gdbus`, from GLib,
 * which every desktop with a portal has). Without gdbus, a portal, or a key,
 * the value stays at its fallback: no accent, Electron's own light/dark,
 * normal contrast, and the three buttons on the right.
 */
export class LinuxDesktopSettings {
  private appearance: LinuxDesktopAppearance = emptyLinuxDesktopAppearance;
  private readonly gdbus: (args: string[]) => Promise<string>;
  private readonly spawnMonitor: (args: string[]) => ChildProcess;
  private readonly readTextFile: (path: string) => Promise<string>;
  private readonly env: NodeJS.ProcessEnv;
  private monitor: ChildProcess | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restarts = 0;
  private stopped = false;
  private gdbusMissing = false;
  private readOneUnsupported = false;
  private refreshGeneration = 0;

  constructor(private readonly options: LinuxDesktopSettingsOptions) {
    this.env = options.env ?? process.env;
    this.gdbus = options.gdbus ?? defaultGdbus;
    this.spawnMonitor = options.spawnMonitor ?? defaultSpawnMonitor;
    this.readTextFile = options.readTextFile ?? ((path) => readFile(path, "utf8"));
  }

  current(): LinuxDesktopAppearance {
    return this.appearance;
  }

  async start(): Promise<void> {
    await this.refresh();
    if (!this.stopped && !this.gdbusMissing) this.startMonitor();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.stopMonitor();
  }

  /** Reads every followed key again; a key that cannot be read falls back. */
  async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration;
    const [accent, scheme, contrast, layout] = await Promise.all([
      this.read(appearanceNamespace, "accent-color"),
      this.read(appearanceNamespace, "color-scheme"),
      this.read(appearanceNamespace, "contrast"),
      this.readButtonLayout(),
    ]);
    if (this.stopped || generation !== this.refreshGeneration) return;
    this.update({
      accentColor: portalAccentColor(accent),
      colorScheme: portalColorScheme(scheme),
      highContrast: portalHighContrast(contrast),
      buttonLayout: layout,
    });
  }

  /** Applies one SettingChanged signal. */
  applyChange(namespace: string, key: string, value: unknown): void {
    if (namespace === appearanceNamespace) {
      if (key === "accent-color") this.update({ ...this.appearance, accentColor: portalAccentColor(value) });
      else if (key === "color-scheme") this.update({ ...this.appearance, colorScheme: portalColorScheme(value) });
      else if (key === "contrast") this.update({ ...this.appearance, highContrast: portalHighContrast(value) });
    } else if (namespace === wmNamespace && key === "button-layout" && !isKdeDesktop(this.env.XDG_CURRENT_DESKTOP)) {
      this.update({ ...this.appearance, buttonLayout: parseGnomeButtonLayout(value) ?? fallbackWindowButtonLayout });
    }
  }

  private update(next: LinuxDesktopAppearance): void {
    const previous = this.appearance;
    if (previous.accentColor === next.accentColor && previous.colorScheme === next.colorScheme
      && previous.highContrast === next.highContrast && sameButtonLayout(previous.buttonLayout, next.buttonLayout)) return;
    this.appearance = Object.freeze({ ...next });
    this.options.onChange(this.appearance, previous);
  }

  private async readButtonLayout() {
    if (isKdeDesktop(this.env.XDG_CURRENT_DESKTOP)) {
      const configHome = this.env.XDG_CONFIG_HOME?.trim() || (this.env.HOME ? join(this.env.HOME, ".config") : "");
      if (!configHome) return fallbackWindowButtonLayout;
      try {
        return parseKdeButtonLayout(await this.readTextFile(join(configHome, "kwinrc")));
      } catch {
        // No kwinrc yet means KDE's defaults.
        return parseKdeButtonLayout("");
      }
    }
    return parseGnomeButtonLayout(await this.read(wmNamespace, "button-layout")) ?? fallbackWindowButtonLayout;
  }

  private async read(namespace: string, key: string): Promise<unknown> {
    if (this.gdbusMissing) return undefined;
    try {
      if (!this.readOneUnsupported) {
        try {
          return parsePortalReadOutput(await this.gdbus(readArgs("ReadOne", namespace, key)));
        } catch (error) {
          // Portals before version 2 have only the deprecated Read.
          if (!/UnknownMethod|No such method/i.test(String((error as { stderr?: unknown })?.stderr ?? (error as Error)?.message))) throw error;
          this.readOneUnsupported = true;
        }
      }
      return parsePortalReadOutput(await this.gdbus(readArgs("Read", namespace, key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") this.gdbusMissing = true;
      return undefined;
    }
  }

  private startMonitor(): void {
    if (this.stopped || this.monitor) return;
    let child: ChildProcess;
    try {
      child = this.spawnMonitor(monitorArgs);
    } catch (error) {
      this.options.log?.(`could not follow desktop settings: ${(error as Error).message}`);
      return;
    }
    this.monitor = child;
    child.on("error", (error) => {
      this.options.log?.(`could not follow desktop settings: ${error.message}`);
    });
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        if (this.monitor !== child) return;
        if (isPortalOwnerAppearedLine(line)) {
          // The portal started or restarted after AmpleFile: read it afresh.
          void this.refresh();
          return;
        }
        const change = parseSettingChangedLine(line);
        if (change) {
          this.restarts = 0;
          this.applyChange(change.namespace, change.key, change.value);
        }
      });
    }
    child.once("exit", () => {
      if (this.monitor !== child) return;
      this.monitor = null;
      child.stdin?.destroy();
      if (this.stopped) return;
      const delay = monitorRestartDelaysMs[this.restarts];
      if (delay === undefined) return;
      this.restarts += 1;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        void this.refresh().then(() => this.startMonitor());
      }, delay);
      this.restartTimer.unref?.();
    });
  }

  private stopMonitor(): void {
    const child = this.monitor;
    this.monitor = null;
    if (!child) return;
    // Closing stdin makes the wrapper stop gdbus; the signal covers a wrapper that already lost it.
    child.stdin?.destroy();
    try { child.kill("SIGTERM"); } catch {}
  }
}
