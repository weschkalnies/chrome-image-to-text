/**
 * OCR module – Storage keys and defaults for user settings and history.
 *
 * Settings live in chrome.storage.local. The optional history lives in
 * chrome.storage.session, so it is gone when the browser is closed and is
 * not readable by content scripts.
 *
 * Attached to the shared `self.Ocr` namespace.
 */
(function (Ocr) {
  "use strict";

  Ocr.Settings = Object.freeze({
    KEYS: Object.freeze({
      languages: "ocrLanguages",
      autoCopy: "autoCopy",
      historyEnabled: "historyEnabled",
    }),
    DEFAULTS: Object.freeze({
      autoCopy: false,
      historyEnabled: false,
    }),
    HISTORY_KEY: "ocrHistory",
    HISTORY_MAX: 10,
  });
})(self.Ocr = self.Ocr || {});
