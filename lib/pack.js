// Archive assembly. Store paths are export-root-relative here; the ZIP entries
// are prefixed with the "kimi-export-<date>/" folder so extraction is tidy.
//
// Two layouts:
//   single   -> one ZIP (or several volumes, each containing a complete set of
//               whole chats so every volume stands on its own)
//   per-chat -> one ZIP per chat

import { ZipWriter, ZIP_MAX_ENTRIES } from "./zip.js";
import { t } from "./i18n.js";

const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|avif|bmp|ico|pdf|zip|gz|tar|pptx?|xlsx?|docx?|mp3|mp4|m4a|wav|ogg|bin|dmg|7z|rar)$/i;

/** Cooperative abort: checked before every entry, so a large pack stops
// between files rather than only after the whole archive is built. */
function checkAbort(signal) {
  if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
}

async function addFile(zip, store, storePath, archivePath, signal) {
  checkAbort(signal);
  if (!(await store.exists(storePath)))
    throw new Error(t("error.store.missing", { path: storePath }));
  const blob = await store.getBlob(storePath);
  await zip.add(archivePath, blob, { store: BINARY_EXT.test(archivePath) });
  return blob.size;
}

/** ZIP entries a volume always carries on top of its chats. */
export const SHELL_ENTRIES = 2; // report.md + error.log

/** Per-chat ZIP entry estimate: output files + downloaded assets. */
function entryCost(e) {
  return SHELL_ENTRIES + (e.files ? e.files.length : 0) + (e.assetPaths ? e.assetPaths.length : 0);
}

/**
 * Split chat entries into volumes under a byte cap AND a ZIP entry cap. Whole
 * chats stay together: a volume is always self-contained, which beats
 * a split archive that needs every sibling part to unpack. The caps are
 * advisory for a single oversized chat (it still gets its own volume rather
 * than being corrupted; the ZipWriter guard is the hard backstop).
 */
export function planVolumes(chatEntries, maxBytes, maxEntries = ZIP_MAX_ENTRIES) {
  const volumes = [];
  let cur = [];
  let acc = 0;
  let accEntries = 0;
  for (const entry of chatEntries) {
    const size = entry.bytes || 0;
    const cost = entryCost(entry);
    if (cur.length && (acc + size > maxBytes || accEntries + cost > maxEntries)) {
      volumes.push(cur);
      cur = [];
      acc = 0;
      accEntries = 0;
    }
    cur.push(entry);
    acc += size;
    accEntries += cost;
  }
  if (cur.length) volumes.push(cur);
  return volumes;
}

/** Zip one subset of chats (plus the two reports) into a single archive. */
export async function packChats({
  store,
  rootDir,
  entries,
  reportMd,
  signal,
  sink,
  onBytes,
  onFile,
}) {
  checkAbort(signal);
  const zip = new ZipWriter({ sink, signal, onBytes });
  const add = async (p) => {
    const n = await addFile(zip, store, p, `${rootDir}/${p}`, signal);
    onFile?.(p, n);
    return n;
  };

  for (const entry of entries) {
    for (const f of entry.files) await add(f.storePath);
    for (const p of entry.assetPaths) await add(p);
  }
  checkAbort(signal);
  if (reportMd !== undefined) {
    await store.writeText("report.md", reportMd);
    await add("report.md");
  }
  if (await store.exists("error.log")) await add("error.log");
  checkAbort(signal);
  return zip.finalize();
}
