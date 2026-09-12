/**
 * Vollstaendiger Playwright-Test fuer "Local Screen OCR" (Chrome 152 + CDP).
 *
 * 1. Chrome direkt starten (fresh profile, --remote-debugging-port)
 * 2. Extension ueber CDP "Extensions.loadUnpacked" laden
 * 3. Playwright per connectOverCDP ankoppeln
 * 4. Testseite mit Text oeffnen, Konsol-Meldungen abgreifen
 * 5. Background-Logik im Service-Worker anstossen (= Icon-Klick)
 * 6. Overlay per Maus auswaehlen, OCR-Ergebnis & Fehler einsammeln
 */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

const EXT = process.argv[2] || path.join(__dirname, "..", "deploy");
const CHROME = require("./_env.cjs").resolveChrome();
const TMP = path.join(__dirname, ".tmp-profile-test-" + Date.now());
const PORT = 9336;
const PAGE_URL = "file:///" + path.join(__dirname, "page.html").replace(/\\/g, "/");

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
const proc = spawn(CHROME, [
  "--user-data-dir=" + TMP,
  "--remote-debugging-port=" + PORT,
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
], { detached: false, stdio: "ignore" });

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}
async function waitForPort(ms) {
  const s = Date.now();
  while (Date.now() - s < ms) {
    try { return await fetchJson("http://127.0.0.1:" + PORT + "/json/version"); } catch (e) { await new Promise((r) => setTimeout(r, 300)); }
  }
  throw new Error("Port nicht erreichbar");
}
function cdpCall(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e6);
    const onMsg = (ev) => {
      let data; try { data = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()); } catch (e) { return; }
      if (data.id === id) { ws.removeEventListener("message", onMsg); data.error ? reject(new Error(method + ": " + JSON.stringify(data.error))) : resolve(data.result); }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const logs = [];
const pushLog = (s) => { logs.push(s); console.log(s); };


(async () => {
  try {
    const ver = await waitForPort(15000);
    pushLog("Chrome: " + ver.Browser);

    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const r = await cdpCall(ws, "Extensions.loadUnpacked", { path: EXT });
    const extId = r.id;
    pushLog("Extension geladen, ID: " + extId);
    ws.close();
    await new Promise((rr) => setTimeout(rr, 2000));

    const browser = await chromium.connectOverCDP("http://127.0.0.1:" + PORT);
    const ctx = browser.contexts()[0];
    pushLog("Playwright verbunden. pages=" + ctx.pages().length + " sw=" + ctx.serviceWorkers().length);

    const page = ctx.pages()[0] || (await ctx.newPage());
    page.on("console", (m) => pushLog(`[page ${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => pushLog(`[pageerror] ${e.message}`));

    let sw = ctx.serviceWorkers().find((w) => w.url().includes(extId)) || null;
    if (!sw) {
      pushLog("SW noch nicht da, warte auf serviceworker-Event ...");
      await ctx.waitForEvent("serviceworker", { timeout: 10000 }).catch(() => {});
      sw = ctx.serviceWorkers().find((w) => w.url().includes(extId)) || ctx.serviceWorkers()[0];
    }
    if (sw) { pushLog("Service-Worker: " + sw.url()); sw.on("console", (m) => pushLog(`[sw ${m.type()}] ${m.text()}`)); }
    else pushLog("FEHLER: Service-Worker der Extension nicht gefunden");

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(PAGE_URL, { waitUntil: "load", timeout: 10000 });
    await page.bringToFront();
    // deviceScaleFactor auf 2 setzen, damit window.devicePixelRatio mit
    // captureVisibleTab (OS-Display 2x) uebereinstimmt - sonst croppt
    // content.js im falschen (leeren) Bereich.
    const cdpPage = await ctx.newCDPSession(page);
    await cdpPage.send("Emulation.setDeviceMetricsOverride", {
      width: 1280, height: 720, deviceScaleFactor: 2, mobile: false,
    });
    await page.waitForSelector(".stage", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
    pushLog("Seite geladen: " + PAGE_URL);

    if (sw) {
      const trigger = await sw.evaluate(async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab) return { error: "kein aktiver Tab" };
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [
            "lib/tesseract.min.js",
            "lib/ocr/config.js",
            "lib/ocr/toast.js",
            "lib/ocr/logger.js",
            "lib/ocr/clipboard.js",
            "content.js",
          ] });
          await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
          await chrome.tabs.sendMessage(tab.id, { action: "start_selection", imageUri: dataUrl });
          return { ok: true, dataLen: dataUrl.length };
        } catch (e) { return { error: e.message, stack: String(e.stack) }; }
      });
      pushLog("trigger result: " + JSON.stringify(trigger));
    }

    await page.waitForSelector("#ocr-overlay-canvas", { timeout: 8000 }).catch(() => {});
    const overlay = await page.locator("#ocr-overlay-canvas").count();
    pushLog("overlay vorhanden: " + overlay);

    if (overlay > 0) {
      const x1 = 256, y1 = 252, x2 = 1024, y2 = 468;
      await page.mouse.move(x1, y1);
      await page.mouse.down();
      for (let i = 1; i <= 12; i++) {
        await page.mouse.move(Math.round(x1 + ((x2 - x1) * i) / 12), Math.round(y1 + ((y2 - y1) * i) / 12));
        await page.waitForTimeout(25);
      }
      await page.mouse.up();
      pushLog(`Auswahl gezogen (${x1},${y1})->(${x2},${y2})`);

      const deadline = Date.now() + 45000;
      let finalToast = "";
      while (Date.now() < deadline) {
        await page.waitForTimeout(1000);
        const t = await page.locator("#ocr-status-toast").textContent().catch(() => null);
        if (t && /(kopiert|Fehler|fehler|Kein|kein|nicht verf)/i.test(t)) { finalToast = t; break; }
      }
      pushLog("finaler Toast: " + (finalToast || "(kein abschliessender Toast)"));
    }

    pushLog("===== [OCR]-Meldungen =====");
    logs.filter((l) => l.includes("[OCR]") || l.toLowerCase().includes("tesseract")).forEach(pushLog);
  } catch (e) {
    pushLog("HARNESS FEHLER: " + e.message);
  } finally {
    try { proc.kill(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 500));
    process.exit(0);
  }
})();