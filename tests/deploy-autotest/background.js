/**
 * Local Screen OCR - Background Service Worker (Manifest V3)
 *
 * Verantwortlichkeiten:
 *  - Klick auf das Extension-Icon abfangen
 *  - Sicherheitsprüfung des aktiven Tabs (keine Browser-internen Seiten)
 *  - Screenshot des sichtbaren Fensters erstellen
 *  - Content-Skript + Tesseract genau einmal pro Tab injizieren
 *  - Bilddaten an das Content-Skript senden
 *
 * Sicherheitshinweis:
 *  - Wir verwenden ausschließlich `activeTab` + `scripting`. Es gibt KEINE
 *    dauerhaften Host-Permissions. Zugriff auf den Tab erfolgt nur nach
 *    explizitem Nutzer-Klick (transient activation).
 *  - `tab.url` ist nur dank `activeTab` verfügbar; wir prüfen daher
 *    defensiv auf undefined.
 */

const INJECTED_TABS = new Set();

// Tab-Cleanup zentral (top-level): Service Worker und Listener-Registrierung
// sind in MV3 ephemeral - daher niemals Listener innerhalb eines Handlers
// registrieren (wuerde bei jedem Klick einen neuen Listener anlegen).
chrome.tabs.onRemoved.addListener((tabId) => {
  INJECTED_TABS.delete(tabId);
});

// Bei Seitennavigation (reload/link) verlieren bereits injizierte Skripte
// ihre Wirkung, weil der Seiten-Kontext (inkl. window.__ocrInitialized-Guard)
// neu aufgebaut wird -> Merker verwerfen, damit neu injiziert werden kann.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    INJECTED_TABS.delete(tabId);
  }
});

/**
 * Prüft, ob eine URL für die Skriptinjektion geeignet ist.
 * Browser-interne Seiten (chrome://, edge://, chrome-extension://, about:)
 * dürfen nicht modifiziert werden.
 *
 * @param {string|undefined} url
 * @returns {boolean} true, wenn die URL erlaubt ist
 */
function isInjectableUrl(url) {
  if (!url || typeof url !== "string") {
    // Ohne explicit host-permission ist url evtl. undefined -> sicherheitshalber ablehnen
    return false;
  }
  const blocked = ["chrome://", "chrome-extension://", "edge://", "about:", "https://chrome.google.com/webstore"];
  return !blocked.some((prefix) => url.startsWith(prefix));
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) {
    console.error("[OCR] Kein gültiger Tab.");
    return;
  }

  if (!isInjectableUrl(tab.url)) {
    console.error("[OCR] Auf dieser Seite kann die Erweiterung nicht ausgeführt werden.");
    return;
  }

  try {
    console.log("[OCR] Icon-Klick auf Tab", tab.id, tab.url);

    // 1. Screenshot des aktuell sichtbaren Fensters (PNG, verlustfrei für OCR)
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });

    if (!dataUrl || !dataUrl.startsWith("data:image/png")) {
      throw new Error("captureVisibleTab lieferte keine gueltige PNG-dataURL.");
    }
    console.log("[OCR] Screenshot erstellt, Laenge", dataUrl.length);

    // 2. Skripte genau einmal pro Tab injizieren (verhindert Duplikate & Race-Conditions)
    //    Reihenfolge ist relevant: tesseract.min.js (global Tesseract),
    //    dann die Helper-Module (Namespace self.Ocr), dann content.js,
    //    das auf beides zugreift.
    if (!INJECTED_TABS.has(tab.id)) {
      console.log("[OCR] Injiziere tesseract.min.js + lib/ocr/* + content.js in Tab", tab.id);
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
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id },
        files: ["content.css"],
      });
      INJECTED_TABS.add(tab.id);
      console.log("[OCR] Injection abgeschlossen");
    } else {
      console.log("[OCR] Tab bereits injiziert, ueberspringe Injection");
    }

    // 3. Bilddaten an das Content-Skript übermitteln
    await chrome.tabs.sendMessage(tab.id, {
      action: "start_selection",
      imageUri: dataUrl,
    });
    console.log("[OCR] start_selection gesendet an Tab", tab.id);
  } catch (error) {
    console.error(
      "[OCR] Fehler beim Starten der OCR-Auswahl:",
      error && error.message ? error.message : error,
      error
    );
  }
});
