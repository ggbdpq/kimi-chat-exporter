// Locale fixture for the suite. The assertions in the test files below are
// written against the Chinese copy, so each of them pins the locale explicitly
// instead of relying on whatever the module default happens to be; English
// rendering is covered by test/i18n.test.mjs.
import { setLocale } from "../lib/i18n.js";

setLocale("zh-CN");
