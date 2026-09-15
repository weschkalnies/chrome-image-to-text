/**
 * Regressionstest fuer den OCR-Worker-Lebenszyklus in content.js.
 *
 * Prueft ohne die echten Tesseract-Binaries:
 * - einen Fehler bei der parallelen Worker-Initialisierung,
 * - den Abbruch einer laufenden OCR mit Escape und
 * - die Sperre gegen parallele OCR-Ausfuehrungen.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { resolveChrome } = require("./_env.cjs");

const ROOT = path.resolve(__dirname, "..");
const CONTENT_SCRIPT = fs.readFileSync(path.join(ROOT, "src", "content.js"), "utf8");
const CONTENT_CSS = fs.readFileSync(path.join(ROOT, "src", "content.css"), "utf8");
const TEST_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9WAAAAABJRU5ErkJggg==";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(page, predicate, message, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate)) return;
    await page.waitForTimeout(25);
  }
  throw new Error(message);
}

const MOCKS = `
  window.__ocrEvents = [];
  window.__ocrWorkers = [];
  window.__ocrMode = "partial-failure";
  window.__ocrListener = null;
  window.chrome = {
    runtime: {
      onMessage: { addListener(listener) { window.__ocrListener = listener; } }
    }
  };
  window.Ocr = {
    Config: {
      minSelectionSize: 5,
      maxCropPixels: 4000 * 4000,
      ocrLanguages: ["eng", "deu"],
      langUncertaintyMargin: 5,
      tesseract: { workerPath: "", corePath: "", langPath: "", workerBlobURL: true }
    },
    log(...args) { window.__ocrEvents.push(["log", args.join(" ")]); },
    showToast(message) { window.__ocrEvents.push(["toast", String(message)]); },
    showError(context, error) {
      window.__ocrEvents.push(["error", context + ": " + (error && error.message)]);
    },
    checkTesseractLoaded() { return true; },
    async copyToClipboard() { return true; }
  };
  window.Tesseract = {
    createWorker(language) {
      const worker = {
        language,
        terminateCalls: 0,
        recognizeCalls: 0,
        terminate() {
          this.terminateCalls += 1;
          return Promise.resolve();
        },
        recognize() {
          this.recognizeCalls += 1;
          return new Promise(() => {});
        }
      };
      window.__ocrWorkers.push(worker);
      if (window.__ocrMode === "partial-failure" && language === "deu") {
        return Promise.reject(new Error("simulierter Initialisierungsfehler"));
      }
      return Promise.resolve(worker);
    }
  };
`;

async function startSelection(page) {
  await page.evaluate((imageUri) => {
    window.__ocrListener({ action: "start_selection", imageUri });
  }, TEST_IMAGE);
  await page.waitForSelector("#ocr-overlay-canvas", { timeout: 1000 });
  // Das kleine data:-Bild muss erst dekodiert sein, bevor mouseup OCR startet.
  await page.waitForTimeout(50);
  await page.mouse.move(1, 1);
  await page.mouse.down();
  await page.mouse.move(10, 10);
  await page.mouse.up();
}

(async () => {
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: resolveChrome(),
      headless: true,
    });
    const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addStyleTag({ content: CONTENT_CSS });
    await page.addScriptTag({ content: MOCKS });
    await page.addScriptTag({ content: CONTENT_SCRIPT });

    await startSelection(page);
    await waitFor(
      page,
      () => window.__ocrEvents.some((event) => event[0] === "error"),
      "Der simulierte Initialisierungsfehler wurde nicht gemeldet."
    );
    const partialFailure = await page.evaluate(() => ({
      engWorker: window.__ocrWorkers.find((worker) => worker.language === "eng"),
      canvasCount: document.querySelectorAll("#ocr-overlay-canvas").length,
    }));
    assert(partialFailure.engWorker, "Der erste Worker wurde nicht erzeugt.");
    assert(
      partialFailure.engWorker.terminateCalls === 1,
      "Der bei Teilfehler gestartete Worker wurde nicht genau einmal terminiert."
    );
    assert(partialFailure.canvasCount === 0, "Das Overlay blieb nach der Auswahl bestehen.");

    await page.evaluate(() => {
      window.__ocrMode = "wait-for-cancel";
      window.__ocrWorkers = [];
      window.__ocrEvents = [];
    });
    await startSelection(page);
    await waitFor(
      page,
      () => window.__ocrWorkers.length === 2 && window.__ocrWorkers.every((worker) => worker.recognizeCalls === 1),
      "Die hängende OCR wurde nicht gestartet."
    );

    await page.evaluate((imageUri) => {
      window.__ocrListener({ action: "start_selection", imageUri });
    }, TEST_IMAGE);
    await page.waitForTimeout(50);
    assert(
      await page.locator("#ocr-overlay-canvas").count() === 0,
      "Eine zweite Auswahl wurde während der OCR zugelassen."
    );

    await page.keyboard.press("Escape");
    await waitFor(
      page,
      () => window.__ocrEvents.some((event) => event[1] === "Texterkennung abgebrochen."),
      "Escape hat die laufende OCR nicht abgebrochen."
    );
    const cancelled = await page.evaluate(() => window.__ocrWorkers.map((worker) => worker.terminateCalls));
    assert(
      cancelled.length === 2 && cancelled.every((calls) => calls === 1),
      "Nicht alle Worker wurden beim Abbruch genau einmal terminiert."
    );

    await page.evaluate((imageUri) => {
      window.__ocrListener({ action: "start_selection", imageUri });
    }, TEST_IMAGE);
    await page.waitForSelector("#ocr-overlay-canvas", { timeout: 1000 });
    await page.keyboard.press("Escape");
    console.log("OK: OCR-Worker-Lebenszyklus ist gegen Teilfehler und Abbruch abgesichert.");
  } finally {
    if (browser) await browser.close();
  }
})().catch((error) => {
  console.error("TEST FEHLER:", error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
