/**
 * Regressionstest fuer den OCR-Worker-Lebenszyklus ueber content.js -> offscreen.js -> engine.js.
 *
 * Prueft ohne die echten Tesseract-Binaries:
 * - Crop-Skalierung anhand der realen Screenshot-Aufloesung,
 * - einen Fehler bei der parallelen Worker-Initialisierung (inkl. spaet aufloesender Worker),
 * - den Abbruch einer laufenden OCR mit Escape und
 * - die Sperre gegen parallele OCR-Ausfuehrungen.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { resolveChrome } = require("./_env.cjs");

const ROOT = path.resolve(__dirname, "..");
const ENGINE_SCRIPT = fs.readFileSync(path.join(ROOT, "src", "lib", "ocr", "engine.js"), "utf8");
const OFFSCREEN_SCRIPT = fs.readFileSync(path.join(ROOT, "src", "offscreen.js"), "utf8");
const CONTENT_SCRIPT = fs.readFileSync(path.join(ROOT, "src", "content.js"), "utf8");
const CONTENT_CSS = fs.readFileSync(path.join(ROOT, "src", "content.css"), "utf8");
const TEST_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9WAAAAABJRU5ErkJggg==";
const SCALE_TEST_IMAGE =
  "data:image/svg+xml;base64," +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="white"/></svg>'
  ).toString("base64");

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
  window.__ocrListeners = [];
  window.__cropDraws = [];
  const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (...args) {
    if (args.length === 9) window.__cropDraws.push(args.slice(1));
    return originalDrawImage.apply(this, args);
  };
  window.__dispatchTabMessage = (message) => {
    for (const listener of window.__ocrListeners) {
      listener(message, {}, () => {});
    }
  };
  window.chrome = {
    runtime: {
      onMessage: {
        addListener(listener) {
          window.__ocrListeners.push(listener);
        }
      },
      sendMessage(message) {
        if (!message || message.target !== "background") {
          return Promise.resolve(undefined);
        }
        const relayed =
          message.action === "run_ocr"
            ? {
                target: "offscreen",
                action: "offscreen_run_ocr",
                requestId: message.requestId,
                dataUrl: message.dataUrl,
              }
            : message.action === "cancel_ocr"
              ? {
                  target: "offscreen",
                  action: "offscreen_cancel_ocr",
                  requestId: message.requestId,
                }
              : null;
        if (!relayed) return Promise.resolve(undefined);
        return new Promise((resolve) => {
          let settled = false;
          let anyAsync = false;
          const sendResponse = (response) => {
            if (!settled) {
              settled = true;
              resolve(response);
            }
          };
          for (const listener of window.__ocrListeners) {
            const keepOpen = listener(relayed, {}, sendResponse);
            if (keepOpen === true) anyAsync = true;
            if (settled) return;
          }
          if (!anyAsync && !settled) {
            settled = true;
            resolve(undefined);
          }
        });
      }
    }
  };
  window.Ocr = {
    Config: {
      minSelectionSize: 5,
      maxCropPixels: 4000 * 4000,
      ocrLanguages: ["eng", "deu"],
      langUncertaintyMargin: 5,
      toastErrorMs: 10000,
      tesseract: { workerPath: "", corePath: "", langPath: "", workerBlobURL: false }
    },
    log(...args) { window.__ocrEvents.push(["log", args.join(" ")]); },
    formatErrorMessage(err) {
      if (err && typeof err.message === "string" && err.message.trim()) return err.message;
      return String(err || "Unknown error");
    },
    showToast(message) { window.__ocrEvents.push(["toast", String(message)]); },
    showError(context, error) {
      window.__ocrEvents.push(["error", context + ": " + (error && error.message)]);
    },
    Result: { show() { return true; }, close() { return false; } },
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
      if (window.__ocrMode === "late-worker-after-failure") {
        if (language === "deu") {
          return Promise.reject(new Error("schneller Fehler"));
        }
        return new Promise((resolve) => setTimeout(() => resolve(worker), 60));
      }
      return Promise.resolve(worker);
    }
  };
`;

async function startSelection(page, imageUri = TEST_IMAGE, start = { x: 1, y: 1 }, end = { x: 10, y: 10 }) {
  await page.evaluate((imageUri) => {
    window.__dispatchTabMessage({ action: "start_selection", imageUri });
  }, imageUri);
  await page.waitForSelector("#ocr-overlay-canvas", { timeout: 1000 });
  // Das kleine data:-Bild muss erst dekodiert sein, bevor mouseup OCR startet.
  await page.waitForTimeout(50);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y);
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
    await page.addScriptTag({ content: ENGINE_SCRIPT });
    await page.addScriptTag({ content: OFFSCREEN_SCRIPT });
    await page.addScriptTag({ content: CONTENT_SCRIPT });

    await startSelection(
      page,
      SCALE_TEST_IMAGE,
      { x: 10, y: 20 },
      { x: 50, y: 60 }
    );
    await waitFor(
      page,
      () => window.__ocrEvents.some((event) => event[0] === "error"),
      "Der simulierte Initialisierungsfehler wurde nicht gemeldet."
    );
    const partialFailure = await page.evaluate(() => ({
      engWorker: window.__ocrWorkers.find((worker) => worker.language === "eng"),
      canvasCount: document.querySelectorAll("#ocr-overlay-canvas").length,
      cropDraw: window.__cropDraws[0],
    }));
    assert(partialFailure.engWorker, "Der erste Worker wurde nicht erzeugt.");
    assert(
      partialFailure.engWorker.terminateCalls === 1,
      "Der bei Teilfehler gestartete Worker wurde nicht genau einmal terminiert."
    );
    assert(partialFailure.canvasCount === 0, "Das Overlay blieb nach der Auswahl bestehen.");
    assert(
      JSON.stringify(partialFailure.cropDraw) === JSON.stringify([40, 60, 160, 120, 0, 0, 160, 120]),
      "Der Crop wurde nicht anhand der realen Screenshot-Aufloesung skaliert."
    );

    // Spaet aufloesender Worker nach schnellem Teilfehler darf nicht leaken.
    await page.evaluate(() => {
      window.__ocrMode = "late-worker-after-failure";
      window.__ocrWorkers = [];
      window.__ocrEvents = [];
    });
    await startSelection(page);
    await waitFor(
      page,
      () => window.__ocrEvents.some((event) => event[0] === "error"),
      "Der schnelle Fehler bei late-worker-after-failure wurde nicht gemeldet."
    );
    await waitFor(
      page,
      () => {
        const eng = window.__ocrWorkers.find((worker) => worker.language === "eng");
        return Boolean(eng && eng.terminateCalls === 1);
      },
      "Ein spaet aufloesender Worker nach Teilfehler wurde nicht terminiert."
    );

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
      window.__dispatchTabMessage({ action: "start_selection", imageUri });
    }, TEST_IMAGE);
    await page.waitForTimeout(50);
    assert(
      await page.locator("#ocr-overlay-canvas").count() === 0,
      "Eine zweite Auswahl wurde während der OCR zugelassen."
    );

    await page.keyboard.press("Escape");
    await waitFor(
      page,
      () => window.__ocrEvents.some((event) => event[1] === "Text recognition cancelled."),
      "Escape hat die laufende OCR nicht abgebrochen."
    );
    const cancelled = await page.evaluate(() => window.__ocrWorkers.map((worker) => worker.terminateCalls));
    assert(
      cancelled.length === 2 && cancelled.every((calls) => calls === 1),
      "Nicht alle Worker wurden beim Abbruch genau einmal terminiert."
    );

    await page.evaluate((imageUri) => {
      window.__dispatchTabMessage({ action: "start_selection", imageUri });
    }, TEST_IMAGE);
    await page.waitForSelector("#ocr-overlay-canvas", { timeout: 1000 });
    await page.keyboard.press("Escape");
    console.log("OK: OCR-Worker-Lebenszyklus ist gegen Teilfehler, spaete Worker und Abbruch abgesichert.");
  } finally {
    if (browser) await browser.close();
  }
})().catch((error) => {
  console.error("TEST FEHLER:", error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
