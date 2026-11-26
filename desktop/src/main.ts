import { fitWindowToWorkArea } from "./window-bounds.js";
import { finderOpenPaths } from "./finder-open-paths.js";
import { FileManagerWindows, parseWindowLocation, shownConnectedFolder, type FileManagerWindowEntry } from "./file-manager-windows.js";
import {
  cascadeBounds,
  parseWindowPlacements,
  placementsAfterClose,
  savePlacement,
  separateRestoredPlacements,
  serializeWindowPlacements,
  type WindowBounds,
  type WindowPlacement,
} from "./window-placements.js";
import { configureLinuxPasswordStore } from "./linux-password-store.js";
import { linuxX11RelaunchArguments, openPathArguments } from "./linux-launch.js";
import { ComputerSessionService } from "../../src/local/agent/computer-session.js";
import { NativeWaylandTransport } from "../../src/local/agent/wayland-transport.js";
import { createEncryptedMcpCredentialBackend } from "./pi-mcp-credentials.js";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain as electronIpcMain,
  Menu,
  net,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  screen,
  safeStorage,
  shell,
  systemPreferences,
  Tray,
  type ContextMenuParams,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type Rectangle,
} from "electron";

import { RoutedPiExtensionUiBridge, type PiExtensionUiEvent } from "../../src/local/agent/extension-ui.js";
import { defaultAgentSdkDir } from "../../src/local/agent/agent-data-dir.js";
import {
  RegisteredConnectedFolderRuntimeProvider,
  RegisteredConnectedFolderTrustAuthority,
} from "../../src/local/agent/registered-connected-folder-runtime.js";
import type { PiRuntimeProvider } from "../../src/local/agent/pi-runtime-config.js";
import { startLocalApi, transferFileEntries } from "../../src/local/server.js";
import { setSystemTrashHandler } from "../../src/local/move-to-system-trash.js";
import { existsOnDisk, FileClipboard, parseCutItems } from "./file-clipboard.js";
import { parseFileClipboardPasteRequest, pasteboardFileList, pasteboardFileText, readPasteboardFileList, type PasteboardFiles } from "./file-clipboard-paste.js";
import { addSidebarFolder, assertStandardFolderPathUnowned, isStandardFolderId, resolveStandardFolderPath, standardFolderRoot } from "../../src/local/standard-folders.js";
import { resolveFolderLocation, resolvePlaceSymbolicLink, type FolderLocation } from "../../src/local/folder-locations.js";
import { loadLocalEnvironmentFile } from "../../src/local/server-dev-options.js";
import type { AmpleFileActFacade } from "../../src/local/cli/act-facade.js";
import {
  removeAmpleFileCliActTokenFile,
  writeAmpleFileCliActTokenFile,
} from "../../src/local/cli/act-token.js";
import { configureAmpleFileStateRoot, managedConnectedFolderRoot, ampleFileAgentRoot } from "../../src/local/state-paths.js";
import { getConnectedFolder, listConnectedFolders, resolveConnectedFolderPath } from "../../src/local/connected-folder.js";
import { AmpleFileCliKernelAdapter } from "../../src/local/amplefile-cli-adapter.js";
import { AmpleFileKernel } from "../../src/local/amplefile-kernel.js";
import {
  AmpleFileDesktopCliHost,
  ampleFileCliInstanceData,
  ampleFileCliRequestIdFromArgv,
  ampleFileInspectContextFromArgv,
  ampleFileSecondInstanceIntent,
} from "./amplefile-cli-host.js";
import { AmpleFileAgentPopover, type PopoverAnchor } from "./amplefile-agent-popover.js";
import {
  pruneRecentConnectedFolders,
  readRecentConnectedFolders,
  recentConnectedFolderMenuEntries,
  recentConnectedFoldersPath,
  recordRecentConnectedFolder,
  writeRecentConnectedFolders,
  type RecentConnectedFolderEntry,
} from "./recent-connected-folders.js";
import { ModelContextWindow } from "./model-context-window.js";
import { writeDesktopClipboard } from "./clipboard.js";
import { readLinuxClipboardFiles, writeLinuxClipboardFiles } from "./linux-file-clipboard.js";
import { linuxClipboardHelperUsable, LinuxClipboardOwner, linuxFileClipboardOffers, verifiedClipboardHelper } from "./linux-clipboard-helper.js";
import { closedLastWindowNeedsNotice, stillRunningNotice } from "./still-running-notice.js";
import { PackagedPiRuntimeProvider } from "./pi-runtime.js";
import { includedToolsRoot } from "../../src/local/agent/included-tools.js";
import { prepareLinuxDevelopmentCli } from "./linux-development-cli.js";
import { ComputerHelperInstallation } from "./computer-helper-installation.js";
import { leftoverChromeCleanupApplies, removeLeftoverChromeRegistration } from "./chrome-registration-cleanup.js";
import { applyLoginShellEnvironment, formatLoginShellEnvironmentResult, type LoginShellEnvironmentResult } from "./shell-environment.js";
import { SecureSettingsStore } from "./settings.js";
import { DesktopUpdater, hasPackagedDesktopUpdateFeed, type DesktopUpdates } from "./updater.js";
import { createSystemPackageUpdates } from "./system-package-updates.js";
import { HeadlessQuitSequence } from "./headless-quit.js";
import {
  ampleFileDesktopUserDataPath,
  ampleFileDesktopStateOverride,
  ampleFileDesktopUsesInstalledProductData,
} from "./user-data-path.js";
import { createDesktopPiOAuthHooks } from "./pi-oauth.js";
import { AppLifetimeResource } from "./app-lifetime-resource.js";
import {
  nativeFileMenuItems,
  parseNativeFileMenuRequest,
  type NativeFileMenuCommand,
} from "./file-context-menu.js";
import {
  nativeTabMenuItems,
  parseNativeTabMenuRequest,
} from "./tab-context-menu.js";
import {
  nativeConnectedFolderMenuItems,
  parseNativeConnectedFolderMenuRequest,
} from "./connected-folder-context-menu.js";
import { openFileWithPickedApp, openWithDialogOptions, type OpenWithLaunchPlan } from "./open-with.js";
import { pickLinuxOpenWithApp } from "./open-with-linux-chooser.js";
import { linuxTerminalLaunchPlan } from "./linux-open-terminal.js";
import { macTerminalLaunchPlan, openFolderInTerminal } from "./open-terminal.js";
import { desktopWindowMaterial, shouldUseMacVibrancy, shouldUseWindowsMica } from "./window-material.js";
import { GracefulQuitCoordinator, type QuitPreparationOutcome } from "./quit-coordinator.js";
import { RailTooltipOverlay } from "./rail-tooltip-overlay.js";
import { LinuxDesktopSettings } from "./linux-desktop-settings.js";
import { launcherOpenPaths, startLinuxFileManager, type FileManagerOpenPath } from "./linux-file-manager-host.js";
import { fallbackWindowButtonLayout, linuxNativeThemeSource, type LinuxDesktopAppearance, type LinuxWindowChromeState } from "../../src/shared/linux-desktop-appearance.js";
import { macSpellingGuesses } from "./mac-spelling.js";
import { BuiltInBrowser, parseBrowserCommand, parseBrowserTabsSync, parseBrowserViewRequest } from "./built-in-browser.js";
import { isBrowserPageId } from "../../src/shared/browser.js";
import type { AutomationDetailResponse, AutomationEnableProposalResponse, AutomationProposalsResponse, AutomationsResponse } from "../../src/shared/automation-settings-view.js";
import type { TransferAnswer } from "../../src/shared/file-transfer.js";
import type {
  AmpleFileAgentStagedItem,
  ApplicationMenuId,
  DesktopSendChannel,
  DesktopUpdateStatus,
  NativeConnectedFolderMenuCommand,
  NativeFileMenuRequest,
  NativeTabMenuCommand,
  NativeTabMenuRequest,
  RendererMenuCommand,
  WindowLocation,
  WindowMenuState,
} from "../../src/shared/desktop-ipc.js";
import { sendToRenderer, type DesktopIpcMain, type DesktopSendHandler } from "./desktop-ipc-main.js";
import { productIdentity } from "../../src/shared/product-identity.js";
import { isMacPackageName } from "../../src/shared/mac-packages.js";
import { registerCommandLineIpc } from "./command-line-host.js";
import { resolveDesktopApplicationVersion } from "./application-version.js";
import { handleRendererRequest, rendererBuildDirectory } from "./renderer-protocol.js";

/** Electron's ipcMain, typed by the desktop IPC contract (src/shared/desktop-ipc.ts): only its channels, with their answers. */
const ipcMain: DesktopIpcMain = electronIpcMain;

/** The local API's address; it listens on loopback only. */
const localApiHost = "127.0.0.1";

// AppImage launchers can fall back to --no-sandbox when namespaces are blocked.
// Refuse before initializing user state rather than weaken renderer isolation.
const refusedUnsandboxedLaunch = process.platform === "linux" && app.commandLine.hasSwitch("no-sandbox");
if (refusedUnsandboxedLaunch) {
  console.error("AmpleFile requires the Chromium sandbox. Install the DEB/RPM with the distribution's supported sandbox configuration.");
  app.exit(1);
}

configureLinuxPasswordStore(app.commandLine, process.platform, process.env);
// Every file manager window, the AmpleFile Agent popover, and the inspector share one Chromium session, which
// allows six connections to a host at a time. Each window keeps an event stream open to the loopback local API,
// so a third window's first request would wait forever behind two windows' streams. The limit is lifted for the
// local API's loopback address alone (it never listens elsewhere; src/local/server.ts).
app.commandLine.appendSwitch("ignore-connections-limit", localApiHost);
// Hidden browser views need X11's native parent for trusted input and capture.
// Desktop sharing still uses the Wayland portal in a Wayland login session.
// Chromium has already chosen its platform here, so the instance that owns the
// app starts again under X11 when it needs to (linuxX11RelaunchArguments).
const linuxX11Relaunch = refusedUnsandboxedLaunch ? null : linuxX11RelaunchArguments({
  platform: process.platform,
  display: process.env.DISPLAY,
  argv: process.argv,
  selectedOzonePlatform: app.commandLine.getSwitchValue("ozone-platform"),
  socketExists: existsSync,
});

const productionProductName = productIdentity.productName;
const localMacSmokeProductName = productIdentity.macSmokeProductName;
const localMacSmokeBuild = process.platform === "darwin" && app.isPackaged && packagedBuildChannel() === "mac-local-smoke";
const productName = localMacSmokeBuild ? localMacSmokeProductName : productionProductName;
const appProtocol = productIdentity.internalProtocol;
const appUserModelId = productIdentity.productionAppId;
const desktopTitleBarHeight = 40;
const desktopTitleBarOverlayPalettes = {
  light: { color: "#f2f4ef", symbolColor: "#1c2530" },
  dark: { color: "#0f1622", symbolColor: "#e9eef7" },
} as const;
// Electron supports Mica on Windows 11 22H2+ (build 22621). Older builds and
// reduced-transparency sessions use a solid theme-matched window background.
const micaSupported = shouldUseWindowsMica(
  process.platform,
  process.getSystemVersion(),
  nativeTheme.prefersReducedTransparency,
);
const macVibrancyEnabled = process.env.AMPLEFILE_MAC_NATIVE_MATERIAL?.trim() !== "0";
const macVibrancySupported = shouldUseMacVibrancy(
  process.platform,
  nativeTheme.prefersReducedTransparency,
  macVibrancyEnabled,
);
const nativeWindowMaterial = desktopWindowMaterial(process.platform, {
  windowsMica: micaSupported,
  macVibrancy: macVibrancySupported,
});
const windowBackgroundColors = { light: "#f2f4ef", dark: "#0f1622" } as const;

function titleBarOverlayFor(theme: "light" | "dark"): Electron.TitleBarOverlay {
  return {
    ...desktopTitleBarOverlayPalettes[theme],
    // With Mica the window-controls corner stays transparent so the material
    // shows through the whole title bar instead of a solid strip.
    ...(micaSupported ? { color: "#00000000" } : {}),
    height: desktopTitleBarHeight,
  };
}
const currentFile = fileURLToPath(import.meta.url);
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
// Development builds may override public service origins through the
// repository's ignored local configuration. Packaged builds use the public
// AmpleFile bridge and never depend on release-workstation credentials.
if (!app.isPackaged) loadLocalEnvironmentFile(join(repoRoot, ".env"));
const applicationVersion = resolveDesktopApplicationVersion({
  isPackaged: app.isPackaged,
  electronVersion: app.getVersion(),
  developmentPackageVersion: developmentPackageVersion(),
});
const folderGrantTtlMs = 5 * 60 * 1000;
const shutdownTimeoutMs = 10_000;
const windowStateSaveDelayMs = 500;
const rendererRecoveryMaxAttempts = 6;
const rendererRecoveryBaseDelayMs = 1_000;
const rendererRecoveryMaxDelayMs = 30_000;
const resumeRendererHealthDelayMs = 5_000;
const resumeUpdateCheckDelayMs = 20_000;
const headlessCliIdleGraceMs = 500;
const defaultWindowState = { width: 1440, height: 960 };
const minimumWindowState = { width: 1100, height: 760 };
const folderGrants = new Map<string, { connectedFolderRoot: string; expiresAt: number }>();

/**
 * The file manager windows (desktop/src/file-manager-windows.ts): which one a
 * menu command, a reply, a folder handed to the app, or a Worker's browser
 * page goes to. Every window shares the one local API and its event streams.
 */
const fileManagerWindows = new FileManagerWindows<BrowserWindow, FolderLocation>();
/** Each window's rail tooltip overlay, by window id. */
const railTooltipOverlays = new Map<number, RailTooltipOverlay>();
/** Where the windows were on the screen (window-state.json), loaded when the first window opens. */
let windowPlacements: WindowPlacement[] | null = null;
let builtInBrowser: BuiltInBrowser | null = null;
let tray: Tray | null = null;
let ampleFileAgentPopover: AmpleFileAgentPopover | null = null;
let ampleFileAgentPopoverPromise: Promise<AmpleFileAgentPopover | null> | null = null;
let trayWarmupTimer: NodeJS.Timeout | null = null;
let modelContextWindow: ModelContextWindow | null = null;
const localApiLifetime = new AppLifetimeResource<Awaited<ReturnType<typeof startLocalApi>>>();
let piRuntime: PackagedPiRuntimeProvider | null = null;
let secureSettings: SecureSettingsStore | null = null;
let apiSessionToken = "";
let actFacade: AmpleFileActFacade | null = null;
let actToken = "";
let resolveAmpleFileAgentLineageParent: ((taskId: string) => { taskId: string } | null) | null = null;
/**
 * The automation executor's sleep/wake lifecycle handle (docs/automations.md:
 * suspension aborts the active run, which settles `interrupted`; resume
 * re-arms cadences from the durable anchor). Set once the interactive local
 * API exists; both calls are safe no-ops after close.
 */
let automationPowerLifecycle: { suspend: () => void; resume: () => Promise<void> } | null = null;
let quitting = false;
let quittingForUpdate = false;
let activeAgentTurns = 0;
let trayPulseTimer: NodeJS.Timeout | null = null;
let trayPulseFrames: Electron.NativeImage[] | null = null;
let powerBlockerId: number | null = null;
let desktopUpdater: DesktopUpdates | null = null;
let shutdownPromise: Promise<void> | null = null;
let rendererProtocolRegistered = false;
let ipcRegistered = false;
let powerMonitorRegistered = false;
let accentColorMonitorRegistered = false;
// Linux: the desktop's accent, light/dark, contrast and window-button layout (XDG settings portal).
let linuxDesktopSettings: LinuxDesktopSettings | null = null;
let linuxDesktopSettingsReady: Promise<void> | null = null;
// The renderer's last Appearance mode, so a portal change can re-resolve "system".
let rendererThemeSource: "light" | "dark" | "system" = "system";
/** Each window's renderer recovery (a reload after its renderer failed), by window id. */
const rendererRecoveries = new Map<number, RendererRecovery>();
let restoreWindowsPromise: Promise<BrowserWindow> | null = null;
let desktopHostPromise: Promise<DesktopHost> | null = null;
let interactiveStartupPromise: Promise<void> | null = null;
let activateRegistered = false;
let interactiveRequested = false;
let cliRequestGeneration = 0;
// Linux Open Recent: Connected Folder ids shown most recently, and their menu entries.
let recentConnectedFolderEntries: RecentConnectedFolderEntry[] = [];
let recentConnectedFoldersUpdate: Promise<void> = Promise.resolve();
// Strings open as given in the most recent window; an entry can show a folder selected in its parent (`reveal`,
// Settings → File Manager's ShowItems) or open in a window of its own (`newWindow`, a launcher's further folders).
const pendingOpenPaths: Array<string | FileManagerOpenPath> = [];
let linuxFileManager: ReturnType<typeof startLinuxFileManager> | null = null;
let openPathDrainPromise: Promise<void> | null = null;
const quitCoordinator = new GracefulQuitCoordinator({
  prepare: prepareForApplicationQuit,
  quit: () => app.quit(),
  onError: (error) => {
    console.warn(`${productName} quit preparation failed; continuing shutdown: ${errorMessage(error)}`);
  },
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: appProtocol,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function packagedBuildChannel(): string {
  try {
    const metadata = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) as { ampleFileBuildChannel?: unknown };
    return typeof metadata.ampleFileBuildChannel === "string" ? metadata.ampleFileBuildChannel : "production";
  } catch {
    // Historical production packages predate the explicit channel marker.
    return "production";
  }
}

function developmentPackageVersion(): string | undefined {
  if (app.isPackaged) return undefined;
  try {
    const metadata = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version?: unknown };
    return typeof metadata.version === "string" ? metadata.version : undefined;
  } catch {
    return undefined;
  }
}

app.setName(productName);
if (process.platform === "win32") app.setAppUserModelId(appUserModelId);

configureStableUserDataPath();
let initialCliRequestId: string | null = null;
let initialCliArgumentError: unknown = null;
try {
  initialCliRequestId = ampleFileCliRequestIdFromArgv(process.argv);
} catch (error) {
  initialCliArgumentError = error;
}
interactiveRequested = initialCliRequestId === null && initialCliArgumentError === null;
const initialInspectContext = interactiveRequested && ampleFileInspectContextFromArgv(process.argv);
// Only the instance that owns the app starts again under X11; a second launch
// just hands its arguments to the owner, whichever platform it chose.
const ownsInstance = app.requestSingleInstanceLock(ampleFileCliInstanceData(initialCliRequestId, initialInspectContext))
  && !relaunchedUnderX11();
if (!ownsInstance) app.quit();

function relaunchedUnderX11(): boolean {
  if (!linuxX11Relaunch) return false;
  app.releaseSingleInstanceLock();
  // An AppImage's mount ends with this process, so start the image again.
  const appImage = process.env.APPIMAGE;
  const executable = appImage && isAbsolute(appImage) && existsSync(appImage) ? appImage : process.execPath;
  // Chromium keeps some files open and inheritable (ICU data, the archive);
  // close everything but stdio first, or the new instance holds them, and an
  // AppImage's old mount, for its lifetime. Output stays on this launch's
  // stdout and stderr, which Electron's own relauncher would discard.
  const closeInheritedFiles = 'for fd in /proc/self/fd/*; do n=${fd##*/}; case $n in 0|1|2) ;; *) eval "exec $n>&-" 2>/dev/null;; esac; done; exec "$0" "$@"';
  const child = spawn("/bin/sh", ["-c", closeInheritedFiles, executable, ...linuxX11Relaunch], { stdio: "inherit", env: process.env });
  child.once("error", (error) => console.error(`${productName} could not start under X11: ${errorMessage(error)}`));
  child.unref();
  return true;
}

