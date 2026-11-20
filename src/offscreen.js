/**
 * Local Screen OCR - MV3 Offscreen Document Controller
 *
 * Executes local Tesseract.js OCR inside an isolated extension origin so page
 * Content Security Policies cannot block Web Workers or WASM execution.
 */
(function () {
  "use strict";

  const ACTIVE_OPERATIONS = new Map();

  function serializeError(err) {
    const name = (err && err.name) || "Error";
    const message =
      window.Ocr && typeof Ocr.formatErrorMessage === "function"
        ? Ocr.formatErrorMessage(err)
        : String(err || "Unknown error");
    return { name, message };
  }

  // Register synchronously at top level so messages arriving right after
  // chrome.offscreen.createDocument() are never dropped.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== "offscreen") {
      return false;
    }

    if (message.action === "offscreen_ping") {
      const tesseractLoaded = Boolean(
        window.Ocr &&
          typeof Ocr.checkTesseractLoaded === "function" &&
          Ocr.checkTesseractLoaded()
      );
      sendResponse({ ready: true, tesseractLoaded });
      return false;
    }

    if (message.action === "offscreen_cancel_ocr") {
      const op = ACTIVE_OPERATIONS.get(message.requestId);
      if (op) op.abort();
      sendResponse({ ok: true, cancelled: Boolean(op) });
      return false;
    }

    if (message.action === "offscreen_run_ocr") {
      if (typeof message.requestId !== "string" || !message.requestId) {
        sendResponse({
          ok: false,
          error: { name: "Error", message: "Missing OCR requestId." },
        });
        return false;
      }
      if (
        typeof message.dataUrl !== "string" ||
        !message.dataUrl.startsWith("data:image/")
      ) {
        sendResponse({
          ok: false,
          error: { name: "Error", message: "Invalid image data received." },
        });
        return false;
      }
      if (!window.Ocr || !Ocr.Engine) {
        sendResponse({
          ok: false,
          error: { name: "Error", message: "OCR engine is not initialized." },
        });
        return false;
      }
      const languages =
        Ocr.Languages && Ocr.Languages.normalize(message.languages);
      if (!languages) {
        sendResponse({
          ok: false,
          error: { name: "Error", message: "Invalid OCR language selection." },
        });
        return false;
      }
      if (ACTIVE_OPERATIONS.has(message.requestId)) {
        sendResponse({
          ok: false,
          error: { name: "Error", message: "Duplicate OCR requestId." },
        });
        return false;
      }

      const operation = Ocr.Engine.createOcrOperation();
      ACTIVE_OPERATIONS.set(message.requestId, operation);

      (async () => {
        try {
          const result = await Ocr.Engine.recognizeText(
            message.dataUrl,
            operation,
            languages
          );
          sendResponse({ ok: true, result });
        } catch (err) {
          sendResponse({
            ok: false,
            aborted: Ocr.Engine.isOcrAbortError(err),
            error: serializeError(err),
          });
        } finally {
          if (ACTIVE_OPERATIONS.get(message.requestId) === operation) {
            ACTIVE_OPERATIONS.delete(message.requestId);
          }
        }
      })();

      return true;
    }

    return false;
  });
})();
