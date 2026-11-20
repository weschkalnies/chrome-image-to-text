/**
 * OCR module – UI translation helper.
 *
 * Thin wrapper around chrome.i18n.getMessage (texts in _locales/<lang>/).
 * Falls back to the key itself so a missing message is visible but never
 * breaks the UI.
 *
 * Attached to the shared `self.Ocr` namespace.
 */
(function (Ocr) {
  "use strict";

  /**
   * @param {string} key   message name from messages.json
   * @param {string|string[]} [subs] values for $1, $2 …
   */
  function t(key, subs) {
    try {
      const message =
        typeof chrome !== "undefined" &&
        chrome.i18n &&
        chrome.i18n.getMessage(key, subs);
      if (message) return message;
    } catch (_error) {
      // Extension context invalidated (e.g. after an update) – use the key.
    }
    return key;
  }

  /** Browser UI language, e.g. "de" or "en-US". */
  function uiLanguage() {
    try {
      if (typeof chrome !== "undefined" && chrome.i18n && chrome.i18n.getUILanguage) {
        return chrome.i18n.getUILanguage();
      }
    } catch (_error) {
      // ignore
    }
    return (typeof navigator !== "undefined" && navigator.language) || "en";
  }

  Ocr.t = t;
  Ocr.uiLanguage = uiLanguage;
})(self.Ocr = self.Ocr || {});