if (ownsInstance && process.platform === "linux" && interactiveRequested) {
  // A desktop launcher's %U: folders open like a Finder open-file below; a second folder and more each open a window.
  pendingOpenPaths.push(...launcherOpenPaths(openPathArguments(process.argv, { defaultApp: process.defaultApp === true, workingDirectory: process.cwd() })));
}

if (ownsInstance && process.platform === "darwin") {
  // macOS can deliver this before `ready`. Queue the path so Finder and Dock
  // launches can be resolved against the registered Connected Folder catalog once the
  // app host is available. Unknown folders are never registered implicitly.
  // One Finder request arrives as one open-file event per item, all in the
  // same turn; they are gathered and opened together (finder-open-paths.ts).
  let finderRequest: string[] | null = null;
  app.on("open-file", (event, path) => {
    event.preventDefault();
    interactiveRequested = true;
    if (finderRequest) { finderRequest.push(path); return; }
    finderRequest = [path];
    setImmediate(() => {
      const paths = finderRequest ?? [];
      finderRequest = null;
      pendingOpenPaths.push(...finderOpenPaths(paths, (item) => lstatSync(item, { throwIfNoEntry: false })?.isDirectory() === true));
      if (app.isReady()) {
        void startInteractiveApp()
          .then(drainPendingOpenPaths)
          .catch(reportStartupError);
      }
    });
  });
}

if (ownsInstance) {
  app.on("second-instance", (_event, argv, workingDirectory, additionalData) => {
    // Route by cause: the shim relaunches this executable for every CLI
    // request, so anything CLI-shaped stays headless — even when the request
    // id was lost in transit — and only a genuine interactive relaunch (the
    // person opened AmpleFile again) may front the window.
    const intent = ampleFileSecondInstanceIntent(argv, additionalData);
    if (intent.kind === "cli-invalid") {
      console.warn(`${productName} rejected an invalid CLI launch: ${intent.reason}`);
      return;
    }
    if (intent.kind === "cli") {
      void processAmpleFileCliRequest(intent.requestId).catch((error) => {
        console.warn(`${productName} could not process CLI request ${intent.requestId}: ${errorMessage(error)}`);
      });
      return;
    }
    if (intent.kind === "inspect-context") {
      void startInteractiveApp().then(openModelContextWindow).catch(reportStartupError);
      return;
    }
    interactiveRequested = true;
    if (process.platform === "linux") {
      pendingOpenPaths.push(...launcherOpenPaths(openPathArguments(argv, { defaultApp: process.defaultApp === true, workingDirectory })));
    }
    void startInteractiveApp().then(showFrontWindow).then(drainPendingOpenPaths).catch(reportStartupError);
  });
  app.whenReady().then(async () => {
    configureStableUserDataPath();
    configureAmpleFileStateRoot(app.getPath("userData"));
    await ensureLoginShellEnvironment();
    configureCliEnvironment();
    if (initialCliArgumentError) throw initialCliArgumentError;
    if (initialCliRequestId) {
      await processAmpleFileCliRequest(initialCliRequestId);
      if (!interactiveRequested) {
        await quitAfterCliRequest();
        return;
      }
    }
    await startInteractiveApp();
    if (initialInspectContext) await openModelContextWindow();
  }).catch(reportStartupError);
}

app.on("window-all-closed", () => {
  if (quittingForUpdate) return;
  if (process.platform === "win32") app.quit();
});

app.on("before-quit", (event) => {
  quitting = true;
  if (!quitCoordinator.shouldPreventNativeQuit()) return;
  event.preventDefault();
  quitCoordinator.requestQuit();
});

async function prepareForApplicationQuit(): Promise<QuitPreparationOutcome> {
  destroyTray();
  // An explicit restart may already be staging the update. Let that install
  // finish preparing and hand off before deciding whether to quit normally.
  if (await desktopUpdater?.prepareForApplicationQuit()) return "handoff";
  await shutdown();
  desktopUpdater?.dispose();
  desktopUpdater = null;
  return "quit";
}

function requestApplicationQuit(): void {
  quitting = true;
  quitCoordinator.requestQuit();
}

interface DesktopHost {
  settings: SecureSettingsStore;
  extensionUi: RoutedPiExtensionUiBridge;
  runtime: PackagedPiRuntimeProvider;
  runtimeProvider: PiRuntimeProvider;
  connectedFolderTrustAuthority: RegisteredConnectedFolderTrustAuthority;
  kernel: AmpleFileKernel;
  cli: AmpleFileDesktopCliHost;
  computerSession?: ComputerSessionService;
}

let loginShellEnvironmentPromise: Promise<LoginShellEnvironmentResult> | null = null;

/**
 * Dock, Finder, Spotlight, and `open` launches inherit launchd's minimal
 * environment, so Pi's shell tools would miss everything the person's shell
 * profile adds to PATH. Resolve the login shell once, before any Pi session or
 * CLI PATH pin can observe process.env; a terminal launch is left untouched.
 */
function ensureLoginShellEnvironment(): Promise<LoginShellEnvironmentResult> {
  loginShellEnvironmentPromise ??= applyLoginShellEnvironment().then((result) => {
    const line = formatLoginShellEnvironmentResult(result);
    if (result.status === "failed") console.warn(`${productName}: ${line}`);
    else console.log(`${productName}: ${line}`);
    return result;
  });
  return loginShellEnvironmentPromise;
}

async function ensureDesktopHost(): Promise<DesktopHost> {
  if (desktopHostPromise) return desktopHostPromise;
  desktopHostPromise = (async () => {
    await ensureLoginShellEnvironment();
    const userData = app.getPath("userData");
    configureAmpleFileStateRoot(userData);
    const settings = new SecureSettingsStore(join(userData, "secure-settings.bin"));
    const extensionUi = new RoutedPiExtensionUiBridge();
    extensionUi.on("event", (event: PiExtensionUiEvent) => {
    if (event.method === "openExternal") void openExternal(event.url).catch((error) => console.warn(`${productName} blocked external navigation: ${errorMessage(error)}`));
    else if (event.method === "oauthDeviceCode") void openExternal(event.verificationUri).catch((error) => console.warn(`${productName} blocked external navigation: ${errorMessage(error)}`));
    else if (event.method === "copyText") copyTextToClipboard(event.text);
    else if (event.method === "openSettings") { const front = frontWindow(); if (front) sendToRenderer(front.webContents, "amplefile:agent:open-settings"); }
    else if (event.method === "quit") app.quit();
    });
    const bundledComputerHelper = process.platform === "linux"
      ? join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "out", "included-tools"), "computer-helper", "linux-bridge")
      : app.isPackaged
      ? join(process.resourcesPath, "computer-helper", "AmpleFile Computer.app")
      : join(app.getAppPath(), "out", "included-tools", "computer-helper", "AmpleFile Computer.app");
    const computerHelper = process.platform === "darwin" && app.isPackaged
      ? await ComputerHelperInstallation.create({ sourceAppPath: bundledComputerHelper, stateRoot: join(userData, "assistant-tools") })
      : undefined;
    const computerSession = process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland"
      ? new ComputerSessionService({ launch: () => NativeWaylandTransport.launch(join(
        app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "out", "included-tools"), "wayland-helper", "amplefile-wayland")) }) : undefined;
    const runtime = new PackagedPiRuntimeProvider({
      includedTools: {
        rootPath: includedToolsRoot(), stateRoot: join(userData, "assistant-tools"),
        computerSession,
        helperAppPath: computerHelper?.helperAppPath ?? bundledComputerHelper,
        prepareComputerHelper: computerHelper?.prepare,
        repairComputerHelper: computerHelper?.repair,
      },
      agentDir: defaultAgentSdkDir(),
      authStorageHost: settings,
      mcpCredentialBackend: createEncryptedMcpCredentialBackend(join(userData, "pi-mcp-credentials.bin"), safeStorage),
      modelPreferencesPath: join(userData, "model-preferences.json"),
      openRouterCatalogPath: join(userData, "model-catalogs", "openrouter.json"),
      ampleFileAgentRootPath: ampleFileAgentRoot(),
      extensionUi,
    });
    const connectedFolderTrustAuthority = new RegisteredConnectedFolderTrustAuthority((await listConnectedFolders()).map((connectedFolder) => connectedFolder.connectedFolderRoot));
    const runtimeProvider = new RegisteredConnectedFolderRuntimeProvider(runtime, connectedFolderTrustAuthority);
    const kernel = new AmpleFileKernel({ runtimeProvider });
    const cli = new AmpleFileDesktopCliHost({
    stateRoot: userData,
    kernel: new AmpleFileCliKernelAdapter(kernel),
    version: applicationVersion,
    productName,
    getActFacade: () => (actFacade && actToken ? { facade: actFacade, token: actToken } : null),
    resolveLineageParent: (taskId) => resolveAmpleFileAgentLineageParent?.(taskId) ?? null,
    });
    await cli.initialize();
    secureSettings = settings;
    piRuntime = runtime;
    return {
      settings, extensionUi, runtime, runtimeProvider, connectedFolderTrustAuthority, kernel, cli, computerSession,
    };
  })();
  return desktopHostPromise;
}

async function processAmpleFileCliRequest(requestId: string): Promise<void> {
  cliRequestGeneration += 1;
  const host = await ensureDesktopHost();
  await host.cli.processRequest(requestId);
}

async function startInteractiveApp(): Promise<void> {
  interactiveRequested = true;
  if (interactiveStartupPromise) return interactiveStartupPromise;
  interactiveStartupPromise = (async () => {
    // Settings → File Manager (linux-file-manager-host.ts): first, so an app that started AmpleFile on demand is answered soon.
    if (process.platform === "linux") linuxFileManager ??= startLinuxFileManager({
      ipcMain, assertTrusted: assertTrustedMainRenderer, userDataPath: app.getPath("userData"),
      isPackaged: app.isPackaged, execPath: process.execPath, appPath: app.getAppPath(), appImage: process.env.APPIMAGE,
      log: (message) => console.warn(`${productName} file manager: ${message}`),
      open: (target) => { pendingOpenPaths.push(target); void startInteractiveApp().then(showFrontWindow).then(drainPendingOpenPaths).catch(reportStartupError); },
    });
    // A headless CLI host may be tearing down; it re-checks for this launch
    // afterwards and stays up, but the new act token must not race it.
    await headlessQuit.whenTeardownSettled();
    await ensureDesktopHost();
    removeLeftoverChromeRegistrationOnce();
    const api = await ensureInteractiveLocalApi();
    loadDesktopPreferences();
    if (process.platform === "linux") void updateRecentConnectedFolders((ids) => ids);
    registerRendererProtocol();
    registerIpc();
    // On Linux the update source makes no network call, so it starts before
    // the first window: that window's first status read is then the real one,
    // never the "not available" stand-in (an RPM from the package repository
    // would otherwise say so until its status event arrives, if it arrives
    // after the window subscribes).
    if (process.platform === "linux") configureUpdater();
    await ensureWindow();
    configureUpdater();
    createTrayIfSupported();
    if (!activateRegistered) {
      activateRegistered = true;
      // The Dock icon: the windows that were open come back when none is, else the front one comes forward.
      app.on("activate", () => { showFrontWindow(); });
    }
    await drainPendingOpenPaths();
  })();
  return interactiveStartupPromise;
}

/**
 * Removes the Google Chrome registration and helper copy an earlier AmpleFile
 * left. Only interactive startup calls it, never a headless CLI host.
 */
function removeLeftoverChromeRegistrationOnce(): void {
  if (!leftoverChromeCleanupApplies({ platform: process.platform, isPackaged: app.isPackaged, localSmokeBuild: localMacSmokeBuild, environment: process.env })) return;
  void removeLeftoverChromeRegistration({ stateRoot: join(app.getPath("userData"), "assistant-tools") })
    .catch((error) => console.warn(`${productName} could not remove an earlier Chrome helper copy: ${errorMessage(error)}`));
}

const headlessQuit = new HeadlessQuitSequence({
  interactiveRequested: () => interactiveRequested,
  cliRequestGeneration: () => cliRequestGeneration,
  waitForIdle: async () => {
    const host = await ensureDesktopHost();
    await host.cli.whenIdle();
    await host.runtime.flush();
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, headlessCliIdleGraceMs));
  },
  // A headless boot proves no interactive app holds the single-instance lock,
  // so any act-token file on disk is stale crash residue; removing it lets
  // shims fail fast instead of booting another headless host per attempt.
  removeActToken: () => removeAmpleFileCliActTokenFile(app.getPath("userData")).catch(() => undefined),
  quit: () => {
    quitting = true;
    // Exit synchronously after the queue and host-backed auth storage are both
    // drained so a new process cannot hand work to a half-shutdown primary.
    quitCoordinator.allowNativeQuit();
    app.quit();
  },
});

async function quitAfterCliRequest(): Promise<void> {
  await ensureDesktopHost();
  if (await headlessQuit.run() === "interactive") await startInteractiveApp();
}

function reportStartupError(error: unknown): void {
  console.error(`${productName} could not start: ${errorMessage(error)}`);
  if (interactiveRequested) dialog.showErrorBox(`${productName} could not start`, errorMessage(error));
  quitting = true;
  app.quit();
}

function ensureInteractiveLocalApi(): Promise<Awaited<ReturnType<typeof startLocalApi>>> {
  return localApiLifetime.ensure(async () => {
    const userData = app.getPath("userData");
    const host = await ensureDesktopHost();
    apiSessionToken = randomUUID();
    // An item a Replace takes out of a plain folder goes to the operating system's own Trash.
    setSystemTrashHandler((path) => shell.trashItem(path));
    const api = await startLocalApi({
      appMode: "desktop",
      host: localApiHost,
      port: 0,
      connectedFolderBase: managedConnectedFolderRoot(),
      stateBase: userData,
      sessionToken: apiSessionToken,
      allowedOrigins: [`${appProtocol}://app`],
      piRuntimeProvider: host.runtime,
      piOAuthHooks: createDesktopPiOAuthHooks({
        openExternal,
        readClipboard: () => clipboard.readText(),
        writeClipboard: (value) => copyTextToClipboard(value),
        showMessageBox: (options) => {
          const parent = BrowserWindow.getFocusedWindow() ?? frontWindow();
          return parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
        },
        onError: (error) => console.warn(`${productName} provider sign-in UI failed: ${errorMessage(error)}`),
      }),
      connectedFolderTrustAuthority: host.connectedFolderTrustAuthority,
      extensionUiBridge: host.extensionUi,
      kernel: host.kernel,
      // The CLI host's own act-receipts journal, so Settings acts and CLI
      // acts share one ledger file and one at-most-once gate.
      actReceipts: host.cli.receipts,
      localFolderGrantProvider: { consumeLocalFolderGrant },
      // Every Worker and the AmpleFile Agent can use the browser tabs the person sees.
      browser: ensureBuiltInBrowser().toolHost,
      onAgentTurnActivity: updateAgentPowerState,
    });
    // The per-launch act token authorizes the CLI act lane for exactly this
    // interactive run; without a readable token file, act commands stay
    // unavailable rather than half-working.
    actToken = randomBytes(32).toString("hex");
    actFacade = api.actFacade;
    resolveAmpleFileAgentLineageParent = api.resolveAmpleFileAgentLineageParent;
    automationPowerLifecycle = api.automations;
    try {
      await writeAmpleFileCliActTokenFile(userData, actToken, productName);
    } catch (error) {
      actFacade = null;
      actToken = "";
      console.warn(`${productName} could not write the CLI act token; act commands will report unavailable: ${errorMessage(error)}`);
    }
    return api;
  });
}

interface FileManagerWindowOptions {
  /** A saved window coming back: its slot and place on the screen. */
  placement?: WindowPlacement;
  /** A new window: placed a step from this one (or the front window). */
  cascadeFrom?: BrowserWindow | null;
  /** A new window, not one coming back: its renderer forgets what an earlier window in its slot left. */
  fresh?: boolean;
}

/**
 * Opens one file manager window. Every window loads the same renderer over
 * the same local API; what makes it this window is its slot (its saved place
 * and its per-window renderer storage) and the registry entry that routes its
 * menus, replies, and handed-over folders.
 */
