/**
 * Local Screen OCR - Content Script (Orchestrator)
 *
 * Verwaltet:
 *  - das Canvas-Overlay zur Bereichsauswahl mit der Maus
 *  - ESC-Abbruch
 *  - das exakte Zuschneiden des Screenshots anhand seiner realen Aufloesung
 *  - die Weiterleitung des Ausschnitts an das isolierte MV3 Offscreen Document
 *    zur lokalen OCR-Erkennung via Tesseract.js (offline)
 *
 * Querschnittsfunktionen liegen als Helper-Module unter lib/ocr/ und lib/ui/
 * und werden ueber den gemeinsamen Namespace `self.Ocr` angesprochen
 * (INJEKTIONSREIHENFOLGE beachten: config -> i18n -> languages -> toast ->
 * logger -> clipboard -> ui/result -> content.js):
 *  - lib/ocr/config.js     -> Ocr.Config            (Konstanten)
 *  - lib/ocr/i18n.js       -> Ocr.t()               (UI-Texte aus _locales/)
 *  - lib/ocr/languages.js  -> Ocr.Languages         (Sprachnamen)
 *  - lib/ocr/toast.js      -> Ocr.showToast()       (Status-Toast)
 *  - lib/ocr/logger.js     -> Ocr.log() / showError()
 *  - lib/ocr/clipboard.js  -> Ocr.copyToClipboard() (Zwischenablage)
 *  - lib/ui/result.js      -> Ocr.Result            (Ergebnis-Dialog im closed Shadow DOM)
 *
 * Sicherheitsmerkmale:
 *  - IIFE-Guard verhindert Mehrfach-Initialisierung
 *  - Nur textContent, niemals innerHTML -> kein DOM-XSS (in lib/ocr/toast.js)
 *  - Begrenzung der Crop-Abmessungen (DoS-Schutz)
 *  - Defensive Prüfungen auf null/undefined
 *  - Keine Auswertung von page-eigenem Content
 */
