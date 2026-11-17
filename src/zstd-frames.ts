import { zstdDecompressSync } from "node:zlib";

/** RFC 8878 little-endian magic number: 0xFD2FB528. */
const ZSTD_MAGIC = 0xFD2FB528;

export interface ZstdFrameRange {
  start: number;
  end: number;
}

/**
 * Locate complete concatenated Zstandard frames without decompressing them.
 * An unfinished trailing frame is reported rather than treated as corruption,
 * matching crash-recovery semantics used by DeepSeek Harness session logs.
 */
export function scanZstdFrames(buffer: Uint8Array): {
  frames: ZstdFrameRange[];
  trailingIncomplete: boolean;
} {
  const frames: ZstdFrameRange[] = [];
  const view = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 0;
  while (offset < view.length) {
    const start = offset;
    if (offset + 5 > view.length) {
      return { frames, trailingIncomplete: true };
    }
    if (view.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid zstd magic at offset ${offset}`);
    }
    offset += 4;
    const descriptor = view[offset]!;
    offset += 1;
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`reserved zstd frame descriptor bits set at offset ${start}`);
    }
    const fcsFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const hasChecksum = (descriptor & 0x04) !== 0;
    const dictFlag = descriptor & 0x03;
    const dictBytes = dictFlag === 3 ? 4 : dictFlag;
    const fcsBytes = fcsFlag === 0 ? (singleSegment ? 1 : 0) : (1 << fcsFlag);
    const headerRest = (singleSegment ? 0 : 1) + dictBytes + fcsBytes;
    if (offset + headerRest > view.length) {
      return { frames, trailingIncomplete: true };
    }
    offset += headerRest;
    for (;;) {
      if (offset + 3 > view.length) {
        return { frames, trailingIncomplete: true };
      }
      const header = view[offset]! | (view[offset + 1]! << 8) | (view[offset + 2]! << 16);
      offset += 3;
      const last = (header & 1) !== 0;
      const type = (header >>> 1) & 3;
      const size = header >>> 3;
      if (type === 3) {
        throw new Error(`invalid zstd block type at offset ${start}`);
      }
      const payload = type === 1 ? 1 : size;
      if (offset + payload > view.length) {
        return { frames, trailingIncomplete: true };
      }
      offset += payload;
      if (last) break;
    }
    if (hasChecksum) {
      if (offset + 4 > view.length) {
        return { frames, trailingIncomplete: true };
      }
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames, trailingIncomplete: false };
}

/** Decompress every complete concatenated frame, ignoring an unfinished tail. */
export function decodeZstdFrameConcat(buffer: Uint8Array): Buffer {
  const view = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const { frames, trailingIncomplete } = scanZstdFrames(view);
  if (frames.length === 0) {
    throw new Error(trailingIncomplete
      ? "zstd artifact has no complete frame"
      : "zstd artifact is empty");
  }
  return Buffer.concat(frames.map((frame) => zstdDecompressSync(view.subarray(frame.start, frame.end))));
}
