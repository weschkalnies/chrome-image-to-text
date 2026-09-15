/**
 * Vollstaendiger Playwright-Test fuer "Local Screen OCR".
 *
 * Der Test laedt ausschliesslich die erzeugte Test-Extension
 * (tests/deploy-autotest). Sie enthaelt die fuer einen programmgesteuerten
 * Test notwendige Host-Permission, waehrend die Produktiv-Extension bei
 * `activeTab` bleibt. Jeder fehlende Zwischenschritt oder ein abweichendes
 * OCR-Ergebnis beendet den Prozess mit einem Fehlerstatus.
 */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");
const WebSocket = require("ws");

const EXT = path.resolve(process.argv[2] || path.join(__dirname, "deploy-autotest"));
const CHROME = require("./_env.cjs").resolveChrome();
const TMP = path.join(__dirname, ".tmp-profile-test-" + Date.now());
const EXPECTED_TEXT = "HELLO WORLD 12345";
const TEST_PAGE = path.join(__dirname, "page.html");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function startTestServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.url !== "/") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(TEST_PAGE));
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const { port } = server.address();
      resolve({ server, origin: "http://127.0.0.1:" + port });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
}

async function waitForPort(port, getSpawnError, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const spawnError = getSpawnError();
    if (spawnError) throw new Error("Chrome konnte nicht gestartet werden: " + spawnError.message);
    try {
      return await fetchJson("http://127.0.0.1:" + port + "/json/version");
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error("Chrome-CDP-Port war nicht innerhalb von " + timeoutMs + " ms erreichbar.");
}

function cdpCall(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e6);
    const onMessage = (event) => {
      let data;
      try {
        data = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
      } catch (error) {
        return;
      }
      if (data.id !== id) return;
      ws.removeEventListener("message", onMessage);
      if (data.error) reject(new Error(method + ": " + JSON.stringify(data.error)));
      else resolve(data.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function waitForFinalToast(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    const text = await page.locator("#ocr-status-toast").textContent().catch(() => null);
    if (!text) continue;
    if (/Text in Zwischenablage kopiert!/i.test(text)) return text;
    if (/(Fehler|failed|Kein Text erkannt|nicht verfuegbar)/i.test(text)) {
      throw new Error("OCR meldete keinen Erfolg: " + text);
    }
  }
  throw new Error("Kein erfolgreicher OCR-Toast innerhalb von " + timeoutMs + " ms.");
}

const logs = [];
const log = (message) => {
  logs.push(message);
  console.log(message);
};

(async () => {
  const port = 9336;
  let browser;
  let server;
  let proc;
  let spawnError;
  let testOrigin;

  try {
    assert(fs.existsSync(path.join(EXT, "manifest.json")), "Test-Extension fehlt: " + EXT);

    proc = spawn(CHROME, [
      "--user-data-dir=" + TMP,
      "--remote-debugging-port=" + port,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ], { detached: false, stdio: "ignore" });
    proc.once("error", (error) => { spawnError = error; });

    const version = await waitForPort(port, () => spawnError, 15000);
    log("Chrome: " + version.Browser);

    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    const loaded = await cdpCall(ws, "Extensions.loadUnpacked", { path: EXT });
    ws.close();
    assert(loaded && loaded.id, "Chrome hat keine Extension-ID zurueckgegeben.");
    const extensionId = loaded.id;
    log("Test-Extension geladen: " + extensionId);

    ({ server, origin: testOrigin } = await startTestServer());
    browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
    const context = browser.contexts()[0];
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: testOrigin });

    const page = context.pages()[0] || await context.newPage();
    page.on("console", (message) => log("[page " + message.type() + "] " + message.text()));
    page.on("pageerror", (error) => log("[pageerror] " + error.message));
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(testOrigin, { waitUntil: "load", timeout: 10000 });
    await page.bringToFront();
    await page.waitForSelector(".stage", { timeout: 5000 });

    let serviceWorker = context.serviceWorkers().find((worker) => worker.url().includes(extensionId));
    if (!serviceWorker) {
      await context.waitForEvent("serviceworker", { timeout: 10000 });
      serviceWorker = context.serviceWorkers().find((worker) => worker.url().includes(extensionId));
    }
    assert(serviceWorker, "Service Worker der Test-Extension wurde nicht gefunden.");

    const trigger = await serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error("Kein aktiver Tab gefunden.");
      const imageUri = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
          "lib/tesseract.min.js",
          "lib/ocr/config.js",
          "lib/ocr/toast.js",
          "lib/ocr/logger.js",
          "lib/ocr/clipboard.js",
          "content.js",
        ],
      });
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
      await chrome.tabs.sendMessage(tab.id, { action: "start_selection", imageUri });
      return { imageLength: imageUri.length };
    });
    assert(trigger.imageLength > 0, "Screenshot fuer OCR wurde nicht erzeugt.");

    await page.waitForSelector("#ocr-overlay-canvas", { timeout: 8000 });
    const x1 = 256;
    const y1 = 252;
    const x2 = 1024;
    const y2 = 468;
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move(x2, y2, { steps: 12 });
    await page.mouse.up();
    log("Auswahl gezogen (" + x1 + "," + y1 + ")->(" + x2 + "," + y2 + ")");

    const toast = await waitForFinalToast(page, 45000);
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    assert(
      normalizeText(clipboardText) === EXPECTED_TEXT,
      "Unerwarteter OCR-Text: " + JSON.stringify(clipboardText)
    );
    log("E2E erfolgreich: " + toast + " | OCR=" + JSON.stringify(clipboardText));
  } catch (error) {
    console.error("E2E FEHLER:", error && error.stack ? error.stack : error);
    console.error("===== Relevante OCR-Logs =====");
    logs
      .filter((entry) => entry.includes("[OCR]") || entry.toLowerCase().includes("tesseract"))
      .forEach((entry) => console.error(entry));
    process.exitCode = 1;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        console.error("Browser-Cleanup fehlgeschlagen:", error.message);
        process.exitCode = 1;
      }
    }
    await closeServer(server);
    if (proc) {
      try {
        proc.kill();
      } catch (error) {
        // Prozess kann bereits beendet sein.
      }
    }
  }
})();
