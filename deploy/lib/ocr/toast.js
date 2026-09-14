/**
 * OCR module – Toast notification UI.
 *
 * Creates and manages a single toast element. Uses only `textContent`
 * (never `innerHTML`) to prevent DOM-XSS. Multi-line errors stay readable
 * via `white-space: pre-line` in the CSS.
 *
 * Attached to the shared `self.Ocr` namespace.
 */
(function (Ocr) {
  "use strict";

  let toastTimer = null;
  // Zuletzt registrierter Close-Handler – verhindert Listener-Akkumulation,
  // wenn showToast mehrfach mit allowClose auf demselben Element aufgerufen wird.
  let lastCloseHandler = null;

  /**
   * Shows (or replaces) the status toast.
   *
   * @param {string} message      Text to display
   * @param {string} [type]       "error" | "success" | undefined (neutral)
   * @param {number} [duration]   Auto-dismiss in ms (defaults depend on type)
   * @param {boolean} [allowClose] If true, clicking the toast dismisses it
   */
  function showToast(message, type, duration, allowClose) {
    let toast = document.getElementById("ocr-status-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "ocr-status-toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      if (document.body) document.body.appendChild(toast);
      else return; // body not ready yet – silently skip
    }

    // SECURITY: textContent only, never innerHTML -> no DOM-XSS
    toast.textContent = message;

    toast.classList.remove("ocr-error", "ocr-success", "ocr-closeable");
    if (type === "error") toast.classList.add("ocr-error");
    else if (type === "success") toast.classList.add("ocr-success");
    if (allowClose) {
      toast.classList.add("ocr-closeable");
      toast.title = "Click to close";
    }

    // Click dismisses the toast immediately (when allowClose is set)
    const onClickClose = () => {
      toast.removeEventListener("click", lastCloseHandler);
      lastCloseHandler = null;
      if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
      toast.classList.remove("ocr-visible");
      setTimeout(() => {
        if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
      }, 250);
    };
    if (allowClose) {
      if (lastCloseHandler) toast.removeEventListener("click", lastCloseHandler);
      lastCloseHandler = onClickClose;
      toast.addEventListener("click", onClickClose);
    }

    requestAnimationFrame(() => toast.classList.add("ocr-visible"));

    const C = Ocr.Config;
    const ms = duration || (type === "error" ? C.toastErrorMs : C.toastShortMs);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (lastCloseHandler) {
        toast.removeEventListener("click", lastCloseHandler);
        lastCloseHandler = null;
      }
      toast.classList.remove("ocr-visible");
      setTimeout(() => {
        if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
      }, 250);
    }, ms);
  }

  Ocr.showToast = showToast;
})(self.Ocr = self.Ocr || {});
