/**
 * Local Screen OCR - Background Service Worker (Manifest V3)
 *
 * Verantwortlichkeiten:
 *  - Klick auf das Extension-Icon abfangen
 *  - Sicherheitsprüfung des aktiven Tabs (keine Browser-internen Seiten)
 *  - Screenshot des sichtbaren Fensters erstellen
 *  - Content-Skript + Tesseract race-sicher pro Tab injizieren
 *  - Bilddaten an das Content-Skript senden
 *
 * Sicherheitshinweis:
 *  - Wir verwenden ausschließlich `activeTab` + `scripting`. Es gibt KEINE
 *    dauerhaften Host-Permissions. Zugriff auf den Tab erfolgt nur nach
 *    explizitem Nutzer-Klick (transient activation).
 *  - `tab.url` ist nur dank `activeTab` verfügbar; wir prüfen daher
 *    defensiv auf undefined.
 */

// MV3-Service-Worker können jederzeit beendet werden. Ein Set mit zuvor
// injizierten Tabs wäre deshalb nach einem Neustart falsch. Diese Map lebt
// nur während einer laufenden Injektion und verhindert parallele Klicks.
const INJECTION_PROMISES = new Map();
const CONTENT_SCRIPT_FILES = [
  "lib/tesseract.min.js",
  "lib/ocr/config.js",
  "lib/ocr/toast.js",
  "lib/ocr/logger.js",
  "lib/ocr/clipboard.js",
  "lib/ui/result.js",
  "content.js",
];

async function isOcrContentScriptReady(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: "ocr_ping" });
    return response && response.ready === true;
  } catch (error) {
    // Bei einer frischen Seite gibt es noch keinen Empfänger. Das ist der
    // erwartete Fall vor der ersten Injektion, kein Nutzerfehler.
    return false;
  }
}

async function injectOcrContentScript(tabId) {
  console.log("[OCR] Injiziere tesseract.min.js + lib/ocr/* + content.js in Tab", tabId);
  await Promise.all([
    chrome.scripting.executeScript({
      target: { tabId },
      files: CONTENT_SCRIPT_FILES,
    }),
    chrome.scripting.insertCSS({
      target: { tabId },
      files: ["content.css"],
    }),
  ]);

  if (!await isOcrContentScriptReady(tabId)) {
    throw new Error("Content-Skript antwortet nach der Injektion nicht.");
  }
  console.log("[OCR] Injection abgeschlossen");
}

/**
 * Stellt sicher, dass genau eine Injektion pro Tab gleichzeitig stattfindet.
 * Nach einem Service-Worker-Neustart erkennt der Ping ein bereits lebendes
 * Content-Skript im Tab, ohne einen nicht persistenten Cache zu benötigen.
 */
async function ensureOcrContentScript(tabId) {
  const inFlight = INJECTION_PROMISES.get(tabId);
  if (inFlight) {
    console.log("[OCR] Warte auf laufende Injection in Tab", tabId);
    return inFlight;
  }

  const operation = (async () => {
    if (await isOcrContentScriptReady(tabId)) {
      console.log("[OCR] Content-Skript antwortet bereits, ueberspringe Injection");
      return;
    }
    await injectOcrContentScript(tabId);
  })();
  INJECTION_PROMISES.set(tabId, operation);

  try {
    await operation;
  } finally {
    // Nur den eigenen Eintrag löschen; eine spätere Operation darf nicht
    // versehentlich entfernt werden.
    if (INJECTION_PROMISES.get(tabId) === operation) {
      INJECTION_PROMISES.delete(tabId);
    }
  }
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "file:"]);

/**
 * Prüft, ob eine URL für die Skriptinjektion geeignet ist.
 * Erlaubt ausschließlich http:, https: und file: und blockiert Web-Store-Seiten
 * sowie Browser-interne Schemata (chrome://, view-source:, about:, etc.).
 *
 * @param {string|undefined} url
 * @returns {boolean} true, wenn die URL erlaubt ist
 */
function isInjectableUrl(url) {
  if (!url || typeof url !== "string") {
    // Ohne explicit host-permission ist url evtl. undefined -> sicherheitshalber ablehnen
    return false;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (_error) {
    return false;
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "chromewebstore.google.com") {
    return false;
  }
  if (
    hostname === "chrome.google.com" &&
    (parsed.pathname === "/webstore" || parsed.pathname.startsWith("/webstore/"))
  ) {
    return false;
  }

  return true;
}

/**
 * Setzt oder löscht das Aktions-Badge für den angegebenen Tab.
 *
 * @param {number} tabId
 * @param {string} text
 */
async function setActionBadge(tabId, text) {
  if (!chrome.action || typeof chrome.action.setBadgeText !== "function") {
    return;
  }
  try {
    if (text && typeof chrome.action.setBadgeBackgroundColor === "function") {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#d93025" });
    }
    await chrome.action.setBadgeText({ tabId, text });
  } catch (_error) {
    // Tab existiert evtl. nicht mehr; kein kritischer Fehler.
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) {
    console.error("[OCR] Kein gültiger Tab.");
    return;
  }

  if (!isInjectableUrl(tab.url)) {
    console.error("[OCR] Auf dieser Seite kann die Erweiterung nicht ausgeführt werden.");
    await setActionBadge(tab.id, "!");
    return;
  }

  try {
    await setActionBadge(tab.id, "");
    console.log("[OCR] Icon-Klick auf Tab", tab.id, tab.url);

    // 1 & 2. Screenshot des aktuell sichtbaren Fensters (PNG, verlustfrei für OCR)
    // und Content-Script-Injektion parallel ausführen (Injektion verändert kein sichtbares DOM).
    const [dataUrl] = await Promise.all([
      chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "png",
      }),
      ensureOcrContentScript(tab.id),
    ]);

    if (!dataUrl || !dataUrl.startsWith("data:image/png")) {
      throw new Error("captureVisibleTab lieferte keine gueltige PNG-dataURL.");
    }
    console.log("[OCR] Screenshot erstellt, Laenge", dataUrl.length);

    // 3. Bilddaten an das Content-Skript übermitteln
    await chrome.tabs.sendMessage(tab.id, {
      action: "start_selection",
      imageUri: dataUrl,
    });
    console.log("[OCR] start_selection gesendet an Tab", tab.id);
  } catch (error) {
    await setActionBadge(tab.id, "!");
    console.error(
      "[OCR] Fehler beim Starten der OCR-Auswahl:",
      error && error.message ? error.message : error,
      error
    );
  }
});
