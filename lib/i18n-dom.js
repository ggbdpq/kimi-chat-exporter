// DOM side of the i18n layer: paints catalog text into the extension pages and
// keeps them in step with the stored preference. Storage is injected, so this
// module never touches chrome.* itself.

import { LOCALE_KEY, getLocale, resolveLocale, setLocale, t } from "./i18n.js";

/**
 * Applies the active catalog to the static markup:
 *   data-i18n="key"          -> textContent
 *   data-i18n-attr="attr:key,attr:key"
 * and keeps <html lang> and the document title in sync.
 *
 * `root` and `doc` default to the page's own document; they are injectable so
 * the painting can be exercised without a browser.
 */
export function applyStaticI18n({
  root,
  doc = globalThis.document,
  titleKey = "",
} = {}) {
  root = root || doc;
  if (root) {
    for (const node of root.querySelectorAll("[data-i18n]"))
      node.textContent = t(node.dataset.i18n);
    for (const node of root.querySelectorAll("[data-i18n-attr]")) {
      for (const pair of node.dataset.i18nAttr.split(",")) {
        const [attr, key] = pair.split(":").map((part) => part.trim());
        if (attr && key) node.setAttribute(attr, t(key));
      }
    }
  }
  if (doc?.documentElement) doc.documentElement.lang = getLocale();
  if (doc && titleKey) doc.title = t(titleKey);
}

/**
 * Resolves the page locale: the browser language is applied synchronously, so
 * the Chinese copy that ships in the HTML is replaced before the first paint,
 * then a stored preference overrides it and later changes are followed live.
 */
export async function initPageI18n({
  storage,
  onChanged,
  titleKey = "",
  onChange,
  root,
  doc = globalThis.document,
} = {}) {
  const paint = () => applyStaticI18n({ root, doc, titleKey });
  setLocale(resolveLocale());
  paint();
  if (storage) {
    try {
      const stored = (await storage.get(LOCALE_KEY))[LOCALE_KEY];
      setLocale(resolveLocale(stored));
      paint();
    } catch {
      /* Unreadable storage leaves the detected locale in place. */
    }
    // Either event works: chrome.storage.onChanged reports the area as a second
    // argument, the area-scoped StorageArea.onChanged carries only the changes,
    // so the area is only checked when it is actually passed.
    const event = onChanged || storage.onChanged;
    event?.addListener((changes, area) => {
      if (area && area !== "local") return;
      if (!changes[LOCALE_KEY]) return;
      setLocale(resolveLocale(changes[LOCALE_KEY].newValue));
      paint();
      onChange?.(getLocale());
    });
  }
  return getLocale();
}

/** Persists an explicit language choice in the same store the pages read. */
export function storeLocale(storage, locale) {
  return storage.set({ [LOCALE_KEY]: locale });
}

/**
 * Wires the two 中/EN buttons (marked `data-locale`) into a radio group: click
 * or arrow key switches the catalog, repaints the static markup and stores the
 * choice. Returns a `sync()` that re-marks the active button, for the page to
 * call when the preference changed elsewhere; the control, the storage write and
 * the repaint are shared because both the popup and the task page carry one.
 */
export function bindLocaleSwitch({
  storage,
  root,
  doc = globalThis.document,
  titleKey = "",
  onChange,
} = {}) {
  const buttons = [...(root || doc).querySelectorAll("[data-locale]")];
  if (!buttons.length) return null;
  const sync = () => {
    for (const button of buttons) {
      const on = button.dataset.locale === getLocale();
      button.setAttribute("aria-checked", String(on));
      button.tabIndex = on ? 0 : -1;
    }
  };
  const activate = (button, { focus = false } = {}) => {
    if (focus) button.focus();
    setLocale(button.dataset.locale);
    if (storage) Promise.resolve(storeLocale(storage, button.dataset.locale)).catch(() => {});
    applyStaticI18n({ root, doc, titleKey });
    sync();
    onChange?.(getLocale());
  };
  buttons.forEach((button, index) => {
    button.addEventListener("click", () => activate(button));
    button.addEventListener("keydown", (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      activate(buttons[(index + step + buttons.length) % buttons.length], { focus: true });
    });
  });
  sync();
  return sync;
}
