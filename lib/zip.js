// Streaming classic ZIP: data descriptors allow sizes/CRC to be emitted after data.
import { checkAbort, sleep } from "./control.js";
import { t } from "./i18n.js";
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32Update(crc, bytes) {
  let c = crc ^ 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export const ZIP_MAX_ENTRIES = 65535;
export const ZIP_MAX_OFFSET = 0xfffffffe;
export class ZipLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "ZipLimitError";
  }
}
const encoder = new TextEncoder();
async function* parts(data, signal) {
  if (typeof data === "string") data = new Blob([data]);
  if (data instanceof ArrayBuffer) data = new Uint8Array(data);
  if (data instanceof Blob) {
    const reader = data.stream().getReader();
    try {
      for (;;) {
        checkAbort(signal);
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } else if (data instanceof Uint8Array) {
    for (let i = 0; i < data.length; i += 65536) yield data.subarray(i, i + 65536);
  } else if (data?.[Symbol.asyncIterator]) yield* data;
  else throw new TypeError("ZipWriter: unsupported entry data");
}
export class ZipWriter {
  constructor({ sink, signal, onBytes } = {}) {
    this.sink = sink;
    this.signal = signal;
    this.onBytes = onBytes;
    this.chunks = [];
    this.entries = [];
    this.offset = 0;
    this.yieldAt = Date.now();
  }
  async _push(bytes) {
    checkAbort(this.signal);
    if (this.offset + bytes.byteLength > ZIP_MAX_OFFSET)
      throw new ZipLimitError(t("error.zip.tooLarge"));
    if (this.sink) await this.sink.write(bytes);
    else this.chunks.push(bytes);
    this.offset += bytes.byteLength;
    this.onBytes?.(this.offset);
    if (Date.now() - this.yieldAt >= 16) {
      await sleep(0, this.signal);
      this.yieldAt = Date.now();
    }
  }
  async add(name, data, { mtime = new Date(), store = false } = {}) {
    checkAbort(this.signal);
    if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").includes(".."))
      throw new Error(t("error.zip.badPath"));
    if (this.entries.length >= ZIP_MAX_ENTRIES)
      throw new ZipLimitError(t("error.zip.entries", { max: ZIP_MAX_ENTRIES }));
    const nameBytes = encoder.encode(name);
    if (nameBytes.length > 65535) throw new Error(t("error.zip.nameTooLong"));
    const method = !store && typeof CompressionStream === "function" ? 8 : 0;
    const time =
      ((mtime.getHours() << 11) | (mtime.getMinutes() << 5) | (mtime.getSeconds() >> 1)) & 65535;
    const date =
      (((mtime.getFullYear() - 1980) << 9) | ((mtime.getMonth() + 1) << 5) | mtime.getDate()) &
      65535;
    const start = this.offset;
    const header = new Uint8Array(30 + nameBytes.length),
      v = new DataView(header.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 0x0808, true);
    v.setUint16(8, method, true);
    v.setUint16(10, time, true);
    v.setUint16(12, date, true);
    v.setUint16(26, nameBytes.length, true);
    header.set(nameBytes, 30);
    await this._push(header);
    let crc = 0,
      uncompressed = 0;
    const iterator = parts(data, this.signal)[Symbol.asyncIterator]();
    let stream = new ReadableStream({
      pull: async (controller) => {
        try {
          checkAbort(this.signal);
          const { value, done } = await iterator.next();
          if (done) {
            controller.close();
            return;
          }
          const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
          crc = crc32Update(crc, chunk);
          uncompressed += chunk.byteLength;
          if (uncompressed > ZIP_MAX_OFFSET)
            throw new ZipLimitError(t("error.zip.fileTooLarge", { name }));
          controller.enqueue(chunk);
        } catch (err) {
          controller.error(err);
        }
      },
      cancel: () => iterator.return?.(),
    });
    if (method === 8) stream = stream.pipeThrough(new CompressionStream("deflate-raw"));
    const reader = stream.getReader(),
      dataStart = this.offset;
    try {
      for (;;) {
        checkAbort(this.signal);
        const { done, value } = await reader.read();
        if (done) break;
        await this._push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      await iterator.return?.();
    }
    const compressed = this.offset - dataStart;
    const desc = new Uint8Array(16),
      dv = new DataView(desc.buffer);
    dv.setUint32(0, 0x08074b50, true);
    dv.setUint32(4, crc, true);
    dv.setUint32(8, compressed, true);
    dv.setUint32(12, uncompressed, true);
    await this._push(desc);
    this.entries.push({ nameBytes, method, time, date, crc, uncompressed, compressed, start });
    return { name, uncompressed, compressed, method };
  }
  async finalize() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const rec = new Uint8Array(46 + e.nameBytes.length),
        v = new DataView(rec.buffer);
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, 20, true);
      v.setUint16(6, 20, true);
      v.setUint16(8, 0x0808, true);
      v.setUint16(10, e.method, true);
      v.setUint16(12, e.time, true);
      v.setUint16(14, e.date, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, e.compressed, true);
      v.setUint32(24, e.uncompressed, true);
      v.setUint16(28, e.nameBytes.length, true);
      v.setUint32(42, e.start, true);
      rec.set(e.nameBytes, 46);
      await this._push(rec);
    }
    const size = this.offset - cdStart,
      end = new Uint8Array(22),
      v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, this.entries.length, true);
    v.setUint16(10, this.entries.length, true);
    v.setUint32(12, size, true);
    v.setUint32(16, cdStart, true);
    await this._push(end);
    if (this.sink) {
      await this.sink.close();
      return { bytes: this.offset };
    }
    return new Blob(this.chunks, { type: "application/zip" });
  }
}
