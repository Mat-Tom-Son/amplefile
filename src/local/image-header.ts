/**
 * Reads a picture's format and pixel size from its own header bytes, before
 * anything decodes it. Thumbnails (thumbnails.ts) treat image files as hostile
 * input: the format comes from the bytes, not the file's name, and the pixel
 * count is checked before a decoder allocates for it, so a small file that
 * claims a huge picture (a decompression bomb) is refused without decoding.
 *
 * Only the formats thumbnails decode are recognized. SVG is deliberately not
 * one of them: it is a document that can name other files and carry script.
 */

export type ThumbnailImageFormat = "png" | "jpeg" | "gif" | "webp" | "bmp" | "avif";

export interface ImageHeader {
  format: ThumbnailImageFormat;
  width: number;
  height: number;
}

/** The picture's format and size, or null when the bytes are not a recognized picture or its header is damaged. */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    const header = pngHeader(data) ?? jpegHeader(data) ?? gifHeader(data) ?? webpHeader(data) ?? bmpHeader(data) ?? avifHeader(data);
    if (!header || !(header.width > 0) || !(header.height > 0)) return null;
    return header;
  } catch {
    // A header that ends early or points past the end is damaged, not a picture.
    return null;
  }
}

function pngHeader(data: Buffer): ImageHeader | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.length < 24 || signature.some((byte, index) => data[index] !== byte)) return null;
  if (data.toString("latin1", 12, 16) !== "IHDR") return null;
  return { format: "png", width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function jpegHeader(data: Buffer): ImageHeader | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) return null;
    const marker = data[offset + 1]!;
    // Fill bytes before a marker.
    if (marker === 0xff) { offset += 1; continue; }
    // Markers without a length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image or scan data before any frame header
    const length = data.readUInt16BE(offset + 2);
    if (length < 2) return null;
    // Start of frame: every SOFn except DHT (C4), JPG (C8), and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > data.length) return null;
      return { format: "jpeg", height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function gifHeader(data: Buffer): ImageHeader | null {
  if (data.length < 10) return null;
  const signature = data.toString("latin1", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  return { format: "gif", width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
}

function webpHeader(data: Buffer): ImageHeader | null {
  if (data.length < 30 || data.toString("latin1", 0, 4) !== "RIFF" || data.toString("latin1", 8, 12) !== "WEBP") return null;
  const chunk = data.toString("latin1", 12, 16);
  if (chunk === "VP8 ") {
    // Lossy: a key frame's start code, then 14-bit width and height.
    if (data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a) return null;
    return { format: "webp", width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (data[20] !== 0x2f) return null;
    const bits = data.readUInt32LE(21);
    return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    return { format: "webp", width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
  }
  return null;
}

function bmpHeader(data: Buffer): ImageHeader | null {
  if (data.length < 26 || data.toString("latin1", 0, 2) !== "BM") return null;
  const infoSize = data.readUInt32LE(14);
  if (infoSize === 12) return { format: "bmp", width: data.readUInt16LE(18), height: data.readUInt16LE(20) };
  if (infoSize < 40) return null;
  // A negative height is a top-down picture of that many rows.
  return { format: "bmp", width: data.readInt32LE(18), height: Math.abs(data.readInt32LE(22)) };
}

/**
 * AVIF is an ISO base media file: an `ftyp` box naming an AVIF brand, then a
 * `meta` box whose item properties (`iprp` → `ipco`) hold one `ispe` (image
 * spatial extent) per image item. A grid picture has an `ispe` for the whole
 * grid and one per tile; the largest one bounds what a decoder allocates.
 */
function avifHeader(data: Buffer): ImageHeader | null {
  if (data.length < 16 || data.toString("latin1", 4, 8) !== "ftyp") return null;
  const ftypSize = data.readUInt32BE(0);
  if (ftypSize < 16 || ftypSize > data.length) return null;
  const brands = [data.toString("latin1", 8, 12)];
  for (let offset = 16; offset + 4 <= ftypSize; offset += 4) brands.push(data.toString("latin1", offset, offset + 4));
  if (!brands.some((brand) => brand === "avif" || brand === "avis")) return null;
  const meta = findBox(data, 0, data.length, "meta");
  if (!meta) return null;
  // `meta` is a full box: four bytes of version and flags before its children.
  const iprp = findBox(data, meta.start + 4, meta.end, "iprp");
  const ipco = iprp ? findBox(data, iprp.start, iprp.end, "ipco") : null;
  if (!ipco) return null;
  let largest: { width: number; height: number } | null = null;
  for (const box of boxes(data, ipco.start, ipco.end)) {
    if (box.type !== "ispe" || box.end - box.start < 12) continue;
    const width = data.readUInt32BE(box.start + 4);
    const height = data.readUInt32BE(box.start + 8);
    if (!largest || width * height > largest.width * largest.height) largest = { width, height };
  }
  return largest ? { format: "avif", ...largest } : null;
}

interface Box { type: string; start: number; end: number }

function* boxes(data: Buffer, start: number, end: number): Generator<Box> {
  let offset = start;
  let count = 0;
  while (offset + 8 <= end && count < 4096) {
    count += 1;
    let size = data.readUInt32BE(offset);
    const type = data.toString("latin1", offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) return;
      const large = data.readBigUInt64BE(offset + 8);
      if (large > BigInt(end - offset)) return;
      size = Number(large);
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) return;
    yield { type, start: offset + header, end: offset + size };
    offset += size;
  }
}

function findBox(data: Buffer, start: number, end: number, type: string): Box | null {
  for (const box of boxes(data, start, end)) if (box.type === type) return box;
  return null;
}
