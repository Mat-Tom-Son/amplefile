import { readFile } from "node:fs/promises";
import { posix } from "node:path";

import {
  busDaemonCall,
  DBusError,
  type DBusMessage,
  SessionBusConnection,
  type SessionBusOpenOptions,
} from "./linux-session-bus.js";

/**
 * `org.freedesktop.FileManager1` on the session bus: what a browser's
 * downloads list, a chat app or the desktop portal calls to "show in folder"
 * ([interface](https://www.freedesktop.org/wiki/Specifications/file-manager-interface/)).
 * While the person has chosen it in Settings → File Manager, AmpleFile owns
 * the name and hands each request to the window's open-location path.
 */

export const fileManagerBusName = "org.freedesktop.FileManager1";
export const fileManagerObjectPath = "/org/freedesktop/FileManager1";
export const fileManagerInterface = "org.freedesktop.FileManager1";

/** URIs read from one call; the rest are ignored. */
export const maxFileManagerUris = 64;
/** Longest URI, and longest decoded path, accepted. */
export const maxFileManagerUriLength = 4096;
const maxStartupIdLength = 256;

export type FileManagerMethod = "ShowFolders" | "ShowItems" | "ShowItemProperties";

export interface FileManagerRequest {
  method: FileManagerMethod;
  /** Absolute, normalized local paths, in the caller's order (at least one). */
  paths: string[];
  /** The caller's startup notification id, when it sent a usable one. */
  startupId: string | null;
}

/**
 * The local path a `file:` URI names, or null. Only `file:` URIs with no host
 * (or `localhost`), no query or fragment, strict percent-escapes that decode
 * to UTF-8 without NUL, and an absolute path within the length limit.
 */