async function createFileManagerWindow(options: FileManagerWindowOptions = {}): Promise<BrowserWindow> {
  const api = await ensureInteractiveLocalApi();
  if (process.platform === "linux") await waitForLinuxDesktopSettings();

  // No await from here until the window is registered, so two windows opened at once never share a slot or a place.
  const requestedSlot = options.placement?.slot;
  const slot = requestedSlot && !fileManagerWindows.live().some((entry) => entry.slot === requestedSlot) ? requestedSlot : fileManagerWindows.nextSlot();
  const state = options.placement ? visibleWindowState(options.placement) : null;
  const initialState = state ?? (options.placement || !options.cascadeFrom && !fileManagerWindows.size ? defaultWindowPlacement(slot) : cascadedWindowPlacement(slot, options.cascadeFrom ?? frontWindow()));
  const workArea = screen.getDisplayMatching(initialState).workArea;
  const window = new BrowserWindow({
    x: initialState.x,
    y: initialState.y,
    width: initialState.width,
    height: initialState.height,
    minWidth: Math.min(minimumWindowState.width, workArea.width),
    minHeight: Math.min(minimumWindowState.height, workArea.height),
    title: productName,
    icon: resolveWindowIcon(),
    autoHideMenuBar: process.platform === "win32",
    ...(process.platform === "linux" ? {
      darkTheme: nativeTheme.shouldUseDarkColors,
      // The renderer's title bar draws the window buttons where the desktop's
      // layout puts them; Electron's overlay can only draw all three on the right.
      titleBarStyle: "hidden" as const,
    } : {}),
    ...(process.platform === "win32" ? {
      ...(micaSupported ? { backgroundMaterial: "mica" as const } : {}),
      titleBarStyle: "hidden",
      titleBarOverlay: titleBarOverlayFor(nativeTheme.shouldUseDarkColors ? "dark" : "light"),
    } : {}),
    ...(process.platform === "darwin" ? {
      titleBarStyle: "hiddenInset",
      ...(macVibrancySupported ? {
        vibrancy: "sidebar" as const,
        visualEffectState: "followWindow" as const,
      } : {}),
    } : {}),
    // Solid backgrounds paint over native materials. Reduced-transparency
    // sessions deliberately receive the opaque theme-matched fallback.
    ...(nativeWindowMaterial === "none"
      ? { backgroundColor: windowBackgroundColors[nativeTheme.shouldUseDarkColors ? "dark" : "light"] }
      : { backgroundColor: "#00000000" }),
    show: false,
    webPreferences: {
      preload: resolvePreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      // The built-in PDF viewer is plugin-backed; File tabs preview PDFs inline.
      plugins: true,
      devTools: !app.isPackaged,
      // Worker turns and automations are owned by the app host, not renderer
      // paint. Let Chromium throttle hidden/occluded UI to preserve battery life.
      backgroundThrottling: true,
      additionalArguments: [
        ...productRendererArguments(),
        rendererArgument("api-base-url", api.origin),
        rendererArgument("app-version", applicationVersion),
        rendererArgument("window-material", nativeWindowMaterial),
        // Which window this is, for the renderer's per-window storage (web-local/src/lib/window-storage.ts).
        rendererArgument("window-slot", String(slot)),
        ...(options.fresh ? [rendererArgument("window-fresh", "1")] : []),
      ],
    },
  });
  const entry = fileManagerWindows.add(window, slot);
  if (process.platform === "linux") window.setMenuBarVisibility(false);
  const railTooltipOverlay = new RailTooltipOverlay(window);
  railTooltipOverlays.set(window.id, railTooltipOverlay);

  applyNativeActiveConnectedFolderToWindow(entry);

  if (process.platform === "win32") {
    try {
      window.webContents.session.setSpellCheckerLanguages(["en-US"]);
    } catch (error) {
      console.warn(`${productName} could not configure spellchecker languages: ${errorMessage(error)}`);
    }
  }
  window.webContents.on("did-start-navigation", () => railTooltipOverlay.hide());
  window.webContents.on("render-process-gone", () => railTooltipOverlay.hide());
  window.webContents.on("page-title-updated", (event) => {
    const entry = fileManagerWindows.entry(window);
    if ((process.platform !== "darwin" && process.platform !== "linux") || !entry?.connectedFolder) return;
    event.preventDefault();
    applyNativeActiveConnectedFolderToWindow(entry);
  });
  configureWindowStatePersistence(window, slot);
  const refreshDisplayBounds = () => {
    if (window.isDestroyed()) return;
    const bounds = window.getBounds();
    const workArea = screen.getDisplayMatching(bounds).workArea;
    // Recreate X11 size hints after a scale change; stale pixel hints can make
    // a tiled window larger than the entire display and impossible to shrink.
    window.setMinimumSize(0, 0);
    window.setMinimumSize(Math.min(minimumWindowState.width, workArea.width), Math.min(minimumWindowState.height, workArea.height));
    if (!window.isMaximized() && !window.isFullScreen()) window.setBounds(fitWindowToWorkArea(bounds, workArea, minimumWindowState));
  };
  screen.on("display-metrics-changed", refreshDisplayBounds);
  screen.on("display-removed", refreshDisplayBounds);
  window.once("closed", () => {
    screen.removeListener("display-metrics-changed", refreshDisplayBounds);
    screen.removeListener("display-removed", refreshDisplayBounds);
  });
  if (state?.isMaximized) window.maximize();
  // First reveal only: renderer recoveries can re-emit ready-to-show, and a
  // window the person hid (Windows close-to-tray, minimize) must not
  // resurface because an autonomous reload finished painting.
  window.once("ready-to-show", () => { if (!window.isDestroyed()) window.show(); });
  if (process.platform === "linux") {
    const sendChromeState = () => sendLinuxWindowChromeState(window);
    window.on("maximize", sendChromeState);
    window.on("unmaximize", sendChromeState);
    window.on("enter-full-screen", sendChromeState);
    window.on("leave-full-screen", sendChromeState);
    window.on("focus", sendChromeState);
    window.on("blur", sendChromeState);
  }
  // The front window's menus: its check marks and enabled items, its folder in New Window.
  window.on("focus", () => {
    fileManagerWindows.focus(window);
    refreshApplicationMenuState();
  });
  window.on("blur", () => railTooltipOverlay.hide());
  window.on("hide", () => railTooltipOverlay.hide());
  window.on("minimize", () => railTooltipOverlay.hide());
  window.on("close", (event) => {
    if (quitting || quittingForUpdate || !quitCoordinator.shouldPreventNativeQuit()) return;
    // Close-to-tray is Windows behavior, for the last window; the macOS
    // menu-bar item must not change what closing the last macOS window means
    // (Dock keeps the host).
    if (process.platform !== "win32" || !tray || !desktopPreferences.closeToTray || fileManagerWindows.size > 1) return;
    event.preventDefault();
    window.hide();
    maybeShowStillRunningNotice();
  });
  // A closing window takes its browser pages off the screen; windowClosed below decides where each one goes.
  window.on("close", (event) => { if (!event.defaultPrevented) builtInBrowser?.detachWindow(window); });
  window.on("query-session-end", () => { void shutdown(); });
  window.on("session-end", () => {
    quitting = true;
    void shutdown();
  });
  const windowId = window.id;
  window.on("closed", () => {
    railTooltipOverlay.close();
    railTooltipOverlays.delete(windowId);
    clearRendererRecovery(windowId);
    fileManagerWindows.remove(windowId);
    const othersOpen = fileManagerWindows.size;
    const endingApp = quitting || quittingForUpdate;
    // One of several windows closed: it is forgotten. The last one keeps its place, and Quit keeps them all.
    storeWindowPlacements(placementsAfterClose(currentWindowPlacements(), slot, { quitting: endingApp, othersOpen }));
    if (!endingApp) builtInBrowser?.windowClosed(window, windowId);
    refreshApplicationMenuState();
    if (othersOpen > 0) return;
    if (process.platform === "win32" && !endingApp) app.quit();
    // Linux keeps the host and accepted work after the last window; say so once, tray or not.
    if (closedLastWindowNeedsNotice({ platform: process.platform, quitting: endingApp, alreadyShown: desktopPreferences.trayNoticeShown })) maybeShowStillRunningNotice();
  });
  configureWindowNavigation(window);
  configureContextMenu(window);
  configureWindowResilience(window);
  configurePowerMonitor();
  configureAccentColorMonitor();
  configureMenu(window);

  try {
    await loadMainRenderer(window);
  } catch (error) {
    console.warn(`${productName} renderer load failed: ${errorMessage(error)}`);
    scheduleRendererRecovery(window, `initial renderer load failed: ${errorMessage(error)}`);
  }
  return window;
}

/** Window 1's place the first time AmpleFile opens: the default size at the primary display's top left. */
function defaultWindowPlacement(slot: number): WindowPlacement {
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  return { slot, ...fitWindowToWorkArea({ ...defaultWindowState, x: primaryWorkArea.x, y: primaryWorkArea.y }, primaryWorkArea, minimumWindowState), isMaximized: false };
}

/** A new window's place: a step down and right of the window it came from, clear of every open window. */
function cascadedWindowPlacement(slot: number, from: BrowserWindow | null): WindowPlacement {
  const source = from && !from.isDestroyed() ? (from.isMaximized() || from.isFullScreen() ? from.getNormalBounds() : from.getBounds()) : null;
  if (!source) return defaultWindowPlacement(slot);
  const taken = fileManagerWindows.windows().map((window) => window.getBounds());
  const bounds = cascadeBounds(source, taken, screen.getDisplayMatching(source).workArea, minimumWindowState);
  return { slot, ...bounds, isMaximized: false };
}

function registerRendererProtocol(): void {
  if (rendererProtocolRegistered) return;
  rendererProtocolRegistered = true;
  const rendererRoot = resolveRendererDir();
  const desktopAssets = resolveDesktopAssetsDir();
  protocol.handle(appProtocol, (request) => handleRendererRequest(request, {
    rendererRoot,
    desktopAssets,
    fetchFile: (fileUrl) => net.fetch(fileUrl),
  }));
}

