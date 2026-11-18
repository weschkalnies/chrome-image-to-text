/**
 * OCR module – Local Tesseract.js execution engine & worker lifecycle.
 *
 * Runs inside the isolated MV3 offscreen document (and can be tested directly
 * with mocked Tesseract/Ocr objects).
 *
 * Attached to the shared `self.Ocr` namespace.
 */
(function (Ocr) {
  "use strict";

  const LANGUAGE_LABELS = {
    eng: "English",
    deu: "German",
  };

  /** Creates a typed abort error for cancelled OCR runs. */
  function createOcrAbortError() {
    const error = new Error("Text recognition was cancelled.");
    error.name = "OcrAbortError";
    return error;
  }

  /** Checks whether an error represents a user/lifecycle OCR cancellation. */
  function isOcrAbortError(error) {
    return Boolean(error && error.name === "OcrAbortError");
  }

  /**
   * Tracks all Tesseract workers created during one OCR operation so both
   * partial initialization failures and mid-run cancellations clean up cleanly.
   */
  function createOcrOperation() {
    let cancelled = false;
    let terminated = false;
    let rejectCancellation;
    const workers = new Set();
    const terminations = new Map();
    const cancellation = new Promise((_resolve, reject) => {
      rejectCancellation = reject;
    });
    // Prevent unhandled rejection warnings if abort happens between async steps.
    cancellation.catch(() => {});

    function terminateWorker(worker) {
      if (!worker || typeof worker.terminate !== "function") {
        return Promise.resolve();
      }
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
      terminated = true;
      await Promise.all(Array.from(workers, terminateWorker));
    }

    return {
      get cancelled() {
        return cancelled;
      },
      cancellation,
      registerWorker(worker) {
        if (!worker) return;
        workers.add(worker);
        // Terminate late-resolving workers if the operation already aborted or finalized.
        if (cancelled || terminated) {
          void terminateWorker(worker);
        }
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

  /** Returns the human-readable language label for a Tesseract code. */
  function languageLabel(lang) {
    return LANGUAGE_LABELS[lang] || lang;
  }

  /** Runs a single worker recognition and extracts text + confidence. */
  async function recognizeWith(worker, dataUrl, lang) {
    const ret = await worker.recognize(dataUrl);
    return {
      text: ret && ret.data ? ret.data.text : "",
      confidence:
        ret && ret.data && typeof ret.data.confidence === "number"
          ? ret.data.confidence
          : 0,
      language: lang,
    };
  }

  /** Creates a Tesseract worker for one language using local extension assets. */
  function createOcrWorker(lang) {
    const config = Ocr.Config;
    return Tesseract.createWorker(lang, 1, {
      workerPath: config.tesseract.workerPath,
      corePath: config.tesseract.corePath,
      langPath: config.tesseract.langPath,
      gzip: true,
      workerBlobURL: config.tesseract.workerBlobURL,
      logger: (m) =>
        Ocr.log(
          "Tesseract[" + lang + "]:",
          m.status,
          m.progress != null ? (m.progress * 100).toFixed(0) + "%" : ""
        ),
      errorHandler: (e) => Ocr.log("Tesseract-Worker-Fehler[" + lang + "]:", e),
    });
  }

  /**
   * Executes offline multi-language OCR on a cropped PNG data URL while
   * ensuring every spawned worker is terminated on completion, error, or abort.
   */
  async function recognizeText(dataUrl, operation) {
    if (!Ocr.checkTesseractLoaded()) {
      throw new Error(
        "Tesseract.js is not available (global 'Tesseract' missing)."
      );
    }

    const op = operation || createOcrOperation();
    const config = Ocr.Config;
    const langs = config.ocrLanguages;
    Ocr.log("Erstelle", langs.length, "Tesseract-Worker parallel:", langs.join(", "));

    const t0 = Date.now();
    try {
      let workers;
      try {
        workers = await waitForOcrStep(
          Promise.all(
            langs.map(async (lang) => {
              const worker = await createOcrWorker(lang);
              op.registerWorker(worker);
              return worker;
            })
          ),
          op
        );
      } catch (initErr) {
        if (isOcrAbortError(initErr)) throw initErr;
        if (!initErr || !initErr.message) {
          throw new Error("Could not start local OCR worker.");
        }
        throw initErr;
      }
      Ocr.log("Worker bereit nach", Date.now() - t0, "ms");

      const results = await waitForOcrStep(
        Promise.all(
          workers.map((worker, i) => recognizeWith(worker, dataUrl, langs[i]))
        ),
        op
      );

      const sorted = results.slice().sort((a, b) => b.confidence - a.confidence);
      const best = sorted[0];
      const runnerUp = sorted[1];
      const unambiguous =
        langs.length === 1 ||
        !runnerUp ||
        best.confidence - runnerUp.confidence >= config.langUncertaintyMargin;

      Ocr.log(
        "Bestes Ergebnis: Sprache",
        best.language,
        "Konfidenz",
        best.confidence.toFixed(1),
        "Zweitbeste",
        runnerUp ? runnerUp.language + " " + runnerUp.confidence.toFixed(1) : "-",
        "eindeutig:",
        unambiguous,
        "Zeichen",
        (best.text || "").trim().length
      );

      return {
        text: best.text,
        confidence: best.confidence,
        language: unambiguous ? languageLabel(best.language) : null,
      };
    } finally {
      await op.terminateWorkers();
      Ocr.log("Worker terminiert");
    }
  }

  Ocr.Engine = {
    createOcrAbortError,
    isOcrAbortError,
    createOcrOperation,
    languageLabel,
    recognizeWith,
    createOcrWorker,
    recognizeText,
  };
})(self.Ocr = self.Ocr || {});
