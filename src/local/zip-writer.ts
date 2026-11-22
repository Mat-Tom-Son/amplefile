import { createReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import { basename } from "node:path";
import { createDeflateRaw, crc32 } from "node:zlib";

import { untrackedFileOperation, type FileOperationControl } from "./file-operations.js";

/**
 * Writes a zip archive one entry at a time, streaming each file through
 * deflate, with the 64-bit (ZIP64) records an archive over 4 GB or 65,535
 * items needs. Entries record their Unix modes, so Extract can restore what
 * was executable, and their names in UTF-8. A symbolic link is stored as a
 * link, the way Info-ZIP and Finder's Archive Utility store one: its target
 * as the entry's (uncompressed) content, with the link file type in its mode.
 */

export type ZipWriterEntry =
  | { kind: "folder"; name: string; date: Date; mode: number }
  | { kind: "file"; name: string; path: string; date: Date; mode: number; size: number }
  | { kind: "link"; name: string; target: string; date: Date };

const max32 = 0xffffffff;
const max16 = 0xffff;

/** Tests only: write the 64-bit records for every entry and the end, as a large archive does. */
let forceZip64 = false;
export function setZip64ForTests(force: boolean): void {
  forceZip64 = force;
}

/**
 * Writes `entries` to `output` (an open, empty file). `wrote` is told every
 * chunk written, so the caller can watch the disk. Each chunk read is a
 * boundary of a tracked operation, so a cancel stops inside a file.
 */
export async function writeZip(
  entries: readonly ZipWriterEntry[],
  output: FileHandle,
  operation: FileOperationControl = untrackedFileOperation,
  wrote: (bytes: number) => Promise<void> = async () => undefined,
): Promise<void> {
  let offset = 0;
  const write = async (buffer: Buffer) => {
    for (let at = 0; at < buffer.length;) at += (await output.write(buffer, at, buffer.length - at, offset + at)).bytesWritten;
    offset += buffer.length;
    await wrote(buffer.length);
  };
  const central: Buffer[] = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.kind === "folder" ? `${entry.name.replace(/\/+$/, "")}/` : entry.name, "utf8");
    if (name.length > max16) throw new Error(`“${basename(entry.name)}” has a path too long for a zip archive.`);
    const headerOffset = offset;
    const { time, date } = dosDateTime(entry.date);
    const isFile = entry.kind === "file";
    const linkTarget = entry.kind === "link" ? Buffer.from(entry.target, "utf8") : null;
    // A file near 4 GB may deflate a little larger, so it takes the 64-bit sizes too.
    const zip64Sizes = (forceZip64 && !linkTarget) || (isFile && entry.size >= max32 - 0x100000);
    const flags = 0x0800 | (isFile ? 0x0008 : 0);
    const method = isFile ? 8 : 0;
    // A link's content is known up front, so its header carries the CRC and sizes (no data descriptor).
    const linkCrc = linkTarget ? crc32(linkTarget) >>> 0 : 0;
    const version = zip64Sizes || headerOffset >= max32 ? 45 : 20;

    const localExtra = zip64Sizes ? zip64Extra([0n, 0n]) : Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(version, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(linkCrc, 14);
    local.writeUInt32LE(zip64Sizes ? max32 : linkTarget?.length ?? 0, 18);
    local.writeUInt32LE(zip64Sizes ? max32 : linkTarget?.length ?? 0, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    await write(Buffer.concat([local, name, localExtra]));

    let crc = linkCrc;
    let size = linkTarget?.length ?? 0;
    let compressed = linkTarget?.length ?? 0;
    if (linkTarget) await write(linkTarget);
    if (isFile) {
      operation.current(basename(entry.path));
      const counting = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          operation.boundary("chunk").then(() => {
            crc = crc32(chunk, crc);
            size += chunk.length;
            operation.bytesDone(chunk.length);
            callback(null, chunk);
          }, (error: Error) => callback(error));
        },
      });
      const sink = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          compressed += chunk.length;
          write(chunk).then(() => callback(), (error: Error) => callback(error));
        },
      });
      await pipeline(createReadStream(entry.path, { highWaterMark: 1024 * 1024 }), counting, createDeflateRaw({ level: 6 }), sink);
      if (!zip64Sizes && (size >= max32 || compressed >= max32)) throw new Error(`“${basename(entry.path)}” grew while it was being compressed. Compress it again.`);
      const descriptor = Buffer.alloc(zip64Sizes ? 24 : 16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc >>> 0, 4);
      if (zip64Sizes) {
        descriptor.writeBigUInt64LE(BigInt(compressed), 8);
        descriptor.writeBigUInt64LE(BigInt(size), 16);
      } else {
        descriptor.writeUInt32LE(compressed, 8);
        descriptor.writeUInt32LE(size, 12);
      }
      await write(descriptor);
    }
    operation.itemsDone();

    // The central record names 64-bit values for whatever overflowed (or always, when asked).
    const bigSizes = zip64Sizes || size >= max32 || compressed >= max32;
    const bigOffset = forceZip64 || headerOffset >= max32;
    const centralExtra = bigSizes || bigOffset
      ? zip64Extra([...(bigSizes ? [BigInt(size), BigInt(compressed)] : []), ...(bigOffset ? [BigInt(headerOffset)] : [])])
      : Buffer.alloc(0);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE((3 << 8) | version, 4);
    record.writeUInt16LE(version, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(date, 14);
    record.writeUInt32LE(crc >>> 0, 16);
    record.writeUInt32LE(bigSizes ? max32 : compressed, 20);
    record.writeUInt32LE(bigSizes ? max32 : size, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(centralExtra.length, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    const type = entry.kind === "file" ? 0o100000 : entry.kind === "link" ? 0o120000 : 0o040000;
    const mode = entry.kind === "link" ? 0o777 : entry.mode & 0o7777;
    record.writeUInt32LE((((type | mode) << 16) | (entry.kind === "folder" ? 0x10 : 0)) >>> 0, 38);
    record.writeUInt32LE(bigOffset ? max32 : headerOffset, 42);
    central.push(Buffer.concat([record, name, centralExtra]));
  }

  const directoryOffset = offset;
  for (const record of central) await write(record);
  const directorySize = offset - directoryOffset;
  const count = central.length;
  const zip64End = forceZip64 || count >= max16 || directoryOffset >= max32 || directorySize >= max32;
  if (zip64End) {
    const endOffset = offset;
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE((3 << 8) | 45, 12);
    record.writeUInt16LE(45, 14);
    record.writeUInt32LE(0, 16);
    record.writeUInt32LE(0, 20);
    record.writeBigUInt64LE(BigInt(count), 24);
    record.writeBigUInt64LE(BigInt(count), 32);
    record.writeBigUInt64LE(BigInt(directorySize), 40);
    record.writeBigUInt64LE(BigInt(directoryOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(endOffset), 8);
    locator.writeUInt32LE(1, 16);
    await write(Buffer.concat([record, locator]));
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(zip64End ? max16 : count, 8);
  end.writeUInt16LE(zip64End ? max16 : count, 10);
  end.writeUInt32LE(zip64End ? max32 : directorySize, 12);
  end.writeUInt32LE(zip64End ? max32 : directoryOffset, 16);
  end.writeUInt16LE(0, 20);
  await write(end);
}

function zip64Extra(values: bigint[]): Buffer {
  const extra = Buffer.alloc(4 + values.length * 8);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(values.length * 8, 2);
  for (const [index, value] of values.entries()) extra.writeBigUInt64LE(value, 4 + index * 8);
  return extra;
}

/** A zip's MS-DOS time and date, which start in 1980 and keep even seconds. */
function dosDateTime(value: Date): { time: number; date: number } {
  const when = Number.isNaN(value.getTime()) || value.getFullYear() < 1980 ? new Date(1980, 0, 1) : value;
  const year = Math.min(when.getFullYear(), 2107);
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}
