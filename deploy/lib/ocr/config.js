/**
 * OCR module – Configuration constants.
 *
 * Centralizes all tunable parameters so feature modules stay declarative
 * and the orchestrator can override values if needed.
 *
 * Attached to the shared `self.Ocr` namespace.
 */
(function (Ocr) {
  "use strict";

  Ocr.Config = {
    // Minimum selection size in CSS pixels – smaller drags are ignored
    minSelectionSize: 5,
    // Maximum crop pixels (w * h). Prevents a deliberately huge screenshot
    // from locking up the browser / UI thread (DoS protection).
    maxCropPixels: 4000 * 4000,
    // OCR languages – Tesseract traineddata files must exist locally in lib/
    ocrLanguages: ["eng", "deu"],
    // Toast durations in ms (errors stay longer so they are readable)
    toastShortMs: 3000,
    toastErrorMs: 10000,
    // Paths to local Tesseract resources (100 % offline)
    tesseract: {
      workerPath: chrome.runtime.getURL("lib/worker.min.js"),
      corePath: chrome.runtime.getURL("lib/"),
      langPath: chrome.runtime.getURL("lib/"),
      // Load worker as Blob -> bypasses page-CSP (worker-src) restrictions
      // that would block creating the Tesseract web worker on foreign pages.
      // Very common failure cause in extensions.
      workerBlobURL: true,
    },
  };
})(self.Ocr = self.Ocr || {});
