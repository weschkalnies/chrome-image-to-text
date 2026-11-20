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
      usageCount: "ocrUsageCount",
      reviewDismissed: "reviewPromptDismissed",
    }),
    DEFAULTS: Object.freeze({
      autoCopy: false,
      historyEnabled: false,
    }),
    REVIEW: Object.freeze({
      threshold: 5,
      url: "https://chromewebstore.google.com/detail/localocr-screen-to-text/lklkhielihignkcmfjahobjffganiihl/reviews",
    }),
    HISTORY_KEY: "ocrHistory",
    HISTORY_MAX: 10,
  });
})(self.Ocr = self.Ocr || {});
