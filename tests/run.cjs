/**
 * Playwright-Test-Harness fuer die "Local Screen OCR" Chrome-Extension.
 *
 * Startet Chrome (System-Installation) mit der geladenen Erweiterung aus
 * ../deploy, oeffnet eine Testseite mit Text, stoesst den OCR-Flow ueber den
 * Service-Worker an (entspricht dem Icon-Klick), zieht per Maus einen
 * Auswahlrahmen und sammelt alle Konsol-Meldungen ([OCR] ...).
 *
 * Ziel: die *echte* Fehlerursache sichtbar machen, statt nur "Fehler bei der
 * Texterkennung" zu sehen.
 */
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const EXT = path.join(__dirname, "..", "deploy");
const CHROME = require("./_env.cjs").resolveChrome();
const TMP = path.join(__dirname, ".tmp-profile");
const PAGE_URL = "file:///" + path.join(__dirname, "page.html").replace(/\\/g, "/");

const logs = [];
function pushLog(s) { logs.push(s); console.log(s); }

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });

  const ctx = await chromium.launchPersistentContext(TMP, {
    executablePath: CHROME,
    headless: false,
    viewport: { width: 1280, height: 720 },
    args: [
      "--disable-extensions-except=" + EXT,
      "--load-extension=" + EXT,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
    ],
  });

  const page = await ctx.newPage();
  page.on("console", (m) => pushLog(`[page ${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => pushLog(`[pageerror] ${e.message}`));

  // Service-Worker-Meldungen (Background der Erweiterung) abgreifen
  ctx.on("serviceworker", (sw) => {
    pushLog("[test] service worker registered: " + sw.url());
    sw.on("console", (m) => pushLog(`[sw ${m.type()}] ${m.text()}`));
    sw.on("consolemessage", (m) => pushLog(`[sw-msg] ${m.text()}`));
  });

  // Warten, bis der Service-Worker der Erweiterung da ist
  await ctx.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => {
    pushLog("[test] WARN: kein service worker event innerhalb 15s");
  });
  let sw = ctx.serviceWorkers()[0];
  pushLog("[test] serviceWorkers count: " + ctx.serviceWorkers().length);

  await page.goto(PAGE_URL, { waitUntil: "load" });
  await page.waitForTimeout(500);

  // Background-Logik direkt im Service-Worker anstossen (entspricht Icon-Klick)
  if (sw) {
    const trigger = await sw.evaluate(async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return { error: "kein aktiver Tab" };
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["lib/tesseract.min.js", "content.js"],
        });
        await chrome.scripting.insertCSS({
          target: { tabId: tab.id },
          files: ["content.css"],
        });
        await chrome.tabs.sendMessage(tab.id, { action: "start_selection", imageUri: dataUrl });
        return { ok: true, dataLen: dataUrl.length };
      } catch (e) {
        return { error: e.message, stack: String(e.stack) };
      }
    });
    pushLog("[test] trigger result: " + JSON.stringify(trigger));
  } else {
    pushLog("[test] FEHLER: kein Service-Worker -> Erweiterung nicht geladen");
  }

  // Warten, bis das Overlay-Canvas erscheint
  await page.waitForSelector("#ocr-overlay-canvas", { timeout: 8000 }).catch(() => {});
  const overlayCount = await page.locator("#ocr-overlay-canvas").count();
  pushLog("[test] overlay vorhanden: " + overlayCount);

  if (overlayCount > 0) {
    // Auswahlrahmen ueber den Textbereich ziehen
    const x1 = Math.round(1280 * 0.2), y1 = Math.round(720 * 0.35);
    const x2 = Math.round(1280 * 0.8), y2 = Math.round(720 * 0.65);
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(
        Math.round(x1 + ((x2 - x1) * i) / steps),
        Math.round(y1 + ((y2 - y1) * i) / steps)
      );
      await page.waitForTimeout(25);
    }
    await page.mouse.up();
    pushLog(`[test] Auswahlrahmen gezogen (${x1},${y1})->(${x2},${y2})`);

    // Auf Ende warten: Toast enthaelt "kopiert" / "Fehler" / "Kein" oder Timeout
    const deadline = Date.now() + 40000;
    let finalToast = "";
    while (Date.now() < deadline) {
      await page.waitForTimeout(1000);
      const t = await page.locator("#ocr-status-toast").textContent().catch(() => null);
      if (t && /(kopiert|Fehler|fehler|Kein|kein|nicht verf|abgeschlossen)/i.test(t)) {
        finalToast = t;
        break;
      }
    }
    pushLog("[test] finaler Toast: " + (finalToast || "(kein abschliessender Toast)"));
  }

  // Abschluss-Snapshot der Konsol-Meldungen mit [OCR]
  pushLog("===== [OCR]-Meldungen =====");
  logs.filter((l) => l.includes("[OCR]") || l.includes("Tesseract")).forEach(pushLog);

  await ctx.close();
})().catch((e) => {
  console.error("TEST HARNESS ERROR:", e);
  process.exit(1);
});
