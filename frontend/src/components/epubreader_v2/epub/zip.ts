import { inflateRaw as inflateRawJs } from './inflate';
import { normalizePath } from '../utils/path';
import { inflate as pakoInflate, inflateRaw as pakoInflateRaw } from 'pako';

export type ZipEntry = {
  path: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  flags: number;
};

function hexPreview(bytes: Uint8Array, max = 24): string {
  const slice = bytes.subarray(0, Math.min(max, bytes.length));
  return Array.from(slice)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

function looksLikeZlib(bytes: Uint8Array): boolean {
  if (bytes.length < 6) return false;
  const cmf = bytes[0]!;
  const flg = bytes[1]!;
  if ((cmf & 0x0f) !== 8) return false; // DEFLATE
  if ((((cmf << 8) | flg) % 31) !== 0) return false; // header check
  if ((flg & 0x20) !== 0) return false; // preset dictionary not supported
  return true;
}

function inflateWithZlibFallback(compressed: Uint8Array, expectedSize?: number): Uint8Array {
  try {
    return inflateRawJs(compressed, expectedSize);
  } catch (err) {
    // Our minimal inflater isn't fully spec-complete; fall back to pako for correctness.
    try {
      if (looksLikeZlib(compressed)) {
        const out = pakoInflate(compressed) as Uint8Array;
        return out;
      }
      const out = pakoInflateRaw(compressed) as Uint8Array;
      return out;
    } catch {
      if (!looksLikeZlib(compressed)) throw err;
      // zlib wrapper: 2-byte header + deflate stream + 4-byte adler32
      const inner = compressed.subarray(2, Math.max(2, compressed.length - 4));
      return inflateRawJs(inner, expectedSize);
    }
  }
}

function readUint16LE(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function readUint32LE(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function decodeZipPath(bytes: Uint8Array, isUtf8: boolean): string {
  if (bytes.length === 0) return '';
  try {
    return new TextDecoder(isUtf8 ? 'utf-8' : 'latin1').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function findEndOfCentralDirectory(data: Uint8Array): number {
  const minOffset = Math.max(0, data.length - 65557);
  for (let i = data.length - 22; i >= minOffset; i--) {
    if (data[i] === 0x50 && data[i + 1] === 0x4b && data[i + 2] === 0x05 && data[i + 3] === 0x06) {
      return i;
    }
  }
  return -1;
}

export class ZipArchive {
  readonly byteLength: number;
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly entriesByPath = new Map<string, ZipEntry>();
  private readonly entriesByOffset: ZipEntry[] = [];
  private centralDirOffset = 0;

  constructor(buffer: ArrayBuffer) {
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(buffer);
    this.byteLength = this.bytes.byteLength;
    this.parseCentralDirectory();
  }

  list(): string[] {
    return Array.from(this.entriesByPath.keys()).sort();
  }

  has(path: string): boolean {
    return this.entriesByPath.has(normalizePath(path));
  }

  readEntry(path: string): Uint8Array {
    const normalized = normalizePath(path);
    const entry = this.entriesByPath.get(normalized);
    if (!entry) throw new Error(`ZIP entry not found: ${normalized}`);

    const localOffset = entry.localHeaderOffset;
    if (readUint32LE(this.view, localOffset) !== 0x04034b50) {
      throw new Error('Invalid ZIP local file header signature');
    }

    const fileNameLen = readUint16LE(this.view, localOffset + 26);
    const extraLen = readUint16LE(this.view, localOffset + 28);
    const dataStart = localOffset + 30 + fileNameLen + extraLen;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > this.bytes.length) throw new Error('ZIP entry exceeds archive bounds');

    const compressed = this.bytes.subarray(dataStart, dataEnd);
    if (entry.compressionMethod === 0) {
      return compressed.slice();
    }
    if (entry.compressionMethod === 8) {
      try {
        const inflated = inflateWithZlibFallback(compressed, entry.uncompressedSize);
        if (entry.uncompressedSize !== 0 && inflated.length !== entry.uncompressedSize) {
          // Some archives may have an incorrect size; trust actual data but keep it bounded.
          return inflated;
        }
        return inflated;
      } catch (err) {
        const nextLocalHeaderOffset = this.nextLocalHeaderOffset(localOffset);
        const extendedEnd = Math.min(
          nextLocalHeaderOffset ?? this.centralDirOffset ?? this.bytes.length,
          this.bytes.length,
        );

        if (extendedEnd > dataEnd) {
          // Some "valid enough" EPUBs appear to have incorrect compressedSize metadata for a few
          // entries (Apple Books is tolerant). Retry with the maximum safe slice.
          const extendedCompressed = this.bytes.subarray(dataStart, extendedEnd);
          try {
            const inflated = inflateWithZlibFallback(extendedCompressed, entry.uncompressedSize);
            if (entry.uncompressedSize !== 0 && inflated.length !== entry.uncompressedSize) {
              return inflated;
            }
            return inflated;
          } catch (retryErr) {
            const e = new Error(
              `Failed to inflate ZIP entry: ${normalized} (method=${entry.compressionMethod} compressedSize=${entry.compressedSize} uncompressedSize=${entry.uncompressedSize} flags=0x${entry.flags.toString(
                16,
              )} extendedEnd=${extendedEnd} firstBytes=${hexPreview(extendedCompressed)})`,
            );
            (e as any).cause = retryErr;
            throw e;
          }
        }

        const e = new Error(
          `Failed to inflate ZIP entry: ${normalized} (method=${entry.compressionMethod} compressedSize=${entry.compressedSize} uncompressedSize=${entry.uncompressedSize} flags=0x${entry.flags.toString(
            16,
          )} firstBytes=${hexPreview(compressed)})`,
        );
        (e as any).cause = err;
        throw e;
      }
    }
    throw new Error(`Unsupported ZIP compression method: ${entry.compressionMethod}`);
  }

  private parseCentralDirectory() {
    const eocdOffset = findEndOfCentralDirectory(this.bytes);
    if (eocdOffset === -1) throw new Error('Missing ZIP end of central directory');
    if (readUint32LE(this.view, eocdOffset) !== 0x06054b50) throw new Error('Invalid ZIP EOCD signature');

    const diskNumber = readUint16LE(this.view, eocdOffset + 4);
    const centralDirDiskNumber = readUint16LE(this.view, eocdOffset + 6);
    const entriesOnThisDisk = readUint16LE(this.view, eocdOffset + 8);
    const totalEntries = readUint16LE(this.view, eocdOffset + 10);
    const centralDirSize = readUint32LE(this.view, eocdOffset + 12);
    const centralDirOffset = readUint32LE(this.view, eocdOffset + 16);
    this.centralDirOffset = centralDirOffset;

    if (diskNumber !== 0 || centralDirDiskNumber !== 0 || entriesOnThisDisk !== totalEntries) {
      throw new Error('Multi-disk ZIP archives are not supported');
    }
    if (centralDirOffset + centralDirSize > this.bytes.length) {
      throw new Error('Central directory exceeds archive bounds');
    }

    let offset = centralDirOffset;
    for (let i = 0; i < totalEntries; i++) {
      if (readUint32LE(this.view, offset) !== 0x02014b50) {
        throw new Error('Invalid central directory file header signature');
      }

      const flags = readUint16LE(this.view, offset + 8);
      const compressionMethod = readUint16LE(this.view, offset + 10);
      const compressedSize = readUint32LE(this.view, offset + 20);
      const uncompressedSize = readUint32LE(this.view, offset + 24);
      const fileNameLen = readUint16LE(this.view, offset + 28);
      const extraLen = readUint16LE(this.view, offset + 30);
      const commentLen = readUint16LE(this.view, offset + 32);
      const localHeaderOffset = readUint32LE(this.view, offset + 42);

      const isUtf8 = (flags & (1 << 11)) !== 0;
      const fileNameStart = offset + 46;
      const fileNameEnd = fileNameStart + fileNameLen;
      const rawName = decodeZipPath(this.bytes.subarray(fileNameStart, fileNameEnd), isUtf8);
      const path = normalizePath(rawName);

      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        throw new Error('ZIP64 is not supported');
      }

      if (path && !path.endsWith('/')) {
        const entry: ZipEntry = {
          path,
          compressionMethod,
          compressedSize,
          uncompressedSize,
          localHeaderOffset,
          flags,
        };
        this.entriesByPath.set(path, entry);
        this.entriesByOffset.push(entry);
      }

      offset = fileNameEnd + extraLen + commentLen;
    }

    this.entriesByOffset.sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
  }

  private nextLocalHeaderOffset(currentLocalHeaderOffset: number): number | undefined {
    const entries = this.entriesByOffset;
    if (entries.length === 0) return undefined;

    let lo = 0;
    let hi = entries.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const offset = entries[mid]!.localHeaderOffset;
      if (offset <= currentLocalHeaderOffset) {
        lo = mid + 1;
      } else {
        idx = mid;
        hi = mid - 1;
      }
    }
    return idx === -1 ? undefined : entries[idx]!.localHeaderOffset;
  }
}
