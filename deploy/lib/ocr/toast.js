/**
 * OCR module – Toast notification UI.
 *
 * Renders a single toast inside a closed Shadow DOM so host page CSS cannot
 * bleed in and page scripts cannot read or mutate toast messages. Uses only
 * `textContent` (never `innerHTML`) to prevent DOM-XSS.
 *
 * Attached to the shared `self.Ocr` namespace.
 */
(function (Ocr) {
  "use strict";

  const STYLES = `
    :host { all: initial; }
    #ocr-status-toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      max-width: min(420px, 85vw);
      background-color: #323232;
      color: #ffffff;
      padding: 12px 20px;
      border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
        Helvetica, Arial, sans-serif;
      font-size: 13px;
      line-height: 1.45;
      white-space: pre-line;
      word-break: break-word;
      z-index: 2147483647;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      opacity: 0;
      transform: translateY(8px);
      transition: opacity 0.2s ease-in-out, transform 0.2s ease-in-out;
      pointer-events: none;
      user-select: none;
    }
    #ocr-status-toast.ocr-visible {
      opacity: 1;
      transform: translateY(0);
    }
    #ocr-status-toast.ocr-closeable {
      pointer-events: auto;
      cursor: pointer;
    }
    #ocr-status-toast.ocr-error {
      background-color: #b3261e;
    }
    #ocr-status-toast.ocr-success {
      background-color: #1b6b3a;
    }
  `;

  let activeHost = null;
  let activeToast = null;
  let toastTimer = null;
  let removeTimer = null;
  let lastCloseHandler = null;

  function ensureToast() {
    if (activeHost && activeHost.isConnected && activeToast) {
      return activeToast;
    }
    if (!document.body) return null;

    const host = document.createElement("div");
    host.id = "ocr-toast-host";
    const root = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = STYLES;

    const toast = document.createElement("div");
    toast.id = "ocr-status-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");

    root.append(style, toast);
    document.body.appendChild(host);
    activeHost = host;
    activeToast = toast;
    return toast;
  }

  function dismissToast() {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    if (!activeToast) return;
    const toast = activeToast;
    const host = activeHost;
    if (lastCloseHandler) {
      toast.removeEventListener("click", lastCloseHandler);
      lastCloseHandler = null;
    }
    toast.classList.remove("ocr-visible");
    if (removeTimer) clearTimeout(removeTimer);
    removeTimer = setTimeout(() => {
      removeTimer = null;
      if (host && host.parentNode) host.parentNode.removeChild(host);
      if (activeHost === host) {
        activeHost = null;
        activeToast = null;
      }
    }, 250);
  }

  /**
   * Shows (or replaces) the status toast.
   *
   * @param {string} message      Text to display
   * @param {string} [type]       "error" | "success" | undefined (neutral)
   * @param {number} [duration]   Auto-dismiss in ms (defaults depend on type)
   * @param {boolean} [allowClose] If true, clicking the toast dismisses it
   */
  function showToast(message, type, duration, allowClose) {
    if (removeTimer) {
      clearTimeout(removeTimer);
      removeTimer = null;
    }
    const toast = ensureToast();
    if (!toast) return; // body not ready yet – silently skip

    // SECURITY: textContent only, never innerHTML -> no DOM-XSS
    toast.textContent = message;

    toast.classList.remove("ocr-error", "ocr-success", "ocr-closeable");
    if (type === "error") toast.classList.add("ocr-error");
    else if (type === "success") toast.classList.add("ocr-success");

    if (lastCloseHandler) {
      toast.removeEventListener("click", lastCloseHandler);
      lastCloseHandler = null;
    }

    if (allowClose) {
      toast.classList.add("ocr-closeable");
      toast.title = "Click to close";
      lastCloseHandler = dismissToast;
      toast.addEventListener("click", dismissToast);
    } else {
      toast.removeAttribute("title");
    }

    requestAnimationFrame(() => toast.classList.add("ocr-visible"));

    const C = Ocr.Config;
    const ms = duration || (type === "error" ? C.toastErrorMs : C.toastShortMs);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(dismissToast, ms);
  }

  Ocr.showToast = showToast;
})(self.Ocr = self.Ocr || {});
