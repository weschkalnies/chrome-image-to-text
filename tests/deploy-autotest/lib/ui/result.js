/**
 * OCR module – editable result dialog.
 *
 * The UI lives in a closed Shadow DOM so recognized text is not exposed in
 * the page's regular DOM to scripts from the currently visited website.
 */
(function (Ocr) {
  "use strict";

  let activeResult = null;

  const STYLES = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .backdrop {
      position: fixed; inset: 0; z-index: 2147483647;
      display: flex; align-items: center; justify-content: center;
      padding: 20px; background: rgba(9, 25, 40, .48);
      color: #12314d; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .dialog {
      width: min(560px, 100%); max-height: 100%; display: flex; flex-direction: column;
      gap: 14px; padding: 24px; border-radius: 16px; background: #fff;
      box-shadow: 0 20px 60px rgba(0, 0, 0, .35);
    }
    h2 { margin: 0; font-size: 20px; line-height: 1.25; }
    .meta { color: #526574; font-size: 13px; line-height: 1.4; }
    textarea {
      width: 100%; min-height: 180px; resize: vertical; padding: 12px;
      border: 1px solid #a8b9c6; border-radius: 8px; color: #102b43;
      font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    textarea:focus { outline: 3px solid rgba(18, 49, 77, .25); border-color: #12314d; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    button { min-height: 38px; padding: 8px 14px; border: 1px solid #12314d; border-radius: 7px; cursor: pointer; font: 600 14px/1.2 inherit; }
    button.primary { background: #12314d; color: #fff; }
    button.secondary { background: #fff; color: #12314d; }
    button:disabled { cursor: wait; opacity: .7; }
    .status { min-height: 18px; color: #526574; font-size: 13px; }
    @media (max-width: 420px) { .dialog { padding: 18px; } textarea { min-height: 140px; } .actions button { flex: 1; } }
  `;

  function element(tag, text) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    return node;
  }

  function close() {
    if (!activeResult) return false;
    const { host } = activeResult;
    activeResult = null;
    if (host.parentNode) host.parentNode.removeChild(host);
    return true;
  }

  /**
   * Shows recognized text before it is copied.
   * @param {{text: string, confidence: number, language: string|null, onCopy: (text: string) => Promise<boolean>, onReselect: () => void}} options
   */
  function show(options) {
    if (!document.body || !options || typeof options.text !== "string") return false;
    close();

    const host = document.createElement("div");
    host.id = "ocr-result-host";
    const root = host.attachShadow({ mode: "closed" });
    const style = element("style", STYLES);
    const backdrop = element("div");
    backdrop.className = "backdrop";
    const dialog = element("section");
    dialog.className = "dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "OCR-Ergebnis");

    const title = element("h2", "Text erkannt");
    const metaParts = ["Konfidenz " + Math.round(options.confidence || 0) + "%"];
    if (options.language) metaParts.push("Sprache " + options.language);
    const meta = element("div", metaParts.join(" · "));
    meta.className = "meta";

    const textarea = element("textarea");
    textarea.value = options.text;
    textarea.setAttribute("aria-label", "Erkannter Text, bearbeitbar");

    const status = element("div");
    status.className = "status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");

    const actions = element("div");
    actions.className = "actions";
    const closeButton = element("button", "Schließen");
    closeButton.className = "secondary";
    closeButton.type = "button";
    closeButton.addEventListener("click", close);

    const reselectButton = element("button", "Auswahl wiederholen");
    reselectButton.className = "secondary";
    reselectButton.type = "button";
    reselectButton.addEventListener("click", () => {
      close();
      if (typeof options.onReselect === "function") options.onReselect();
    });

    const copyButton = element("button", "Kopieren");
    copyButton.className = "primary";
    copyButton.type = "button";
    copyButton.addEventListener("click", async () => {
      const text = textarea.value;
      if (!text.trim()) {
        status.textContent = "Der Text ist leer.";
        textarea.focus();
        return;
      }
      copyButton.disabled = true;
      try {
        const copied = typeof options.onCopy === "function" && await options.onCopy(text);
        status.textContent = copied
          ? "In die Zwischenablage kopiert."
          : "Kopieren fehlgeschlagen. Bitte erneut versuchen.";
      } catch (error) {
        status.textContent = "Kopieren fehlgeschlagen. Bitte erneut versuchen.";
      } finally {
        copyButton.disabled = false;
      }
    });

    actions.append(closeButton, reselectButton, copyButton);
    dialog.append(title, meta, textarea, status, actions);
    backdrop.appendChild(dialog);
    root.append(style, backdrop);
    document.body.appendChild(host);
    activeResult = { host };
    textarea.focus({ preventScroll: true });
    return true;
  }

  Ocr.Result = { show, close };
})(self.Ocr = self.Ocr || {});
