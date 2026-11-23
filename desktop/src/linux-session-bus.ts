import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";

/**
 * A small D-Bus client for the Linux session bus, enough to own a well-known
 * name and answer method calls (the `org.freedesktop.FileManager1` service).
 *
 * Electron has no D-Bus server API. Rather than add a native helper or a
 * JavaScript D-Bus package (with its own dependency tree and install-script
 * review), AmpleFile speaks the wire protocol itself: a Unix socket, SASL
 * EXTERNAL authentication, and the little marshalling format of the
 * [D-Bus specification](https://dbus.freedesktop.org/doc/dbus-specification.html).
 * It handles every basic and container type when reading, writes the types
 * its callers use, never passes file descriptors, and refuses a message
 * larger than {@link maxMessageBytes}.
 */

export type DBusValue = string | number | bigint | boolean | DBusVariant | DBusValue[];
export interface DBusVariant { signature: string; value: DBusValue }

export const DBusMessageType = { MethodCall: 1, MethodReturn: 2, Error: 3, Signal: 4 } as const;
export type DBusMessageType = (typeof DBusMessageType)[keyof typeof DBusMessageType];
export const noReplyExpectedFlag = 0x1;

export interface DBusMessage {
  type: DBusMessageType;
  flags: number;
  serial: number;
  path?: string;
  interface?: string;
  member?: string;
  errorName?: string;
  replySerial?: number;
  destination?: string;
  sender?: string;
  signature: string;
  body: DBusValue[];
}

/** Larger messages close the connection: nothing AmpleFile is sent needs more. */
export const maxMessageBytes = 1024 * 1024;
const maxAuthLineBytes = 512;