async function openModelContextWindow(): Promise<void> {
  if (quitting) return;
  if (!modelContextWindow) {
    const api = await ensureInteractiveLocalApi();
    if (quitting) return;
    modelContextWindow ??= new ModelContextWindow({
      url: `${appProtocol}://app/index.html?dev-context`,
      title: `Inspect Context — ${productName}`,
      preload: join(dirnameFromFile(currentFile), "model-context-preload.cjs"),
      createWindow: (options) => new BrowserWindow(options),
      request: async ({ path, method, body }) => {
        const response = await fetch(`${api.origin}${path}`, {
          method,
          headers: { "x-amplefile-session": apiSessionToken, ...(body ? { "content-type": "application/json" } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
        });
        const result = await response.json() as { error?: unknown };
        if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Context inspection is unavailable.");
        return result;
      },
    });
  }
  await modelContextWindow.open();
}

function registerIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle("amplefile:clipboard:write", (event, value: unknown) => {
    if (modelContextWindow?.owns(event.sender)) modelContextWindow.assertSender(event);
    else {
      assertTrustedRenderer(event);
      if (!senderIsMainFrame(event)) {
        throw new Error("Clipboard requests require a trusted main frame.");
      }
    }
    // A picture goes on the clipboard alone, so every app pastes the picture rather than text.
    writeDesktopClipboard(value, (content) => clipboard.write(content.image !== undefined
      ? { image: nativeImage.createFromDataURL(content.image) }
      : { text: content.text, ...(content.html !== undefined ? { html: content.html } : {}) }));
    // The pasteboard holds something else now, so nothing is cut.
    fileClipboard.replaced();
  });
  ipcMain.handle("amplefile:diagnostics:request", (event, input: unknown) => {
    if (!modelContextWindow) throw new Error("The developer inspector is not open.");
    return modelContextWindow.request(event, input);
  });
  ipcMain.handle("amplefile:diagnostics:close", (event) => {
    if (!modelContextWindow) throw new Error("The developer inspector is not open.");
    modelContextWindow.closeFrom(event);
  });
  ipcMain.handle("amplefile:api:session-headers", (event) => {
    assertMainOrAgentPopoverRenderer(event);
    return { "x-amplefile-session": apiSessionToken };
  });
  ipcMain.handle("amplefile:runtime:health", async (event) => {
    assertTrustedMainRenderer(event);
    return {
      pi: piRuntime ? await piRuntime.health() : { ok: false, configured: false, version: "", message: "Pi is still starting." },
      settings: secureSettings ? await secureSettings.status() : { encryptionAvailable: false, configuredProviders: [], credentialsNeedReentry: false },
    };
  });
  ipcMain.handle("amplefile:connected-folder:choose-folder", async (event) => {
    assertTrustedMainRenderer(event);
    const window = senderWindow(event);
    const result = window
      ? await dialog.showOpenDialog(window, { title: "Choose a Folder", properties: ["openDirectory", "createDirectory"] })
      : await dialog.showOpenDialog({ title: "Choose a Folder", properties: ["openDirectory", "createDirectory"] });
    const connectedFolderRoot = result.filePaths[0];
    if (result.canceled || !connectedFolderRoot) return null;
    return { path: connectedFolderRoot, folderGrantId: createFolderGrant(connectedFolderRoot) };
  });
  // The facade's own types (src/local/api/automation-settings.ts) describe a trigger as one flat record with every
  // field optional (AmpleFileActAutomationTriggerRef), where Settings' view (src/shared/automation-settings-view.ts)
  // is a union by kind holding the same values. The four answers that carry a trigger are read through the view
  // with `as`; everything else in every answer is checked against the contract.
  const automationSettings = async (event: IpcMainInvokeEvent, value?: unknown) => {
    assertTrustedMainRenderer(event);
    return {
      facade: (await ensureInteractiveLocalApi()).automationSettings,
      ...(value !== undefined ? { automationId: automationSettingsId(value) } : {}),
    };
  };
  ipcMain.handle("amplefile:automations:list", async (event) => {
    const { facade } = await automationSettings(event);
    return facade.list() as Promise<AutomationsResponse>;
  });
  ipcMain.handle("amplefile:automations:proposals", async (event) => {
    const { facade } = await automationSettings(event);
    return facade.proposals() as Promise<AutomationProposalsResponse>;
  });
  ipcMain.handle("amplefile:automations:enable-proposal", async (event, value: unknown) => {
    const { facade } = await automationSettings(event);
    return facade.enableProposal(automationProposalPath(value)) as Promise<AutomationEnableProposalResponse>;
  });
  ipcMain.handle("amplefile:automations:show", async (event, value: unknown) => {
    const { facade, automationId } = await automationSettings(event, value);
    return facade.show(automationId!) as Promise<AutomationDetailResponse>;
  });
  ipcMain.handle("amplefile:automations:history", async (event, value: unknown) => {
    const { facade, automationId } = await automationSettings(event, value);
    return facade.history(automationId!);
  });
  ipcMain.handle("amplefile:automations:enable", async (event, value: unknown) => {
    const { facade, automationId } = await automationSettings(event, value);
    return facade.enable(automationId!);
  });
  // A ready-made Automation from the file manager's Info panel: the host builds it for this Connected Folder.
  ipcMain.handle("amplefile:automations:enable-template", async (event, value: unknown) => {
    const { facade } = await automationSettings(event);
    if (!isRecord(value) || typeof value.connectedFolderId !== "string" || typeof value.templateId !== "string") {
      throw new Error("A Connected Folder and a ready-made Automation are required.");
    }
    return facade.enableTemplate(value.connectedFolderId, value.templateId);
  });
  ipcMain.handle("amplefile:automations:run", async (event, value: unknown) => {
    const { facade, automationId } = await automationSettings(event, value);
    return facade.run(automationId!);
  });
  ipcMain.handle("amplefile:automations:stop", async (event, value: unknown) => {
    const { facade, automationId } = await automationSettings(event, value);
    return facade.stop(automationId!);
  });
  ipcMain.handle("amplefile:automations:disable", async (event, value: unknown) => {
    const { facade, automationId } = await automationSettings(event, value);
    return facade.disable(automationId!);
  });
  ipcMain.handle("amplefile:automations:delete", async (event, value: unknown) => {
    const { facade, automationId } = await automationSettings(event, value);
    return facade.delete(automationId!);
  });
  ipcMain.handle("amplefile:connected-folder:reveal-folder", async (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    if (typeof value !== "string") throw new Error("A Connected Folder id is required.");
    const connectedFolder = await getConnectedFolder(value);
    const error = await shell.openPath(connectedFolder.connectedFolderRoot);
    if (error) throw new Error(`AmpleFile could not show this folder. ${error}`);
  });
  // Open Terminal Here resolves the folder under its place's path policy and rechecks it after choosing the terminal.
  if (process.platform === "darwin" || process.platform === "linux") {
    const linux = process.platform === "linux";
    ipcMain.handle("amplefile:place:open-terminal", async (event, value: unknown) => {
      assertTrustedMainRenderer(event);
      const location = parseWindowLocation(value);
      if (!location) throw new Error("Choose a folder to open in a terminal.");
      const { place, path } = location;
      await openFolderInTerminal({
        resolveFolder: async () => place.kind === "connected-folder"
          ? resolveConnectedFolderPath((await getConnectedFolder(place.id)).connectedFolderRoot, path)
          : isStandardFolderId(place.id) ? resolveStandardFolderPath(place.id, path) : null,
        launch: launchOpenWith,
        launchPlan: linux ? linuxTerminalLaunchPlan : macTerminalLaunchPlan,
        launchFailureMessage: linux ? "AmpleFile couldn’t open a terminal." : undefined,
      });
    });
  }
  ipcMain.handle("amplefile:connected-folder:open-path", async (event, value: unknown) => {
    assertMainOrAgentPopoverRenderer(event);
    const request = connectedFolderPathRequest(value);
    const filePath = await resolveConnectedFolderItem(request.connectedFolderId, request.path);
    if (request.action === "reveal") {
      shell.showItemInFolder(filePath);
      return;
    }
    const result = await shell.openPath(filePath);
    if (result) throw new Error(`${productName} could not open this item. ${result}`);
  });
  ipcMain.handle("amplefile:connected-folder:open-path-with", async (event, value: unknown): Promise<{ opened: boolean; canceled: boolean; appName: string | null }> => {
    assertTrustedMainRenderer(event);
    const request = connectedFolderPathRequest(value, false);
    return openFileWithPickedApp(process.platform, {
      resolveFile: async () => {
        const filePath = await resolveConnectedFolderItem(request.connectedFolderId, request.path);
        if (!(await stat(filePath)).isFile()) throw new Error("Only files can be opened with another app.");
        return filePath;
      },
      pickApp: async (filePath) => {
        const window = senderWindow(event);
        if (process.platform === "linux") return pickLinuxOpenWithApp(window, filePath);
        const options = openWithDialogOptions(process.platform);
        const choice = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
        // Only the path the dialog itself returned is ever launched.
        return choice.canceled ? null : choice.filePaths[0] ?? null;
      },
      launch: launchOpenWith,
    });
  });
  // Dragging out of the window: every item dragged, files and folders, to any app that takes them.
  ipcMain.handle("amplefile:connected-folder:start-drag", async (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    const request = placeDragRequest(value, "connectedFolderId");
    const connectedFolder = await getConnectedFolder(request.id);
    const items: string[] = [];
    for (const path of request.paths) {
      items.push(await draggableItem(resolveConnectedFolderPath(connectedFolder.connectedFolderRoot, path, { finalLink: true }), () => resolveConnectedFolderItem(request.id, path)));
    }
    return startItemDrag(event.sender, items);
  });
  ipcMain.handle("amplefile:connected-folder:preview-file", async (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    if (process.platform !== "darwin") return false;
    const request = connectedFolderPathRequest(value, false);
    const filePath = await resolveConnectedFolderItem(request.connectedFolderId, request.path);
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Only files can be previewed with Quick Look.");
    const window = senderWindow(event);
    if (!window) throw new Error("The AmpleFile window is not available.");
    window.previewFile(filePath, basename(filePath));
    return true;
  });
  // Standard Folders (the file manager's Desktop, Documents, and Downloads):
  // the same open, Quick Look, and drag paths as a Connected Folder's files, and
  // Move to Trash where a Connected Folder would use Recently deleted.
  ipcMain.handle("amplefile:standard-folder:open-path", async (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    const request = standardFolderPathRequest(value, true);
    const filePath = await resolveStandardFolderItem(request.standardFolderId, request.path);
    if (request.action === "reveal" && request.path) {
      shell.showItemInFolder(filePath);
      return;
    }
    const result = await shell.openPath(filePath);
    if (result) throw new Error(`${productName} could not open this item. ${result}`);
  });
  ipcMain.handle("amplefile:standard-folder:open-path-with", async (event, value: unknown): Promise<{ opened: boolean; canceled: boolean; appName: string | null }> => {
    assertTrustedMainRenderer(event);
    const request = standardFolderPathRequest(value);
    return openFileWithPickedApp(process.platform, {
      resolveFile: async () => {
        const filePath = await resolveStandardFolderItem(request.standardFolderId, request.path);
        if (!(await stat(filePath)).isFile()) throw new Error("Only files can be opened with another app.");
        return filePath;
      },
      pickApp: async (filePath) => {
        const window = senderWindow(event);
        if (process.platform === "linux") return pickLinuxOpenWithApp(window, filePath);
        const options = openWithDialogOptions(process.platform);
        const choice = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
        return choice.canceled ? null : choice.filePaths[0] ?? null;
      },
      launch: launchOpenWith,
    });
  });
  ipcMain.handle("amplefile:standard-folder:start-drag", async (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    const request = placeDragRequest(value, "standardFolderId");
    if (!isStandardFolderId(request.id)) throw new Error("That standard folder isn’t on this computer.");
    const items: string[] = [];
    for (const path of request.paths) {
      items.push(await draggableItem(resolveStandardFolderPath(request.id, path, homedir(), { finalLink: true }), () => resolveStandardFolderItem(request.id, path)));
    }
    return startItemDrag(event.sender, items);
  });
  // A symbolic link a listing showed: open what it points to, or show the link itself in the system file manager.
  // A linked folder is never opened here; the window goes to where it really is instead. A linked Mac package
  // (/Applications/Safari.app is one) is one item, as in Finder: it opens in its app like a file.
  ipcMain.handle("amplefile:place:open-link", async (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    if (!isRecord(value) || !isRecord(value.place) || typeof value.path !== "string" || !value.path || value.path.includes("\0") || isAbsolute(value.path)) throw new Error("Choose a link inside the folder.");
    const kind = value.place.kind;
    const id = value.place.id;
    if ((kind !== "connected-folder" && kind !== "standard") || typeof id !== "string" || !id) throw new Error("Choose where the link is.");
    const action = value.action === "reveal" ? "reveal" : "open";
    const link = await resolvePlaceSymbolicLink({ kind, id }, value.path);
    if (action === "reveal") {
      shell.showItemInFolder(link.linkPath);
      return;
    }
    const linkedPackage = process.platform === "darwin" && link.target === "folder" && isMacPackageName(basename(link.targetPath));
    if (link.target !== "file" && !linkedPackage) throw new Error("This link points to a folder. Open it in the window.");
    const result = await shell.openPath(link.targetPath);
    if (result) throw new Error(`${productName} could not open this item. ${result}`);
  });
  ipcMain.handle("amplefile:standard-folder:preview-file", async (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    if (process.platform !== "darwin") return false;
    const request = standardFolderPathRequest(value);
    const filePath = await resolveStandardFolderItem(request.standardFolderId, request.path);
    if (!(await stat(filePath)).isFile()) throw new Error("Only files can be previewed with Quick Look.");
    const window = senderWindow(event);
    if (!window) throw new Error("The AmpleFile window is not available.");
    window.previewFile(filePath, basename(filePath));
    return true;
  });
  // Copy, Cut, and paste with Finder and Linux file managers: files copied or cut there paste into the file
  // manager, and files copied or cut here paste there, through the system's file pasteboard. Paste reads the
  // pasteboard here, never in the window (the window can't read the clipboard). A Cut made in any window is the
  // host's (desktop/src/file-clipboard.ts) and pastes by its place as a move in every window; what this window
  // copied pastes by place (desktop/src/file-clipboard-paste.ts); another app's files are copied in, or moved when
  // that app cut them or the person chose ⌥⌘V. The window's `operationId` shows the paste's progress, and
  // `conflicts` asks about taken names first, then carries the person's choices. The conflicts-first answer has
  // `conflicts` and no `written` or `restorePoints`, which the window's TransferAnswer declares always there; the
  // window reads only `conflicts` and `moved` from it, so the answer is read as a TransferAnswer with `as`.
  ipcMain.handle("amplefile:file-clipboard:paste", async (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    const request = parseFileClipboardPasteRequest(value);
    return fileClipboard.paste(request, await listConnectedFolders(), (body) => transferFileEntries(body)) as Promise<TransferAnswer>;
  });
  ipcMain.handle("amplefile:file-clipboard:write", async (event, value: unknown): Promise<boolean> => {
    assertTrustedMainRenderer(event);
    // A list of paths is a Copy; { paths, operation: "cut", from: { place, paths } } is a Cut, which the host
    // remembers for every window: the items by place, and the files it put on the pasteboard.
    if (isRecord(value) && !Array.isArray(value) && value.operation === "cut") {
      const items = parseCutItems(value);
      const kept = items.nativePaths.flatMap((path, index) => lstatSync(path, { throwIfNoEntry: false }) ? [index] : []);
      if (!kept.length) return false;
      await fileClipboard.cut({ place: items.place, paths: kept.map((index) => items.paths[index]!), nativePaths: kept.map((index) => items.nativePaths[index]!) });
      return true;
    }
    const list = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.paths) ? value.paths : null;
    if (!list || !list.length || list.length > 5_000) throw new Error("Choose items to copy.");
    const paths = list.map((item) => {
      if (typeof item !== "string" || !isAbsolute(item) || item.includes("\0")) throw new Error("Choose items to copy.");
      return item;
    }).filter((path) => Boolean(lstatSync(path, { throwIfNoEntry: false })));
    if (!paths.length) return false;
    await writePasteboardFilePaths(paths);
    // A Copy replaces whatever was cut.
    fileClipboard.replaced();
    return true;
  });
  // What is cut now, in any window, while the pasteboard still holds it; a window asks when it opens and when it
  // comes to the front (another app may have copied meanwhile), and hears every change.
  ipcMain.handle("amplefile:file-clipboard:cut", async (event): Promise<{ nativePaths: string[] } | null> => {
    assertTrustedMainRenderer(event);
    const cut = await fileClipboard.current();
    return cut ? { nativePaths: [...cut.nativePaths] } : null;
  });
  // Esc in the folder list: the Cut is cancelled in every window, and its files leave the pasteboard.
  ipcMain.handle("amplefile:file-clipboard:cancel-cut", async (event): Promise<void> => {
    assertTrustedMainRenderer(event);
    await fileClipboard.cancel();
  });
  // The file manager's + beside Standard Folders: the person chooses a folder in the picker, and only that adds it.
  ipcMain.handle("amplefile:standard-folder:add", async (event): Promise<{ id: string; name: string } | null> => {
    assertTrustedMainRenderer(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = { title: "Add a Folder to the Sidebar", buttonLabel: "Add", properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory"> };
    const choice = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    const folderPath = choice.filePaths[0];
    if (choice.canceled || !folderPath) return null;
    return addSidebarFolder(folderPath);
  });
  ipcMain.handle("amplefile:standard-folder:trash", async (event, value: unknown): Promise<{ trashed: string[]; failed: { path: string; error: string } | null }> => {
    assertTrustedMainRenderer(event);
    if (!isRecord(value) || !Array.isArray(value.paths) || !value.paths.length || value.paths.length > 10_000) throw new Error("Choose items to move to the Trash.");
    const standardFolderId = typeof value.standardFolderId === "string" ? value.standardFolderId : "";
    if (!isStandardFolderId(standardFolderId)) throw new Error("That standard folder isn’t on this computer.");
    const trashed: string[] = [];
    for (const path of value.paths) {
      try {
        const request = standardFolderPathRequest({ standardFolderId, path });
        // Anything a Connected Folder owns is changed through that Connected Folder, where History keeps it.
        await assertStandardFolderPathUnowned(standardFolderId, request.path, homedir(), { finalLink: true });
        // A symbolic link goes to the Trash as itself; what it points to stays.
        const linkPath = resolveStandardFolderPath(standardFolderId, request.path, homedir(), { finalLink: true });
        const isLink = Boolean((await lstat(linkPath).catch(() => null))?.isSymbolicLink());
        await shell.trashItem(isLink ? linkPath : await resolveStandardFolderItem(standardFolderId, request.path));
        trashed.push(request.path);
      } catch (error) {
        return { trashed, failed: { path: typeof path === "string" ? path : "", error: error instanceof Error ? error.message : String(error) } };
      }
    }
    return { trashed, failed: null };
  });
  ipcMain.handle("amplefile:connected-folder:popup-file-menu", async (event, value: unknown): Promise<NativeFileMenuCommand | null> => {
    assertTrustedMainRenderer(event);
    if (process.platform !== "darwin") return null;
    const request = parseNativeFileMenuRequest(value);
    await validateNativeFileMenuEntry(request);
    return popupNativeFileMenu(request, senderWindow(event));
  });
  ipcMain.handle("amplefile:connected-folder:popup-tab-menu", (event, value: unknown): Promise<NativeTabMenuCommand | null> => {
    assertTrustedMainRenderer(event);
    if (process.platform !== "darwin") return Promise.resolve(null);
    return popupNativeTabMenu(parseNativeTabMenuRequest(value), senderWindow(event));
  });
  ipcMain.handle("amplefile:connected-folder:popup-header-menu", (event, value: unknown): Promise<NativeConnectedFolderMenuCommand | null> => {
    assertTrustedMainRenderer(event);
    if (process.platform !== "darwin") return Promise.resolve(null);
    const request = parseNativeConnectedFolderMenuRequest(value);
    return popupNativeCommandMenu(nativeConnectedFolderMenuItems(request), request.point, senderWindow(event));
  });
  ipcMain.handle("amplefile:connected-folder:set-active-connected-folder", async (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    if (value !== null && (typeof value !== "string" || !value.trim() || value.length > 512)) {
      throw new Error("A valid Connected Folder id is required.");
    }
    // Each window names the Connected Folder it shows; its title and Open Recent follow.
    await setWindowConnectedFolder(senderWindow(event), value === null ? null : value.trim());
  });
  // A location handed to this window (a folder given to the app, New Window, Open in New Window) waits until its renderer takes it.
  ipcMain.handle("amplefile:file-manager:take-open-location", (event) => {
    assertTrustedMainRenderer(event);
    return fileManagerWindows.takeOpenLocation(senderWindow(event));
  });
  onRendererMessage("amplefile:file-manager:ack-open-location", (event, value: unknown) => {
    fileManagerWindows.acknowledgeOpenLocation(senderWindow(event), value);
  });
  // Windows (docs/product-model.md, "Windows"): where this window is, so New Window opens there; and a new window, at a
  // folder the renderer names (Open in New Window in its menus) or where this one is.
  onRendererMessage("amplefile:window:set-location", (event, value: unknown) => {
    const entry = fileManagerWindows.entry(senderWindow(event));
    if (!entry) return;
    entry.location = parseWindowLocation(value);
    // The title names the Connected Folder the tab in front shows, and none for a plain folder.
    applyNativeActiveConnectedFolderToWindow(entry);
  });
  ipcMain.handle("amplefile:window:new-window", async (event) => {
    assertTrustedMainRenderer(event);
    await openNewWindow({ from: senderWindow(event) });
    return true;
  });
  ipcMain.handle("amplefile:window:open-in-new-window", async (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    const location = parseWindowLocation(value);
    if (!location) throw new Error("Choose a folder to open in a new window.");
    if (location.place.kind === "connected-folder") await getConnectedFolder(location.place.id);
    else if (!isStandardFolderId(location.place.id)) throw new Error("That folder isn’t on this computer.");
    await openNewWindow({ from: senderWindow(event), location: { place: location.place, path: location.path, select: location.select ?? null } });
    return true;
  });
  ipcMain.handle("amplefile:shell:open-external", async (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    if (typeof value !== "string") throw new Error("A URL is required.");
    await openExternal(value);
  });
  ipcMain.handle("amplefile:window:accent-color", (event) => {
    assertMainOrAgentPopoverRenderer(event);
    return getSystemAccentColor();
  });
  ipcMain.handle("amplefile:agent:open-agent-draft", async (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    if (typeof value !== "string" || !value.trim() || value.length > 4096) throw new Error("A bounded AmpleFile Agent draft is required.");
    await openAmpleFileAgentPopoverWithItems([{ kind: "text", value }], windowPopoverAnchor(BrowserWindow.fromWebContents(event.sender)));
    return true;
  });
  onRendererMessage("amplefile:agent:hide", () => {
    ampleFileAgentPopover?.hide();
  }, assertMainOrAgentPopoverRenderer);
  ipcMain.handle("amplefile:agent:open-main", (event) => {
    assertMainOrAgentPopoverRenderer(event);
    ampleFileAgentPopover?.hide();
    // The popover asks for the front window; a file manager window asking means itself.
    const asking = senderWindow(event);
    if (asking) showFileManagerWindow(asking);
    else showFrontWindow();
    return true;
  });
  ipcMain.handle("amplefile:agent:open-ai-models-settings", async (event) => {
    assertMainOrAgentPopoverRenderer(event);
    ampleFileAgentPopover?.hide();
    const window = senderWindow(event) ?? await ensureWindow();
    showFileManagerWindow(window);
    sendToRenderer(window.webContents, "amplefile:agent:open-settings", "agent");
    return true;
  });
  ipcMain.handle("amplefile:window:get-close-to-tray", (event) => {
    assertTrustedMainRenderer(event);
    return closeToTrayStatus();
  });
  ipcMain.handle("amplefile:window:set-close-to-tray", (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    if (typeof value !== "boolean") throw new Error("Close-to-background preference must be a boolean.");
    updateDesktopPreferences({ closeToTray: value });
    return closeToTrayStatus();
  });
  onRendererMessage("amplefile:window:set-theme", (_event, value: unknown, source: unknown) => {
    if (value !== "light" && value !== "dark") return;
    // Keep the OS-drawn chrome (Mica backdrop, frame, menus) on the app theme.
    // "system" preserves prefers-color-scheme change events in the renderer.
    const requested = source === "light" || source === "dark" || source === "system" ? source : value;
    rendererThemeSource = requested;
    // Electron on Linux takes light/dark from the GTK theme; the portal's explicit preference wins for "system".
    nativeTheme.themeSource = process.platform === "linux"
      ? linuxNativeThemeSource(requested, linuxDesktopSettings?.current().colorScheme ?? null)
      : requested;
    // Appearance is one setting for the app, so every window takes it.
    for (const window of fileManagerWindows.windows()) {
      if (process.platform === "win32") {
        window.setTitleBarOverlay(titleBarOverlayFor(value));
        if (!micaSupported) window.setBackgroundColor(windowBackgroundColors[value]);
      } else if (process.platform === "linux") {
        // The renderer draws the whole Linux title bar, buttons included.
        window.setBackgroundColor(windowBackgroundColors[value]);
      } else if (process.platform === "darwin" && nativeWindowMaterial === "none") {
        window.setBackgroundColor(windowBackgroundColors[value]);
      }
    }
  });
  ipcMain.handle("amplefile:window:chrome-state", (event) => {
    assertTrustedMainRenderer(event);
    return linuxWindowChromeState(senderWindow(event));
  });
  onRendererMessage("amplefile:window:control", (event, value: unknown) => {
    const window = senderWindow(event);
    if (!window || window.isDestroyed()) return;
    // Closing the last folder tab closes that window on every platform, through the window's own close rules.
    if (value === "close") { window.close(); return; }
    if (process.platform !== "linux") return;
    if (value === "minimize") window.minimize();
    else if (value === "toggle-maximize") {
      if (window.isFullScreen()) window.setFullScreen(false);
      else if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    }
  });
  onRendererMessage("amplefile:menu:set-state", (event, value: unknown) => {
    // Each window keeps its own; the application menu shows the front window's.
    const updated = senderWindow(event);
    if (updated) fileManagerWindows.updateMenuState(updated, value);
    refreshApplicationMenuState();
  });
  ipcMain.handle("amplefile:menu:popup", (event, menuId: unknown, bounds: unknown) => {
    assertTrustedMainRenderer(event);
    popupApplicationSubmenu(menuId, bounds, senderWindow(event));
  });
  // Other AI agents (Settings → Command Line): the command on Terminal's PATH
  // and the skill in Claude Code's and Codex's skills folders, each on a click.
  registerCommandLineIpc({ ipcMain, assertTrusted: assertTrustedMainRenderer, isPackaged: app.isPackaged });
  ipcMain.handle("amplefile:settings:status", (event) => {
    assertTrustedMainRenderer(event);
    return secureSettings?.status() ?? { encryptionAvailable: false, configuredProviders: [], credentialsNeedReentry: false };
  });
  onRendererMessage("amplefile:window:rail-tooltip-show", (event, value: unknown) => {
    railTooltipOverlays.get(senderWindow(event)?.id ?? -1)?.show(value);
  });
  onRendererMessage("amplefile:window:rail-tooltip-hide", (event) => {
    railTooltipOverlays.get(senderWindow(event)?.id ?? -1)?.hide();
  });
  ipcMain.handle("amplefile:browser:mount", (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    return ensureBuiltInBrowser().mount(parseBrowserViewRequest(value), requireSenderWindow(event));
  });
  onRendererMessage("amplefile:browser:layout", (event, value: unknown) => {
    ensureBuiltInBrowser().layout(parseBrowserViewRequest(value), requireSenderWindow(event));
  });
  ipcMain.handle("amplefile:browser:unmount", (event, pageId: unknown) => {
    assertTrustedMainRenderer(event);
    if (!isBrowserPageId(pageId)) throw new Error("The browser tab id is invalid.");
    ensureBuiltInBrowser().detach(pageId, requireSenderWindow(event));
  });
  ipcMain.handle("amplefile:browser:navigate", (event, pageId: unknown, address: unknown) => {
    assertTrustedMainRenderer(event);
    if (!isBrowserPageId(pageId)) throw new Error("The browser tab id is invalid.");
    if (typeof address !== "string" || address.length > 32_768) throw new Error("The browser address is invalid.");
    return ensureBuiltInBrowser().navigate(pageId, address, requireSenderWindow(event));
  });
  ipcMain.handle("amplefile:browser:command", (event, pageId: unknown, command: unknown) => {
    assertTrustedMainRenderer(event);
    if (!isBrowserPageId(pageId)) throw new Error("The browser tab id is invalid.");
    ensureBuiltInBrowser().command(pageId, parseBrowserCommand(command), requireSenderWindow(event));
  });
  ipcMain.handle("amplefile:browser:respond-permission", (event, pageId: unknown, requestId: unknown, decision: unknown) => {
    assertTrustedMainRenderer(event);
    if (!isBrowserPageId(pageId) || typeof requestId !== "string" || !/^[a-f0-9]{16}$/.test(requestId)) throw new Error("The site's request is invalid.");
    if (decision !== "allow" && decision !== "block") throw new Error("Choose Allow or Block.");
    // Only the window holding the page can answer its site's question.
    ensureBuiltInBrowser().respondPermission(pageId, requestId, decision, requireSenderWindow(event));
  });
  ipcMain.handle("amplefile:browser:close", (event, pageId: unknown) => {
    assertTrustedMainRenderer(event);
    if (!isBrowserPageId(pageId)) throw new Error("The browser tab id is invalid.");
    ensureBuiltInBrowser().close(pageId, requireSenderWindow(event));
  });
  onRendererMessage("amplefile:browser:sync", (event, value: unknown) => {
    ensureBuiltInBrowser().sync(parseBrowserTabsSync(value), requireSenderWindow(event));
  });
  ipcMain.handle("amplefile:browser:states", (event) => {
    assertTrustedMainRenderer(event);
    return ensureBuiltInBrowser().states(requireSenderWindow(event));
  });
  ipcMain.handle("amplefile:browser:popup-tab-menu", (event, pageId: unknown, url: unknown, point: unknown, options: unknown) => {
    assertTrustedMainRenderer(event);
    if (!isBrowserPageId(pageId) || typeof url !== "string" || url.length > 32_768) throw new Error("The browser tab is invalid.");
    const at = point as { x?: unknown; y?: unknown } | null;
    const flags = options as { canReopen?: unknown; hasOthers?: unknown } | null;
    if (!at || typeof at.x !== "number" || typeof at.y !== "number" || !Number.isFinite(at.x) || !Number.isFinite(at.y)) throw new Error("The menu position is invalid.");
    return ensureBuiltInBrowser().popupTabMenu(pageId, url, { x: at.x, y: at.y }, { canReopen: flags?.canReopen === true, hasOthers: flags?.hasOthers === true }, requireSenderWindow(event));
  });
  ipcMain.handle("amplefile:browser:suggest", (event, text: unknown) => {
    assertTrustedMainRenderer(event);
    if (typeof text !== "string" || text.length > 2_048) throw new Error("The address is invalid.");
    return ensureBuiltInBrowser().suggest(text);
  });
  ipcMain.handle("amplefile:browser:recent", (event) => {
    assertTrustedMainRenderer(event);
    return ensureBuiltInBrowser().recentHistory();
  });
  ipcMain.handle("amplefile:browser:clear-history", (event) => {
    assertTrustedMainRenderer(event);
    return ensureBuiltInBrowser().clearHistory();
  });
  ipcMain.handle("amplefile:browser:show-download", (event, path: unknown) => {
    assertTrustedMainRenderer(event);
    if (typeof path !== "string") throw new Error("The download is invalid.");
    ensureBuiltInBrowser().showDownload(path);
  });
  ipcMain.handle("amplefile:updates:status", (event): DesktopUpdateStatus => {
    assertTrustedMainRenderer(event);
    return getUpdateStatus();
  });
  ipcMain.handle("amplefile:updates:check", async (event): Promise<DesktopUpdateStatus> => {
    assertTrustedMainRenderer(event);
    return checkForUpdates();
  });
  ipcMain.handle("amplefile:updates:install", async (event): Promise<DesktopUpdateStatus> => {
    assertTrustedMainRenderer(event);
    return desktopUpdater?.install() ?? getUpdateStatus();
  });
  ipcMain.handle("amplefile:updates:update-now", async (event): Promise<DesktopUpdateStatus> => {
    assertTrustedMainRenderer(event);
    return desktopUpdater?.updateNow() ?? getUpdateStatus();
  });
}

/** A menu item's click: the command goes to the window the menu was used in, else the front window. */
function menuCommand(command: RendererMenuCommand): (item: Electron.MenuItem, window: Electron.BaseWindow | undefined) => void {
  return (_item, window) => sendRendererMenuCommand(command, window);
}

function configureMenu(window: BrowserWindow): void {
  if (process.platform === "darwin") {
    app.setAboutPanelOptions({
      applicationName: productName,
      applicationVersion,
      copyright: "Copyright © Mat-Tom-Son",
    });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenuTemplate()));
  if (process.platform === "win32") {
    window.setAutoHideMenuBar(false);
    window.setMenuBarVisibility(false);
  }
  refreshApplicationMenuState();
}

function buildApplicationMenuTemplate(state: WindowMenuState = fileManagerWindows.menuState()): MenuItemConstructorOptions[] {
  return [
    ...macApplicationMenu(),
    { id: "file", label: "File", submenu: buildApplicationSubmenuTemplate("file", state) },
    { id: "edit", label: "Edit", submenu: buildApplicationSubmenuTemplate("edit", state) },
    { id: "view", label: "View", submenu: buildApplicationSubmenuTemplate("view", state) },
    ...macWindowMenu(),
    { id: "help", label: "Help", submenu: buildApplicationSubmenuTemplate("help", state) },
  ];
}

function buildApplicationSubmenuTemplate(menuId: ApplicationMenuId, state: WindowMenuState): MenuItemConstructorOptions[] {
  if (menuId === "file") {
    const items: MenuItemConstructorOptions[] = [
      // Another window at the folder the front one shows (docs/product-model.md, "Windows").
      { id: "new-window", label: "New Window", accelerator: "CommandOrControl+N", click: (_item, window) => { void openNewWindow({ from: window }).catch(reportWindowError); } },
      // A folder tab at the folder shown. The window owns the key, so it works wherever the keyboard is and the
      // Browser pane keeps its own ⌘T while it has the keyboard; the menu shows the key without registering it.
      { id: "new-tab", label: "New Tab", accelerator: "CommandOrControl+T", registerAccelerator: false, enabled: state.folderTabsOpen, click: menuCommand("new-tab") },
      { label: "New Connected Folder", accelerator: "Alt+CommandOrControl+N", click: menuCommand("new-connected-folder") },
      { label: "Connect Folder...", accelerator: "CommandOrControl+O", click: menuCommand("open-local-folder") },
      ...(process.platform === "darwin" ? [{
        label: "Open Recent",
        role: "recentDocuments" as const,
        submenu: [{ role: "clearRecentDocuments" as const }],
      }] : []),
      ...(process.platform === "linux" ? [linuxOpenRecentMenuItem()] : []),
      ...(process.platform === "darwin" || process.platform === "linux" ? [{ id: "open-terminal", label: "Open Terminal Here", enabled: state.terminalFolderOpen === true, click: menuCommand("open-terminal") }] : []),
      { type: "separator" },
      { id: "new-chat", label: "New Chat", accelerator: "CommandOrControl+Shift+N", enabled: state.connectedFolderOpen, click: menuCommand("new-chat") },
      // The folder shown, in any place: a Connected Folder, a Standard Folder, the disk, or any other folder.
      { id: "refresh", label: "Refresh", accelerator: "CommandOrControl+R", enabled: state.folderTabsOpen, click: menuCommand("refresh") },
      // The panel, opened at Info for the selection, or for the folder shown when nothing is selected.
      { id: "get-info", label: "Get Info", accelerator: "CommandOrControl+I", enabled: state.folderTabsOpen, click: menuCommand("get-info") },
    ];
    if (process.platform !== "darwin") {
      items.push(
        { type: "separator" },
        { label: "Settings...", accelerator: "CommandOrControl+,", click: menuCommand("open-settings") },
      );
    }
    if (process.platform === "darwin") {
      // Cmd+W follows tab-strip muscle memory and closes the active surface
      // tab; the window keeps the conventional Shift+Cmd+W.
      items.push(
        { type: "separator" },
        { id: "close-tab", label: "Close Tab", accelerator: "CommandOrControl+W", enabled: state.folderTabsOpen, click: menuCommand("close-tab") },
        { role: "close", accelerator: "Shift+CommandOrControl+W" },
      );
    } else if (process.platform === "linux") {
      // As on the Mac, Ctrl+W closes the folder tab in front (the browser tab in
      // front while the Browser pane has the keyboard; the last folder tab closes
      // the window), and Shift+Ctrl+W closes the window (the host and accepted
      // work keep running).
      items.push(
        { type: "separator" },
        { id: "close-tab", label: "Close Tab", accelerator: "Control+W", enabled: state.folderTabsOpen, click: menuCommand("close-tab") },
        { role: "close", label: "Close Window", accelerator: "Shift+Control+W" },
        { role: "quit", accelerator: "Control+Q" },
      );
    } else {
      items.push({ type: "separator" }, { role: "quit" });
    }
    return items;
  }
  if (menuId === "edit") {
    return [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      // Linux: Chromium's own Ctrl+Shift+V, pasting text without its formatting.
      ...(process.platform === "darwin" ? [{ role: "pasteAndMatchStyle" as const }]
        : process.platform === "linux" ? [{ role: "pasteAndMatchStyle" as const, accelerator: "Shift+Control+V" }] : []),
      { role: "delete" },
      { type: "separator" },
      { role: "selectAll" },
      ...macEditMenuAdditions(),
    ];
  }
  if (menuId === "view") {
    return [
      { label: "Command Palette...", accelerator: "CommandOrControl+K", click: menuCommand("open-command-palette") },
      // Linux places the popover in the window that asked, so its item (and Ctrl+J) is here rather than with the Mac's below.
      ...(process.platform === "linux" ? [{ label: "Toggle AmpleFile Agent", accelerator: "CommandOrControl+J", click: (_item: Electron.MenuItem, window: Electron.BaseWindow | undefined) => { void toggleAmpleFileAgentPopover(windowPopoverAnchor(window)); } }] : []),
      { type: "separator" },
      // The window owns the key (Shift-Command-Period, Ctrl+H) so it works while the folder list has the keyboard
      // and in the browser preview; the menu shows the key and the check without registering it twice.
      {
        id: "show-hidden-files",
        label: "Show Hidden Files",
        type: "checkbox",
        checked: state.showHiddenFiles,
        accelerator: process.platform === "darwin" ? "Shift+Command+." : "Control+H",
        registerAccelerator: false,
        // Every folder the window shows has hidden files, with or without a Connected Folder.
        enabled: state.folderTabsOpen,
        click: menuCommand("toggle-hidden-files"),
      },
      // Folder tabs: the strip shows with more than one tab, or always with Show Tab Bar on. The window owns the next and
      // previous tab keys (Ctrl+Tab and Ctrl+Shift+Tab everywhere, as listed here per platform).
      {
        id: "show-tab-bar",
        label: "Show Tab Bar",
        type: "checkbox",
        checked: state.showTabBar,
        enabled: state.folderTabsOpen,
        click: menuCommand("toggle-tab-bar"),
      },
      { id: "previous-tab", label: "Show Previous Tab", accelerator: process.platform === "darwin" ? "Shift+Command+[" : "Control+PageUp", registerAccelerator: false, enabled: state.folderTabsOpen, click: menuCommand("previous-tab") },
      { id: "next-tab", label: "Show Next Tab", accelerator: process.platform === "darwin" ? "Shift+Command+]" : "Control+PageDown", registerAccelerator: false, enabled: state.folderTabsOpen, click: menuCommand("next-tab") },
      { type: "separator" },
      // The AmpleFile Agent is above every Connected Folder and lives in the menu-bar popover, so this shows or hides
      // the popover from any window, with or without a Connected Folder. It goes to the host, not to a window.
      ...(ampleFileAgentPopoverHosted() ? [
        { id: "toggle-amplefile-agent", label: "Toggle AmpleFile Agent", accelerator: "CommandOrControl+J", click: () => { void toggleAmpleFileAgentPopover(); } },
        { type: "separator" },
      ] as MenuItemConstructorOptions[] : []),
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      ...(!app.isPackaged ? [{ type: "separator" }, { role: "toggleDevTools" }] as MenuItemConstructorOptions[] : []),
      { type: "separator" },
      { role: "togglefullscreen" },
    ];
  }
  const items: MenuItemConstructorOptions[] = [
    { id: "open-capabilities", label: "Skills && Extensions", accelerator: "CommandOrControl+Shift+S", enabled: state.connectedFolderOpen, click: menuCommand("open-capabilities") },
    { label: "Shortcut Keys", accelerator: "CommandOrControl+/", click: menuCommand("open-keyboard-shortcuts") },
  ];
  if (process.platform !== "darwin") {
    items.push(
      ...checkForUpdatesMenuItems(() => sendRendererMenuCommand("check-for-updates")),
      { type: "separator" },
      { label: `About ${productName} ${applicationVersion}`, click: menuCommand("open-about") },
    );
  }
  return items;
}

/** The AmpleFile Agent popover hangs from the menu-bar (or tray) icon, which only the Mac and Windows have. */
function ampleFileAgentPopoverHosted(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}

function macApplicationMenu(): MenuItemConstructorOptions[] {
  if (process.platform !== "darwin") return [];
  return [{
    label: productName,
    submenu: [
      { role: "about" },
      ...checkForUpdatesMenuItems(() => {
        void checkForUpdatesFromMenu().catch((error) => {
          console.warn(`${productName} could not present the update check: ${errorMessage(error)}`);
        });
      }, { separator: false }),
      { type: "separator" },
      { label: "Settings...", accelerator: "Command+,", click: menuCommand("open-settings") },
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { id: "quit-connected-folder", label: `Quit ${productName}`, accelerator: "Command+Q", click: requestApplicationQuit },
    ],
  }];
}

function macWindowMenu(): MenuItemConstructorOptions[] {
  if (process.platform !== "darwin") return [];
  return [{ role: "windowMenu" }];
}

function macEditMenuAdditions(): MenuItemConstructorOptions[] {
  if (process.platform !== "darwin") return [];
  return [
    { type: "separator" },
    {
      label: "Substitutions",
      submenu: [
        { role: "showSubstitutions" },
        { type: "separator" },
        { role: "toggleSmartQuotes" },
        { role: "toggleSmartDashes" },
        { role: "toggleTextReplacement" },
      ],
    },
    {
      label: "Speech",
      submenu: [
        { role: "startSpeaking" },
        { role: "stopSpeaking" },
      ],
    },
    { type: "separator" },
    { label: "Emoji && Symbols", accelerator: "Control+Command+Space", click: () => app.showEmojiPanel() },
  ];
}

/** The Linux and Windows title bar's menus: in the window that asked, with that window's check marks. */
function popupApplicationSubmenu(menuId: unknown, bounds: unknown, window: BrowserWindow | null): void {
  const entry = fileManagerWindows.entry(window);
  if (!entry || !isApplicationMenuId(menuId)) return;
  const point = menuPopupPoint(bounds);
  Menu.buildFromTemplate(buildApplicationSubmenuTemplate(menuId, entry.menuState)).popup({ window: entry.window, x: point.x, y: point.y });
}

function isApplicationMenuId(value: unknown): value is ApplicationMenuId {
  return value === "file" || value === "edit" || value === "view" || value === "help";
}

function menuPopupPoint(value: unknown): { x: number; y: number } {
  const rawX = isRecord(value) ? Number(value.x) : Number.NaN;
  const rawY = isRecord(value) ? Number(value.y) : Number.NaN;
  return {
    x: Number.isFinite(rawX) ? Math.max(0, Math.round(rawX)) : 0,
    y: Number.isFinite(rawY) ? Math.max(0, Math.round(rawY)) : desktopTitleBarHeight,
  };
}

/**
 * A menu command goes to the window the menu was used in when that is a file
 * manager window, else the front one; with no window open, the windows come
 * back first and the front one takes it.
 */
function sendRendererMenuCommand(command: RendererMenuCommand, menuWindow?: Electron.BaseWindow | null): void {
  if (modelContextWindow?.handleMenuCommand(command)) return;
  const window = fileManagerWindows.target(menuWindow)?.window;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    if (app.isReady() && !quitting && !quittingForUpdate) {
      void ensureWindow().then(() => sendRendererMenuCommand(command)).catch(reportStartupError);
    }
    return;
  }
  showFileManagerWindow(window);
  sendToRenderer(window.webContents, "amplefile:menu-command", command);
}