export function localPathFromFileUri(value: unknown): string | null {
  if (typeof value !== "string" || value.length > maxFileManagerUriLength) return null;
  if (!/^file:\/\//i.test(value)) return null;
  // Control characters, and the query and fragment delimiters, never appear in a usable file URI.
  if (/[\u0000-\u001f\u007f?#]/.test(value)) return null;
  const rest = value.slice("file://".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const host = rest.slice(0, slash);
  if (host !== "" && host.toLowerCase() !== "localhost") return null;
  const encoded = rest.slice(slash);
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index += 1) {
    const char = encoded[index]!;
    if (char === "%") {
      const hex = encoded.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else {
      bytes.push(...Buffer.from(char, "utf8"));
    }
  }
  if (bytes.includes(0)) return null;
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.length > maxFileManagerUriLength) return null;
  const normalized = posix.normalize(decoded);
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function usableStartupId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxStartupIdLength && /^[\x21-\x7e]+$/.test(value) ? value : null;
}

/** A FileManager1 call's arguments as a request, or null when none of its URIs is usable. */
export function fileManagerRequest(method: FileManagerMethod, uris: unknown, startupId: unknown): FileManagerRequest | null {
  if (!Array.isArray(uris)) return null;
  const paths: string[] = [];
  for (const uri of uris.slice(0, maxFileManagerUris)) {
    const path = localPathFromFileUri(uri);
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths.length ? { method, paths, startupId: usableStartupId(startupId) } : null;
}

export const fileManagerIntrospection = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="org.freedesktop.FileManager1">
    <method name="ShowFolders"><arg type="as" name="URIs" direction="in"/><arg type="s" name="StartupId" direction="in"/></method>
    <method name="ShowItems"><arg type="as" name="URIs" direction="in"/><arg type="s" name="StartupId" direction="in"/></method>
    <method name="ShowItemProperties"><arg type="as" name="URIs" direction="in"/><arg type="s" name="StartupId" direction="in"/></method>
  </interface>
  <interface name="org.freedesktop.DBus.Introspectable">
    <method name="Introspect"><arg type="s" name="xml_data" direction="out"/></method>
  </interface>
  <interface name="org.freedesktop.DBus.Peer">
    <method name="Ping"/>
    <method name="GetMachineId"><arg type="s" name="machine_uuid" direction="out"/></method>
  </interface>
</node>
`;

function parentIntrospection(child: string): string {
  return `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">\n<node>\n  <node name="${child}"/>\n</node>\n`;
}

const parentNodes = new Map([["/", "org"], ["/org", "freedesktop"], ["/org/freedesktop", "FileManager1"]]);

export type FileManagerServiceState =
  | { kind: "stopped" }
  | { kind: "starting" }
  | { kind: "owner" }
  /** Another program holds the name; AmpleFile is next in line and takes over when it lets go. */
  | { kind: "queued"; currentOwner: string | null }
  | { kind: "unavailable"; reason: string };

export interface FileManagerServiceOptions {
  onRequest: (request: FileManagerRequest) => void;
  onStateChange?: (state: FileManagerServiceState) => void;
  bus?: SessionBusOpenOptions;
  log?: (message: string) => void;
  /** Requests accepted per {@link requestWindowMs}; further ones are answered and ignored. */
  maxRequestsPerWindow?: number;
  requestWindowMs?: number;
  /** Reads a process's command name (for "nautilus is answering now"). */
  processName?: (pid: number) => Promise<string | null>;
  now?: () => number;
}

const requestNameReplaceExisting = 0x2;
const reconnectDelaysMs = [2_000, 10_000, 30_000];

async function defaultProcessName(pid: number): Promise<string | null> {
  try {
    const name = (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
    return /^[\x20-\x7e]{1,32}$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

/** Answers the FileManager1 interface while started. */
export class FileManagerService {
  private connection: SessionBusConnection | null = null;
  private state: FileManagerServiceState = { kind: "stopped" };
  private wanted = false;
  private generation = 0;
  private reconnects = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private recentRequests: number[] = [];
  private readonly log: (message: string) => void;

  constructor(private readonly options: FileManagerServiceOptions) {
    this.log = options.log ?? (() => {});
  }

  current(): FileManagerServiceState { return this.state; }

  /** The live connection, for a bus call such as ReloadConfig. */
  busConnection(): SessionBusConnection | null {
    return this.connection && !this.connection.isClosed ? this.connection : null;
  }

  async start(): Promise<FileManagerServiceState> {
    this.wanted = true;
    if (this.connection && !this.connection.isClosed) return this.state;
    return this.connect();
  }

  async stop(): Promise<void> {
    this.wanted = false;
    this.generation += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const connection = this.connection;
    this.connection = null;
    if (connection && !connection.isClosed) {
      await busDaemonCall(connection, "ReleaseName", "s", [fileManagerBusName], 2_000).catch(() => {});
      connection.close();
    }
    this.setState({ kind: "stopped" });
  }

  private setState(state: FileManagerServiceState): void {
    this.state = state;
    this.options.onStateChange?.(state);
  }

  private async connect(): Promise<FileManagerServiceState> {
    const generation = ++this.generation;
    this.setState({ kind: "starting" });
    let connection: SessionBusConnection;
    try {
      connection = await SessionBusConnection.open(this.options.bus);
    } catch (error) {
      if (generation === this.generation) this.setState({ kind: "unavailable", reason: `AmpleFile can't reach the desktop's session bus (${messageOf(error)}).` });
      return this.state;
    }
    if (generation !== this.generation || !this.wanted) {
      connection.close();
      return this.state;
    }
    this.connection = connection;
    connection.on("methodCall", (message: DBusMessage) => this.handleCall(connection, message));
    connection.on("signal", (message: DBusMessage) => this.handleSignal(connection, message));
    connection.on("close", (error: Error | null) => {
      if (this.connection !== connection) return;
      this.connection = null;
      if (!this.wanted) return;
      this.setState({ kind: "unavailable", reason: `The desktop's session bus closed AmpleFile's connection${error ? ` (${error.message})` : ""}.` });
      this.scheduleReconnect();
    });
    try {
      const reply = await busDaemonCall(connection, "RequestName", "su", [fileManagerBusName, requestNameReplaceExisting]);
      const result = Number(reply.body[0]);
      if (generation !== this.generation) return this.state;
      if (result === 1 || result === 4) {
        this.reconnects = 0;
        this.setState({ kind: "owner" });
      } else if (result === 2) {
        this.setState({ kind: "queued", currentOwner: await this.ownerName(connection) });
      } else {
        this.setState({ kind: "unavailable", reason: "Another file manager holds the name and won't share it." });
      }
    } catch (error) {
      if (generation === this.generation) {
        this.setState({ kind: "unavailable", reason: error instanceof DBusError && /AccessDenied/.test(error.name)
          ? "The desktop's bus policy doesn't let AmpleFile answer as the file manager."
          : `AmpleFile couldn't take the file manager's name (${messageOf(error)}).` });
      }
    }
    return this.state;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.reconnects >= reconnectDelaysMs.length) return;
    const delay = reconnectDelaysMs[this.reconnects++]!;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wanted) void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async ownerName(connection: SessionBusConnection): Promise<string | null> {
    try {
      const owner = String((await busDaemonCall(connection, "GetNameOwner", "s", [fileManagerBusName], 2_000)).body[0] ?? "");
      if (!owner || owner === connection.uniqueName) return null;
      const pid = Number((await busDaemonCall(connection, "GetConnectionUnixProcessID", "s", [owner], 2_000)).body[0]);
      return Number.isSafeInteger(pid) && pid > 0 ? await (this.options.processName ?? defaultProcessName)(pid) : null;
    } catch {
      return null;
    }
  }

  private handleSignal(connection: SessionBusConnection, message: DBusMessage): void {
    if (message.sender !== "org.freedesktop.DBus" || message.interface !== "org.freedesktop.DBus" || message.body[0] !== fileManagerBusName) return;
    if (message.member === "NameAcquired") {
      this.reconnects = 0;
      this.setState({ kind: "owner" });
    } else if (message.member === "NameLost" && this.wanted) {
      void this.ownerName(connection).then((currentOwner) => {
        if (this.connection === connection && this.state.kind !== "owner") this.setState({ kind: "queued", currentOwner });
      });
      this.setState({ kind: "queued", currentOwner: null });
    }
  }

  private allowRequest(): boolean {
    const now = (this.options.now ?? Date.now)();
    const windowMs = this.options.requestWindowMs ?? 10_000;
    this.recentRequests = this.recentRequests.filter((time) => now - time < windowMs);
    if (this.recentRequests.length >= (this.options.maxRequestsPerWindow ?? 10)) return false;
    this.recentRequests.push(now);
    return true;
  }

  private handleCall(connection: SessionBusConnection, message: DBusMessage): void {
    try {
      const { path = "", member = "" } = message;
      const iface = message.interface;
      if (iface === "org.freedesktop.DBus.Peer" || (!iface && (member === "Ping" || member === "GetMachineId"))) {
        if (member === "Ping" && message.signature === "") return connection.reply(message);
        if (member === "GetMachineId" && message.signature === "") {
          void readFile("/etc/machine-id", "utf8").then(
            (id) => connection.reply(message, "s", [id.trim()]),
            () => connection.replyError(message, "org.freedesktop.DBus.Error.Failed", "No machine id."),
          );
          return;
        }
      }
      if ((iface === "org.freedesktop.DBus.Introspectable" || !iface) && member === "Introspect" && message.signature === "") {
        if (path === fileManagerObjectPath) return connection.reply(message, "s", [fileManagerIntrospection]);
        const child = parentNodes.get(path);
        if (child) return connection.reply(message, "s", [parentIntrospection(child)]);
      }
      if (path === fileManagerObjectPath && (iface === fileManagerInterface || !iface)
        && (member === "ShowFolders" || member === "ShowItems" || member === "ShowItemProperties")) {
        if (message.signature !== "ass") return connection.replyError(message, "org.freedesktop.DBus.Error.InvalidArgs", `${member} takes (as URIs, s StartupId).`);
        // Answer first: the caller is waiting, and opening the window can take a moment.
        connection.reply(message);
        // Not gated on the recorded state: the bus routes the name's calls here only once AmpleFile
        // owns it, and a call held for activation can arrive before the RequestName reply is read.
        if (!this.wanted || this.connection !== connection) return;
        const request = fileManagerRequest(member, message.body[0], message.body[1]);
        if (!request) {
          this.log(`ignored a ${member} request with no usable file: URI`);
          return;
        }
        if (!this.allowRequest()) {
          this.log(`ignored a ${member} request: too many in a short time`);
          return;
        }
        this.options.onRequest(request);
        return;
      }
      if (path !== fileManagerObjectPath && !parentNodes.has(path)) return connection.replyError(message, "org.freedesktop.DBus.Error.UnknownObject", `No object at ${path}.`);
      connection.replyError(message, "org.freedesktop.DBus.Error.UnknownMethod", `No method ${member} here.`);
    } catch (error) {
      this.log(`could not answer a FileManager1 call: ${messageOf(error)}`);
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
