// Language layer for the whole extension: which locale is active, how a stored
// preference and the browser language map onto a catalog, and the lookup used
// by both the UI and the export pipeline. Pure JS — no chrome.* and no DOM — so
// the pipeline keeps running unchanged under Node.
//
// `current` is the one deliberate piece of module state in this project: the
// popup, the task page and the job worker each resolve their own locale once,
// and the export pipeline reads it while rendering. Entry points set it before
// doing any work (`setLocale`); a job carries its locale so a resumed run keeps
// rendering the same language.

import enUS from "./locales/en-US.js";
import zhCN from "./locales/zh-CN.js";

export const LOCALES = ["zh-CN", "en-US"];
/** Used when the browser language matches no catalog. */
export const DEFAULT_LOCALE = "en-US";
/** chrome.storage.local key holding the user's explicit choice. */
export const LOCALE_KEY = "locale";

const CATALOGS = { "zh-CN": zhCN, "en-US": enUS };

let current = DEFAULT_LOCALE;
const pluralRules = new Map();

/** "zh*" -> "zh-CN", "en*" -> "en-US", anything else -> "" (no catalog). */
export function matchLocale(tag) {
  const primary = String(tag || "")
    .toLowerCase()
    .split(/[-_]/)[0];
  if (primary === "zh") return "zh-CN";
  if (primary === "en") return "en-US";
  return "";
}

/** Browser/OS language of the current context, falling back to the default. */
export function detectLocale() {
  let tag = "";
  try {
    tag = globalThis.chrome?.i18n?.getUILanguage?.() || "";
  } catch {
    /* Not an extension context; navigator is next. */
  }
  if (!tag) tag = globalThis.navigator?.language || "";
  return matchLocale(tag) || DEFAULT_LOCALE;
}

/** A stored preference wins; otherwise follow the browser language. */
export function resolveLocale(stored) {
  return matchLocale(stored) || detectLocale();
}

/**
 * Resolves the locale from an injected storage adapter (chrome.storage.local in
 * the extension, a stub in tests). An unreadable store falls back to the
 * browser language instead of breaking the caller.
 */
export async function readStoredLocale(storage) {
  try {
    const stored = (await storage.get(LOCALE_KEY))[LOCALE_KEY];
    return resolveLocale(stored);
  } catch {
    return resolveLocale();
  }
}

/** Switches the catalog used by t()/tn(); returns the locale actually set. */
export function setLocale(locale) {
  current = matchLocale(locale) || (CATALOGS[locale] ? locale : DEFAULT_LOCALE);
  return current;
}

export function getLocale() {
  return current;
}

/** True when the active catalog defines the key (used by tests and tn()). */
export function hasKey(key) {
  return typeof CATALOGS[current][key] === "string";
}

function interpolate(text, params) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

/**
 * Catalog lookup. An unknown key returns the key itself, so a missing
 * translation shows up as `popup.foo` instead of silently rendering nothing.
 */
export function t(key, params) {
  const value = CATALOGS[current][key];
  return typeof value === "string" ? interpolate(value, params) : key;
}

/**
 * Plural-aware lookup: `baseKey_one` / `baseKey_other` are picked with
 * Intl.PluralRules, then fall back to `baseKey_other` and finally to the plain
 * key. `count` is always interpolated.
 */
export function tn(baseKey, count, params = {}) {
  let rules = pluralRules.get(current);
  if (!rules) {
    rules = new Intl.PluralRules(current);
    pluralRules.set(current, rules);
  }
  const category = rules.select(count);
  const suffixed = `${baseKey}_${category}`;
  const key = hasKey(suffixed) ? suffixed : `${baseKey}_other`;
  return t(key, { count, ...params });
}
