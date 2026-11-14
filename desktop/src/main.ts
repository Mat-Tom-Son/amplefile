import { fitWindowToWorkArea } from "./window-bounds.js";
import { configureLinuxPasswordStore } from "./linux-password-store.js";
import { linuxX11RelaunchArguments, openPathArguments } from "./linux-launch.js";
import { ComputerSessionService } from "../../src/local/agent/computer-session.js";
import { NativeWaylandTransport } from "../../src/local/agent/wayland-transport.js";
import { createEncryptedMcpCredentialBackend } from "./pi-mcp-credentials.js";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
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
import { addSidebarFolder, assertStandardFolderPathUnowned, isStandardFolderId, resolveStandardFolderPath, standardFolderRoot } from "../../src/local/standard-folders.js";
import { loadLocalEnvironmentFile } from "../../src/local/server-dev-options.js";
import type { AmpleFileActFacade } from "../../src/local/cli/act-facade.js";
import {
  removeAmpleFileCliActTokenFile,
  writeAmpleFileCliActTokenFile,
} from "../../src/local/cli/act-token.js";
import { configureAmpleFileStateRoot, managedConnectedFolderRoot, ampleFileAgentRoot } from "../../src/local/state-paths.js";
import { getConnectedFolder, listConnectedFolders } from "../../src/local/connected-folder.js";
import { AmpleFileCliKernelAdapter } from "../../src/local/amplefile-cli-adapter.js";
import { AmpleFileKernel } from "../../src/local/amplefile-kernel.js";
import {
  AmpleFileDesktopCliHost,
  ampleFileCliInstanceData,
  ampleFileCliRequestIdFromArgv,
  ampleFileInspectContextFromArgv,
  ampleFileSecondInstanceIntent,
} from "./amplefile-cli-host.js";
import { AmpleFileAgentPopover, type AmpleFileAgentPopoverStagedItem } from "./amplefile-agent-popover.js";
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
import { DesktopUpdater, hasPackagedDesktopUpdateFeed, type DesktopUpdateStatus } from "./updater.js";
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
  type NativeFileMenuRequest,
} from "./file-context-menu.js";
import {
  nativeTabMenuItems,
  parseNativeTabMenuRequest,
  type NativeTabMenuCommand,
  type NativeTabMenuRequest,
} from "./tab-context-menu.js";
import {
  nativeConnectedFolderMenuItems,
  parseNativeConnectedFolderMenuRequest,
  type NativeConnectedFolderMenuCommand,
} from "./connected-folder-context-menu.js";
import { openFileWithPickedApp, openWithDialogOptions, type OpenWithLaunchPlan } from "./open-with.js";
import { pickLinuxOpenWithApp } from "./open-with-linux-chooser.js";
import { desktopWindowMaterial, shouldUseMacVibrancy, shouldUseWindowsMica } from "./window-material.js";
import { GracefulQuitCoordinator, type QuitPreparationOutcome } from "./quit-coordinator.js";
import { RailTooltipOverlay } from "./rail-tooltip-overlay.js";
import { macSpellingGuesses } from "./mac-spelling.js";
import { BuiltInBrowser, parseBrowserCommand, parseBrowserTabsSync, parseBrowserViewRequest } from "./built-in-browser.js";
import { isBrowserPageId } from "../../src/shared/browser.js";
import { productIdentity } from "../../src/shared/product-identity.js";
import {
  commandLineStatus,
  defaultCommandLineEnvironment,
  installCommandOnPath,
  installSkill,
  isCommandLineSkillTarget,
  removeCommandFromPath,
  removeSkill,
} from "./command-line-install.js";
import { outsideAgentSkill } from "../../src/shared/outside-agent-skill.js";
import { resolveDesktopApplicationVersion } from "./application-version.js";
import { handleRendererRequest, rendererBuildDirectory } from "./renderer-protocol.js";

// AppImage launchers can fall back to --no-sandbox when namespaces are blocked.
// Refuse before initializing user state rather than weaken renderer isolation.
const refusedUnsandboxedLaunch = process.platform === "linux" && app.commandLine.hasSwitch("no-sandbox");
if (refusedUnsandboxedLaunch) {
  console.error("AmpleFile requires the Chromium sandbox. Install the DEB/RPM with the distribution's supported sandbox configuration.");
  app.exit(1);
}

configureLinuxPasswordStore(app.commandLine, process.platform, process.env);
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

let mainWindow: BrowserWindow | null = null;
let railTooltipOverlay: RailTooltipOverlay | null = null;
let builtInBrowser: BuiltInBrowser | null = null;
let tray: Tray | null = null;
let ampleFileAgentPopover: AmpleFileAgentPopover | null = null;
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
let desktopUpdater: DesktopUpdater | null = null;
let shutdownPromise: Promise<void> | null = null;
let rendererProtocolRegistered = false;
let ipcRegistered = false;
let powerMonitorRegistered = false;
let accentColorMonitorRegistered = false;
let rendererRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let rendererRecoveryInFlight = false;
let rendererRecoveryAttempts = 0;
let rendererRecoveryFailurePromptShown = false;
let createWindowPromise: Promise<void> | null = null;
let rendererMenuState: RendererMenuState = { connectedFolderOpen: false };
let desktopHostPromise: Promise<DesktopHost> | null = null;
let interactiveStartupPromise: Promise<void> | null = null;
let activateRegistered = false;
let interactiveRequested = false;
let cliRequestGeneration = 0;
let activeNativeConnectedFolder: { id: string; name: string; connectedFolderRoot: string } | null = null;
let activeNativeConnectedFolderGeneration = 0;
let pendingOpenConnectedFolderRequest: { token: string; connectedFolderId: string } | null = null;
const pendingOpenPaths: string[] = [];
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
  // A desktop launcher's %U: folders open like a Finder open-file below.
  pendingOpenPaths.push(...openPathArguments(process.argv, { defaultApp: process.defaultApp === true, workingDirectory: process.cwd() }));
}

