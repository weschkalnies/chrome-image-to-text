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
    // Mindest-Vorsprung der Best-Konfidenz gegenueber der zweitbesten Sprache
    // (in Prozentpunkten), damit die Sprache als eindeutig gilt und angezeigt wird.
    langUncertaintyMargin: 5,
    // Toast durations in ms (errors stay longer so they are readable)
    toastShortMs: 3000,
    toastErrorMs: 10000,
    // Paths to local Tesseract resources (100 % offline)
    tesseract: {
      workerPath: chrome.runtime.getURL("lib/worker.min.js"),
      corePath: chrome.runtime.getURL("lib/"),
      langPath: chrome.runtime.getURL("lib/"),
      // OCR runs inside the extension's offscreen document (chrome-extension://<id>),
      // where lib/worker.min.js is same-origin and loads directly via
      // new Worker(workerPath) without Blob URLs.
      workerBlobURL: false,
    },
  };
})(self.Ocr = self.Ocr || {});
