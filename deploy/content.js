/**
 * Local Screen OCR - Content Script (Orchestrator)
 *
 * Verwaltet:
 *  - das Canvas-Overlay zur Bereichsauswahl mit der Maus
 *  - ESC-Abbruch
 *  - das exakte Zuschneiden des Screenshots (inkl. devicePixelRatio)
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
  if (!window.Ocr || typeof Ocr.Config !== "object") {
    console.error(
      "[OCR] Helper-Module fehlen (lib/ocr/config|toast|logger|clipboard.js). " +
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

  /* -----------------------------------------------------------------------
     Message-Listener
     --------------------------------------------------------------------- */

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.action === "start_selection") {
      Ocr.log("start_selection empfangen");
      if (selectionInProgress) {
        Ocr.log("Abbruch: Auswahl laeuft bereits");
        return; // keine parallelen Overlays
      }
      if (
        typeof message.imageUri !== "string" ||
        !message.imageUri.startsWith("data:image/")
      ) {
        Ocr.showError(
          "Start",
          new Error("Ungueltige Bilddaten empfangen (kein data:image/*)."),
          { type: typeof message.imageUri }
        );
        return;
      }
      if (!Ocr.checkTesseractLoaded()) {
        Ocr.showError(
          "Start",
          new Error(
            "Tesseract.js ist nicht geladen. Moegliche Ursache: die Seite " +
              "blockt per CSP das Injizieren von lib/tesseract.min.js."
          )
        );
        return;
      }
      initSelection(message.imageUri);
    }
  });

  /* -----------------------------------------------------------------------
     Auswahl-Overlay
     --------------------------------------------------------------------- */

  function initSelection(imageUri) {
    if (!document.body) {
      Ocr.showError("Start", new Error("document.body ist nicht vorhanden (Seite noch nicht bereit)."));
      return;
    }

    selectionInProgress = true;
    Ocr.log("Overlay wird erstellt", window.innerWidth + "x" + window.innerHeight, "DPR=" + (window.devicePixelRatio || 1));

    const canvas = document.createElement("canvas");
    canvas.id = "ocr-overlay-canvas";
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(canvas);
    activeOverlay = canvas;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      cleanupOverlay();
      Ocr.showError("Overlay", new Error("2D-Canvas-Kontext nicht verfuegbar."));
      return;
    }

    // Screenshot asynchron laden
    const img = new Image();
    let imgLoaded = false;
    img.onload = () => {
      imgLoaded = true;
      Ocr.log("Screenshot geladen", img.naturalWidth + "x" + img.naturalHeight);
      drawOverlay(ctx, canvas, null);
    };
    img.onerror = () => {
      cleanupOverlay();
      Ocr.showError("Screenshot-Laden", new Error("Das dataURL-Bild konnte nicht dekodiert werden."), {
        dataLen: imageUri ? imageUri.length : 0,
      });
    };
    img.src = imageUri;

    let startX = 0;
    let startY = 0;
    let isDragging = false;

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
      const rect = normalizeRect(startX, startY, e.clientX, e.clientY);
      drawOverlay(ctx, canvas, rect);
    }

    function onMouseUp(e) {
      if (!isDragging) return;
      isDragging = false;
      const rect = normalizeRect(startX, startY, e.clientX, e.clientY);
      cleanup(); // Overlay entfernen, bevor OCR laeuft
      if (
        rect.w >= CONFIG.minSelectionSize &&
        rect.h >= CONFIG.minSelectionSize
      ) {
        if (!imgLoaded) {
          Ocr.showError("OCR", new Error("Screenshot wurde noch nicht dekodiert, als die Auswahl endete."));
          return;
        }
        runOcr(img, rect);
      }
    }

    function cleanup() {
      isDragging = false;
      document.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mouseup", onMouseUp);
      cleanupOverlay();
    }

    document.addEventListener("keydown", onKeyDown);
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseup", onMouseUp);
  }

  /* -----------------------------------------------------------------------
     Zeichnen
     --------------------------------------------------------------------- */

  function drawOverlay(ctx, canvas, rect) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (rect) {
      ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
      ctx.strokeStyle = "#007bff";
      ctx.lineWidth = 2;
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  function normalizeRect(x1, y1, x2, y2) {
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.abs(x2 - x1),
      h: Math.abs(y2 - y1),
    };
  }

  /* -----------------------------------------------------------------------
     Bild zuschneiden (mit devicePixelRatio)
     --------------------------------------------------------------------- */

  function cropImage(img, x, y, w, h) {
    const dpr = window.devicePixelRatio || 1;

    const srcX = Math.round(x * dpr);
    const srcY = Math.round(y * dpr);
    const srcW = Math.round(w * dpr);
    const srcH = Math.round(h * dpr);

    // DoS-Schutz: extrem grosse Crops ablehnen
    if (srcW * srcH > CONFIG.maxCropPixels) {
      throw new Error("Auswahl zu gross.");
    }

    // Quellbereich begrenzen, falls er das Bild uebersteigt
    const clampedW = Math.max(1, Math.min(srcW, img.naturalWidth - srcX));
    const clampedH = Math.max(1, Math.min(srcH, img.naturalHeight - srcY));

    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = clampedW;
    cropCanvas.height = clampedH;

    const ctx = cropCanvas.getContext("2d");
    if (!ctx) throw new Error("Canvas-Kontext nicht verfuegbar.");

    // Physische Aufloesung fuer bestmoegliche OCR-Genauigkeit beibehalten
    ctx.drawImage(img, srcX, srcY, clampedW, clampedH, 0, 0, clampedW, clampedH);

    return cropCanvas.toDataURL("image/png");
  }

  /* -----------------------------------------------------------------------
     OCR
     --------------------------------------------------------------------- */

  async function runOcr(img, rect) {
    Ocr.showToast("Erkenne Text (lokal) …");
    Ocr.log("Starte OCR fuer Auswahl", JSON.stringify(rect), "Bild", img.naturalWidth + "x" + img.naturalHeight);
    try {
      let croppedDataUrl;
      try {
        croppedDataUrl = cropImage(img, rect.x, rect.y, rect.w, rect.h);
        Ocr.log("Crop erzeugt", croppedDataUrl.length + " Zeichen dataURL");
      } catch (cropErr) {
        Ocr.showError("Zuschneiden", cropErr, {
          auswahl: rect.w + "x" + rect.h,
          bild: img.naturalWidth + "x" + img.naturalHeight,
        });
        return;
      }

      const result = await recognizeText(croppedDataUrl);
      const trimmed = (result.text || "").trim();

      if (trimmed) {
        const copied = await Ocr.copyToClipboard(trimmed);
        // Detail-Zeile: Zeichenzahl, ggf. Sprache (nur wenn eindeutig), Konfidenz
        let details = trimmed.length + " Zeichen";
        if (result.language) {
          details += " · " + result.language;
        }
        details += " (Konfidenz " + Math.round(result.confidence) + "%)";
        Ocr.showToast(
          (copied
            ? "Text in Zwischenablage kopiert!"
            : "Text erkannt, aber Zwischenablage nicht verfuegbar (siehe Konsole).") +
            "\n" + details,
          copied ? "success" : "error"
        );
        Ocr.log("OCR fertig,", details, "kopiert:", copied);
      } else {
        Ocr.showToast("Kein Text erkannt.", "error");
        Ocr.log("OCR fertig, kein Text");
      }
    } catch (err) {
      Ocr.showError("Texterkennung", err, {
        Sprachen: CONFIG.ocrLanguages.join("+"),
      });
    }
  }

  /** Anzeigename fuer eine Tesseract-Sprachkennung (Fallback: Kennung selbst). */
  function languageLabel(lang) {
    const LABELS = { eng: "Englisch", deu: "Deutsch" };
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

  async function recognizeText(dataUrl) {
    if (!Ocr.checkTesseractLoaded()) {
      throw new Error(
        "Tesseract.js ist nicht verfuegbar (global 'Tesseract' fehlt). " +
          "Wahrscheinlich wurde lib/tesseract.min.js durch die CSP der Seite blockiert."
      );
    }

    const langs = CONFIG.ocrLanguages;
    Ocr.log("Erstelle", langs.length, "Tesseract-Worker parallel:", langs.join(", "));

    // Sprache wird NICHT von Tesseract gemeldet, wenn mehrere Sprachen in
    // einem Worker geladen sind. Trick: pro Sprache ein eigener Worker
    // (parallel initialisiert -> Init-Latenz bleibt ~gleich), dann gewinnt
    // das Ergebnis mit der hoechsten Konfidenz.
    const t0 = Date.now();
    const workers = await Promise.all(langs.map(createOcrWorker));
    Ocr.log("Worker bereit nach", Date.now() - t0, "ms");

    // Schwellwert fuer eindeutige Sprachzuordnung: Besteht zwischen der
    // besten und der zweitbesten Konfidenz ein kleinerer Abstand, ist die
    // Sprache nicht sicher unterscheidbar und wird dem Nutzer NICHT
    // angezeigt (verhindert irrefuehrende Angaben bei sprachneutralem Text
    // wie Ziffern oder Latein, das in beiden Sprachen vorkommt).
    const LANG_UNCERTAINTY_MARGIN = 5;

    try {
      const results = await Promise.all(
        workers.map((worker, i) => recognizeWith(worker, dataUrl, langs[i]))
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
      // Worker immer terminieren, sonst leaken die Web Worker
      await Promise.all(
        workers.map((worker) =>
          worker.terminate().catch((termErr) =>
            Ocr.log("Worker-Terminierung fehlgeschlagen:", termErr)
          )
        )
      );
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