if (ownsInstance && process.platform === "darwin") {
  // macOS can deliver this before `ready`. Queue the path so Finder and Dock
  // launches can be resolved against the registered Connected Folder catalog once the
  // app host is available. Unknown folders are never registered implicitly.
  app.on("open-file", (event, path) => {
    event.preventDefault();
    pendingOpenPaths.push(path);
    interactiveRequested = true;
    if (app.isReady()) {
      void startInteractiveApp()
        .then(drainPendingOpenPaths)
        .catch(reportStartupError);
    }
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
      pendingOpenPaths.push(...openPathArguments(argv, { defaultApp: process.defaultApp === true, workingDirectory }));
    }
    void startInteractiveApp().then(showWindow).then(drainPendingOpenPaths).catch(reportStartupError);
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
  if (desktopUpdater?.shouldInstallOnQuit()) {
    // The updater stages and validates the payload first, then runs the
    // update shutdown, then hands off. If staging fails nothing has shut down
    // yet and the ordinary quit below continues; `shutdown()` is idempotent.
    const status = await desktopUpdater.installDownloadedUpdateOnQuit();
    if (status.phase === "installing") return "handoff";
  }
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
    else if (event.method === "copyText") clipboard.writeText(event.text);
    else if (event.method === "openSettings") mainWindow?.webContents.send("amplefile:agent:open-settings");
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
    // A headless CLI host may be tearing down; it re-checks for this launch
    // afterwards and stays up, but the new act token must not race it.
    await headlessQuit.whenTeardownSettled();
    await ensureDesktopHost();
    removeLeftoverChromeRegistrationOnce();
    const api = await ensureInteractiveLocalApi();
    loadDesktopPreferences();
    registerRendererProtocol();
    registerIpc();
    await ensureMainWindow();
    configureUpdater();
    createTrayIfSupported();
    if (!activateRegistered) {
      activateRegistered = true;
      app.on("activate", () => {
        if (!mainWindow || mainWindow.isDestroyed()) void ensureMainWindow();
        else showWindow();
      });
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
    const api = await startLocalApi({
      appMode: "desktop",
      port: 0,
      connectedFolderBase: managedConnectedFolderRoot(),
      stateBase: userData,
      sessionToken: apiSessionToken,
      allowedOrigins: [`${appProtocol}://app`],
      piRuntimeProvider: host.runtime,
      piOAuthHooks: createDesktopPiOAuthHooks({
        openExternal,
        readClipboard: () => clipboard.readText(),
        writeClipboard: (value) => clipboard.writeText(value),
        showMessageBox: (options) => {
          const parent = BrowserWindow.getFocusedWindow() ?? mainWindow;
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

async function createMainWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showWindow();
    return;
  }

  const api = await ensureInteractiveLocalApi();

  const state = visibleWindowState(readWindowState());
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const initialState = state ?? fitWindowToWorkArea({ ...defaultWindowState, x: primaryWorkArea.x, y: primaryWorkArea.y, isMaximized: false }, primaryWorkArea, minimumWindowState);
  const workArea = screen.getDisplayMatching(initialState).workArea;
  mainWindow = new BrowserWindow({
    ...initialState,
    minWidth: Math.min(minimumWindowState.width, workArea.width),
    minHeight: Math.min(minimumWindowState.height, workArea.height),
    title: productName,
    icon: resolveWindowIcon(),
    autoHideMenuBar: process.platform === "win32",
    ...(process.platform === "linux" ? { darkTheme: nativeTheme.shouldUseDarkColors } : {}),
    ...(["win32", "linux"].includes(process.platform) ? {
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
      ],
    },
  });
  if (process.platform === "linux") mainWindow.setMenuBarVisibility(false);
  railTooltipOverlay = new RailTooltipOverlay(mainWindow);

  applyNativeActiveConnectedFolderToWindow(mainWindow);

  if (process.platform === "win32") {
    try {
      mainWindow.webContents.session.setSpellCheckerLanguages(["en-US"]);
    } catch (error) {
      console.warn(`${productName} could not configure spellchecker languages: ${errorMessage(error)}`);
    }
  }
  mainWindow.webContents.on("did-start-navigation", () => railTooltipOverlay?.hide());
  mainWindow.webContents.on("render-process-gone", () => railTooltipOverlay?.hide());
  mainWindow.webContents.on("page-title-updated", (event) => {
    if (process.platform !== "darwin" || !activeNativeConnectedFolder) return;
    event.preventDefault();
    applyNativeActiveConnectedFolderToWindow(mainWindow);
  });
  configureWindowStatePersistence(mainWindow);
  const window = mainWindow;
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
  if (state?.isMaximized) mainWindow.maximize();
  // First reveal only: renderer recoveries can re-emit ready-to-show, and a
  // window the person hid (Windows close-to-tray, minimize) must not
  // resurface because an autonomous reload finished painting.
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("blur", () => railTooltipOverlay?.hide());
  mainWindow.on("hide", () => railTooltipOverlay?.hide());
  mainWindow.on("minimize", () => railTooltipOverlay?.hide());
  mainWindow.on("close", (event) => {
    if (quitting || quittingForUpdate || !quitCoordinator.shouldPreventNativeQuit()) return;
    // Close-to-tray is Windows behavior; the macOS menu-bar item must not
    // change what closing the last macOS window means (Dock keeps the host).
    if (process.platform !== "win32" || !tray || !desktopPreferences.closeToTray) return;
    event.preventDefault();
    mainWindow?.hide();
    maybeShowStillRunningNotice();
  });
  // A closing window gives its browser pages back; they show again in the next window.
  const browserWindow = mainWindow;
  mainWindow.on("close", (event) => { if (!event.defaultPrevented) builtInBrowser?.detachWindow(browserWindow); });
  mainWindow.on("query-session-end", () => { void shutdown(); });
  mainWindow.on("session-end", () => {
    quitting = true;
    void shutdown();
  });
  mainWindow.on("closed", () => {
    railTooltipOverlay?.close();
    railTooltipOverlay = null;
    mainWindow = null;
    if (process.platform === "win32" && !quitting && !quittingForUpdate) app.quit();
    // Linux keeps the host and accepted work after the last window; say so once, tray or not.
    if (closedLastWindowNeedsNotice({ platform: process.platform, quitting: quitting || quittingForUpdate, alreadyShown: desktopPreferences.trayNoticeShown })) maybeShowStillRunningNotice();
  });
  configureWindowNavigation(mainWindow);
  configureContextMenu(mainWindow);
  configureWindowResilience(mainWindow);
  configurePowerMonitor();
  configureAccentColorMonitor();
  configureMenu();

  try {
    await loadMainRenderer(mainWindow);
  } catch (error) {
    console.warn(`${productName} renderer load failed: ${errorMessage(error)}`);
    scheduleRendererRecovery(`initial renderer load failed: ${errorMessage(error)}`);
  }
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
      const frame = event.senderFrame;
      const mainFrame = event.sender.mainFrame;
      if (!frame || frame.processId !== mainFrame.processId || frame.routingId !== mainFrame.routingId) {
        throw new Error("Clipboard requests require a trusted main frame.");
      }
    }
    // A picture goes on the clipboard alone, so every app pastes the picture rather than text.
    writeDesktopClipboard(value, (content) => clipboard.write(content.image !== undefined
      ? { image: nativeImage.createFromDataURL(content.image) }
      : { text: content.text, ...(content.html !== undefined ? { html: content.html } : {}) }));
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
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, { title: "Choose a Folder", properties: ["openDirectory", "createDirectory"] })
      : await dialog.showOpenDialog({ title: "Choose a Folder", properties: ["openDirectory", "createDirectory"] });
    const connectedFolderRoot = result.filePaths[0];
    if (result.canceled || !connectedFolderRoot) return null;
    return { path: connectedFolderRoot, folderGrantId: createFolderGrant(connectedFolderRoot) };
  });
  const automationSettings = async (event: IpcMainInvokeEvent, value?: unknown) => {
    assertTrustedMainRenderer(event);
    return {
      facade: (await ensureInteractiveLocalApi()).automationSettings,
      ...(value !== undefined ? { automationId: automationSettingsId(value) } : {}),
    };
  };
  ipcMain.handle("amplefile:automations:list", async (event) => {
    const { facade } = await automationSettings(event);
    return facade.list();
  });
  ipcMain.handle("amplefile:automations:proposals", async (event) => {
    const { facade } = await automationSettings(event);
    return facade.proposals();
  });
  ipcMain.handle("amplefile:automations:enable-proposal", async (event, value: unknown) => {
    const { facade } = await automationSettings(event);
    return facade.enableProposal(automationProposalPath(value));
  });
  ipcMain.handle("amplefile:automations:show", async (event, value: unknown) => {
    const { facade, automationId } = await automationSettings(event, value);
    return facade.show(automationId!);
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
        const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
        if (process.platform === "linux") return pickLinuxOpenWithApp(window, filePath);
        const options = openWithDialogOptions(process.platform);
        const choice = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
        // Only the path the dialog itself returned is ever launched.
        return choice.canceled ? null : choice.filePaths[0] ?? null;
      },
      launch: launchOpenWith,
    });
  });
  ipcMain.handle("amplefile:connected-folder:start-drag", async (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    const request = connectedFolderPathRequest(value, false);
    const filePath = await resolveConnectedFolderItem(request.connectedFolderId, request.path);
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Only files can be dragged out of a Connected Folder.");
    const icon = nativeImage.createFromPath(join(resolveDesktopAssetsDir(), "icon-32.png"));
    if (icon.isEmpty()) return false;
    event.sender.startDrag({ file: filePath, icon });
    return true;
  });
  ipcMain.handle("amplefile:connected-folder:preview-file", async (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    if (process.platform !== "darwin") return false;
    const request = connectedFolderPathRequest(value, false);
    const filePath = await resolveConnectedFolderItem(request.connectedFolderId, request.path);
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Only files can be previewed with Quick Look.");
    const window = mainWindow;
    if (!window || window.isDestroyed()) throw new Error("The AmpleFile window is not available.");
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
        const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
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
    const request = standardFolderPathRequest(value);
    const filePath = await resolveStandardFolderItem(request.standardFolderId, request.path);
    if (!(await stat(filePath)).isFile()) throw new Error("Only files can be dragged out.");
    const icon = nativeImage.createFromPath(join(resolveDesktopAssetsDir(), "icon-32.png"));
    if (icon.isEmpty()) return false;
    event.sender.startDrag({ file: filePath, icon });
    return true;
  });
  ipcMain.handle("amplefile:standard-folder:preview-file", async (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    if (process.platform !== "darwin") return false;
    const request = standardFolderPathRequest(value);
    const filePath = await resolveStandardFolderItem(request.standardFolderId, request.path);
    if (!(await stat(filePath)).isFile()) throw new Error("Only files can be previewed with Quick Look.");
    const window = mainWindow;
    if (!window || window.isDestroyed()) throw new Error("The AmpleFile window is not available.");
    window.previewFile(filePath, basename(filePath));
    return true;
  });
  // Copy and paste with Finder: files copied in Finder paste into the file manager, and
  // files copied here paste into Finder, through the system's file pasteboard.
  // Paste reads the pasteboard here, never in the window (the window can't read the clipboard): what was
  // copied in this window pastes by place (so ⌥⌘V can move it); anything else Finder copied is copied in.
  ipcMain.handle("amplefile:file-clipboard:paste", async (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    if (!isRecord(value) || !isRecord(value.target)) throw new Error("Choose where to paste.");
    const mode = value.mode === "move" ? "move" : "copy";
    const internal = isRecord(value.internal) && Array.isArray(value.internal.paths) && Array.isArray(value.internal.nativePaths) ? value.internal : null;
    const pasteboard = await readPasteboardFilePaths();
    const internalNative = internal ? (internal.nativePaths as unknown[]).filter((item): item is string => typeof item === "string") : [];
    const fromHere = Boolean(internal) && (!pasteboard.length || (pasteboard.length === internalNative.length && pasteboard.every((path) => internalNative.includes(path))));
    const sources = fromHere
      ? (internal!.paths as unknown[]).map((path) => ({ place: internal!.place, path }))
      : pasteboard.map((nativePath) => ({ nativePath }));
    if (!sources.length) return { mode: "copy", written: [], restorePoints: [], nothing: true };
    const result = await transferFileEntries({ mode: fromHere ? mode : "copy", sources, target: value.target });
    return { ...result, fromHere, count: sources.length };
  });
  ipcMain.handle("amplefile:file-clipboard:write", async (event, value: unknown): Promise<boolean> => {
    assertTrustedMainRenderer(event);
    if (!Array.isArray(value) || !value.length || value.length > 5_000) throw new Error("Choose items to copy.");
    const paths = value.map((item) => {
      if (typeof item !== "string" || !isAbsolute(item) || item.includes("\0")) throw new Error("Choose items to copy.");
      return item;
    }).filter((path) => existsSync(path));
    if (!paths.length) return false;
    await writePasteboardFilePaths(paths);
    return true;
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
        await assertStandardFolderPathUnowned(standardFolderId, request.path);
        await shell.trashItem(await resolveStandardFolderItem(standardFolderId, request.path));
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
    return popupNativeFileMenu(request);
  });
  ipcMain.handle("amplefile:connected-folder:popup-tab-menu", (event, value: unknown): Promise<NativeTabMenuCommand | null> => {
    assertTrustedMainRenderer(event);
    if (process.platform !== "darwin") return Promise.resolve(null);
    return popupNativeTabMenu(parseNativeTabMenuRequest(value));
  });
  ipcMain.handle("amplefile:connected-folder:popup-header-menu", (event, value: unknown): Promise<NativeConnectedFolderMenuCommand | null> => {
    assertTrustedMainRenderer(event);
    if (process.platform !== "darwin") return Promise.resolve(null);
    const request = parseNativeConnectedFolderMenuRequest(value);
    return popupNativeCommandMenu(nativeConnectedFolderMenuItems(request), request.point);
  });
  ipcMain.handle("amplefile:connected-folder:set-active-connected-folder", async (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    if (value !== null && (typeof value !== "string" || !value.trim() || value.length > 512)) {
      throw new Error("A valid Connected Folder id is required.");
    }
    await setActiveNativeConnectedFolder(value === null ? null : value.trim());
  });
  ipcMain.handle("amplefile:connected-folder:take-open-connected-folder", (event) => {
    assertTrustedMainRenderer(event);
    const request = pendingOpenConnectedFolderRequest;
    pendingOpenConnectedFolderRequest = null;
    return request;
  });
  ipcMain.on("amplefile:connected-folder:ack-open-connected-folder", (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    if (typeof value === "string" && pendingOpenConnectedFolderRequest?.token === value) pendingOpenConnectedFolderRequest = null;
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
    await openAmpleFileAgentPopoverWithItems([{ kind: "text", value }]);
    return true;
  });
  ipcMain.on("amplefile:agent:hide", (event) => {
    assertMainOrAgentPopoverRenderer(event);
    ampleFileAgentPopover?.hide();
  });
  ipcMain.handle("amplefile:agent:open-main", (event) => {
    assertMainOrAgentPopoverRenderer(event);
    ampleFileAgentPopover?.hide();
    showWindow();
    return true;
  });
  ipcMain.handle("amplefile:agent:open-ai-models-settings", async (event) => {
    assertMainOrAgentPopoverRenderer(event);
    ampleFileAgentPopover?.hide();
    await ensureMainWindow();
    showWindow();
    mainWindow?.webContents.send("amplefile:agent:open-settings", "agent");
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
  ipcMain.on("amplefile:window:set-theme", (event, value: unknown, source: unknown, chrome: unknown) => {
    assertTrustedMainRenderer(event);
    if (value !== "light" && value !== "dark") return;
    // Keep the OS-drawn chrome (Mica backdrop, frame, menus) on the app theme.
    // "system" preserves prefers-color-scheme change events in the renderer.
    nativeTheme.themeSource = source === "light" || source === "dark" || source === "system" ? source : value;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (process.platform === "win32" || process.platform === "linux") {
      const colors = process.platform === "linux" && isRecord(chrome) && typeof chrome.color === "string" && /^#[0-9a-f]{6}$/i.test(chrome.color)
        && typeof chrome.symbolColor === "string" && /^#[0-9a-f]{6}$/i.test(chrome.symbolColor)
        ? { color: chrome.color, symbolColor: chrome.symbolColor } : {};
      mainWindow.setTitleBarOverlay({ ...titleBarOverlayFor(value), ...colors });
      if (!micaSupported) mainWindow.setBackgroundColor(windowBackgroundColors[value]);
    } else if (process.platform === "darwin" && nativeWindowMaterial === "none") {
      mainWindow.setBackgroundColor(windowBackgroundColors[value]);
    }
  });
  ipcMain.on("amplefile:menu:set-state", (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    updateApplicationMenuState(value);
  });
  ipcMain.handle("amplefile:menu:popup", (event, menuId: unknown, bounds: unknown) => {
    assertTrustedMainRenderer(event);
    popupApplicationSubmenu(menuId, bounds);
  });
  // Other AI agents (Settings → Command Line): the command on Terminal's PATH
  // and the skill in Claude Code's and Codex's skills folders, each on a click.
  const commandLineEnvironment = () => defaultCommandLineEnvironment({ isPackaged: app.isPackaged });
  ipcMain.handle("amplefile:command-line:status", (event) => {
    assertTrustedMainRenderer(event);
    return commandLineStatus(commandLineEnvironment());
  });
  ipcMain.handle("amplefile:command-line:install-path", (event) => {
    assertTrustedMainRenderer(event);
    return installCommandOnPath(commandLineEnvironment());
  });
  ipcMain.handle("amplefile:command-line:remove-path", (event) => {
    assertTrustedMainRenderer(event);
    return removeCommandFromPath(commandLineEnvironment());
  });
  ipcMain.handle("amplefile:command-line:install-skill", (event, target: unknown) => {
    assertTrustedMainRenderer(event);
    if (!isCommandLineSkillTarget(target)) throw new Error("Choose Claude Code or Codex.");
    return installSkill(commandLineEnvironment(), target);
  });
  ipcMain.handle("amplefile:command-line:remove-skill", (event, target: unknown) => {
    assertTrustedMainRenderer(event);
    if (!isCommandLineSkillTarget(target)) throw new Error("Choose Claude Code or Codex.");
    return removeSkill(commandLineEnvironment(), target);
  });
  ipcMain.handle("amplefile:command-line:skill", (event) => {
    assertTrustedMainRenderer(event);
    return outsideAgentSkill();
  });
  ipcMain.handle("amplefile:settings:status", (event) => {
    assertTrustedMainRenderer(event);
    return secureSettings?.status() ?? { encryptionAvailable: false, configuredProviders: [], credentialsNeedReentry: false };
  });
  ipcMain.on("amplefile:window:rail-tooltip-show", (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    try {
      railTooltipOverlay?.show(value);
    } catch (error) {
      console.warn(`${productName} could not show a rail tooltip: ${errorMessage(error)}`);
    }
  });
  ipcMain.on("amplefile:window:rail-tooltip-hide", (event) => {
    assertTrustedMainRenderer(event);
    railTooltipOverlay?.hide();
  });
  ipcMain.handle("amplefile:browser:mount", (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    return ensureBuiltInBrowser().mount(parseBrowserViewRequest(value));
  });
  ipcMain.on("amplefile:browser:layout", (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    try {
      ensureBuiltInBrowser().layout(parseBrowserViewRequest(value));
    } catch (error) {
      console.warn(`${productName} could not lay out a browser tab: ${errorMessage(error)}`);
    }
  });
  ipcMain.handle("amplefile:browser:unmount", (event, pageId: unknown) => {
    assertTrustedMainRenderer(event);
    if (!isBrowserPageId(pageId)) throw new Error("The browser tab id is invalid.");
    ensureBuiltInBrowser().detach(pageId);
  });
  ipcMain.handle("amplefile:browser:navigate", (event, pageId: unknown, address: unknown) => {
    assertTrustedMainRenderer(event);
    if (!isBrowserPageId(pageId)) throw new Error("The browser tab id is invalid.");
    if (typeof address !== "string" || address.length > 32_768) throw new Error("The browser address is invalid.");
    return ensureBuiltInBrowser().navigate(pageId, address);
  });
  ipcMain.handle("amplefile:browser:command", (event, pageId: unknown, command: unknown) => {
    assertTrustedMainRenderer(event);
    if (!isBrowserPageId(pageId)) throw new Error("The browser tab id is invalid.");
    ensureBuiltInBrowser().command(pageId, parseBrowserCommand(command));
  });
  ipcMain.handle("amplefile:browser:respond-permission", (event, pageId: unknown, requestId: unknown, decision: unknown) => {
    assertTrustedMainRenderer(event);
    if (!isBrowserPageId(pageId) || typeof requestId !== "string" || !/^[a-f0-9]{16}$/.test(requestId)) throw new Error("The site's request is invalid.");
    if (decision !== "allow" && decision !== "block") throw new Error("Choose Allow or Block.");
    ensureBuiltInBrowser().respondPermission(pageId, requestId, decision);
  });
  ipcMain.handle("amplefile:browser:close", (event, pageId: unknown) => {
    assertTrustedMainRenderer(event);
    if (!isBrowserPageId(pageId)) throw new Error("The browser tab id is invalid.");
    ensureBuiltInBrowser().close(pageId);
  });
  ipcMain.on("amplefile:browser:sync", (event, value: unknown) => {
    assertTrustedMainRenderer(event);
    try {
      ensureBuiltInBrowser().sync(parseBrowserTabsSync(value));
    } catch (error) {
      console.warn(`${productName} could not read the browser tab list: ${errorMessage(error)}`);
    }
  });
  ipcMain.handle("amplefile:browser:states", (event) => {
    assertTrustedMainRenderer(event);
    return ensureBuiltInBrowser().states();
  });
  ipcMain.handle("amplefile:browser:popup-tab-menu", (event, pageId: unknown, url: unknown, point: unknown, options: unknown) => {
    assertTrustedMainRenderer(event);
    if (!isBrowserPageId(pageId) || typeof url !== "string" || url.length > 32_768) throw new Error("The browser tab is invalid.");
    const at = point as { x?: unknown; y?: unknown } | null;
    const flags = options as { canReopen?: unknown; hasOthers?: unknown } | null;
    if (!at || typeof at.x !== "number" || typeof at.y !== "number" || !Number.isFinite(at.x) || !Number.isFinite(at.y)) throw new Error("The menu position is invalid.");
    return ensureBuiltInBrowser().popupTabMenu(pageId, url, { x: at.x, y: at.y }, { canReopen: flags?.canReopen === true, hasOthers: flags?.hasOthers === true });
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

type RendererMenuCommand =
  | "new-connected-folder"
  | "open-local-folder"
  | "new-chat"
  | "close-tab"
  | "reload-connected-folder-state"
  | "check-for-updates"
  | "open-settings"
  | "open-about"
  | "open-capabilities"
  | "open-skills"
  | "open-extensions"
  | "open-command-palette"
  | "open-keyboard-shortcuts"
  | "toggle-sidebar"
  | "toggle-agent-panel";

type ApplicationMenuId = "file" | "edit" | "view" | "help";

interface RendererMenuState {
  connectedFolderOpen: boolean;
}

function configureMenu(): void {
  if (process.platform === "darwin") {
    app.setAboutPanelOptions({
      applicationName: productName,
      applicationVersion,
      copyright: "Copyright © Mat-Tom-Son",
    });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenuTemplate()));
  if (process.platform === "win32" && mainWindow) {
    mainWindow.setAutoHideMenuBar(false);
    mainWindow.setMenuBarVisibility(false);
  }
  updateApplicationMenuState(rendererMenuState);
}

function buildApplicationMenuTemplate(): MenuItemConstructorOptions[] {
  return [
    ...macApplicationMenu(),
    { id: "file", label: "File", submenu: buildApplicationSubmenuTemplate("file") },
    { id: "edit", label: "Edit", submenu: buildApplicationSubmenuTemplate("edit") },
    { id: "view", label: "View", submenu: buildApplicationSubmenuTemplate("view") },
    ...macWindowMenu(),
    { id: "help", label: "Help", submenu: buildApplicationSubmenuTemplate("help") },
  ];
}

function buildApplicationSubmenuTemplate(menuId: ApplicationMenuId): MenuItemConstructorOptions[] {
  if (menuId === "file") {
    const items: MenuItemConstructorOptions[] = [
      { label: "New Connected Folder", accelerator: "CommandOrControl+N", click: () => sendRendererMenuCommand("new-connected-folder") },
      { label: "Connect Folder...", accelerator: "CommandOrControl+O", click: () => sendRendererMenuCommand("open-local-folder") },
      ...(process.platform === "darwin" ? [{
        label: "Open Recent",
        role: "recentDocuments" as const,
        submenu: [{ role: "clearRecentDocuments" as const }],
      }] : []),
      { type: "separator" },
      { id: "new-chat", label: "New Chat", accelerator: "CommandOrControl+Shift+N", enabled: rendererMenuState.connectedFolderOpen, click: () => sendRendererMenuCommand("new-chat") },
      { id: "refresh-connected-folder", label: "Refresh Connected Folder", accelerator: "CommandOrControl+R", enabled: rendererMenuState.connectedFolderOpen, click: () => sendRendererMenuCommand("reload-connected-folder-state") },
    ];
    if (process.platform !== "darwin") {
      items.push(
        { type: "separator" },
        { label: "Settings...", accelerator: "CommandOrControl+,", click: () => sendRendererMenuCommand("open-settings") },
      );
    }
    if (process.platform === "darwin") {
      // Cmd+W follows tab-strip muscle memory and closes the active surface
      // tab; the window keeps the conventional Shift+Cmd+W.
      items.push(
        { type: "separator" },
        { id: "close-tab", label: "Close Tab", accelerator: "CommandOrControl+W", enabled: rendererMenuState.connectedFolderOpen, click: () => sendRendererMenuCommand("close-tab") },
        { role: "close", accelerator: "Shift+CommandOrControl+W" },
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
      ...(process.platform === "darwin" ? [{ role: "pasteAndMatchStyle" as const }] : []),
      { role: "delete" },
      { type: "separator" },
      { role: "selectAll" },
      ...macEditMenuAdditions(),
    ];
  }
  if (menuId === "view") {
    return [
      { label: "Command Palette...", accelerator: "CommandOrControl+K", click: () => sendRendererMenuCommand("open-command-palette") },
      ...(process.platform === "linux" ? [{ label: "AmpleFile Agent", click: () => { void toggleAmpleFileAgentPopover(); } }] : []),
      { type: "separator" },
      { id: "toggle-sidebar", label: "Toggle Sidebar", accelerator: "CommandOrControl+B", enabled: rendererMenuState.connectedFolderOpen, click: () => sendRendererMenuCommand("toggle-sidebar") },
      { id: "toggle-agent-panel", label: "Toggle AmpleFile Agent", accelerator: "CommandOrControl+J", enabled: rendererMenuState.connectedFolderOpen, click: () => sendRendererMenuCommand("toggle-agent-panel") },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      ...(!app.isPackaged ? [{ type: "separator" }, { role: "toggleDevTools" }] as MenuItemConstructorOptions[] : []),
      { type: "separator" },
      { role: "togglefullscreen" },
    ];
  }
  const items: MenuItemConstructorOptions[] = [
    { id: "open-capabilities", label: "Skills && Extensions", accelerator: "CommandOrControl+Shift+S", enabled: rendererMenuState.connectedFolderOpen, click: () => sendRendererMenuCommand("open-capabilities") },
    { label: "Shortcut Keys", accelerator: "CommandOrControl+/", click: () => sendRendererMenuCommand("open-keyboard-shortcuts") },
  ];
  if (process.platform !== "darwin") {
    items.push(
      ...checkForUpdatesMenuItems(() => sendRendererMenuCommand("check-for-updates")),
      { type: "separator" },
      { label: `About ${productName} ${applicationVersion}`, click: () => sendRendererMenuCommand("open-about") },
    );
  }
  return items;
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
      { label: "Settings...", accelerator: "Command+,", click: () => sendRendererMenuCommand("open-settings") },
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

function popupApplicationSubmenu(menuId: unknown, bounds: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed() || !isApplicationMenuId(menuId)) return;
  const point = menuPopupPoint(bounds);
  Menu.buildFromTemplate(buildApplicationSubmenuTemplate(menuId)).popup({ window: mainWindow, x: point.x, y: point.y });
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

function sendRendererMenuCommand(command: RendererMenuCommand): void {
  if (modelContextWindow?.handleMenuCommand(command)) return;
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    if (app.isReady() && !quitting && !quittingForUpdate) {
      void ensureMainWindow().then(() => sendRendererMenuCommand(command)).catch(reportStartupError);
    }
    return;
  }
  showWindow();
  window.webContents.send("amplefile:menu-command", command);
}

function updateApplicationMenuState(value: unknown): void {
  rendererMenuState = {
    connectedFolderOpen: isRecord(value)
      ? value.connectedFolderOpen === true
      : rendererMenuState.connectedFolderOpen,
  };
  const menu = Menu.getApplicationMenu();
  setMenuItemEnabled(menu, "new-chat", rendererMenuState.connectedFolderOpen);
  setMenuItemEnabled(menu, "refresh-connected-folder", rendererMenuState.connectedFolderOpen);
  setMenuItemEnabled(menu, "close-tab", rendererMenuState.connectedFolderOpen);
  setMenuItemEnabled(menu, "open-capabilities", rendererMenuState.connectedFolderOpen);
  setMenuItemEnabled(menu, "toggle-sidebar", rendererMenuState.connectedFolderOpen);
  setMenuItemEnabled(menu, "toggle-agent-panel", rendererMenuState.connectedFolderOpen);
}

function setMenuItemEnabled(menu: Menu | null, id: string, enabled: boolean): void {
  const item = menu?.getMenuItemById(id);
  if (item) item.enabled = enabled;
}

function configureUpdater(): void {
  // Ad hoc verification builds use a separate identity and must never touch
  // the production update feed or production AmpleFile Safe Storage key.
  if (desktopUpdater || localMacSmokeBuild) return;
  desktopUpdater = new DesktopUpdater({
    getWindow: () => mainWindow,
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
 * or before it starts the same feed test it uses. Linux previews, unpackaged
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
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
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
  assertPathInsideRoot(root, resolvedCandidate);
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

async function setActiveNativeConnectedFolder(connectedFolderId: string | null): Promise<void> {
  const generation = ++activeNativeConnectedFolderGeneration;
  if (connectedFolderId === null) {
    activeNativeConnectedFolder = null;
    applyNativeActiveConnectedFolderToWindow(mainWindow);
    return;
  }

  // The renderer supplies identity only. Name and root are always loaded from
  // the host-owned registry before they reach native window or OS APIs.
  const connectedFolder = await getConnectedFolder(connectedFolderId);
  if (generation !== activeNativeConnectedFolderGeneration) return;
  activeNativeConnectedFolder = { id: connectedFolder.id, name: connectedFolder.name, connectedFolderRoot: connectedFolder.connectedFolderRoot };
  applyNativeActiveConnectedFolderToWindow(mainWindow);
  if (process.platform === "darwin") app.addRecentDocument(connectedFolder.connectedFolderRoot);
}

async function validateNativeFileMenuEntry(request: NativeFileMenuRequest): Promise<void> {
  let info;
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

function popupNativeFileMenu(request: NativeFileMenuRequest): Promise<NativeFileMenuCommand | null> {
  return popupNativeCommandMenu(nativeFileMenuItems(request, process.platform), request.point);
}

function popupNativeTabMenu(request: NativeTabMenuRequest): Promise<NativeTabMenuCommand | null> {
  return popupNativeCommandMenu(nativeTabMenuItems(request), request.point);
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

/** The files on the system pasteboard (Finder's or a Linux file manager's Copy), newest format first; empty when it holds no files. */
async function readPasteboardFilePaths(): Promise<string[]> {
  // A Linux Cut is pasted as a copy too: the other app's files stay where they are.
  if (process.platform === "linux") {
    // The helper reads off the main thread, and also reads another Chromium app's files; Electron's read is the fallback.
    const files = await (await linuxClipboardOwner())?.readFiles();
    return (files ?? readLinuxClipboardFiles(clipboard)).paths;
  }
  if (process.platform !== "darwin") return [];
  const plist = clipboard.read("NSFilenamesPboardType");
  const listed = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => decodeXmlText(match[1] ?? "")).filter((path) => isAbsolute(path));
  if (listed.length) return listed;
  const url = clipboard.read("public.file-url").trim();
  if (url.startsWith("file://")) {
    try { return [fileURLToPath(url)]; } catch { return []; }
  }
  return [];
}

/** Puts files on the system pasteboard the way Finder's (or a Linux file manager's) Copy does, so it can paste them. */
async function writePasteboardFilePaths(paths: readonly string[]): Promise<void> {
  if (process.platform === "linux") {
    // The helper offers GNOME's format, the URI list and text together; Electron alone offers only the URI list.
    const owner = await linuxClipboardOwner();
    if (owner && await owner.offer(linuxFileClipboardOffers(paths))) return;
    writeLinuxClipboardFiles(clipboard, paths);
    return;
  }
  if (process.platform !== "darwin") { clipboard.writeText(paths.join("\n")); return; }
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><array>${paths.map((path) => `<string>${encodeXmlText(path)}</string>`).join("")}</array></plist>`;
  clipboard.writeBuffer("NSFilenamesPboardType", Buffer.from(plist, "utf8"));
}

function encodeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function decodeXmlText(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
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
 * Shows a native menu at a point in the app's CSS pixels; resolves with the
 * chosen command, or null. Every native context menu goes through here.
 */
function popupNativeCommandMenu<Command extends string>(items: NativeCommandMenuItem<Command>[], point: { x: number; y: number }): Promise<Command | null> {
  const window = mainWindow;
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

function applyNativeActiveConnectedFolderToWindow(window: BrowserWindow | null): void {
  if (process.platform !== "darwin" || !window || window.isDestroyed()) return;
  window.setRepresentedFilename(activeNativeConnectedFolder?.connectedFolderRoot ?? "");
  window.setTitle(activeNativeConnectedFolder?.name ?? productName);
}

// Folders the system asked AmpleFile to open: Finder's open-file on macOS, a
// desktop launcher's arguments on Linux. Each opens only an already
// registered Connected Folder; connecting a folder stays an explicit act.
async function drainPendingOpenPaths(): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  if (openPathDrainPromise) {
    await openPathDrainPromise;
    if (pendingOpenPaths.length) await drainPendingOpenPaths();
    return;
  }

  openPathDrainPromise = (async () => {
    while (pendingOpenPaths.length) {
      const path = pendingOpenPaths.shift();
      if (!path) continue;
      await ensureMainWindow();
      showWindow();
      const connectedFolderId = await registeredConnectedFolderIdForOpenPath(path);
      if (!connectedFolderId) {
        console.warn(`${productName} ignored a folder that is not a Connected Folder: ${path}`);
        continue;
      }
      await setActiveNativeConnectedFolder(connectedFolderId);
      const request = { token: randomUUID(), connectedFolderId };
      pendingOpenConnectedFolderRequest = request;
      const window = mainWindow;
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send("amplefile:connected-folder:open-connected-folder", request);
      }
    }
  })().finally(() => {
    openPathDrainPromise = null;
  });

  await openPathDrainPromise;
  if (pendingOpenPaths.length) await drainPendingOpenPaths();
}

async function registeredConnectedFolderIdForOpenPath(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return null;
    const openedRoot = await realpath(path);
    for (const connectedFolder of await listConnectedFolders()) {
      try {
        const registeredRoot = await realpath(connectedFolder.connectedFolderRoot);
        if (samePath(openedRoot, registeredRoot)) return connectedFolder.id;
      } catch {
        // Missing registered folders are already excluded from normal bootstrap;
        // one stale registration must not block another exact match.
      }
    }
  } catch {
    // Finder may pass a path that moved before AmpleFile was ready.
  }
  return null;
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

/** The built-in browser (docs/built-in-browser.md); created once the app is ready, before any window. */
function ensureBuiltInBrowser(): BuiltInBrowser {
  builtInBrowser ??= new BuiltInBrowser({
    window: () => mainWindow && !mainWindow.isDestroyed() ? mainWindow : null,
    send: (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(channel, payload);
    },
    openExternal,
    downloadsPath: () => app.getPath("downloads"),
    sitePermissionsPath: join(app.getPath("userData"), "browser-site-permissions.json"),
    historyPath: join(app.getPath("userData"), "browser-history.json"),
    // The app names itself, as Claude's browser does; Google's sign-in refuses a browser posing as plain Chrome.
    userAgentProduct: `${productionProductName}/${applicationVersion}`,
    onViewAttached: () => railTooltipOverlay?.raise(),
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
  modelContextWindow?.dispose();
  // Quitting closes every page. Tabs are not kept: sign-ins and history are what the next launch has.
  builtInBrowser?.dispose();
  if (rendererRecoveryTimer) clearTimeout(rendererRecoveryTimer);
  rendererRecoveryTimer = null;
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

function showWindow(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    if (app.isReady()) void ensureMainWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}

function ensureMainWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) return Promise.resolve();
  createWindowPromise ??= createMainWindow().finally(() => { createWindowPromise = null; });
  return createWindowPromise;
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
  if (tray || !["win32", "darwin", "linux"].includes(process.platform)) return;
  const icon = resolveTrayIcon();
  if (!icon) {
    console.warn(`${productName} tray icon was not found; the ${process.platform === "darwin" ? "menu-bar" : "tray"} surface is unavailable.`);
    return;
  }
  tray = new Tray(icon);
  const menu = Menu.buildFromTemplate([
    { label: "AmpleFile Agent", click: () => { void toggleAmpleFileAgentPopover(); } },
    { label: `Open ${productName}`, click: showWindow },
    ...checkForUpdatesMenuItems(() => sendRendererMenuCommand("check-for-updates")),
    { type: "separator" },
    { label: `Quit ${productName}`, click: () => app.quit() },
  ]);
  if (process.platform === "darwin") {
    // No persistent context menu on macOS: setContextMenu would swallow the
    // left click. Click opens the AmpleFile Agent popover, right-click the menu,
    // and material dropped on the icon lands in the popover as staged context.
    tray.on("click", () => { void toggleAmpleFileAgentPopover(); });
    tray.on("right-click", () => tray?.popUpContextMenu(menu));
    tray.on("drop-files", (_event, files) => {
      void openAmpleFileAgentPopoverWithItems(files.map((file) => ({ kind: "path" as const, value: file })));
    });
    tray.on("drop-text", (_event, text) => {
      void openAmpleFileAgentPopoverWithItems([{ kind: "text" as const, value: text }]);
    });
  } else {
    tray.setContextMenu(menu);
    tray.on("click", showWindow);
    tray.on("double-click", showWindow);
  }
  updateTrayTooltip();
  updateTrayPulse();
  // Warm the hidden popover renderer off the startup critical path so the
  // first AmpleFile Agent summon paints the ready surface immediately.
  setTimeout(() => {
    void ensureAmpleFileAgentPopover().then((popover) => popover.warm()).catch(() => {});
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
  stopTrayPulse();
  tray?.destroy();
  tray = null;
  ampleFileAgentPopover?.destroy();
  ampleFileAgentPopover = null;
}

async function ensureAmpleFileAgentPopover(): Promise<AmpleFileAgentPopover> {
  if (ampleFileAgentPopover) return ampleFileAgentPopover;
  const api = await ensureInteractiveLocalApi();
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
  });
  return ampleFileAgentPopover;
}

async function toggleAmpleFileAgentPopover(): Promise<void> {
  try {
    const popover = await ensureAmpleFileAgentPopover();
    await popover.toggle(tray?.getBounds() ?? null);
  } catch (error) {
    console.warn(`${productName} could not open the AmpleFile Agent popover: ${errorMessage(error)}`);
  }
}

async function openAmpleFileAgentPopoverWithItems(items: AmpleFileAgentPopoverStagedItem[]): Promise<void> {
  try {
    const popover = await ensureAmpleFileAgentPopover();
    await popover.stage(items, tray?.getBounds() ?? null);
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

function configureAccentColorMonitor(): void {
  if (accentColorMonitorRegistered || (process.platform !== "win32" && process.platform !== "darwin")) return;
  accentColorMonitorRegistered = true;
  const sendAccentColor = () => {
    const accent = getSystemAccentColor();
    const window = mainWindow;
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send("amplefile:window:accent-color-changed", accent);
    }
    // The menu-bar popover subscribes too, and may be open with no main window.
    ampleFileAgentPopover?.send("amplefile:window:accent-color-changed", accent);
  };
  if (process.platform === "darwin") {
    systemPreferences.subscribeNotification("AppleColorPreferencesChangedNotification", sendAccentColor);
  } else {
    systemPreferences.on("accent-color-changed", sendAccentColor);
  }
}

function getSystemAccentColor(): string | null {
  if (process.platform !== "win32" && process.platform !== "darwin") return null;
  try {
    const raw = systemPreferences.getAccentColor().replace(/^#/, "");
    return /^[0-9a-fA-F]{8}$/.test(raw) ? `#${raw.slice(0, 6)}` : null;
  } catch {
    return null;
  }
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
    scheduleRendererRecovery(description || `load failed with error ${code}`);
  });
  window.webContents.on("did-finish-load", () => {
    rendererRecoveryAttempts = 0;
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    detachBrowserViews();
    if (!window.isDestroyed()) scheduleRendererRecovery(`renderer process ended: ${details.reason}`);
  });
}

function ensureRendererAfterResume(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isLoadingMainFrame()) return;
  const currentUrl = window.webContents.getURL();
  if (!isTrustedRendererUrl(currentUrl)) scheduleRendererRecovery(`renderer was not on the app URL after resume: ${currentUrl || "blank"}`, 0);
}

function loadMainRenderer(window: BrowserWindow): Promise<void> {
  return window.loadURL(`${appProtocol}://app/index.html`);
}

function scheduleRendererRecovery(reason: string, delayMs?: number): void {
  if (quitting || quittingForUpdate || !quitCoordinator.shouldPreventNativeQuit()) return;
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed() || rendererRecoveryTimer || rendererRecoveryInFlight) return;
  if (rendererRecoveryAttempts >= rendererRecoveryMaxAttempts) {
    void showRendererRecoveryFailedDialog(reason);
    return;
  }
  const delay = delayMs ?? Math.min(rendererRecoveryMaxDelayMs, rendererRecoveryBaseDelayMs * (2 ** rendererRecoveryAttempts));
  rendererRecoveryTimer = setTimeout(() => {
    rendererRecoveryTimer = null;
    void recoverRenderer(reason);
  }, delay);
}

async function recoverRenderer(reason: string): Promise<void> {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  rendererRecoveryInFlight = true;
  rendererRecoveryAttempts += 1;
  let retryReason: string | null = null;
  try {
    console.warn(`${productName} reloading its window after a recoverable issue: ${reason}`);
    await loadMainRenderer(window);
  } catch (error) {
    retryReason = errorMessage(error);
  } finally {
    rendererRecoveryInFlight = false;
  }
  if (retryReason) scheduleRendererRecovery(retryReason);
  else {
    rendererRecoveryAttempts = 0;
    rendererRecoveryFailurePromptShown = false;
    window.webContents.send("amplefile:runtime:renderer-recovered");
  }
}

async function showRendererRecoveryFailedDialog(reason: string): Promise<void> {
  if (rendererRecoveryFailurePromptShown) return;
  rendererRecoveryFailurePromptShown = true;
  const options = {
    type: "error" as const,
    message: `${productName} could not recover this window.`,
    detail: `The window failed to reload after ${rendererRecoveryAttempts} attempts. Restart to try again. (${reason})`,
    buttons: [`Restart ${productName}`, "Close"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, options)
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
  if (params.linkURL.length > 0) template.push({ label: "Copy Link Address", click: () => clipboard.writeText(params.linkURL) });
  return template;
}

function assertTrustedRenderer(event: IpcMainInvokeEvent | IpcMainEvent): void {
  if (modelContextWindow?.owns(event.sender)) throw new Error("The developer inspector has diagnostics-only access.");
  if (!event.senderFrame || !isTrustedRendererUrl(event.senderFrame.url)) throw new Error("Untrusted renderer IPC request.");
}

/**
 * The handful of channels the AmpleFile Agent popover's narrow preload uses.
 * Every other handler requires the main renderer, so popover isolation does
 * not rest on its preload alone.
 */
function assertMainOrAgentPopoverRenderer(event: IpcMainInvokeEvent | IpcMainEvent): void {
  if (ampleFileAgentPopover?.owns(event.sender)) {
    assertTrustedRenderer(event);
    const frame = event.senderFrame;
    const mainFrame = event.sender.mainFrame;
    if (!frame || frame.processId !== mainFrame.processId || frame.routingId !== mainFrame.routingId) {
      throw new Error("This request requires the AmpleFile Agent popover's main frame.");
    }
    return;
  }
  assertTrustedMainRenderer(event);
}

function assertTrustedMainRenderer(event: IpcMainInvokeEvent | IpcMainEvent): void {
  assertTrustedRenderer(event);
  const frame = event.senderFrame;
  const mainFrame = event.sender.mainFrame;
  const mainFrameMatches = Boolean(frame && frame.processId === mainFrame.processId && frame.routingId === mainFrame.routingId);
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || !mainFrameMatches) {
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

interface WindowState { x: number; y: number; width: number; height: number; isMaximized: boolean }

function configureWindowStatePersistence(window: BrowserWindow): void {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveWindowState(window);
    }, windowStateSaveDelayMs);
  };
  window.on("resize", scheduleSave);
  window.on("move", scheduleSave);
  window.on("close", () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveWindowState(window);
  });
}

function readWindowState(): WindowState | null {
  const path = join(app.getPath("userData"), "window-state.json");
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<WindowState>;
    if (![value.x, value.y, value.width, value.height].every((part) => typeof part === "number" && Number.isFinite(part))) return null;
    return {
      x: Math.round(value.x as number),
      y: Math.round(value.y as number),
      width: Math.max(1, Math.round(value.width as number)),
      height: Math.max(1, Math.round(value.height as number)),
      isMaximized: value.isMaximized === true,
    };
  } catch {
    return null;
  }
}

function visibleWindowState(state: WindowState | null): WindowState | null {
  if (!state || !screen.getAllDisplays().some((display) => intersects(state, display.bounds))) return null;
  return fitWindowToWorkArea(state, screen.getDisplayMatching(state).workArea, minimumWindowState);
}

function saveWindowState(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  try {
    const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
    const state: WindowState = { ...bounds, isMaximized: window.isMaximized() };
    writeFileSync(join(app.getPath("userData"), "window-state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // Window placement is a convenience; startup should not fail if it cannot be saved.
  }
}

function intersects(a: WindowState, b: Rectangle): boolean {
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
