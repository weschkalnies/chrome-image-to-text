/**
 * run3: Testet den OCR-KERN (Tesseract) mit den echten lokalen Dateien der
 * Extension, im echten Seitenkontext. Das ist genau die Stelle, an der beim
 * Nutzer "Fehler bei der Texterkennung" auftritt.
 *
 * Statt ueber die Extension (activeTab noetig) wird Tesseract direkt in die
 * Seite geladen (chrome-extension:// URLs sind web-accessible) und mit einem
 * Screenshot der Testseite gefuettert -> reproduziert content.js/recognizeText.
 */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

const EXT = path.join(__dirname, "..", "deploy");
const CHROME = require("./_env").resolveChrome();
const TMP = path.join(__dirname, ".tmp-profile-core-" + Date.now());
const PORT = 9337;
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
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}
async function waitForPort(ms) {
  const s = Date.now();
  while (Date.now() - s < ms) { try { return await fetchJson("http://127.0.0.1:" + PORT + "/json/version"); } catch (e) { await new Promise((r) => setTimeout(r, 300)); } }
  throw new Error("Port nicht erreichbar");
}
function cdpCall(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e6);
    const onMsg = (ev) => { let data; try { data = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()); } catch (e) { return; } if (data.id === id) { ws.removeEventListener("message", onMsg); data.error ? reject(new Error(method + ": " + JSON.stringify(data.error))) : resolve(data.result); } };
    ws.addEventListener("message", onMsg); ws.send(JSON.stringify({ id, method, params }));
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
    await new Promise((rr) => setTimeout(rr, 1500));

    const browser = await chromium.connectOverCDP("http://127.0.0.1:" + PORT);
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || (await ctx.newPage());
    page.on("console", (m) => pushLog(`[page ${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => pushLog(`[pageerror] ${e.message}`));

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(PAGE_URL, { waitUntil: "load", timeout: 10000 });
    await page.waitForTimeout(500);
    pushLog("Seite geladen.");

    // Screenshot des Textbereichs (= das, was captureVisibleTab+crop liefern wuerde)
    const clip = { x: 256, y: 252, width: 768, height: 216 };
    const buf = await page.screenshot({ clip, type: "png" });
    const dataUrl = "data:image/png;base64," + buf.toString("base64");
    pushLog("Screenshot dataURL erzeugt, Laenge: " + dataUrl.length);

    const base = "chrome-extension://" + extId + "/lib/";
    // Tesseract in die Seite laden
    await page.addScriptTag({ url: base + "tesseract.min.js" });
    await page.waitForFunction(() => typeof Tesseract !== "undefined" && !!Tesseract.createWorker, { timeout: 15000 })
      .catch(() => pushLog("WARN: Tesseract global nicht innerhalb 15s sichtbar"));
    const tVer = await page.evaluate(() => (typeof Tesseract !== "undefined" && Tesseract.version) ? Tesseract.version : "n/a").catch(() => "eval-fehler");
    pushLog("Tesseract-Version (Seite): " + tVer);

    // recognizeText reproduzieren (identisch zu content.js)
    pushLog("Starte OCR im Seitenkontext mit lokalen Dateien unter " + base);
    const result = await page.evaluate(async (params) => {
      const out = { logs: [], text: null, error: null };
      try {
        const worker = await Tesseract.createWorker(["eng", "deu"], 1, {
          workerPath: params.base + "worker.min.js",
          corePath: params.base,
          langPath: params.base,
          gzip: true,
          workerBlobURL: true,
          logger: (m) => out.logs.push((m.status || "?") + " " + (m.progress != null ? Math.round(m.progress * 100) + "%" : "")),
          errorHandler: (e) => out.logs.push("ERR:" + (e && e.message ? e.message : String(e))),
        });
        out.logs.push("worker ready");
        const ret = await worker.recognize(params.dataUrl);
        out.text = ret && ret.data ? ret.data.text : "";
        out.logs.push("recognized");
        try { await worker.terminate(); } catch (e) {}
      } catch (e) {
        out.error = (e && e.message) ? e.message : String(e);
        out.errorStack = e && e.stack ? String(e.stack) : null;
      }
      return out;
    }, { base, dataUrl });

    pushLog("===== OCR-Ergebnis =====");
    pushLog("error: " + (result.error || "(kein)"));
    if (result.errorStack) pushLog("stack: " + result.errorStack);
    pushLog("text: " + JSON.stringify(result.text));
    pushLog("----- Tesseract-Log -----");
    (result.logs || []).forEach((l) => pushLog("  " + l));
  } catch (e) {
    pushLog("HARNESS FEHLER: " + e.message);
  } finally {
    try { proc.kill(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 500));
    process.exit(0);
  }
})();