export class DBusError extends Error {
  constructor(readonly name: string, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Signatures

/** Index just past the single complete type starting at `index`. */
export function completeTypeEnd(signature: string, index: number, depth = 0): number {
  if (depth > 32) throw new Error("D-Bus signature nests too deeply.");
  const code = signature[index];
  if (code === undefined) throw new Error("Truncated D-Bus signature.");
  if ("ybnqiuxtdsogvh".includes(code)) return index + 1;
  if (code === "a") return completeTypeEnd(signature, index + 1, depth + 1);
  if (code === "(" || code === "{") {
    const close = code === "(" ? ")" : "}";
    let cursor = index + 1;
    let members = 0;
    while (signature[cursor] !== close) {
      if (signature[cursor] === undefined) throw new Error("Unclosed D-Bus signature group.");
      cursor = completeTypeEnd(signature, cursor, depth + 1);
      members += 1;
    }
    if (members === 0 || (code === "{" && members !== 2)) throw new Error("Invalid D-Bus signature group.");
    return cursor + 1;
  }
  throw new Error(`Unknown D-Bus type code ${JSON.stringify(code)}.`);
}

export function splitSignature(signature: string): string[] {
  const types: string[] = [];
  let index = 0;
  while (index < signature.length) {
    const end = completeTypeEnd(signature, index);
    types.push(signature.slice(index, end));
    index = end;
  }
  return types;
}

function alignment(code: string): number {
  switch (code) {
    case "y": case "g": case "v": return 1;
    case "n": case "q": return 2;
    case "x": case "t": case "d": case "(": case "{": return 8;
    default: return 4;
  }
}

// ---------------------------------------------------------------------------
// Writing (little-endian)

class Writer {
  private buffer = Buffer.alloc(256);
  length = 0;

  private reserve(bytes: number): void {
    if (this.length + bytes <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + bytes) size *= 2;
    const next = Buffer.alloc(size);
    this.buffer.copy(next, 0, 0, this.length);
    this.buffer = next;
  }

  align(to: number): void {
    const padding = (to - (this.length % to)) % to;
    this.reserve(padding);
    this.buffer.fill(0, this.length, this.length + padding);
    this.length += padding;
  }

  u8(value: number): void { this.reserve(1); this.buffer.writeUInt8(value, this.length); this.length += 1; }
  u32(value: number): void { this.align(4); this.reserve(4); this.buffer.writeUInt32LE(value, this.length); this.length += 4; }
  patchU32(offset: number, value: number): void { this.buffer.writeUInt32LE(value, offset); }

  bytes(value: Buffer): void { this.reserve(value.length); value.copy(this.buffer, this.length); this.length += value.length; }

  write(type: string, value: DBusValue): void {
    const code = type[0];
    switch (code) {
      case "y": this.u8(Number(value)); return;
      case "b": this.u32(value ? 1 : 0); return;
      case "n": this.align(2); this.reserve(2); this.buffer.writeInt16LE(Number(value), this.length); this.length += 2; return;
      case "q": this.align(2); this.reserve(2); this.buffer.writeUInt16LE(Number(value), this.length); this.length += 2; return;
      case "i": this.align(4); this.reserve(4); this.buffer.writeInt32LE(Number(value), this.length); this.length += 4; return;
      case "u": case "h": this.u32(Number(value)); return;
      case "x": this.align(8); this.reserve(8); this.buffer.writeBigInt64LE(BigInt(value as number | bigint), this.length); this.length += 8; return;
      case "t": this.align(8); this.reserve(8); this.buffer.writeBigUInt64LE(BigInt(value as number | bigint), this.length); this.length += 8; return;
      case "d": this.align(8); this.reserve(8); this.buffer.writeDoubleLE(Number(value), this.length); this.length += 8; return;
      case "s": case "o": {
        const text = Buffer.from(String(value), "utf8");
        if (text.includes(0)) throw new Error("D-Bus strings cannot contain NUL.");
        this.u32(text.length);
        this.bytes(text);
        this.u8(0);
        return;
      }
      case "g": {
        const text = Buffer.from(String(value), "ascii");
        if (text.length > 255) throw new Error("D-Bus signature too long.");
        this.u8(text.length);
        this.bytes(text);
        this.u8(0);
        return;
      }
      case "v": {
        const variant = value as DBusVariant;
        if (splitSignature(variant.signature).length !== 1) throw new Error("A D-Bus variant holds one complete type.");
        this.write("g", variant.signature);
        this.write(variant.signature, variant.value);
        return;
      }
      case "a": {
        const elementType = type.slice(1);
        if (!Array.isArray(value)) throw new Error("A D-Bus array needs an array value.");
        this.u32(0);
        const lengthOffset = this.length - 4;
        this.align(alignment(elementType[0] ?? ""));
        const start = this.length;
        for (const element of value) this.write(elementType, element);
        this.patchU32(lengthOffset, this.length - start);
        return;
      }
      case "(": case "{": {
        const members = splitSignature(type.slice(1, -1));
        if (!Array.isArray(value) || value.length !== members.length) throw new Error("A D-Bus struct needs one value per member.");
        this.align(8);
        members.forEach((member, index) => this.write(member, value[index] as DBusValue));
        return;
      }
      default:
        throw new Error(`Cannot write D-Bus type ${type}.`);
    }
  }

  result(): Buffer { return this.buffer.subarray(0, this.length); }
}

const headerField = { path: 1, interface: 2, member: 3, errorName: 4, replySerial: 5, destination: 6, sender: 7, signature: 8, unixFds: 9 } as const;

export function encodeMessage(message: Omit<DBusMessage, "serial" | "sender">, serial: number): Buffer {
  const types = splitSignature(message.signature);
  if (types.length !== message.body.length) throw new Error("The D-Bus body does not match its signature.");
  const body = new Writer();
  types.forEach((type, index) => body.write(type, message.body[index] as DBusValue));
  const fields: Array<[number, DBusVariant]> = [];
  if (message.path !== undefined) fields.push([headerField.path, { signature: "o", value: message.path }]);
  if (message.interface !== undefined) fields.push([headerField.interface, { signature: "s", value: message.interface }]);
  if (message.member !== undefined) fields.push([headerField.member, { signature: "s", value: message.member }]);
  if (message.errorName !== undefined) fields.push([headerField.errorName, { signature: "s", value: message.errorName }]);
  if (message.replySerial !== undefined) fields.push([headerField.replySerial, { signature: "u", value: message.replySerial }]);
  if (message.destination !== undefined) fields.push([headerField.destination, { signature: "s", value: message.destination }]);
  if (message.signature) fields.push([headerField.signature, { signature: "g", value: message.signature }]);
  const header = new Writer();
  header.u8("l".charCodeAt(0));
  header.u8(message.type);
  header.u8(message.flags);
  header.u8(1);
  header.u32(body.length);
  header.u32(serial);
  header.write("a(yv)", fields);
  header.align(8);
  const total = Buffer.concat([header.result(), body.result()]);
  if (total.length > maxMessageBytes) throw new Error("D-Bus message too large.");
  return total;
}

// ---------------------------------------------------------------------------
// Reading (either byte order)

class Reader {
  offset = 0;
  constructor(private readonly buffer: Buffer, private readonly littleEndian: boolean) {}

  private need(bytes: number): void {
    if (this.offset + bytes > this.buffer.length) throw new Error("Truncated D-Bus message.");
  }

  align(to: number): void {
    const padding = (to - (this.offset % to)) % to;
    this.need(padding);
    this.offset += padding;
  }

  u8(): number { this.need(1); return this.buffer.readUInt8(this.offset++); }
  u32(): number {
    this.align(4);
    this.need(4);
    const value = this.littleEndian ? this.buffer.readUInt32LE(this.offset) : this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  private text(length: number, encoding: "utf8" | "ascii"): string {
    this.need(length + 1);
    const bytes = this.buffer.subarray(this.offset, this.offset + length);
    if (this.buffer[this.offset + length] !== 0 || bytes.includes(0)) throw new Error("Malformed D-Bus string.");
    this.offset += length + 1;
    if (encoding === "utf8") return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return bytes.toString("ascii");
  }

  read(type: string, depth = 0): DBusValue {
    if (depth > 64) throw new Error("D-Bus value nests too deeply.");
    const code = type[0];
    const le = this.littleEndian;
    switch (code) {
      case "y": return this.u8();
      case "b": { const value = this.u32(); if (value > 1) throw new Error("Malformed D-Bus boolean."); return value === 1; }
      case "n": { this.align(2); this.need(2); const value = le ? this.buffer.readInt16LE(this.offset) : this.buffer.readInt16BE(this.offset); this.offset += 2; return value; }
      case "q": { this.align(2); this.need(2); const value = le ? this.buffer.readUInt16LE(this.offset) : this.buffer.readUInt16BE(this.offset); this.offset += 2; return value; }
      case "i": { this.align(4); this.need(4); const value = le ? this.buffer.readInt32LE(this.offset) : this.buffer.readInt32BE(this.offset); this.offset += 4; return value; }
      case "u": case "h": return this.u32();
      case "x": { this.align(8); this.need(8); const value = le ? this.buffer.readBigInt64LE(this.offset) : this.buffer.readBigInt64BE(this.offset); this.offset += 8; return value; }
      case "t": { this.align(8); this.need(8); const value = le ? this.buffer.readBigUInt64LE(this.offset) : this.buffer.readBigUInt64BE(this.offset); this.offset += 8; return value; }
      case "d": { this.align(8); this.need(8); const value = le ? this.buffer.readDoubleLE(this.offset) : this.buffer.readDoubleBE(this.offset); this.offset += 8; return value; }
      case "s": case "o": return this.text(this.u32(), "utf8");
      case "g": return this.text(this.u8(), "ascii");
      case "v": {
        const signature = this.read("g", depth + 1) as string;
        if (splitSignature(signature).length !== 1) throw new Error("Malformed D-Bus variant.");
        return { signature, value: this.read(signature, depth + 1) };
      }
      case "a": {
        const length = this.u32();
        if (length > maxMessageBytes) throw new Error("D-Bus array too long.");
        const elementType = type.slice(1);
        this.align(alignment(elementType[0] ?? ""));
        const end = this.offset + length;
        this.need(length);
        const values: DBusValue[] = [];
        while (this.offset < end) values.push(this.read(elementType, depth + 1));
        if (this.offset !== end) throw new Error("Malformed D-Bus array.");
        return values;
      }
      case "(": case "{": {
        this.align(8);
        return splitSignature(type.slice(1, -1)).map((member) => this.read(member, depth + 1));
      }
      default:
        throw new Error(`Cannot read D-Bus type ${type}.`);
    }
  }
}

/** Bytes the message at the start of `buffer` occupies, or null while its fixed header is incomplete. */
export function messageLength(buffer: Buffer): number | null {
  if (buffer.length < 16) return null;
  const endian = buffer[0];
  if (endian !== 0x6c && endian !== 0x42) throw new Error("Unknown D-Bus byte order.");
  const le = endian === 0x6c;
  const bodyLength = le ? buffer.readUInt32LE(4) : buffer.readUInt32BE(4);
  const fieldsLength = le ? buffer.readUInt32LE(12) : buffer.readUInt32BE(12);
  const headerLength = 16 + fieldsLength + ((8 - (fieldsLength % 8)) % 8);
  return headerLength + bodyLength;
}

export function decodeMessage(buffer: Buffer): DBusMessage {
  const littleEndian = buffer[0] === 0x6c;
  const reader = new Reader(buffer, littleEndian);
  reader.u8();
  const type = reader.u8();
  const flags = reader.u8();
  if (reader.u8() !== 1) throw new Error("Unsupported D-Bus protocol version.");
  const bodyLength = reader.u32();
  const serial = reader.u32();
  const fields = reader.read("a(yv)") as Array<[number, DBusVariant]>;
  reader.align(8);
  if (type < 1 || type > 4) throw new Error("Unknown D-Bus message type.");
  const message: DBusMessage = { type: type as DBusMessageType, flags, serial, signature: "", body: [] };
  for (const [code, variant] of fields) {
    const value = variant.value;
    if (code === headerField.path && variant.signature === "o") message.path = value as string;
    else if (code === headerField.interface && variant.signature === "s") message.interface = value as string;
    else if (code === headerField.member && variant.signature === "s") message.member = value as string;
    else if (code === headerField.errorName && variant.signature === "s") message.errorName = value as string;
    else if (code === headerField.replySerial && variant.signature === "u") message.replySerial = value as number;
    else if (code === headerField.destination && variant.signature === "s") message.destination = value as string;
    else if (code === headerField.sender && variant.signature === "s") message.sender = value as string;
    else if (code === headerField.signature && variant.signature === "g") message.signature = value as string;
  }
  const bodyStart = reader.offset;
  if (buffer.length !== bodyStart + bodyLength) throw new Error("Malformed D-Bus message length.");
  const bodyReader = new Reader(buffer.subarray(bodyStart), littleEndian);
  message.body = splitSignature(message.signature).map((bodyType) => bodyReader.read(bodyType));
  if (bodyReader.offset !== bodyLength) throw new Error("Malformed D-Bus message body.");
  return message;
}

// ---------------------------------------------------------------------------
// Addresses

export type SessionBusAddress = { kind: "path"; path: string } | { kind: "abstract"; name: string };

function unescapeAddressValue(value: string): string {
  return Buffer.from(value.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), "latin1").toString("utf8");
}

/** The Unix-socket addresses in a D-Bus address string, in the order to try. */
export function parseBusAddresses(value: string | undefined, env: NodeJS.ProcessEnv = process.env): SessionBusAddress[] {
  const addresses: SessionBusAddress[] = [];
  for (const entry of (value ?? "").split(";")) {
    const colon = entry.indexOf(":");
    if (colon < 0 || entry.slice(0, colon) !== "unix") continue;
    const keys = new Map<string, string>();
    for (const pair of entry.slice(colon + 1).split(",")) {
      const equals = pair.indexOf("=");
      if (equals > 0) keys.set(pair.slice(0, equals), unescapeAddressValue(pair.slice(equals + 1)));
    }
    const path = keys.get("path");
    const abstract = keys.get("abstract");
    if (path) addresses.push({ kind: "path", path });
    else if (abstract) addresses.push({ kind: "abstract", name: abstract });
    else if (keys.get("runtime") === "yes" && env.XDG_RUNTIME_DIR) addresses.push({ kind: "path", path: `${env.XDG_RUNTIME_DIR}/bus` });
  }
  return addresses;
}

export function sessionBusAddresses(env: NodeJS.ProcessEnv = process.env): SessionBusAddress[] {
  const configured = parseBusAddresses(env.DBUS_SESSION_BUS_ADDRESS, env);
  if (configured.length || env.DBUS_SESSION_BUS_ADDRESS?.trim()) return configured;
  const runtime = env.XDG_RUNTIME_DIR?.trim();
  return runtime && existsSync(`${runtime}/bus`) ? [{ kind: "path", path: `${runtime}/bus` }] : [];
}

// ---------------------------------------------------------------------------
// Connection

export interface SessionBusOpenOptions {
  env?: NodeJS.ProcessEnv;
  /** Overrides the address list (tests use a private bus). */
  addresses?: SessionBusAddress[];
  uid?: number;
  timeoutMs?: number;
}

interface PendingCall {
  resolve: (message: DBusMessage) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One authenticated connection to the session bus. Emits `methodCall`
 * (DBusMessage), `signal` (DBusMessage) and `close` (Error | null).
 */
export class SessionBusConnection extends EventEmitter {
  uniqueName = "";
  private serial = 0;
  private buffered: Buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, PendingCall>();
  private closed = false;

  private constructor(private readonly socket: Socket) {
    super();
  }

  static async open(options: SessionBusOpenOptions = {}): Promise<SessionBusConnection> {
    const env = options.env ?? process.env;
    const addresses = options.addresses ?? sessionBusAddresses(env);
    if (!addresses.length) throw new Error("No session bus is available (DBUS_SESSION_BUS_ADDRESS is not set).");
    const uid = options.uid ?? process.getuid?.();
    if (uid === undefined) throw new Error("The session bus needs a Unix user id.");
    const timeoutMs = options.timeoutMs ?? 5_000;
    let lastError: unknown = null;
    for (const address of addresses) {
      try {
        const socket = await authenticate(address, uid, timeoutMs);
        const connection = new SessionBusConnection(socket);
        connection.attach();
        const hello = await connection.call({ destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "Hello" }, timeoutMs);
        connection.uniqueName = String(hello.body[0] ?? "");
        return connection;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Could not connect to the session bus.");
  }

  private attach(): void {
    this.socket.on("data", (chunk: Buffer) => {
      this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
      try {
        for (;;) {
          const length = messageLength(this.buffered);
          if (length === null) break;
          if (length > maxMessageBytes) throw new Error("The session bus sent a message larger than AmpleFile accepts.");
          if (this.buffered.length < length) break;
          const bytes = this.buffered.subarray(0, length);
          this.buffered = this.buffered.subarray(length);
          this.dispatch(decodeMessage(Buffer.from(bytes)));
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.socket.on("error", (error) => this.fail(error));
    this.socket.on("close", () => this.fail(null));
  }

  private dispatch(message: DBusMessage): void {
    if ((message.type === DBusMessageType.MethodReturn || message.type === DBusMessageType.Error) && message.replySerial !== undefined) {
      const pending = this.pending.get(message.replySerial);
      if (!pending) return;
      this.pending.delete(message.replySerial);
      clearTimeout(pending.timer);
      if (message.type === DBusMessageType.Error) pending.reject(new DBusError(message.errorName ?? "org.freedesktop.DBus.Error.Failed", typeof message.body[0] === "string" ? message.body[0] : message.errorName ?? "D-Bus call failed."));
      else pending.resolve(message);
      return;
    }
    if (message.type === DBusMessageType.MethodCall) this.emit("methodCall", message);
    else if (message.type === DBusMessageType.Signal) this.emit("signal", message);
  }

  private fail(error: Error | null): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error("The session bus connection closed."));
    }
    this.pending.clear();
    this.socket.destroy();
    this.emit("close", error);
  }

  get isClosed(): boolean { return this.closed; }

  private send(message: Omit<DBusMessage, "serial" | "sender">): number {
    if (this.closed) throw new Error("The session bus connection is closed.");
    this.serial = this.serial >= 0xffff_fffe ? 1 : this.serial + 1;
    this.socket.write(encodeMessage(message, this.serial));
    return this.serial;
  }

  call(call: { destination: string; path: string; interface: string; member: string; signature?: string; body?: DBusValue[] }, timeoutMs = 5_000): Promise<DBusMessage> {
    return new Promise((resolve, reject) => {
      let serial: number;
      try {
        serial = this.send({ type: DBusMessageType.MethodCall, flags: 0, ...call, signature: call.signature ?? "", body: call.body ?? [] });
      } catch (error) {
        reject(error);
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(serial);
        reject(new DBusError("org.freedesktop.DBus.Error.Timeout", `${call.member} did not answer in time.`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(serial, { resolve, reject, timer });
    });
  }

  reply(to: DBusMessage, signature = "", body: DBusValue[] = []): void {
    if (to.flags & noReplyExpectedFlag || this.closed) return;
    this.send({ type: DBusMessageType.MethodReturn, flags: noReplyExpectedFlag, replySerial: to.serial, destination: to.sender, signature, body });
  }

  replyError(to: DBusMessage, errorName: string, text: string): void {
    if (to.flags & noReplyExpectedFlag || this.closed) return;
    this.send({ type: DBusMessageType.Error, flags: noReplyExpectedFlag, replySerial: to.serial, destination: to.sender, errorName, signature: "s", body: [text] });
  }

  close(): void {
    this.fail(null);
  }
}

function authenticate(address: SessionBusAddress, uid: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path: address.kind === "path" ? address.path : `\0${address.name}` });
    let received = "";
    let finished = false;
    const finish = (error: Error | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.removeAllListeners("data");
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    };
    const timer = setTimeout(() => finish(new Error("The session bus did not answer in time.")), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => {
      const identity = Buffer.from(String(uid), "ascii").toString("hex");
      socket.write(Buffer.concat([Buffer.from([0]), Buffer.from(`AUTH EXTERNAL ${identity}\r\n`, "ascii")]));
    });
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("latin1");
      if (received.length > maxAuthLineBytes) return finish(new Error("The session bus sent an unexpected answer."));
      const end = received.indexOf("\r\n");
      if (end < 0) return;
      const line = received.slice(0, end);
      if (!line.startsWith("OK ")) return finish(new Error("The session bus refused AmpleFile's sign-in."));
      if (received.length > end + 2) return finish(new Error("The session bus sent data before AmpleFile began."));
      socket.write("BEGIN\r\n");
      finish(null);
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("The session bus closed the connection.")));
  });
}

/** Calls one bus-daemon method on the session bus. */
export function busDaemonCall(connection: SessionBusConnection, member: string, signature = "", body: DBusValue[] = [], timeoutMs = 5_000): Promise<DBusMessage> {
  return connection.call({ destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member, signature, body }, timeoutMs);
}