(function () {
  "use strict";

  if (window.__ocrInitialized) return;
  window.__ocrInitialized = true;

  /* -----------------------------------------------------------------------
     Guard: Helper-Module muessen VOR diesem Skript injiziert worden sein.
     Fehlt der gemeinsame Ocr-Namespace, ist hier Schluss (klare Diagnose).
     --------------------------------------------------------------------- */
  if (
    !window.Ocr ||
    typeof Ocr.Config !== "object" ||
    typeof Ocr.t !== "function" ||
    typeof Ocr.Result !== "object"
  ) {
    console.error(
        "[OCR] Helper-Module fehlen (lib/ocr/config|i18n|languages|toast|logger|clipboard|ui/result.js). " +
        "Bitte Injection-Reihenfolge in background.js pruefen."
    );
    return;
  }

  /** Kurzalias auf die zentrale Konfiguration (lib/ocr/config.js). */
  const CONFIG = Ocr.Config;

  /* -----------------------------------------------------------------------
     Zustand (Module-Level)
     --------------------------------------------------------------------- */

  let activeOverlay = null; // aktuelles canvas-Element
  let selectionInProgress = false;
  let activeOcrRequest = null;
  let ocrInProgress = false;

  function createOcrAbortError() {
    const error = new Error("Text recognition was cancelled.");
    error.name = "OcrAbortError";
    return error;
  }

  function isOcrAbortError(error) {
    return Boolean(error && error.name === "OcrAbortError");
  }

  function createRequestId() {
    if (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    ) {
      return crypto.randomUUID();
    }
    return "ocr-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
  }

  /** Shows the editable result dialog with an explicit copy action. */
  function showResultDialog(text, confidence, languageName, imageUri) {
    Ocr.Result.show({
      text,
      confidence,
      language: languageName,
      onCopy: async (editedText) => {
        const copied = await Ocr.copyToClipboard(editedText);
        Ocr.showToast(
          copied ? Ocr.t("toastCopied") : Ocr.t("toastClipboardUnavailable"),
          copied ? "success" : "error"
        );
        Ocr.log("OCR-Ergebnis kopiert:", copied, "Zeichen:", editedText.length);
        return copied;
      },
      onReselect: () => initSelection(imageUri),
      onOpenSettings: openLanguageSettings,
    });
  }

  /** Opens the options page (content scripts cannot call openOptionsPage). */
  function openLanguageSettings() {
    Promise.resolve()
      .then(() =>
        chrome.runtime.sendMessage({ target: "background", action: "open_options" })
      )
      .catch((error) => Ocr.log("Optionsseite konnte nicht geoeffnet werden:", error));
  }

  function cancelActiveOcr() {
    if (!activeOcrRequest) return false;
    Ocr.log("OCR-Abbruch angefordert");
    if (activeOcrRequest.cancelRequested) return true;
    activeOcrRequest.cancelRequested = true;
    Ocr.showToast(Ocr.t("toastCancelling"));
    Promise.resolve()
      .then(() =>
        chrome.runtime.sendMessage({
          target: "background",
          action: "cancel_ocr",
          requestId: activeOcrRequest.id,
        })
      )
      .catch((err) => {
        Ocr.log("OCR-Abbruchnachricht fehlgeschlagen:", err);
      });
    return true;
  }

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (cancelActiveOcr() || Ocr.Result.close()) {
      event.preventDefault();
    }
  });

  /* -----------------------------------------------------------------------
     Message-Listener
     --------------------------------------------------------------------- */

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || (message.target && message.target !== "content")) return;

    // Der Background-Service-Worker ist in MV3 nicht persistent. Dieser Ping
    // ersetzt einen fluechtigen "bereits injiziert"-Cache nach Neustarts.
    if (message.action === "ocr_ping") {
      sendResponse({
        ready:
          window.__ocrInitialized === true &&
          typeof window.Ocr === "object" &&
          typeof window.Ocr.Result === "object",
      });
      return;
    }

    if (message.action === "cancel_ocr") {
      cancelActiveOcr();
      return;
    }

    if (message.action === "start_selection") {
      Ocr.log("start_selection empfangen");
      if (selectionInProgress || ocrInProgress) {
        const status = selectionInProgress ? "Auswahl" : "Texterkennung";
        Ocr.log("Start abgewiesen:", status, "laeuft bereits");
        if (ocrInProgress) {
          Ocr.showToast(Ocr.t("toastAlreadyRunning"));
        }
        return; // keine parallele Auswahl bzw. OCR-Ausfuehrung
      }
      if (
        typeof message.imageUri !== "string" ||
        !message.imageUri.startsWith("data:image/")
      ) {
        Ocr.showError(
          Ocr.t("contextStart"),
          new Error("Invalid image data received (not a data:image/* URI)."),
          { type: typeof message.imageUri }
        );
        return;
      }
      Ocr.Result.close();
      initSelection(message.imageUri);
    }
  });

  /* -----------------------------------------------------------------------
     Auswahl-Overlay
     --------------------------------------------------------------------- */

  function initSelection(imageUri) {
    if (!document.body) {
      Ocr.showError(Ocr.t("contextStart"), new Error("document.body is not available (page not ready yet)."));
      return;
    }

    selectionInProgress = true;
    const dpr = window.devicePixelRatio || 1;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    Ocr.log("Overlay wird erstellt", viewportWidth + "x" + viewportHeight, "DPR=" + dpr);

    const canvas = document.createElement("canvas");
    canvas.id = "ocr-overlay-canvas";
    canvas.width = Math.round(viewportWidth * dpr);
    canvas.height = Math.round(viewportHeight * dpr);
    canvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(canvas);
    activeOverlay = canvas;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      cleanupOverlay();
      Ocr.showError(Ocr.t("contextOverlay"), new Error("2D canvas context is not available."));
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Screenshot asynchron laden
    const img = new Image();
    let imgLoaded = false;
    img.onload = () => {
      imgLoaded = true;
      Ocr.log("Screenshot geladen", img.naturalWidth + "x" + img.naturalHeight);
      drawOverlay(ctx, viewportWidth, viewportHeight, null);
    };
    img.onerror = () => {
      cleanupOverlay();
      Ocr.showError(Ocr.t("contextScreenshot"), new Error("Could not decode the screenshot image."), {
        dataLen: imageUri ? imageUri.length : 0,
      });
    };
    img.src = imageUri;

    let startX = 0;
    let startY = 0;
    let isDragging = false;
    let pendingRect = null;
    let rafId = null;

    function onKeyDown(e) {
      if (e.key === "Escape") cleanup();
    }

    function onMouseDown(e) {
      if (e.button !== 0) return; // nur linke Maustaste
      startX = e.clientX;
      startY = e.clientY;
      isDragging = true;
      e.preventDefault();
    }

    function onMouseMove(e) {
      if (!isDragging) return;
      pendingRect = normalizeRect(startX, startY, e.clientX, e.clientY, viewportWidth, viewportHeight);
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (isDragging && pendingRect) {
          drawOverlay(ctx, viewportWidth, viewportHeight, pendingRect);
        }
      });
    }

    function onMouseUp(e) {
      if (!isDragging) return;
      isDragging = false;
      const rect = normalizeRect(startX, startY, e.clientX, e.clientY, viewportWidth, viewportHeight);
      cleanup(); // Overlay entfernen, bevor OCR laeuft
      if (
        rect.w >= CONFIG.minSelectionSize &&
        rect.h >= CONFIG.minSelectionSize
      ) {
        if (!imgLoaded) {
          Ocr.showError(Ocr.t("contextRecognition"), new Error("Screenshot had not finished decoding when selection ended."));
          return;
        }
        runOcr(img, rect, imageUri);
      }
    }

    function cleanup() {
      isDragging = false;
      pendingRect = null;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      document.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("blur", cleanup);
      cleanupOverlay();
    }

    document.addEventListener("keydown", onKeyDown);
    canvas.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("blur", cleanup);
  }

  /* -----------------------------------------------------------------------
     Zeichnen
     --------------------------------------------------------------------- */

  function drawOverlay(ctx, width, height, rect) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
    ctx.fillRect(0, 0, width, height);
    if (rect) {
      ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
      ctx.strokeStyle = "#007bff";
      ctx.lineWidth = 2;
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  function normalizeRect(x1, y1, x2, y2, maxW, maxH) {
    const clampedX1 = Math.max(0, Math.min(x1, maxW));
    const clampedY1 = Math.max(0, Math.min(y1, maxH));
    const clampedX2 = Math.max(0, Math.min(x2, maxW));
    const clampedY2 = Math.max(0, Math.min(y2, maxH));
    return {
      x: Math.min(clampedX1, clampedX2),
      y: Math.min(clampedY1, clampedY2),
      w: Math.abs(clampedX2 - clampedX1),
      h: Math.abs(clampedY2 - clampedY1),
    };
  }

  /* -----------------------------------------------------------------------
     Bild zuschneiden (anhand der Screenshot-Aufloesung)
     --------------------------------------------------------------------- */

  function cropImage(img, x, y, w, h) {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    if (
      !Number.isFinite(viewportWidth) || viewportWidth <= 0 ||
      !Number.isFinite(viewportHeight) || viewportHeight <= 0 ||
      !img.naturalWidth || !img.naturalHeight
    ) {
      throw new Error("Screenshot or viewport dimensions are invalid.");
    }

    // captureVisibleTab() kann eine andere physische Aufloesung als die
    // CSS-Pixel des Tabs haben. Die reale Bildgroesse ist deshalb die
    // verlaessliche Quelle; X und Y werden separat skaliert, weil Screenshots
    // auch nicht-proportional vom Viewport abweichen koennen.
    const scaleX = img.naturalWidth / viewportWidth;
    const scaleY = img.naturalHeight / viewportHeight;
    const srcX = Math.max(0, Math.round(x * scaleX));
    const srcY = Math.max(0, Math.round(y * scaleY));
    const srcW = Math.round(w * scaleX);
    const srcH = Math.round(h * scaleY);

    // DoS-Schutz: extrem grosse Crops ablehnen
    if (srcW * srcH > CONFIG.maxCropPixels) {
      throw new Error("Selected area is too large.");
    }

    // Quellbereich begrenzen, falls er das Bild uebersteigt
    const clampedW = Math.max(1, Math.min(srcW, img.naturalWidth - srcX));
    const clampedH = Math.max(1, Math.min(srcH, img.naturalHeight - srcY));

    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = clampedW;
    cropCanvas.height = clampedH;

    const ctx = cropCanvas.getContext("2d");
    if (!ctx) throw new Error("Canvas context is not available.");

    // Physische Screenshot-Aufloesung fuer bestmoegliche OCR-Genauigkeit
    // beibehalten.
    ctx.drawImage(img, srcX, srcY, clampedW, clampedH, 0, 0, clampedW, clampedH);

    return cropCanvas.toDataURL("image/png");
  }

  /* -----------------------------------------------------------------------
     OCR
     --------------------------------------------------------------------- */

  async function runOcr(img, rect, imageUri) {
    if (ocrInProgress) {
      Ocr.log("OCR-Start abgewiesen: OCR laeuft bereits");
      return;
    }

    const request = { id: createRequestId(), cancelRequested: false };
    activeOcrRequest = request;
    ocrInProgress = true;
    Ocr.showToast(Ocr.t("toastRecognizing"));
    Ocr.log("Starte OCR fuer Auswahl", JSON.stringify(rect), "Bild", img.naturalWidth + "x" + img.naturalHeight);
    let usedLanguages = null;
    try {
      let croppedDataUrl;
      try {
        croppedDataUrl = cropImage(img, rect.x, rect.y, rect.w, rect.h);
        Ocr.log("Crop erzeugt", croppedDataUrl.length + " Zeichen dataURL");
      } catch (cropErr) {
        Ocr.showError(Ocr.t("contextCropping"), cropErr, {
          selection: rect.w + "x" + rect.h,
          image: img.naturalWidth + "x" + img.naturalHeight,
        });
        return;
      }

      if (request.cancelRequested) {
        throw createOcrAbortError();
      }

      const response = await chrome.runtime.sendMessage({
        target: "background",
        action: "run_ocr",
        requestId: request.id,
        dataUrl: croppedDataUrl,
      });

      if (!response || typeof response !== "object") {
        if (request.cancelRequested) {
          throw createOcrAbortError();
        }
        throw new Error("OCR service did not return a response.");
      }

      if (Array.isArray(response.languages)) {
        usedLanguages = response.languages;
      }

      if (!response.ok) {
        if (response.aborted || request.cancelRequested) {
          throw createOcrAbortError();
        }
        const errInfo = response.error || {};
        const err = new Error(errInfo.message || "Text recognition failed.");
        if (errInfo.name) err.name = errInfo.name;
        throw err;
      }

      const result = response.result || {};
      const trimmed = (result.text || "").trim();

      if (trimmed) {
        const languageName = result.languageCode
          ? Ocr.Languages.displayName(result.languageCode, Ocr.uiLanguage())
          : result.language || null;
        Ocr.log(
          "OCR fertig:",
          trimmed.length + " Zeichen",
          languageName ? "· " + languageName : "",
          "(Konfidenz " + Math.round(result.confidence) + "%)",
          response.autoCopy ? "· sofort kopieren" : ""
        );

        // "Sofort kopieren": Dialog ueberspringen. Schlaegt das Kopieren fehl
        // (z. B. Tab verlor den Fokus), faellt es auf den Dialog zurueck.
        if (response.autoCopy) {
          const copied = await Ocr.copyToClipboard(trimmed);
          Ocr.log("OCR-Ergebnis automatisch kopiert:", copied, "Zeichen:", trimmed.length);
          if (copied) {
            Ocr.showToast(Ocr.t("toastCopied"), "success");
            return;
          }
        }

        showResultDialog(trimmed, result.confidence, languageName, imageUri);
        if (response.autoCopy) {
          Ocr.showToast(Ocr.t("resultAutoCopyFailed"), "error");
        }
      } else {
        Ocr.showToast(Ocr.t("toastNoText"), "error");
        Ocr.log("OCR fertig, kein Text");
      }
    } catch (err) {
      if (isOcrAbortError(err) || request.cancelRequested) {
        Ocr.showToast(Ocr.t("toastCancelled"));
        Ocr.log("OCR abgebrochen");
      } else {
        Ocr.showError(
          Ocr.t("contextRecognition"),
          err,
          usedLanguages ? { [Ocr.t("errorLanguages")]: usedLanguages.join("+") } : undefined
        );
      }
    } finally {
      // Der Status wird erst nach Abschluss der Offscreen-Antwort freigegeben;
      // so kann keine zweite Auswahl waehrend laufender OCR starten.
      if (activeOcrRequest === request) {
        activeOcrRequest = null;
        ocrInProgress = false;
      }
    }
  }

  /* -----------------------------------------------------------------------
     Aufräumen
     --------------------------------------------------------------------- */

  function cleanupOverlay() {
    if (activeOverlay && activeOverlay.parentNode) {
      activeOverlay.parentNode.removeChild(activeOverlay);
    }
    activeOverlay = null;
    selectionInProgress = false;
  }
})();