/** The application menu's check marks and enabled items follow the front window. */
function refreshApplicationMenuState(): void {
  const state = fileManagerWindows.menuState();
  const menu = Menu.getApplicationMenu();
  const showHidden = menu?.getMenuItemById("show-hidden-files");
  if (showHidden) showHidden.checked = state.showHiddenFiles;
  setMenuItemEnabled(menu, "show-hidden-files", state.folderTabsOpen);
  setMenuItemEnabled(menu, "new-chat", state.connectedFolderOpen);
  setMenuItemEnabled(menu, "refresh", state.folderTabsOpen);
  setMenuItemEnabled(menu, "get-info", state.folderTabsOpen);
  setMenuItemEnabled(menu, "open-terminal", state.terminalFolderOpen === true);
  setMenuItemEnabled(menu, "close-tab", state.folderTabsOpen);
  const showTabBar = menu?.getMenuItemById("show-tab-bar");
  if (showTabBar) showTabBar.checked = state.showTabBar;
  for (const id of ["new-tab", "show-tab-bar", "previous-tab", "next-tab"]) setMenuItemEnabled(menu, id, state.folderTabsOpen);
  setMenuItemEnabled(menu, "open-capabilities", state.connectedFolderOpen);
}

function setMenuItemEnabled(menu: Menu | null, id: string, enabled: boolean): void {
  const item = menu?.getMenuItemById(id);
  if (item) item.enabled = enabled;
}

function configureUpdater(): void {
  // Ad hoc verification builds use a separate identity and must never touch
  // the production update feed or production AmpleFile Safe Storage key.
  if (desktopUpdater || localMacSmokeBuild) return;
  // An RPM from the Fedora package repository updates with the system's
  // software; AmpleFile only offers the restart once dnf replaced its files.
  desktopUpdater = createSystemPackageUpdates({
    productName,
    repositoryId: productIdentity.linuxPackageRepositoryId,
    getWindows: () => fileManagerWindows.windows(),
    prepareToRestart: shutdownForUpdateInstall,
  });
  if (desktopUpdater) {
    desktopUpdater.start();
    return;
  }
  desktopUpdater = new DesktopUpdater({
    // Its questions go over the front window; its status and progress reach every window.
    getWindow: frontWindow,
    getWindows: () => fileManagerWindows.windows(),
    prepareToInstall: shutdownForUpdateInstall,
    // The local API, Pi runtime, and act token are already gone, so the
    // window cannot work again: never offer the update as ready here.
    onInstallFailedAfterShutdown: ({ message, relaunch }) => {
      console.error(`${productName} update install failed after shutdown; ${relaunch ? "restarting" : "quitting"}: ${message}`);
      if (relaunch) app.relaunch();
      app.quit();
    },
  });
  desktopUpdater.start();
}

/**
 * Whether this build has an update feed to check: the updater's own answer,
 * or before it starts the same feed test it uses. Linux previews (including
 * an RPM whose updates the system's package manager installs), unpackaged
 * runs, and the Mac local smoke build have none.
 */
function updatesSupportedHere(): boolean {
  if (desktopUpdater) return desktopUpdater.supported;
  return !localMacSmokeBuild && hasPackagedDesktopUpdateFeed({ isPackaged: app.isPackaged, platform: process.platform, resourcesPath: process.resourcesPath });
}

/** Check for Updates… (after a separator unless `separator` is false), only where an update check can do something. */
function checkForUpdatesMenuItems(click: () => void, { separator = true } = {}): MenuItemConstructorOptions[] {
  if (!updatesSupportedHere()) return [];
  return [...(separator ? [{ type: "separator" as const }] : []), { label: "Check for Updates...", click }];
}

function getUpdateStatus(): DesktopUpdateStatus {
  return desktopUpdater?.getStatus() ?? {
    supported: false,
    phase: "unsupported",
    currentVersion: applicationVersion,
    availableVersion: null,
    progressPercent: null,
    checkedAt: null,
    message: "Updates are not available in this build.",
    error: null,
  };
}

function checkForUpdates(interactive = true): Promise<DesktopUpdateStatus> {
  return desktopUpdater?.check(interactive) ?? Promise.resolve(getUpdateStatus());
}

