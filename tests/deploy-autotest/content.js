/**
 * Local Screen OCR - Content Script (Orchestrator)
 *
 * Verwaltet:
 *  - das Canvas-Overlay zur Bereichsauswahl mit der Maus
 *  - ESC-Abbruch
 *  - das exakte Zuschneiden des Screenshots anhand seiner realen Aufloesung
 *  - die lokale OCR-Erkennung via Tesseract.js (offline)
 *
 * Querschnittsfunktionen liegen als Helper-Module unter lib/ocr/ und werden
 * ueber den gemeinsamen Namespace `self.Ocr` angesprochen (INJEKTIONSREIHEN-
 * FOLGE beachten: config -> toast -> logger -> clipboard -> content.js):
 *  - lib/ocr/config.js     -> Ocr.Config                             (Konstanten)
 *  - lib/ocr/toast.js      -> Ocr.showToast()                        (Status-Toast)
 *  - lib/ocr/logger.js     -> Ocr.log() / showError() / checkTesseractLoaded()
 *  - lib/ocr/clipboard.js  -> Ocr.copyToClipboard()                  (Zwischenablage)
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
    typeof Ocr.Result !== "object"
  ) {
    console.error(
        "[OCR] Helper-Module fehlen (lib/ocr/config|toast|logger|clipboard|ui/result.js). " +
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
  let activeOcrOperation = null;
  let ocrInProgress = false;

  function createOcrAbortError() {
    const error = new Error("Text recognition was cancelled.");
    error.name = "OcrAbortError";
    return error;
  }

  function isOcrAbortError(error) {
    return error && error.name === "OcrAbortError";
  }

  /**
   * Verwaltet alle Worker einer OCR-Ausfuehrung. Worker werden direkt nach
   * ihrer asynchronen Erstellung registriert; damit kann auch eine teilweise
   * fehlgeschlagene parallele Initialisierung vollstaendig aufgeraeumt werden.
   */
  function createOcrOperation() {
    let cancelled = false;
    let rejectCancellation;
    const workers = new Set();
    const terminations = new Map();
    const cancellation = new Promise((resolve, reject) => {
      rejectCancellation = reject;
    });
    // Der Handler verhindert eine unbehandelte Rejection, falls der Abbruch
    // genau zwischen zwei asynchronen OCR-Schritten angefordert wird.
    cancellation.catch(() => {});

    function terminateWorker(worker) {
      if (terminations.has(worker)) return terminations.get(worker);
      const termination = Promise.resolve()
        .then(() => worker.terminate())
        .catch((termErr) =>
          Ocr.log("Worker-Terminierung fehlgeschlagen:", termErr)
        );
      terminations.set(worker, termination);
      return termination;
    }

    async function terminateWorkers() {
      await Promise.all(Array.from(workers, terminateWorker));
    }

    return {
      get cancelled() {
        return cancelled;
      },
      cancellation,
      registerWorker(worker) {
        workers.add(worker);
        // Falls der Worker erst nach einem Abbruch fertig initialisiert wird,
        // darf er nicht unbemerkt weiterlaufen.
        if (cancelled) void terminateWorker(worker);
      },
      abort() {
        if (cancelled) return;
        cancelled = true;
        rejectCancellation(createOcrAbortError());
        void terminateWorkers();
      },
      terminateWorkers,
    };
  }

  function waitForOcrStep(promise, operation) {
    return Promise.race([promise, operation.cancellation]);
  }

  function cancelActiveOcr() {
    if (!activeOcrOperation) return false;
    Ocr.log("OCR-Abbruch angefordert");
    activeOcrOperation.abort();
    Ocr.showToast("Cancelling text recognition …");
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
    if (!message) return;

    // Der Background-Service-Worker ist in MV3 nicht persistent. Dieser Ping
    // ersetzt einen fluechtigen "bereits injiziert"-Cache nach Neustarts.
    if (message.action === "ocr_ping") {
      sendResponse({
        ready:
          window.__ocrInitialized === true &&
          typeof window.Tesseract === "object" &&
          typeof window.Ocr === "object",
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
          Ocr.showToast("Text recognition is already running. Press Esc to cancel.");
        }
        return; // keine parallele Auswahl bzw. OCR-Ausfuehrung
      }
      if (
        typeof message.imageUri !== "string" ||
        !message.imageUri.startsWith("data:image/")
      ) {
        Ocr.showError(
          "Start",
          new Error("Invalid image data received (not a data:image/* URI)."),
          { type: typeof message.imageUri }
        );
        return;
      }
      if (!Ocr.checkTesseractLoaded()) {
        Ocr.showError(
          "Start",
          new Error(
            "Tesseract.js is not loaded. The page's CSP may be blocking lib/tesseract.min.js."
          )
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
      Ocr.showError("Start", new Error("document.body is not available (page not ready yet)."));
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
      Ocr.showError("Overlay", new Error("2D canvas context is not available."));
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
      Ocr.showError("Screenshot loading", new Error("Could not decode the screenshot image."), {
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
          Ocr.showError("OCR", new Error("Screenshot had not finished decoding when selection ended."));
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

    const operation = createOcrOperation();
    activeOcrOperation = operation;
    ocrInProgress = true;
    Ocr.showToast("Recognizing text (local) …\nPress Esc to cancel");
    Ocr.log("Starte OCR fuer Auswahl", JSON.stringify(rect), "Bild", img.naturalWidth + "x" + img.naturalHeight);
    try {
      let croppedDataUrl;
      try {
        croppedDataUrl = cropImage(img, rect.x, rect.y, rect.w, rect.h);
        Ocr.log("Crop erzeugt", croppedDataUrl.length + " Zeichen dataURL");
      } catch (cropErr) {
        Ocr.showError("Cropping", cropErr, {
          selection: rect.w + "x" + rect.h,
          image: img.naturalWidth + "x" + img.naturalHeight,
        });
        return;
      }

      const result = await recognizeText(croppedDataUrl, operation);
      const trimmed = (result.text || "").trim();

      if (trimmed) {
        let details = trimmed.length + " Zeichen";
        if (result.language) {
          details += " · " + result.language;
        }
        details += " (Konfidenz " + Math.round(result.confidence) + "%)";
        Ocr.Result.show({
          text: trimmed,
          confidence: result.confidence,
          language: result.language,
          onCopy: async (editedText) => {
            const copied = await Ocr.copyToClipboard(editedText);
            Ocr.showToast(
              copied
                ? "Text copied to clipboard!"
                : "Text recognized, but clipboard is unavailable (see console).",
              copied ? "success" : "error"
            );
            Ocr.log("OCR-Ergebnis kopiert:", copied, "Zeichen:", editedText.length);
            return copied;
          },
          onReselect: () => initSelection(imageUri),
        });
        Ocr.log("OCR fertig, Ergebnis angezeigt:", details);
      } else {
        Ocr.showToast("No text recognized.", "error");
        Ocr.log("OCR fertig, kein Text");
      }
    } catch (err) {
      if (isOcrAbortError(err)) {
        Ocr.showToast("Text recognition cancelled.");
        Ocr.log("OCR abgebrochen");
      } else {
        Ocr.showError("Text recognition", err, {
          Languages: CONFIG.ocrLanguages.join("+"),
        });
      }
    } finally {
      // Der Status wird erst nach dem terminierenden recognizeText-finally
      // freigegeben; so kann keine zweite Auswahl neue Worker starten.
      if (activeOcrOperation === operation) {
        activeOcrOperation = null;
        ocrInProgress = false;
      }
    }
  }

  /** Anzeigename fuer eine Tesseract-Sprachkennung (Fallback: Kennung selbst). */
  function languageLabel(lang) {
    const LABELS = { eng: "English", deu: "German" };
    return LABELS[lang] || lang;
  }

  /** Ein recognize() inkl. Extraktion von Text + Konfidenz. */
  async function recognizeWith(worker, dataUrl, lang) {
    const ret = await worker.recognize(dataUrl);
    return {
      text: ret && ret.data ? ret.data.text : "",
      // data.confidence: 0–100 (Tesseract-Gesamtkonfidenz der Erkennung)
      confidence:
        ret && ret.data && typeof ret.data.confidence === "number"
          ? ret.data.confidence
          : 0,
      language: lang,
    };
  }

  /** Erstellt einen Tesseract-Worker fuer EINE Sprache (v5-API). */
  function createOcrWorker(lang) {
    return Tesseract.createWorker(lang, 1, {
      workerPath: CONFIG.tesseract.workerPath,
      corePath: CONFIG.tesseract.corePath,
      langPath: CONFIG.tesseract.langPath,
      gzip: true,
      workerBlobURL: CONFIG.tesseract.workerBlobURL,
      logger: (m) => Ocr.log("Tesseract[" + lang + "]:", m.status, m.progress != null ? (m.progress * 100).toFixed(0) + "%" : ""),
      errorHandler: (e) => Ocr.log("Tesseract-Worker-Fehler[" + lang + "]:", e),
    });
  }

  async function recognizeText(dataUrl, operation) {
    if (!Ocr.checkTesseractLoaded()) {
      throw new Error(
        "Tesseract.js is not available (global 'Tesseract' missing). " +
          "lib/tesseract.min.js was likely blocked by the page's CSP."
      );
    }

    const langs = CONFIG.ocrLanguages;
    Ocr.log("Erstelle", langs.length, "Tesseract-Worker parallel:", langs.join(", "));

    // Sprache wird NICHT von Tesseract gemeldet, wenn mehrere Sprachen in
    // einem Worker geladen sind. Trick: pro Sprache ein eigener Worker
    // (parallel initialisiert -> Init-Latenz bleibt ~gleich), dann gewinnt
    // das Ergebnis mit der hoechsten Konfidenz.
    const t0 = Date.now();
    try {
      const workers = await waitForOcrStep(
        Promise.all(
          langs.map(async (lang) => {
            const worker = await createOcrWorker(lang);
            operation.registerWorker(worker);
            return worker;
          })
        ),
        operation
      );
      Ocr.log("Worker bereit nach", Date.now() - t0, "ms");

      // Schwellwert fuer eindeutige Sprachzuordnung: Besteht zwischen der
      // besten und der zweitbesten Konfidenz ein kleinerer Abstand, ist die
      // Sprache nicht sicher unterscheidbar und wird dem Nutzer NICHT
      // angezeigt (verhindert irrefuehrende Angaben bei sprachneutralem Text
      // wie Ziffern oder Latein, das in beiden Sprachen vorkommt).
      const LANG_UNCERTAINTY_MARGIN = CONFIG.langUncertaintyMargin;

      const results = await waitForOcrStep(
        Promise.all(
          workers.map((worker, i) => recognizeWith(worker, dataUrl, langs[i]))
        ),
        operation
      );
      // Hoechste Konfidenz gewinnt; bei Gleichstand gewinnt die erste Sprache.
      const sorted = results.slice().sort((a, b) => b.confidence - a.confidence);
      const best = sorted[0];
      const runnerUp = sorted[1];
      // Sprache nur melden, wenn eindeutig: deutlicher Vorsprung ODER nur
      // eine Sprache konfiguriert (dann trivial eindeutig).
      const unambiguous = langs.length === 1 || !runnerUp ||
        best.confidence - runnerUp.confidence >= LANG_UNCERTAINTY_MARGIN;
      Ocr.log(
        "Bestes Ergebnis: Sprache", best.language,
        "Konfidenz", best.confidence.toFixed(1),
        "Zweitbeste", runnerUp ? runnerUp.language + " " + runnerUp.confidence.toFixed(1) : "-",
        "eindeutig:", unambiguous,
        "Zeichen", (best.text || "").trim().length
      );
      return {
        text: best.text,
        confidence: best.confidence,
        // null => Sprache nicht eindeutig ermittelbar (keine Anzeige im Toast)
        language: unambiguous ? languageLabel(best.language) : null,
      };
    } finally {
      // Umfasst auch Fehler bei Promise.all(createWorker): alle bis dahin
      // registrierten Worker werden immer terminiert.
      await operation.terminateWorkers();
      Ocr.log("Worker terminiert");
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
