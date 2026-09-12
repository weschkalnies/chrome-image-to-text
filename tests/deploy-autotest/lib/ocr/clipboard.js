/**
 * OCR module – Clipboard write with fallback.
 *
 * Prefers the asynchronous Clipboard API and falls back to the legacy
 * `execCommand("copy")` approach when the API is unavailable (e.g. missing
 * focus or non-secure context).
 *
 * Attached to the shared `self.Ocr` namespace.
 */
(function (Ocr) {
  "use strict";

  /**
   * Copies text to the system clipboard.
   *
   * @param {string} text
   * @returns {Promise<boolean>} true if the copy succeeded
   */
  async function copyToClipboard(text) {
    // Preferred: async Clipboard API
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) {
        // Fall through to legacy fallback
      }
    }
    // Fallback: execCommand
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  Ocr.copyToClipboard = copyToClipboard;
})(self.Ocr = self.Ocr || {});
