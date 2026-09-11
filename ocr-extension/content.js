/**
 * Local Screen OCR - Content Script
 *
 * Verwaltet:
 *  - das Canvas-Overlay zur Bereichsauswahl mit der Maus
 *  - ESC-Abbruch
 *  - das exakte Zuschneiden des Screenshots (inkl. devicePixelRatio)
 *  - die lokale OCR-Erkennung via Tesseract.js (offline)
 *  - das Kopieren des Ergebnisses in die Zwischenablage (mit Fallback)
 *
 * Sicherheitsmerkmale:
 *  - IIFE-Guard verhindert Mehrfach-Initialisierung
 *  - Nur textContent, niemals innerHTML -> kein DOM-XSS
 *  - Begrenzung der Crop-Abmessungen (DoS-Schutz)
 *  - Defensive Prüfungen auf null/undefined
 *  - Keine Auswertung von page-eigenem Content
 */
(function () {
  "use strict";

  if (window.__ocrInitialized) return;
  window.__ocrInitialized = true;

  /* -----------------------------------------------------------------------
     Konfiguration
     --------------------------------------------------------------------- */

  const CONFIG = {
    // Mindestgröße eines Auswahlrechtecks in CSS-Pixeln
    minSelectionSize: 5,
    // Maximal zulässige Crop-Pixel (Breite * Hoehe). Verhindert, dass ein
    // absichtlich riesiger Screenshot den Browser/UI-Thread lahmlegt.
    maxCropPixels: 4000 * 4000,
    // OCR-Sprachen (Tesseract traineddata muessen lokal vorliegen)
    ocrLanguages: ["eng", "deu"],
    // Toast-Dauern in ms (Fehler laenger, damit sie lesbar sind)
    toastShortMs: 3000,
    toastErrorMs: 10000,
    // Pfade zu den lokalen Tesseract-Ressourcen (offline)
    tesseract: {
      workerPath: chrome.runtime.getURL("lib/worker.min.js"),
      corePath: chrome.runtime.getURL("lib/"),
      langPath: chrome.runtime.getURL("lib/"),
      // Worker als Blob laden -> umgeht page-CSP (worker-src) Restriktionen,
      // die das Erstellen des Tesseract-Web-Workers auf fremden Seiten
      // blockieren wuerden. Sehr haeufige Fehlerursache in Extensions.
      workerBlobURL: true,
    },
  };

  /* -----------------------------------------------------------------------
     Zustand (Module-Level)
     --------------------------------------------------------------------- */

  let activeOverlay = null; // aktuelles canvas-Element
  let selectionInProgress = false;

  /* -----------------------------------------------------------------------
     Logging & Fehleranzeige
     Alle Meldungen erscheinen mit Praefix "[OCR]" in der Devtools-Konsole
     der Zielseite und (gekuerzt) als Toast fuer den Nutzer.
     --------------------------------------------------------------------- */

  function log(...args) {
    console.log("[OCR]", ...args);
  }

  /**
   * Detaillierte Fehlermeldung: schreibt den vollen Fehler (inkl. Stack)
   * in die Konsole und zeigt eine lesbare Nachricht als Toast an.
   *
   * @param {string} context  Was gerade versucht wurde (z.B. "Texterkennung")
   * @param {Error|*} err     Das Fehlerobjekt
   * @param {object} [extra]  Zusaetzliche Diagnosedaten (key->value)
   */
  function showError(context, err, extra) {
    const name = (err && err.name) || "Error";
    const msg = (err && err.message) || String(err);
    console.error("[OCR]", context, "-", name + ":", msg, "\n", err, extra || "");

    // Lesbare Toast-Zeile(n) bauen (nur textContent -> kein XSS)
    let line = context + " fehlgeschlagen:";
    line += "\n" + name + ": " + msg;
    if (extra) {
      for (const k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) {
          line += "\n" + k + ": " + extra[k];
        }
      }
    }
    showToast(line, "error", CONFIG.toastErrorMs, true);
  }

  /** Prueft ob Tesseract global verfuegbar ist und protokolliert die Version. */
  function checkTesseractLoaded() {
    const ok = typeof Tesseract !== "undefined" && !!Tesseract.createWorker;
    log(
      "Tesseract geladen:",
      ok,
      ok && Tesseract.version ? "v" + Tesseract.version : "(Version unbekannt)"
    );
    return ok;
  }

  /* -----------------------------------------------------------------------
     Message-Listener
     --------------------------------------------------------------------- */

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.action === "start_selection") {
      log("start_selection empfangen");
      if (selectionInProgress) {
        log("Abbruch: Auswahl laeuft bereits");
        return; // keine parallelen Overlays
      }
      if (
        typeof message.imageUri !== "string" ||
        !message.imageUri.startsWith("data:image/")
      ) {
        showError(
          "Start",
          new Error("Ungueltige Bilddaten empfangen (kein data:image/*)."),
          { type: typeof message.imageUri }
        );
        return;
      }
      if (!checkTesseractLoaded()) {
        showError(
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
      showError("Start", new Error("document.body ist nicht vorhanden (Seite noch nicht bereit)."));
      return;
    }

    selectionInProgress = true;
    log("Overlay wird erstellt", window.innerWidth + "x" + window.innerHeight, "DPR=" + (window.devicePixelRatio || 1));

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
      showError("Overlay", new Error("2D-Canvas-Kontext nicht verfuegbar."));
      return;
    }

    // Screenshot asynchron laden
    const img = new Image();
    let imgLoaded = false;
    img.onload = () => {
      imgLoaded = true;
      log("Screenshot geladen", img.naturalWidth + "x" + img.naturalHeight);
      drawOverlay(ctx, canvas, null);
    };
    img.onerror = () => {
      cleanupOverlay();
      showError("Screenshot-Laden", new Error("Das dataURL-Bild konnte nicht dekodiert werden."), {
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
          showError("OCR", new Error("Screenshot wurde noch nicht dekodiert, als die Auswahl endete."));
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
    showToast("Erkenne Text (lokal) …");
    log("Starte OCR fuer Auswahl", JSON.stringify(rect), "Bild", img.naturalWidth + "x" + img.naturalHeight);
    try {
      let croppedDataUrl;
      try {
        croppedDataUrl = cropImage(img, rect.x, rect.y, rect.w, rect.h);
        log("Crop erzeugt", croppedDataUrl.length + " Zeichen dataURL");
      } catch (cropErr) {
        showError("Zuschneiden", cropErr, {
          auswahl: rect.w + "x" + rect.h,
          bild: img.naturalWidth + "x" + img.naturalHeight,
        });
        return;
      }

      const text = await recognizeText(croppedDataUrl);
      const trimmed = (text || "").trim();

      if (trimmed) {
        const copied = await copyToClipboard(trimmed);
        showToast(
          copied
            ? "Text in Zwischenablage kopiert!"
            : "Text erkannt, aber Zwischenablage nicht verfuegbar (siehe Konsole).",
          copied ? "success" : "error"
        );
        log("OCR fertig, Textlaenge", trimmed.length, "kopiert:", copied);
      } else {
        showToast("Kein Text erkannt.", "error");
        log("OCR fertig, kein Text");
      }
    } catch (err) {
      showError("Texterkennung", err, {
        Sprachen: CONFIG.ocrLanguages.join("+"),
      });
    }
  }

  async function recognizeText(dataUrl) {
    if (!checkTesseractLoaded()) {
      throw new Error(
        "Tesseract.js ist nicht verfuegbar (global 'Tesseract' fehlt). " +
          "Wahrscheinlich wurde lib/tesseract.min.js durch die CSP der Seite blockiert."
      );
    }

    log("Erstelle Tesseract-Worker", JSON.stringify(CONFIG.tesseract));

    // Tesseract.js v5 API: createWorker(langs, oem, options)
    const worker = await Tesseract.createWorker(CONFIG.ocrLanguages, 1, {
      workerPath: CONFIG.tesseract.workerPath,
      corePath: CONFIG.tesseract.corePath,
      langPath: CONFIG.tesseract.langPath,
      gzip: true,
      workerBlobURL: CONFIG.tesseract.workerBlobURL,
      // Logger: Tesseract-Fortschritt/Status landet in der Konsole
      logger: (m) => log("Tesseract:", m.status, m.progress != null ? (m.progress * 100).toFixed(0) + "%" : ""),
      errorHandler: (e) => log("Tesseract-Worker-Fehler:", e),
    });

    log("Worker initialisiert, starte recognize()");
    try {
      const ret = await worker.recognize(dataUrl);
      log("recognize() fertig", ret ? "ok" : "leer");
      return ret && ret.data ? ret.data.text : "";
    } finally {
      // Worker immer terminieren, sonst leakt der Web Worker
      try {
        await worker.terminate();
        log("Worker terminiert");
      } catch (termErr) {
        log("Worker-Terminierung fehlgeschlagen:", termErr);
      }
    }
  }

  /* -----------------------------------------------------------------------
     Zwischenablage (mit Fallback)
     --------------------------------------------------------------------- */

  async function copyToClipboard(text) {
    // Bevorzugt: asynchrone Clipboard-API
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) {
        // Fallback (z.B. fehlender Fokus / nicht-secure context)
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

  /* -----------------------------------------------------------------------
     Toast-Benachrichtigung
     --------------------------------------------------------------------- */

  let toastTimer = null;

  function showToast(message, type, duration, allowClose) {
    let toast = document.getElementById("ocr-status-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "ocr-status-toast";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      document.body.appendChild(toast);
    }

    // WICHTIG: nur textContent, niemals innerHTML -> kein DOM-XSS
    // Mehrzeilige Fehler bleiben lesbar (white-space: pre-line im CSS)
    toast.textContent = message;

    toast.classList.remove("ocr-error", "ocr-success", "ocr-closeable");
    if (type === "error") toast.classList.add("ocr-error");
    else if (type === "success") toast.classList.add("ocr-success");
    if (allowClose) {
      toast.classList.add("ocr-closeable");
      toast.title = "Klicken zum Schließen";
    }

    // Klick schliesst den Toast sofort (bei allowClose)
    const onClickClose = () => {
      toast.removeEventListener("click", onClickClose);
      if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
      toast.classList.remove("ocr-visible");
      setTimeout(() => {
        if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
      }, 250);
    };
    if (allowClose) toast.addEventListener("click", onClickClose);

    requestAnimationFrame(() => toast.classList.add("ocr-visible"));

    const ms = duration || (type === "error" ? CONFIG.toastErrorMs : CONFIG.toastShortMs);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.removeEventListener("click", onClickClose);
      toast.classList.remove("ocr-visible");
      setTimeout(() => {
        if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
      }, 250);
    }, ms);
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