async function checkForUpdatesFromMenu(): Promise<void> {
  const status = await checkForUpdates(true);
  const window = frontWindow() ?? undefined;
  if (status.phase === "available") {
    const result = window
      ? await dialog.showMessageBox(window, {
        type: "info",
        message: status.message,
        detail: "AmpleFile can download the update now and restart when it is ready.",
        buttons: ["Download and Install", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      : await dialog.showMessageBox({
        type: "info",
        message: status.message,
        detail: "AmpleFile can download the update now and restart when it is ready.",
        buttons: ["Download and Install", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
    if (result.response === 0) await desktopUpdater?.updateNow();
    return;
  }
  if (status.phase === "ready") {
    const result = window
      ? await dialog.showMessageBox(window, {
        type: "info",
        message: status.message,
        buttons: ["Restart and Install", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      : await dialog.showMessageBox({
        type: "info",
        message: status.message,
        buttons: ["Restart and Install", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
    if (result.response === 0) await desktopUpdater?.install();
    return;
  }
  const options = {
    type: status.phase === "error" ? "error" as const : "info" as const,
    message: status.message,
    ...(status.error ? { detail: status.error } : {}),
    buttons: ["OK"],
    noLink: true,
  };
  if (window) await dialog.showMessageBox(window, options);
  else await dialog.showMessageBox(options);
}

function configureStableUserDataPath(): void {
  const useInstalledProductData = ampleFileDesktopUsesInstalledProductData({
    executablePath: process.execPath,
    productName,
    isPackaged: app.isPackaged,
    fileExists: existsSync,
  });
  const target = ampleFileDesktopUserDataPath({
    appDataPath: app.getPath("appData"),
    productName,
    useInstalledProductData,
    override: ampleFileDesktopStateOverride(process.env),
  });
  if (app.getPath("userData") !== target) app.setPath("userData", target);
}

function configureCliEnvironment(): void {
  // Every shell a Worker or the AmpleFile Agent opens must address the same
  // profile as the desktop process that launched it. Development and
  // installed builds intentionally use different userData roots, so leaving
  // this unset can expose a different Connected Folder registry through an
  // installed AmpleFile CLI on PATH.
  process.env.AMPLEFILE_CLI_STATE_DIR = app.getPath("userData");
  if (process.platform === "linux" && !app.isPackaged) {
    const launch = prepareLinuxDevelopmentCli({ repoRoot, stateDirectory: app.getPath("userData"), electronPath: process.execPath });
    process.env.PATH = `${launch.binDirectory}${delimiter}${process.env.PATH ?? ""}`;
    process.env.AMPLEFILE_CLI_APP = launch.appPath;
    return;
  }
  if (!app.isPackaged || !["win32", "darwin", "linux"].includes(process.platform)) return;
  const executableDirectory = dirnameFromFile(process.execPath);
  const binDirectory = process.platform === "darwin"
    ? resolve(executableDirectory, "..", "bin")
    : join(executableDirectory, "bin");
  const pathKey = Object.keys(process.env).find((key) => key.toLocaleLowerCase() === "path") ?? "Path";
  const currentPath = process.env[pathKey] ?? "";
  const alreadyPresent = currentPath
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .some((entry) => samePath(entry, binDirectory));
  if (!alreadyPresent) process.env[pathKey] = currentPath ? `${binDirectory}${delimiter}${currentPath}` : binDirectory;
  // Agent shell tools inherit this process environment. Pinning the executable
  // makes their CLI calls address this exact installed AmpleFile build.
  process.env.AMPLEFILE_CLI_APP = process.execPath;
}

function createFolderGrant(connectedFolderRoot: string): string {
  cleanupFolderGrants();
  const id = randomUUID();
  folderGrants.set(id, { connectedFolderRoot: resolve(connectedFolderRoot), expiresAt: Date.now() + folderGrantTtlMs });
  return id;
}

function consumeLocalFolderGrant(input: { connectedFolderRoot: string; grantId: string }): boolean {
  cleanupFolderGrants();
  const grant = folderGrants.get(input.grantId);
  folderGrants.delete(input.grantId);
  return Boolean(grant && grant.expiresAt >= Date.now() && samePath(grant.connectedFolderRoot, input.connectedFolderRoot));
}

function cleanupFolderGrants(): void {
  const now = Date.now();
  for (const [id, grant] of folderGrants) {
    if (grant.expiresAt <= now) folderGrants.delete(id);
  }
}

type ConnectedFolderPathAction = "open" | "open-native" | "reveal";

function connectedFolderPathRequest(value: unknown, requireAction = true): { connectedFolderId: string; path: string; action: ConnectedFolderPathAction } {
  if (!isRecord(value)) throw new Error("A Connected Folder file request is required.");
  const connectedFolderId = typeof value.connectedFolderId === "string" ? value.connectedFolderId.trim() : "";
  const path = typeof value.path === "string" ? value.path : "";
  const action = value.action === "reveal" || value.action === "open-native" || value.action === "open"
    ? value.action
    : "open";
  if (!connectedFolderId) throw new Error("A Connected Folder id is required.");
  if (!path || path.includes("\0") || isAbsolute(path)) throw new Error("A relative Connected Folder file path is required.");
  if (requireAction && value.action !== undefined && value.action !== "reveal" && value.action !== "open-native" && value.action !== "open") {
    throw new Error("Unsupported Connected Folder file action.");
  }
  return { connectedFolderId, path, action };
}

function launchOpenWith(plan: OpenWithLaunchPlan): Promise<void> {
  if (plan.kind === "exec") {
    return new Promise((resolveLaunch, rejectLaunch) => {
      execFile(plan.command, plan.args, { env: plan.env, cwd: plan.cwd }, (error) => error ? rejectLaunch(error) : resolveLaunch());
    });
  }
  return new Promise((resolveLaunch, rejectLaunch) => {
    const child = spawn(plan.command, plan.args, { detached: true, stdio: "ignore", env: plan.env, cwd: plan.cwd });
    child.once("error", rejectLaunch);
    child.once("spawn", () => {
      child.unref();
      resolveLaunch();
    });
  });
}

/**
 * An item in Desktop, Documents, or Downloads (the file manager's Standard
 * Folders). The host resolves the folder from the home folder; the renderer
 * supplies only its id and a relative path, held to the same path policy and
 * real-path containment as a Connected Folder item.
 */
async function resolveStandardFolderItem(standardFolderId: string, itemPath: string): Promise<string> {
  if (!isStandardFolderId(standardFolderId)) throw new Error("That standard folder isn’t on this computer.");
  const root = await realpath(standardFolderRoot(standardFolderId));
  const candidate = itemPath ? resolveStandardFolderPath(standardFolderId, itemPath) : standardFolderRoot(standardFolderId);
  const resolvedCandidate = await realpath(candidate);
  // The folder itself (Show in Finder with nothing selected) is its own root.
  if (resolvedCandidate !== root) assertPathInsideRoot(root, resolvedCandidate);
  return resolvedCandidate;
}

function standardFolderPathRequest(value: unknown, allowRoot = false): { standardFolderId: string; path: string; action: ConnectedFolderPathAction } {
  if (!isRecord(value)) throw new Error("A standard folder file request is required.");
  const standardFolderId = typeof value.standardFolderId === "string" ? value.standardFolderId : "";
  const path = typeof value.path === "string" ? value.path : "";
  if (!isStandardFolderId(standardFolderId)) throw new Error("That standard folder isn’t on this computer.");
  if ((!path && !allowRoot) || path.includes("\0") || isAbsolute(path)) throw new Error("A relative path inside the folder is required.");
  const action = value.action === "reveal" || value.action === "open-native" ? value.action : "open";
  return { standardFolderId, path, action };
}

async function resolveConnectedFolderItem(connectedFolderId: string, itemPath: string): Promise<string> {
  const connectedFolder = await getConnectedFolder(connectedFolderId);
  const connectedFolderRoot = await realpath(connectedFolder.connectedFolderRoot);
  const candidate = resolve(connectedFolderRoot, itemPath);
  assertPathInsideRoot(connectedFolderRoot, candidate);
  const resolvedCandidate = await realpath(candidate);
  assertPathInsideRoot(connectedFolderRoot, resolvedCandidate);
  return resolvedCandidate;
}

/** The items one drag carries, by place: at least one, at most as many as a paste takes. */
function placeDragRequest(value: unknown, idKey: "connectedFolderId" | "standardFolderId"): { id: string; paths: string[] } {
  if (!isRecord(value)) throw new Error("Choose items to drag.");
  const id = typeof value[idKey] === "string" ? value[idKey] as string : "";
  const paths = Array.isArray(value.paths) ? value.paths : typeof value.path === "string" ? [value.path] : [];
  if (!id || !paths.length || paths.length > 5_000) throw new Error("Choose items to drag.");
  return {
    id,
    paths: paths.map((path) => {
      if (typeof path !== "string" || !path || path.includes("\0") || isAbsolute(path)) throw new Error("A relative path inside the folder is required.");
      return path;
    }),
  };
}

/**
 * One dragged item: a file, folder, or symbolic link, held to the place's
 * path policy (no symbolic link in the folders above it), then resolved where
 * it really is. A link drags as the link itself, never what it points to.
 */
async function draggableItem(policyPath: string, resolveItem: () => Promise<string>): Promise<string> {
  const info = await lstat(policyPath).catch(() => null);
  if (!info) throw new Error(`“${basename(policyPath)}” isn’t there anymore.`);
  if (info.isSymbolicLink()) return policyPath;
  if (!info.isFile() && !info.isDirectory()) throw new Error("Only files and folders can be dragged out.");
  return resolveItem();
}

function startItemDrag(sender: Electron.WebContents, items: string[]): boolean {
  const icon = nativeImage.createFromPath(join(resolveDesktopAssetsDir(), "icon-32.png"));
  if (icon.isEmpty() || !items.length) return false;
  sender.startDrag({ file: items[0]!, files: items, icon });
  return true;
}

/**
 * The Connected Folder a window last showed. Each window has its own. The
 * Open Recent list records Connected Folders in the order any window showed
 * them; the window's title (and its represented folder on a Mac) and the
 * window a Worker's browser page appears in follow `shownConnectedFolder`,
 * which is none while the tab in front is a plain folder, Trash, or Recents.
 * Nothing else reads it: the kernel resolves the CLI's context from the
 * caller's directory, and the AmpleFile Agent works above every Connected
 * Folder, so neither follows a window.
 */
async function setWindowConnectedFolder(window: BrowserWindow | null, connectedFolderId: string | null): Promise<void> {
  const entry = fileManagerWindows.entry(window);
  if (!entry) return;
  const generation = ++entry.connectedFolderGeneration;
  if (connectedFolderId === null) {
    entry.connectedFolder = null;
    applyNativeActiveConnectedFolderToWindow(entry);
    return;
  }

  // The renderer supplies identity only. Name and root are always loaded from
  // the host-owned registry before they reach native window or OS APIs.
  const connectedFolder = await getConnectedFolder(connectedFolderId);
  if (generation !== entry.connectedFolderGeneration || fileManagerWindows.entry(entry.window) !== entry) return;
  entry.connectedFolder = { id: connectedFolder.id, name: connectedFolder.name, connectedFolderRoot: connectedFolder.connectedFolderRoot };
  applyNativeActiveConnectedFolderToWindow(entry);
  if (process.platform === "darwin") app.addRecentDocument(connectedFolder.connectedFolderRoot);
  if (process.platform === "linux") void updateRecentConnectedFolders((ids) => recordRecentConnectedFolder(ids, connectedFolder.id));
}

async function validateNativeFileMenuEntry(request: NativeFileMenuRequest): Promise<void> {
  let info;
  if (request.capabilities.link) {
    // A link row is checked as the link itself (a broken one included), never through it.
    const linkPath = request.standardFolderId
      ? isStandardFolderId(request.standardFolderId) ? resolveStandardFolderPath(request.standardFolderId, request.path, homedir(), { finalLink: true }) : ""
      : resolveConnectedFolderPath((await getConnectedFolder(request.connectedFolderId)).connectedFolderRoot, request.path, { finalLink: true });
    if (!linkPath || !(await lstat(linkPath).catch(() => null))?.isSymbolicLink()) throw new Error("The native file menu entry no longer matches this folder.");
    return;
  }
  if (request.standardFolderId) {
    info = await stat(await resolveStandardFolderItem(request.standardFolderId, request.path));
  } else if (request.path) {
    info = await stat(await resolveConnectedFolderItem(request.connectedFolderId, request.path));
  } else {
    const connectedFolder = await getConnectedFolder(request.connectedFolderId);
    info = await stat(await realpath(connectedFolder.connectedFolderRoot));
  }
  if ((request.kind === "file" && !info.isFile()) || (request.kind === "folder" && !info.isDirectory())) {
    throw new Error("The native file menu entry no longer matches this Connected Folder.");
  }
}

function popupNativeFileMenu(request: NativeFileMenuRequest, window: BrowserWindow | null): Promise<NativeFileMenuCommand | null> {
  return popupNativeCommandMenu(nativeFileMenuItems(request, process.platform), request.point, window);
}

function popupNativeTabMenu(request: NativeTabMenuRequest, window: BrowserWindow | null): Promise<NativeTabMenuCommand | null> {
  return popupNativeCommandMenu(nativeTabMenuItems(request), request.point, window);
}

type NativeCommandMenuItem<Command extends string> =
  | { type: "separator" }
  | { type: "item"; label: string; command: Command; sublabel?: string; enabled?: false; icon?: "amplefile" }
  | { type: "submenu"; label: string; items: NativeCommandMenuItem<Command>[] };

let linuxClipboardOwnerInstance: Promise<LinuxClipboardOwner | null> | undefined;

/** The verified X11 clipboard helper when this launch can use it (docs/linux-build.md); null otherwise. */
function linuxClipboardOwner(): Promise<LinuxClipboardOwner | null> {
  linuxClipboardOwnerInstance ??= (async () => {
    if (process.platform !== "linux" || !linuxClipboardHelperUsable({ ozonePlatform: app.commandLine.getSwitchValue("ozone-platform"), display: process.env.DISPLAY })) return null;
    const helperPath = join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "out", "included-tools"), "clipboard-helper", "amplefile-clipboard");
    if (!(await verifiedClipboardHelper(helperPath))) {
      console.warn(`${productName} copies files with Electron's clipboard: the bundled clipboard helper is missing or changed.`);
      return null;
    }
    return new LinuxClipboardOwner({ helperPath, log: (message) => console.warn(`${productName} ${message}`) });
  })();
  return linuxClipboardOwnerInstance;
}

/**
 * The files on the system pasteboard (Finder's or a Linux file manager's Copy or Cut), newest format first.
 * A Mac's pasteboard has no Cut marker, but carries the token an AmpleFile Cut wrote beside the files; on
 * Linux the reading says whether the files were cut (the GNOME and KDE markers). Empty when it holds no
 * files. Elsewhere the desktop reads no files from it, only its text, where AmpleFile writes files as
 * their paths.
 */
async function readPasteboardFiles(): Promise<PasteboardFiles> {
  if (process.platform === "linux") {
    // The helper reads off the main thread, and also reads another Chromium app's files; Electron's read is the fallback.
    const files = await (await linuxClipboardOwner())?.readFiles();
    return files ?? readLinuxClipboardFiles(clipboard);
  }
  if (process.platform !== "darwin") return { paths: [], operation: null, unreadable: true, text: clipboard.readText() };
  const listed = readPasteboardFileList(clipboard.read("NSFilenamesPboardType"));
  if (listed.paths.length) return { paths: listed.paths, operation: null, cutToken: listed.cutToken };
  const url = clipboard.read("public.file-url").trim();
  if (url.startsWith("file://")) {
    try { return { paths: [fileURLToPath(url)], operation: null }; } catch { return { paths: [], operation: null }; }
  }
  return { paths: [], operation: null };
}

/** Empties the pasteboard. On Linux the clipboard helper stops offering its files too. */
function clearPasteboard(): void {
  if (process.platform === "linux") void linuxClipboardOwner().then((owner) => owner?.release()).catch(() => undefined);
  clipboard.clear();
}

/**
 * Puts files on the system pasteboard the way Finder's (or a Linux file manager's) Copy or Cut does, so it
 * can paste them. A Mac's pasteboard has no Cut marker: a Cut's `token` goes into the file list beside the
 * paths. On Linux a Cut carries the GNOME and KDE cut markers instead. Either way the host remembers the
 * Cut (fileClipboard).
 */
async function writePasteboardFilePaths(paths: readonly string[], token: string | null = null, operation: "copy" | "cut" = "copy"): Promise<void> {
  if (process.platform === "linux") {
    // The helper offers GNOME's format, the URI list and text together; Electron alone offers only the URI list.
    const owner = await linuxClipboardOwner();
    if (owner && await owner.offer(linuxFileClipboardOffers(paths, operation))) return;
    writeLinuxClipboardFiles(clipboard, paths);
    return;
  }
  if (process.platform !== "darwin") { clipboard.writeText(pasteboardFileText(paths)); return; }
  clipboard.writeBuffer("NSFilenamesPboardType", Buffer.from(pasteboardFileList(paths, token), "utf8"));
}

/** The windows' clipboard: the Cut, kept for every window, and Paste. Each change of the Cut reaches every window. */
const fileClipboard = new FileClipboard({
  read: readPasteboardFiles,
  // The windows' clipboard writes only a Cut: on Linux that is the cut markers, on a Mac the token.
  write: (paths, token) => writePasteboardFilePaths(paths, token, "cut"),
  clear: clearPasteboard,
  exists: existsOnDisk,
  token: () => process.platform === "darwin" ? randomBytes(16).toString("hex") : null,
  changed: (nativePaths) => {
    const cut = nativePaths ? { nativePaths: [...nativePaths] } : null;
    for (const window of fileManagerWindows.windows()) {
      if (!window.webContents.isDestroyed()) sendToRenderer(window.webContents, "amplefile:file-clipboard:cut-changed", cut);
    }
  },
});

/** Text AmpleFile puts on the clipboard (a sign-in code, an address): the pasteboard holds it now, so nothing is cut. */
function copyTextToClipboard(text: string): void {
  clipboard.writeText(text);
  fileClipboard.replaced();
}

/**
 * A menu label as written, for Electron: it reads a single "&" as a keyboard
 * mnemonic and drops it, so "Skills & Extensions…" showed as "Skills
 * Extensions…". Doubling it shows the "&" itself, in file and tab names too.
 */
function nativeMenuLabel(label: string): string {
  return label.replace(/&/g, "&&");
}

/**
 * Shows a native menu at a point in the app's CSS pixels, in the window that
 * asked; resolves with the chosen command, or null. Every native context menu
 * goes through here.
 */
function popupNativeCommandMenu<Command extends string>(items: NativeCommandMenuItem<Command>[], point: { x: number; y: number }, window: BrowserWindow | null): Promise<Command | null> {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return Promise.reject(new Error("The AmpleFile window is not available."));
  }
  return new Promise((resolveCommand) => {
    let settled = false;
    const finish = (command: Command | null) => {
      if (settled) return;
      settled = true;
      resolveCommand(command);
    };
    const template = (entries: NativeCommandMenuItem<Command>[]): MenuItemConstructorOptions[] => entries.map((item) => {
      if (item.type === "separator") return { type: "separator" };
      if (item.type === "submenu") return { label: nativeMenuLabel(item.label), submenu: template(item.items) };
      return {
        label: nativeMenuLabel(item.label),
        ...(item.sublabel ? { sublabel: item.sublabel } : {}),
        ...(item.icon === "amplefile" ? ampleFileMenuIcon() : {}),
        enabled: item.enabled !== false,
        click: () => finish(item.command),
      };
    });
    // The point is in the app's CSS pixels; the menu goes where the pointer is in the zoomed window.
    const zoom = window.webContents.getZoomFactor() || 1;
    Menu.buildFromTemplate(template(items)).popup({
      window,
      x: Math.round(point.x * zoom),
      y: Math.round(point.y * zoom),
      // The menu can report closing before the chosen item's click runs.
      callback: () => setTimeout(() => finish(null), 0),
    });
  });
}

function applyNativeActiveConnectedFolderToWindow(entry: FileManagerWindowEntry<BrowserWindow, FolderLocation> | null): void {
  const window = entry?.window;
  if ((process.platform !== "darwin" && process.platform !== "linux") || !entry || !window || window.isDestroyed()) return;
  // The window title names the Connected Folder shown, as on the Mac, so task
  // switchers and window lists (niri's included) tell windows apart.
  const shown = shownConnectedFolder(entry);
  if (process.platform === "darwin") window.setRepresentedFilename(shown?.connectedFolderRoot ?? "");
  window.setTitle(shown?.name ?? productName);
}

/**
 * Applies a change to Linux's Open Recent record (see
 * recent-connected-folders.ts), forgetting disconnected Connected Folders,
 * and refreshes the menu entries. Changes run one at a time.
 */
function updateRecentConnectedFolders(change: (ids: string[]) => string[]): Promise<void> {
  const run = async () => {
    const path = recentConnectedFoldersPath(app.getPath("userData"));
    const registered = await listConnectedFolders();
    const stored = await readRecentConnectedFolders(path);
    const next = pruneRecentConnectedFolders(change(stored), registered);
    if (next.join("\n") !== stored.join("\n")) await writeRecentConnectedFolders(path, next);
    recentConnectedFolderEntries = recentConnectedFolderMenuEntries(next, registered, homedir());
  };
  recentConnectedFoldersUpdate = recentConnectedFoldersUpdate.then(run).catch((error: unknown) => {
    console.warn(`${productName} could not update Open Recent: ${errorMessage(error)}`);
  });
  return recentConnectedFoldersUpdate;
}

/** File → Open Recent on Linux: recently shown Connected Folders, then Clear Menu. */
function linuxOpenRecentMenuItem(): MenuItemConstructorOptions {
  return {
    label: "Open Recent",
    submenu: [
      ...recentConnectedFolderEntries.map((entry): MenuItemConstructorOptions => ({
        label: nativeMenuLabel(entry.label),
        click: () => { void openRecentConnectedFolder(entry.id); },
      })),
      ...(recentConnectedFolderEntries.length ? [{ type: "separator" as const }] : []),
      { label: "Clear Menu", enabled: recentConnectedFolderEntries.length > 0, click: () => { void updateRecentConnectedFolders(() => []); } },
    ],
  };
}

/** Opens a recent Connected Folder the way a launcher's folder argument does: registered ones only. */
async function openRecentConnectedFolder(connectedFolderId: string): Promise<void> {
  try {
    const connectedFolder = await getConnectedFolder(connectedFolderId);
    pendingOpenPaths.push(connectedFolder.connectedFolderRoot);
    await drainPendingOpenPaths();
  } catch (error) {
    console.warn(`${productName} could not open a recent Connected Folder: ${errorMessage(error)}`);
    await updateRecentConnectedFolders((ids) => ids.filter((id) => id !== connectedFolderId));
  }
}

// Folders the system asked AmpleFile to open: Finder's open-file on macOS, a
// desktop launcher's arguments on Linux, a second launch's arguments, and
// FileManager1 calls. Each opens at the place that holds it
// (folder-locations.ts): a registered Connected Folder, deepest first, at the
// right folder; else a Standard Folder; else the computer place, under the
// Standard Folder rules. A file opens its folder with the file selected.
// Nothing is registered: connecting a folder stays an explicit act.
//
// A folder opens in the most recently focused window, as it did when there was
// one window, so an app that asks again and again to show a folder never piles
// windows up. The further folders of one request (Finder handing over several
// at once, a launcher given several, a FileManager1 call naming several
// folders) each open in a new window, as a system file manager does
// (finder-open-paths.ts, linux-file-manager-host.ts).
async function drainPendingOpenPaths(): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  if (openPathDrainPromise) {
    await openPathDrainPromise;
    if (pendingOpenPaths.length) await drainPendingOpenPaths();
    return;
  }

  openPathDrainPromise = (async () => {
    while (pendingOpenPaths.length) {
      const entry = pendingOpenPaths.shift();
      const target = typeof entry === "string" ? { path: entry, reveal: false, newWindow: false } : entry;
      if (!target?.path) continue;
      const opensNewWindow = target.newWindow && fileManagerWindows.size > 0;
      if (!opensNewWindow) showFileManagerWindow(await ensureWindow());
      const location = await folderLocationForOpenPath(target.path, target.reveal);
      if (!location) {
        console.warn(`${productName} could not open a folder that is not on this computer: ${target.path}`);
        continue;
      }
      const window = opensNewWindow ? await createFileManagerWindow({ cascadeFrom: frontWindow(), fresh: true }) : await ensureWindow();
      showFileManagerWindow(window);
      handOpenLocation(window, location);
    }
  })().finally(() => {
    openPathDrainPromise = null;
  });

  await openPathDrainPromise;
  if (pendingOpenPaths.length) await drainPendingOpenPaths();
}

/** Hands a window a place to show; its renderer takes it now, or once it has loaded. */
function handOpenLocation(window: BrowserWindow, location: FolderLocation): void {
  if (location.place.kind === "connected-folder") void setWindowConnectedFolder(window, location.place.id).catch(() => undefined);
  const request = { token: randomUUID(), location };
  if (!fileManagerWindows.handOpenLocation(window, request)) return;
  if (!window.isDestroyed() && !window.webContents.isDestroyed()) sendToRenderer(window.webContents, "amplefile:file-manager:open-location", request);
}

/**
 * File → New Window and Open in New Window: another window, a step from the
 * one it came from, at the given folder, else at the folder the window it
 * came from shows, else at the home folder.
 */
async function openNewWindow(options: { from?: Electron.BaseWindow | null; location?: FolderLocation | null } = {}): Promise<BrowserWindow> {
  const source = fileManagerWindows.target(options.from);
  const shown = source?.location;
  const location = options.location
    ?? (shown ? { place: shown.place, path: shown.path, select: null } : null)
    ?? await folderLocationForOpenPath(homedir());
  const window = await createFileManagerWindow({ cascadeFrom: source?.window ?? null, fresh: true });
  showFileManagerWindow(window);
  if (location) handOpenLocation(window, location);
  return window;
}

function reportWindowError(error: unknown): void {
  console.warn(`${productName} could not open a window: ${errorMessage(error)}`);
}

/** Where a path the system handed over opens, or null when nothing is there (Finder may pass a path that moved before AmpleFile was ready). */
async function folderLocationForOpenPath(path: string, reveal = false): Promise<FolderLocation | null> {
  try {
    return await resolveFolderLocation(path, await listConnectedFolders(), homedir(), { reveal });
  } catch (error) {
    console.warn(`${productName} could not open ${path}: ${errorMessage(error)}`);
    return null;
  }
}

function assertPathInsideRoot(connectedFolderRoot: string, candidate: string): void {
  const child = relative(connectedFolderRoot, candidate);
  if (!child || /^\.\.(?:[\\/]|$)/.test(child) || isAbsolute(child)) throw new Error("The requested item is outside this Connected Folder.");
}

function updateAgentPowerState(activeTurns: number): void {
  activeAgentTurns = Math.max(0, activeTurns);
  updateTrayTooltip();
  updateTrayPulse();
  if (activeTurns > 0 && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start("prevent-app-suspension");
  } else if (activeTurns <= 0 && powerBlockerId !== null) {
    if (powerSaveBlocker.isStarted(powerBlockerId)) powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
}

/**
 * The built-in browser (docs/built-in-browser.md); created once the app is
 * ready, before any window. Each page belongs to one window
 * (browser-page-homes.ts); a Worker's page goes to the window showing that
 * Worker's Connected Folder, else the front window.
 */
function ensureBuiltInBrowser(): BuiltInBrowser {
  builtInBrowser ??= new BuiltInBrowser({
    windows: () => fileManagerWindows.windows(),
    workerWindow: (owner) => fileManagerWindows.workerWindow(owner)?.window ?? null,
    send: (window, channel, ...payload) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) sendToRenderer(window.webContents, channel, ...payload);
    },
    openExternal,
    downloadsPath: () => app.getPath("downloads"),
    sitePermissionsPath: join(app.getPath("userData"), "browser-site-permissions.json"),
    historyPath: join(app.getPath("userData"), "browser-history.json"),
    // The app names itself, as Claude's browser does; Google's sign-in refuses a browser posing as plain Chrome.
    userAgentProduct: `${productionProductName}/${applicationVersion}`,
    onViewAttached: (window) => railTooltipOverlays.get(window.id)?.raise(),
    // An address the person copied from a page replaces what was cut.
    onCopied: () => fileClipboard.replaced(),
    // A page puts a picture on the clipboard in its own time, or fails to: look again shortly, and forget the Cut
    // only once the pasteboard no longer holds it.
    onCopyingImage: () => {
      for (const delay of [300, 2_000]) setTimeout(() => { void fileClipboard.current().catch(() => null); }, delay);
    },
    declaresLocationUse: app.isPackaged,
  });
  return builtInBrowser;
}

async function openExternal(value: string): Promise<void> {
  const url = new URL(value);
  if (!new Set(["https:", "http:", "mailto:"]).has(url.protocol)) throw new Error(`AmpleFile cannot open ${url.protocol} links.`);
  await shell.openExternal(url.toString());
}

async function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  linuxDesktopSettings?.stop();
  void linuxFileManager?.stop();
  modelContextWindow?.dispose();
  // Quitting closes every page. Tabs are not kept: sign-ins and history are what the next launch has.
  builtInBrowser?.dispose();
  for (const id of [...rendererRecoveries.keys()]) clearRendererRecovery(id);
  // Queued act requests must answer unavailable instead of racing a closing
  // Pi runtime, so the act authority is revoked before anything else stops.
  actFacade = null;
  actToken = "";
  resolveAmpleFileAgentLineageParent = null;
  updateAgentPowerState(0);
  const runtime = piRuntime;
  piRuntime = null;
  const computer = desktopHostPromise?.then((host) => host.computerSession?.close()) ?? Promise.resolve();
  shutdownPromise = (async () => {
    const outcomes = await Promise.allSettled([
      withShutdownTimeout(localApiLifetime.close(), "local API"),
      withShutdownTimeout(runtime?.flush() ?? Promise.resolve(), "Pi state"),
      withShutdownTimeout(computer, "desktop sharing"),
      withShutdownTimeout(removeAmpleFileCliActTokenFile(app.getPath("userData")), "CLI act token"),
    ]);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") console.warn(`${productName} shutdown cleanup failed: ${errorMessage(outcome.reason)}`);
    }
  })();
  return shutdownPromise;
}

async function shutdownForUpdateInstall(): Promise<void> {
  quittingForUpdate = true;
  quitting = true;
  destroyTray();
  await shutdown();
  quitCoordinator.allowNativeQuit();
}

async function withShutdownTimeout<T>(promise: Promise<T>, label: string): Promise<T | void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<void>((resolveTimeout) => {
        timeout = setTimeout(() => {
          console.warn(`${productName} shutdown timed out waiting for ${label}; continuing.`);
          resolveTimeout();
        }, shutdownTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** The front file manager window (focused, or focused most recently), or null when none is open. */
function frontWindow(): BrowserWindow | null {
  return fileManagerWindows.mostRecent()?.window ?? null;
}

/** The file manager window an IPC request came from, or null for any other sender. */
function senderWindow(event: IpcMainInvokeEvent | IpcMainEvent): BrowserWindow | null {
  if (event.sender.isDestroyed()) return null;
  const window = BrowserWindow.fromWebContents(event.sender);
  const entry = fileManagerWindows.entry(window);
  return entry && entry.window.webContents === event.sender ? entry.window : null;
}

function requireSenderWindow(event: IpcMainInvokeEvent | IpcMainEvent): BrowserWindow {
  const window = senderWindow(event);
  if (!window) throw new Error("This request requires an AmpleFile window.");
  return window;
}

function showFileManagerWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
  fileManagerWindows.focus(window);
}

/** Brings the front window forward; with none open, the windows that were open come back. */
function showFrontWindow(): void {
  const window = frontWindow();
  if (!window) {
    if (app.isReady()) void ensureWindow().catch(reportStartupError);
    return;
  }
  showFileManagerWindow(window);
}

/**
 * The front window, after bringing back the windows that were open when none
 * is: every window saved in window-state.json (all of them after a quit, the
 * last one after the last window closed), else window 1 at its default place.
 */
function ensureWindow(): Promise<BrowserWindow> {
  const front = frontWindow();
  if (front) return Promise.resolve(front);
  restoreWindowsPromise ??= (async () => {
    const saved = separateRestoredPlacements(currentWindowPlacements(), (bounds) => screen.getDisplayMatching(bounds).workArea, minimumWindowState);
    // Opened together, in slot order; each loads its renderer on its own.
    const opened = await Promise.all((saved.length ? saved : [undefined]).map((placement) => createFileManagerWindow(placement ? { placement } : {})));
    return frontWindow() ?? opened[opened.length - 1]!;
  })().finally(() => { restoreWindowsPromise = null; });
  return restoreWindowsPromise;
}

interface DesktopPreferences {
  closeToTray: boolean;
  trayNoticeShown: boolean;
}

let desktopPreferences: DesktopPreferences = { closeToTray: true, trayNoticeShown: false };

function desktopPreferencesPath(): string {
  return join(app.getPath("userData"), "desktop-preferences.json");
}

function loadDesktopPreferences(): void {
  if (!existsSync(desktopPreferencesPath())) return;
  try {
    const parsed = JSON.parse(readFileSync(desktopPreferencesPath(), "utf8"));
    if (!isRecord(parsed)) return;
    desktopPreferences = {
      closeToTray: typeof parsed.closeToTray === "boolean" ? parsed.closeToTray : true,
      trayNoticeShown: parsed.trayNoticeShown === true,
    };
  } catch (error) {
    console.warn(`${productName} could not read desktop preferences: ${errorMessage(error)}`);
  }
}

function updateDesktopPreferences(update: Partial<DesktopPreferences>): void {
  desktopPreferences = { ...desktopPreferences, ...update };
  try {
    writeFileSync(desktopPreferencesPath(), `${JSON.stringify(desktopPreferences, null, 2)}\n`, "utf8");
  } catch (error) {
    console.warn(`${productName} could not save desktop preferences: ${errorMessage(error)}`);
  }
}

function createTrayIfSupported(): void {
  if (tray || quitting || quittingForUpdate || !["win32", "darwin", "linux"].includes(process.platform)) return;
  const icon = resolveTrayIcon();
  if (!icon) {
    console.warn(`${productName} tray icon was not found; the ${process.platform === "darwin" ? "menu-bar" : "tray"} surface is unavailable.`);
    return;
  }
  tray = new Tray(icon);
  const menu = Menu.buildFromTemplate([
    { label: "AmpleFile Agent", click: () => { void toggleAmpleFileAgentPopover(trayPopoverAnchor()); } },
    { label: `Open ${productName}`, click: () => showFrontWindow() },
    ...checkForUpdatesMenuItems(() => sendRendererMenuCommand("check-for-updates")),
    { type: "separator" },
    { label: `Quit ${productName}`, click: () => app.quit() },
  ]);
  if (process.platform === "darwin") {
    // No persistent context menu on macOS: setContextMenu would swallow the
    // left click. Click opens the AmpleFile Agent popover, right-click the menu,
    // and material dropped on the icon lands in the popover as staged context.
    tray.on("click", () => { void toggleAmpleFileAgentPopover(trayPopoverAnchor()); });
    tray.on("right-click", () => tray?.popUpContextMenu(menu));
    tray.on("drop-files", (_event, files) => {
      void openAmpleFileAgentPopoverWithItems(files.map((file) => ({ kind: "path" as const, value: file })), trayPopoverAnchor());
    });
    tray.on("drop-text", (_event, text) => {
      void openAmpleFileAgentPopoverWithItems([{ kind: "text" as const, value: text }], trayPopoverAnchor());
    });
  } else {
    tray.setContextMenu(menu);
    tray.on("click", () => showFrontWindow());
    tray.on("double-click", () => showFrontWindow());
  }
  updateTrayTooltip();
  updateTrayPulse();
  // Warm the hidden popover renderer off the startup critical path so the
  // first AmpleFile Agent summon paints the ready surface immediately.
  trayWarmupTimer = setTimeout(() => {
    trayWarmupTimer = null;
    if (quitting || quittingForUpdate) return;
    void ensureAmpleFileAgentPopover().then((popover) => popover?.warm()).catch(() => {});
  }, 2_500);
}

/** The menu-bar mark as a 16pt template image for "Connect This Folder" (macOS recolors it). */
function ampleFileMenuIcon(): { icon?: Electron.NativeImage } {
  if (process.platform !== "darwin") return {};
  const path = join(resolveDesktopAssetsDir(), "iconTemplate.png");
  if (!existsSync(path)) return {};
  const image = nativeImage.createFromPath(path);
  if (image.isEmpty()) return {};
  const sized = image.resize({ width: 16, height: 16, quality: "best" });
  sized.setTemplateImage(true);
  return { icon: sized };
}

function resolveTrayIcon(): Electron.NativeImage | string | null {
  if (process.platform === "darwin") return loadTrayTemplate("iconTemplate");
  const iconPath = resolveWindowIcon();
  return existsSync(iconPath) ? iconPath : null;
}

/**
 * A monochrome template image, so macOS recolors the menu-bar item for light
 * and dark menu bars; createFromPath also loads the @2x variant.
 */
function loadTrayTemplate(name: string): Electron.NativeImage | null {
  const path = join(resolveDesktopAssetsDir(), `${name}.png`);
  if (!existsSync(path)) return null;
  const image = nativeImage.createFromPath(path);
  if (image.isEmpty()) return null;
  image.setTemplateImage(true);
  return image;
}

/** The resting icon, then the frames in which the dot fades and returns. */
function trayPulseFrameImages(): Electron.NativeImage[] {
  if (trayPulseFrames) return trayPulseFrames;
  const frames: Electron.NativeImage[] = [];
  for (let frame = 0; ; frame += 1) {
    const image = loadTrayTemplate(frame === 0 ? "iconTemplate" : `iconTemplateWorking${frame}`);
    if (!image) break;
    frames.push(image);
  }
  trayPulseFrames = frames;
  return frames;
}

/**
 * The menu-bar dot pulses while work is running, the way the brand's dot
 * means a Worker or the AmpleFile Agent at work. Reduce Motion keeps it still.
 */
function updateTrayPulse(): void {
  const pulse = tray !== null
    && process.platform === "darwin"
    && activeAgentTurns > 0
    && !systemPreferences.getAnimationSettings().prefersReducedMotion;
  if (!pulse) {
    stopTrayPulse();
    return;
  }
  if (trayPulseTimer) return;
  const frames = trayPulseFrameImages();
  if (frames.length < 2) return;
  let frame = 0;
  trayPulseTimer = setInterval(() => {
    if (!tray) {
      stopTrayPulse();
      return;
    }
    frame = (frame + 1) % frames.length;
    tray.setImage(frames[frame]!);
  }, 200);
}

function stopTrayPulse(): void {
  if (!trayPulseTimer) return;
  clearInterval(trayPulseTimer);
  trayPulseTimer = null;
  const resting = trayPulseFrames?.[0];
  if (tray && resting) tray.setImage(resting);
}

function destroyTray(): void {
  if (trayWarmupTimer) clearTimeout(trayWarmupTimer);
  trayWarmupTimer = null;
  stopTrayPulse();
  tray?.destroy();
  tray = null;
  ampleFileAgentPopover?.destroy();
  ampleFileAgentPopover = null;
}

async function ensureAmpleFileAgentPopover(): Promise<AmpleFileAgentPopover | null> {
  if (quitting || quittingForUpdate) return null;
  if (ampleFileAgentPopover) return ampleFileAgentPopover;
  ampleFileAgentPopoverPromise ??= (async () => {
    const api = await ensureInteractiveLocalApi();
    if (quitting || quittingForUpdate) return null;
    ampleFileAgentPopover = new AmpleFileAgentPopover({
      appProtocol,
      preloadPath: resolveAmpleFileAgentPopoverPreloadPath(),
      additionalArguments: [
        ...productRendererArguments(),
        rendererArgument("api-base-url", api.origin),
        rendererArgument("app-version", applicationVersion),
        rendererArgument("window-material", process.platform === "darwin" && macVibrancySupported ? "vibrancy" : "none"),
      ],
      backgroundColor: windowBackgroundColors[nativeTheme.shouldUseDarkColors ? "dark" : "light"],
      vibrancy: process.platform === "darwin" && macVibrancySupported,
      devTools: !app.isPackaged,
      configureNavigation: configureWindowNavigation,
      onError: (message) => console.warn(`${productName} AmpleFile Agent popover failed to load: ${message}`),
      appWindowBounds: () => {
        const window = fileManagerWindows.windows().find((candidate) => candidate.isVisible() && !candidate.isMinimized());
        return window ? window.getBounds() : null;
      },
    });
    return ampleFileAgentPopover;
  })().finally(() => { ampleFileAgentPopoverPromise = null; });
  return ampleFileAgentPopoverPromise;
}

/** The tray icon asked: its bounds, which Linux StatusNotifierItems leave empty. */
function trayPopoverAnchor(): PopoverAnchor {
  return { kind: "tray", trayBounds: tray?.getBounds() ?? null };
}

/** An AmpleFile window asked (Linux places the popover in it; other platforms use the tray). */
function windowPopoverAnchor(window: Electron.BaseWindow | null | undefined): PopoverAnchor {
  if (process.platform !== "linux") return trayPopoverAnchor();
  const asking = window && !window.isDestroyed() ? window : frontWindow();
  const usable = asking && asking.isVisible() && !asking.isMinimized();
  return { kind: "window", windowBounds: usable ? asking.getBounds() : null };
}

async function toggleAmpleFileAgentPopover(anchor: PopoverAnchor = trayPopoverAnchor()): Promise<void> {
  try {
    const popover = await ensureAmpleFileAgentPopover();
    if (!quitting && !quittingForUpdate) await popover?.toggle(anchor);
  } catch (error) {
    console.warn(`${productName} could not open the AmpleFile Agent popover: ${errorMessage(error)}`);
  }
}

async function openAmpleFileAgentPopoverWithItems(items: AmpleFileAgentStagedItem[], anchor: PopoverAnchor): Promise<void> {
  try {
    const popover = await ensureAmpleFileAgentPopover();
    if (!quitting && !quittingForUpdate) await popover?.stage(items, anchor);
  } catch (error) {
    console.warn(`${productName} could not stage dropped material: ${errorMessage(error)}`);
  }
}

function updateTrayTooltip(): void {
  if (!tray) return;
  tray.setToolTip(activeAgentTurns > 0
    ? `${productName} — working on ${activeAgentTurns === 1 ? "a task" : `${activeAgentTurns} tasks`}`
    : productName);
}

/** Once per profile (`trayNoticeShown` is the persisted once-flag on every platform): AmpleFile kept running without its window. */
function maybeShowStillRunningNotice(): void {
  const notice = stillRunningNotice(process.platform, productName);
  if (!notice || desktopPreferences.trayNoticeShown) return;
  updateDesktopPreferences({ trayNoticeShown: true });
  if (!Notification.isSupported()) return;
  new Notification(notice).show();
}

function closeToTrayStatus(): { supported: boolean; enabled: boolean } {
  // A macOS menu-bar item opens the AmpleFile Agent, not close-to-tray support:
  // closing the last macOS window already keeps the app alive via the Dock.
  return { supported: process.platform === "win32" && tray !== null, enabled: desktopPreferences.closeToTray };
}

function configurePowerMonitor(): void {
  if (powerMonitorRegistered) return;
  powerMonitorRegistered = true;
  powerMonitor.on("suspend", () => {
    void desktopHostPromise?.then(host => host.computerSession?.stop()).catch(() => {});
    // Automation runs share the scheduler discipline: suspension aborts the
    // active run (it settles `interrupted`, honestly receipted) and holds
    // admissions until resume (docs/automations.md).
    automationPowerLifecycle?.suspend();
  });
  powerMonitor.on("resume", () => {
    void automationPowerLifecycle?.resume().catch((error) => {
      console.warn(`${productName} could not resume Automations after wake: ${errorMessage(error)}`);
    });
    setTimeout(ensureRendererAfterResume, resumeRendererHealthDelayMs);
    setTimeout(() => { void checkForUpdates(false); }, resumeUpdateCheckDelayMs);
  });
  powerMonitor.on("lock-screen", () => {
    void desktopHostPromise?.then(host => host.computerSession?.stop()).catch(() => {});
  });
  powerMonitor.on("shutdown", () => { void shutdown(); });
}

function sendAccentColorToRenderers(): void {
  const accent = getSystemAccentColor();
  for (const window of fileManagerWindows.windows()) {
    if (!window.webContents.isDestroyed()) sendToRenderer(window.webContents, "amplefile:window:accent-color-changed", accent);
  }
  // The menu-bar popover subscribes too, and may be open with no main window.
  ampleFileAgentPopover?.send("amplefile:window:accent-color-changed", accent);
}

function linuxWindowChromeState(window: BrowserWindow | null): LinuxWindowChromeState | null {
  if (process.platform !== "linux") return null;
  const appearance = linuxDesktopSettings?.current();
  const live = window && !window.isDestroyed() ? window : null;
  return {
    buttonLayout: appearance?.buttonLayout ?? fallbackWindowButtonLayout,
    maximized: live?.isMaximized() ?? false,
    fullScreen: live?.isFullScreen() ?? false,
    focused: live?.isFocused() ?? true,
    highContrast: appearance?.highContrast ?? false,
  };
}

function sendLinuxWindowChromeState(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  sendToRenderer(window.webContents, "amplefile:window:chrome-state-changed", linuxWindowChromeState(window));
}

/**
 * Starts following the Linux desktop's settings once. Window creation waits
 * for the first read, at most a second, so the first paint already has the
 * desktop's button layout and accent.
 */
function waitForLinuxDesktopSettings(): Promise<void> {
  if (process.platform !== "linux") return Promise.resolve();
  if (!linuxDesktopSettingsReady) {
    const settings = new LinuxDesktopSettings({
      onChange: applyLinuxDesktopAppearance,
      log: (message) => console.warn(`${productName} ${message}`),
    });
    linuxDesktopSettings = settings;
    linuxDesktopSettingsReady = settings.start().catch((error) => {
      console.warn(`${productName} could not read desktop settings: ${errorMessage(error)}`);
    });
  }
  return Promise.race([linuxDesktopSettingsReady, new Promise<void>((resolve) => { setTimeout(resolve, 1_000).unref?.(); })]);
}

function applyLinuxDesktopAppearance(next: LinuxDesktopAppearance, previous: LinuxDesktopAppearance): void {
  if (next.colorScheme !== previous.colorScheme) {
    nativeTheme.themeSource = linuxNativeThemeSource(rendererThemeSource, next.colorScheme);
  }
  if (next.accentColor !== previous.accentColor) sendAccentColorToRenderers();
  for (const window of fileManagerWindows.windows()) sendLinuxWindowChromeState(window);
}

function configureAccentColorMonitor(): void {
  if (accentColorMonitorRegistered || (process.platform !== "win32" && process.platform !== "darwin")) return;
  accentColorMonitorRegistered = true;
  const sendAccentColor = sendAccentColorToRenderers;
  if (process.platform === "darwin") {
    systemPreferences.subscribeNotification("AppleColorPreferencesChangedNotification", sendAccentColor);
  } else {
    systemPreferences.on("accent-color-changed", sendAccentColor);
  }
}

function getSystemAccentColor(): string | null {
  if (process.platform === "linux") return linuxDesktopSettings?.current().accentColor ?? null;
  if (process.platform !== "win32" && process.platform !== "darwin") return null;
  try {
    const raw = systemPreferences.getAccentColor().replace(/^#/, "");
    return /^[0-9a-fA-F]{8}$/.test(raw) ? `#${raw.slice(0, 6)}` : null;
  } catch {
    return null;
  }
}

interface RendererRecovery {
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  attempts: number;
  failurePromptShown: boolean;
}

/** One window's renderer recovery; each window reloads on its own. */
function rendererRecovery(window: BrowserWindow): RendererRecovery {
  let recovery = rendererRecoveries.get(window.id);
  if (!recovery) {
    recovery = { timer: null, inFlight: false, attempts: 0, failurePromptShown: false };
    rendererRecoveries.set(window.id, recovery);
  }
  return recovery;
}

function clearRendererRecovery(windowId: number): void {
  const recovery = rendererRecoveries.get(windowId);
  if (recovery?.timer) clearTimeout(recovery.timer);
  rendererRecoveries.delete(windowId);
}

function configureWindowResilience(window: BrowserWindow): void {
  const detachBrowserViews = () => {
    // Browser pages keep running; they show again when the renderer lays their tabs out.
    builtInBrowser?.detachWindow(window);
  };
  window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) detachBrowserViews();
  });
  window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || !isTrustedRendererUrl(url)) return;
    scheduleRendererRecovery(window, description || `load failed with error ${code}`);
  });
  window.webContents.on("did-finish-load", () => {
    if (!window.isDestroyed()) rendererRecovery(window).attempts = 0;
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    detachBrowserViews();
    if (!window.isDestroyed()) scheduleRendererRecovery(window, `renderer process ended: ${details.reason}`);
  });
}

function ensureRendererAfterResume(): void {
  for (const window of fileManagerWindows.windows()) {
    if (window.webContents.isDestroyed() || window.webContents.isLoadingMainFrame()) continue;
    const currentUrl = window.webContents.getURL();
    if (!isTrustedRendererUrl(currentUrl)) scheduleRendererRecovery(window, `renderer was not on the app URL after resume: ${currentUrl || "blank"}`, 0);
  }
}

function loadMainRenderer(window: BrowserWindow): Promise<void> {
  return window.loadURL(`${appProtocol}://app/index.html`);
}

function scheduleRendererRecovery(window: BrowserWindow, reason: string, delayMs?: number): void {
  if (quitting || quittingForUpdate || !quitCoordinator.shouldPreventNativeQuit()) return;
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  const recovery = rendererRecovery(window);
  if (recovery.timer || recovery.inFlight) return;
  if (recovery.attempts >= rendererRecoveryMaxAttempts) {
    void showRendererRecoveryFailedDialog(window, reason);
    return;
  }
  const delay = delayMs ?? Math.min(rendererRecoveryMaxDelayMs, rendererRecoveryBaseDelayMs * (2 ** recovery.attempts));
  recovery.timer = setTimeout(() => {
    recovery.timer = null;
    void recoverRenderer(window, reason);
  }, delay);
}

async function recoverRenderer(window: BrowserWindow, reason: string): Promise<void> {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  const recovery = rendererRecovery(window);
  recovery.inFlight = true;
  recovery.attempts += 1;
  let retryReason: string | null = null;
  try {
    console.warn(`${productName} reloading a window after a recoverable issue: ${reason}`);
    await loadMainRenderer(window);
  } catch (error) {
    retryReason = errorMessage(error);
  } finally {
    recovery.inFlight = false;
  }
  if (window.isDestroyed()) return;
  if (retryReason) scheduleRendererRecovery(window, retryReason);
  else {
    recovery.attempts = 0;
    recovery.failurePromptShown = false;
    sendToRenderer(window.webContents, "amplefile:runtime:renderer-recovered");
  }
}

async function showRendererRecoveryFailedDialog(window: BrowserWindow, reason: string): Promise<void> {
  const recovery = rendererRecovery(window);
  if (recovery.failurePromptShown) return;
  recovery.failurePromptShown = true;
  const options = {
    type: "error" as const,
    message: `${productName} could not recover this window.`,
    detail: `The window failed to reload after ${recovery.attempts} attempts. Restart to try again. (${reason})`,
    buttons: [`Restart ${productName}`, "Close"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const result = !window.isDestroyed()
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  // Restart goes through the ordinary graceful quit, so turns and History
  // flush and the CLI act token is revoked before the new instance starts.
  if (result.response === 0) app.relaunch();
  app.quit();
}

function configureWindowNavigation(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url).catch((error) => console.warn(`${productName} blocked external navigation: ${errorMessage(error)}`));
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isTrustedRendererUrl(url)) return;
    event.preventDefault();
    void openExternal(url).catch((error) => console.warn(`${productName} blocked external navigation: ${errorMessage(error)}`));
  });
}

