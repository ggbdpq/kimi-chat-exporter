// Pure-Node ZIP reader used by layout tests to read archive contents
// (no third-party or Python deps). Parses EOCD + central directory per
// APPNOTE.TXT and inflates entries with node:zlib. This is a content accessor
// for assertions, not an integrity verifier: runtime does no ZIP verification.

import { inflateRawSync, crc32 } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const UTF8_FLAG = 0x0800;

/** Locate the EOCD by scanning the tail (comment field allows 64KB). */
function findEocd(buf) {
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("EOCD not found: not a valid ZIP archive");
}

export function readArchive(buf) {
  const eocd = findEocd(buf);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not expected from this exporter");
  }
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== CD_SIG) throw new Error(`central entry #${i}: bad signature`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    entries.push({ name, flags, method, crc, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p - cdOffset !== cdSize) throw new Error("central directory size mismatch");

  return {
    entries,
    names: entries.map((e) => e.name),
    /** Decompress and CRC-check one entry, returning its text. */
    text(name) {
      const e = entries.find((x) => x.name === name);
      if (!e) throw new Error("entry not in archive: " + name);
      if (buf.readUInt32LE(e.localOffset) !== LOCAL_SIG) {
        throw new Error(`${e.name}: bad local header signature`);
      }
      const localNameLen = buf.readUInt16LE(e.localOffset + 26);
      const localExtraLen = buf.readUInt16LE(e.localOffset + 28);
      const start = e.localOffset + 30 + localNameLen + localExtraLen;
      const data = buf.subarray(start, start + e.compressedSize);
      if (data.length !== e.compressedSize) throw new Error(`${e.name}: truncated entry data`);
      let raw;
      if (e.method === 0) raw = Buffer.from(data);
      else if (e.method === 8) raw = inflateRawSync(data);
      else throw new Error(`${e.name}: unsupported compression method ${e.method}`);
      if (raw.length !== e.uncompressedSize) {
        throw new Error(`${e.name}: uncompressed size ${raw.length} != ${e.uncompressedSize}`);
      }
      if (crc32(raw) >>> 0 !== e.crc >>> 0) throw new Error(`${e.name}: CRC32 mismatch`);
      return raw.toString("utf8");
    },
  };
}
