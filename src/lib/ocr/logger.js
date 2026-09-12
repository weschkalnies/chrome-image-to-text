/**
 * OCR module – Logging & error display.
 *
 * All messages appear with the "[OCR]" prefix in the DevTools console of the
 * target page and (shortened) as a toast for the user.
 *
 * Attached to the shared `self.Ocr` namespace.
 */
(function (Ocr) {
  "use strict";

  /** Prefixed console logger. */
  function log(...args) {
    console.log("[OCR]", ...args);
  }

  /**
   * Detailed error report: writes the full error (including stack) to the
   * console and shows a readable message as a toast.
   *
   * @param {string} context  What was being attempted (e.g. "Text recognition")
   * @param {Error|*} err     The error object
   * @param {object} [extra]  Additional diagnostic data (key -> value)
   */
  function showError(context, err, extra) {
    const name = (err && err.name) || "Error";
    const msg = (err && err.message) || String(err);
    console.error("[OCR]", context, "-", name + ":", msg, "\n", err, extra || "");

    // Build readable toast line(s) – textContent only, never innerHTML (no XSS)
    let line = context + " failed:";
    line += "\n" + name + ": " + msg;
    if (extra) {
      for (const k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) {
          line += "\n" + k + ": " + extra[k];
        }
      }
    }
    Ocr.showToast(line, "error", Ocr.Config.toastErrorMs, true);
  }

  /** Checks whether Tesseract is globally available and logs its version. */
  function checkTesseractLoaded() {
    const ok = typeof Tesseract !== "undefined" && !!Tesseract.createWorker;
    log(
      "Tesseract loaded:",
      ok,
      ok && Tesseract.version ? "v" + Tesseract.version : "(version unknown)"
    );
    return ok;
  }

  Ocr.log = log;
  Ocr.showError = showError;
  Ocr.checkTesseractLoaded = checkTesseractLoaded;
})(self.Ocr = self.Ocr || {});