function configureContextMenu(window: BrowserWindow): void {
  window.webContents.on("context-menu", (_event, params) => {
    void spellingSuggestions(params).then((suggestions) => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return;
      const template = buildContextMenuTemplate(window, params, suggestions);
      const frame = params.frame && !params.frame.isDestroyed() ? params.frame : undefined;
      if (template) Menu.buildFromTemplate(template).popup({ window, frame });
    });
  });
}

/** macOS often leaves Electron's suggestions empty; ask the system spell checker, as the built-in browser does. */
async function spellingSuggestions(params: ContextMenuParams): Promise<string[]> {
  if (!params.misspelledWord || params.dictionarySuggestions.length) return params.dictionarySuggestions.slice(0, 5);
  return macSpellingGuesses(params.misspelledWord);
}

function buildContextMenuTemplate(window: BrowserWindow, params: ContextMenuParams, suggestions: string[]): MenuItemConstructorOptions[] | null {
  if (params.isEditable) return buildEditableContextMenuTemplate(window, params, suggestions);
  if (params.selectionText.length > 0 || params.linkURL.length > 0) return buildSelectionContextMenuTemplate(params);
  return null;
}

function buildEditableContextMenuTemplate(window: BrowserWindow, params: ContextMenuParams, suggestions: string[]): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  if (params.misspelledWord.length > 0) {
    template.push(...(suggestions.length ? suggestions.map((suggestion) => ({
      label: suggestion,
      click: () => window.webContents.replaceMisspelling(suggestion),
    })) : [{ label: "No Suggestions", enabled: false }]));
    template.push({ label: "Add to Dictionary", click: () => window.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: "separator" });
  }
  template.push(
    { role: "undo", enabled: params.editFlags.canUndo },
    { role: "redo", enabled: params.editFlags.canRedo },
    { type: "separator" },
    { role: "cut", enabled: params.editFlags.canCut },
    { role: "copy", enabled: params.editFlags.canCopy },
    { role: "paste", enabled: params.editFlags.canPaste },
    { role: "selectAll" },
  );
  return template;
}

