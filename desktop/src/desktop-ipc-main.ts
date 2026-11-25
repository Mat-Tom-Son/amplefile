/**
 * The main process's side of the desktop IPC contract (src/shared/desktop-ipc.ts).
 *
 * `DesktopIpcMain` is Electron's own `ipcMain`, typed so that `handle` and
 * `on` take only the contract's channels and a handler must answer with the
 * channel's result; main.ts assigns `electron.ipcMain` to it, and a module that
 * registers handlers takes it as an option. A handler receives its arguments
 * as `unknown` and checks them before use. `sendToRenderer` is
 * `webContents.send` for the contract's events. Neither changes anything at run
 * time, and this module imports nothing from Electron at run time, so the
 * modules that use it stay testable without Electron.
 */
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";

import type {
  DesktopEventArgs,
  DesktopEventChannel,
  DesktopInvokeArgs,
  DesktopInvokeChannel,
  DesktopInvokeResult,
  DesktopSendArgs,
  DesktopSendChannel,
  Unchecked,
} from "../../src/shared/desktop-ipc.js";

export type DesktopInvokeHandler<C extends DesktopInvokeChannel> = (
  event: IpcMainInvokeEvent,
  ...args: Unchecked<DesktopInvokeArgs<C>>
) => DesktopInvokeResult<C> | Promise<DesktopInvokeResult<C>>;

export type DesktopSendHandler<C extends DesktopSendChannel> = (event: IpcMainEvent, ...args: Unchecked<DesktopSendArgs<C>>) => void;

export interface DesktopIpcMain {
  handle<C extends DesktopInvokeChannel>(channel: C, handler: DesktopInvokeHandler<C>): void;
  on<C extends DesktopSendChannel>(channel: C, listener: DesktopSendHandler<C>): unknown;
}

/** Sends one of the contract's events to a renderer. */
export function sendToRenderer<C extends DesktopEventChannel>(
  contents: { send(channel: string, ...args: unknown[]): void },
  channel: C,
  ...args: DesktopEventArgs<C>
): void {
  contents.send(channel, ...args);
}