function buildSelectionContextMenuTemplate(params: ContextMenuParams): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  if (params.selectionText.length > 0) template.push({ role: "copy", enabled: params.editFlags.canCopy });
  if (params.linkURL.length > 0) template.push({ label: "Copy Link Address", click: () => copyTextToClipboard(params.linkURL) });
  return template;
}

/** Asynchronous IPC has no rejection channel. A stale or untrusted sender must not throw into Electron. */
function onRendererMessage<C extends DesktopSendChannel>(
  channel: C,
  handle: DesktopSendHandler<C>,
  assertSender: (event: IpcMainEvent) => void = assertTrustedMainRenderer,
): void {
  ipcMain.on(channel, (event, ...args) => {
    try {
      assertSender(event);
      handle(event, ...args);
    } catch (error) {
      console.warn(`${productName} ignored ${channel}: ${errorMessage(error)}`);
    }
  });
}

function assertTrustedRenderer(event: IpcMainInvokeEvent | IpcMainEvent): void {
  if (event.sender.isDestroyed()) throw new Error("The renderer is no longer available.");
  if (modelContextWindow?.owns(event.sender)) throw new Error("The developer inspector has diagnostics-only access.");
  const frame = event.senderFrame;
  if (!frame || frame.isDestroyed() || frame.detached || !isTrustedRendererUrl(frame.url)) {
    throw new Error("Untrusted renderer IPC request.");
  }
}

function senderIsMainFrame(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  if (event.sender.isDestroyed()) return false;
  const frame = event.senderFrame;
  const mainFrame = event.sender.mainFrame;
  return Boolean(frame && mainFrame && !frame.isDestroyed() && !mainFrame.isDestroyed() && !frame.detached
    && frame.processId === mainFrame.processId && frame.routingId === mainFrame.routingId);
}

/**
 * The handful of channels the AmpleFile Agent popover's narrow preload uses.
 * Every other handler requires the main renderer, so popover isolation does
 * not rest on its preload alone.
 */
function assertMainOrAgentPopoverRenderer(event: IpcMainInvokeEvent | IpcMainEvent): void {
  if (ampleFileAgentPopover?.owns(event.sender)) {
    assertTrustedRenderer(event);
    if (!senderIsMainFrame(event)) {
      throw new Error("This request requires the AmpleFile Agent popover's main frame.");
    }
    return;
  }
  assertTrustedMainRenderer(event);
}

function assertTrustedMainRenderer(event: IpcMainInvokeEvent | IpcMainEvent): void {
  assertTrustedRenderer(event);
  const mainFrameMatches = senderIsMainFrame(event);
  // Any file manager window's own renderer, in its top frame; never the popover, a browser page, or a pop-up.
  if (!senderWindow(event) || !mainFrameMatches) {
    throw new Error("This request requires the main AmpleFile renderer.");
  }
}

/** Shape check only; the local API confines the path to the agent's working folder. */
function automationProposalPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096
    || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)) {
    throw new Error("The automation file path is invalid.");
  }
  return value;
}

function automationSettingsId(value: unknown): string {
  if (typeof value !== "string") throw new Error("An Automation id is required.");
  const automationId = value.trim();
  if (!automationId || automationId.length > 256
    || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(automationId)) {
    throw new Error("The Automation id is invalid.");
  }
  return automationId;
}

function isTrustedRendererUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === `${appProtocol}:` && url.hostname === "app";
  } catch {
    return false;
  }
}

function rendererArgument(name: string, value: string): string {
  return `--amplefile-${name}=${encodeURIComponent(value)}`;
}

function productRendererArguments(): string[] {
  return [
    rendererArgument("product-name", productName),
    rendererArgument("internal-protocol", appProtocol),
    rendererArgument("desktop-environment", process.platform === "linux" ? process.env.XDG_CURRENT_DESKTOP ?? "" : ""),
  ];
}

function resolveRendererDir(): string {
  // A packaged app's root is app.asar, so its renderer is read from the
  // integrity-checked archive rather than from loose files beside it.
  const directory = rendererBuildDirectory(app.isPackaged ? app.getAppPath() : repoRoot);
  if (!existsSync(join(directory, "index.html"))) throw new Error(`${productName} renderer build was not found at ${directory}. Run npm run local:build.`);
  return directory;
}

function resolvePreloadPath(): string {
  return join(dirnameFromFile(currentFile), "preload.cjs");
}

function resolveAmpleFileAgentPopoverPreloadPath(): string {
  return join(dirnameFromFile(currentFile), "amplefile-agent-popover-preload.cjs");
}

function resolveWindowIcon(): string {
  const iconFile = process.platform === "win32" ? "icon.ico" : "icon.png";
  return app.isPackaged ? join(process.resourcesPath, "assets", iconFile) : join(repoRoot, "desktop", "assets", iconFile);
}

function resolveDesktopAssetsDir(): string {
  return app.isPackaged ? join(process.resourcesPath, "assets") : join(repoRoot, "desktop", "assets");
}

function dirnameFromFile(value: string): string {
  return resolve(value, "..");
}

function windowStatePath(): string {
  return join(app.getPath("userData"), "window-state.json");
}

/** Every window's saved place (window-placements.ts), read once. */
function currentWindowPlacements(): WindowPlacement[] {
  if (windowPlacements) return windowPlacements;
  try {
    windowPlacements = existsSync(windowStatePath()) ? parseWindowPlacements(JSON.parse(readFileSync(windowStatePath(), "utf8"))) : [];
  } catch {
    windowPlacements = [];
  }
  return windowPlacements;
}

function storeWindowPlacements(next: WindowPlacement[]): void {
  windowPlacements = next;
  try {
    writeFileSync(windowStatePath(), serializeWindowPlacements(next), "utf8");
  } catch {
    // Window placement is a convenience; startup should not fail if it cannot be saved.
  }
}

function configureWindowStatePersistence(window: BrowserWindow, slot: number): void {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveWindowState(window, slot);
    }, windowStateSaveDelayMs);
  };
  window.on("resize", scheduleSave);
  window.on("move", scheduleSave);
  window.on("close", () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveWindowState(window, slot);
  });
}

function visibleWindowState(state: WindowPlacement | null): WindowPlacement | null {
  if (!state || !screen.getAllDisplays().some((display) => intersects(state, display.bounds))) return null;
  return fitWindowToWorkArea(state, screen.getDisplayMatching(state).workArea, minimumWindowState);
}

function saveWindowState(window: BrowserWindow, slot: number): void {
  if (window.isDestroyed()) return;
  const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
  storeWindowPlacements(savePlacement(currentWindowPlacements(), { slot, ...bounds, isMaximized: window.isMaximized() }));
}

function intersects(a: WindowBounds, b: Rectangle): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function samePath(first: string, second: string): boolean {
  const a = resolve(first);
  const b = resolve(second);
  return process.platform === "win32" ? a.toLocaleLowerCase() === b.toLocaleLowerCase() : a === b;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
