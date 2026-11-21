/**
 * Local Screen OCR - Background Service Worker (Manifest V3)
 *
 * Verantwortlichkeiten:
 *  - Klick auf das Extension-Icon abfangen
 *  - Sicherheitsprüfung des aktiven Tabs (keine Browser-internen Seiten)
 *  - Screenshot des sichtbaren Fensters erstellen
 *  - Content-Skript race-sicher pro Tab injizieren
 *  - Bilddaten an das Content-Skript senden
 *  - OCR-Anfragen sicher an das isolierte MV3 Offscreen Document routen
 *  - Einstellungen (chrome.storage.local) an die OCR weitergeben:
 *    Sprachen, "sofort kopieren", optionaler Verlauf (chrome.storage.session)
 *
 * Sicherheitshinweis:
 *  - Wir verwenden ausschließlich `activeTab`, `scripting`, `offscreen` und
 *    `storage` (nur Einstellungen und optionaler Sitzungsverlauf).
 *    Es gibt KEINE dauerhaften Host-Permissions. Zugriff auf den Tab erfolgt
 *    nur nach explizitem Nutzer-Klick (transient activation).
 *  - `tab.url` ist nur dank `activeTab` verfügbar; wir prüfen daher
 *    defensiv auf undefined.
 */

importScripts("lib/ocr/languages.js", "lib/ocr/settings.js");

// MV3-Service-Worker können jederzeit beendet werden. Ein Set mit zuvor
// injizierten Tabs wäre deshalb nach einem Neustart falsch. Diese Map lebt
// nur während einer laufenden Injektion und verhindert parallele Klicks.
const INJECTION_PROMISES = new Map();
const CONTENT_SCRIPT_FILES = [
  "lib/ocr/config.js",
  "lib/ocr/i18n.js",
  "lib/ocr/languages.js",
  "lib/ocr/toast.js",
  "lib/ocr/logger.js",
  "lib/ocr/clipboard.js",
  "lib/ui/result.js",
  "content.js",
];

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const OFFSCREEN_IDLE_CLOSE_MS = 15000;
const ACTIVE_OCR_REQUESTS = new Map();
let OFFSCREEN_CREATE_PROMISE = null;
let OFFSCREEN_CLOSE_PROMISE = null;
let OFFSCREEN_IDLE_TIMER = null;

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
  console.log("[OCR] Injiziere lib/ocr/* + content.js in Tab", tabId);
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
 * Liefert einen lokalisierten Text aus _locales oder den Fallback.
 *
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function getActionMessage(key, fallback) {
  try {
    if (chrome.i18n && typeof chrome.i18n.getMessage === "function") {
      const message = chrome.i18n.getMessage(key);
      if (message) {
        return message;
      }
    }
  } catch (_error) {
    // i18n nicht verfügbar (z. B. in Tests) -> Fallback.
  }
  return fallback;
}

/**
 * Setzt oder löscht das Aktions-Badge für den angegebenen Tab und passt den
 * Tooltip an, damit Nutzer beim Überfahren des Icons den Grund sehen.
 * Ohne `title` wird der Standard-Tooltip wiederhergestellt.
 * Chrome setzt tab-spezifische Badges/Titel bei Navigation selbst zurück.
 *
 * @param {number} tabId
 * @param {string} text
 * @param {string} [title]
 */
async function setActionBadge(tabId, text, title) {
  if (!chrome.action || typeof chrome.action.setBadgeText !== "function") {
    return;
  }
  try {
    if (text && typeof chrome.action.setBadgeBackgroundColor === "function") {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#d93025" });
    }
    await chrome.action.setBadgeText({ tabId, text });
    if (typeof chrome.action.setTitle === "function") {
      await chrome.action.setTitle({
        tabId,
        title: title || getActionMessage("actionTitle", "Start Screen OCR"),
      });
    }
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
    await setActionBadge(
      tab.id,
      "!",
      getActionMessage(
        "actionBlockedTitle",
        "Not available on this page: Chrome does not allow extensions on the Chrome Web Store or browser-internal pages."
      )
    );
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
    await setActionBadge(
      tab.id,
      "!",
      getActionMessage(
        "actionErrorTitle",
        "Could not start OCR on this page. Reload the page and try again."
      )
    );
    console.error(
      "[OCR] Fehler beim Starten der OCR-Auswahl:",
      error && error.message ? error.message : error,
      error
    );
  }
});

/* -------------------------------------------------------------------------
   MV3 Offscreen Document Lifecycle & OCR Message Routing
   ----------------------------------------------------------------------- */

function clearOffscreenIdleTimer() {
  if (OFFSCREEN_IDLE_TIMER !== null) {
    clearTimeout(OFFSCREEN_IDLE_TIMER);
    OFFSCREEN_IDLE_TIMER = null;
  }
}

async function hasOffscreenDocument() {
  if (!chrome.runtime || typeof chrome.runtime.getContexts !== "function") {
    return false;
  }
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl],
  });
  return Array.isArray(contexts) && contexts.length > 0;
}

async function waitForOffscreenReady(maxAttempts = 10, delayMs = 25) {
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await chrome.runtime.sendMessage({
        target: "offscreen",
        action: "offscreen_ping",
      });
      if (response && response.ready === true) {
        if (response.tesseractLoaded === false) {
          throw new Error("Tesseract.js konnte im Offscreen-Dokument nicht geladen werden.");
        }
        return;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError || new Error("Offscreen-Dokument antwortet nicht.");
}

async function ensureOffscreenDocument() {
  clearOffscreenIdleTimer();
  while (OFFSCREEN_CLOSE_PROMISE) {
    await OFFSCREEN_CLOSE_PROMISE.catch(() => {});
  }
  if (OFFSCREEN_CREATE_PROMISE) {
    return OFFSCREEN_CREATE_PROMISE;
  }

  const operation = (async () => {
    if (!(await hasOffscreenDocument())) {
      const reason =
        (chrome.offscreen &&
          chrome.offscreen.Reason &&
          chrome.offscreen.Reason.WORKERS) ||
        "WORKERS";
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: [reason],
        justification:
          "Run local Tesseract.js OCR Web Workers isolated from webpage Content Security Policies.",
      });
    }
    await waitForOffscreenReady();
  })();
  OFFSCREEN_CREATE_PROMISE = operation;

  try {
    await operation;
  } finally {
    if (OFFSCREEN_CREATE_PROMISE === operation) {
      OFFSCREEN_CREATE_PROMISE = null;
    }
  }
}

async function closeOffscreenDocumentIfIdle() {
  clearOffscreenIdleTimer();
  if (ACTIVE_OCR_REQUESTS.size > 0 || OFFSCREEN_CREATE_PROMISE) {
    return;
  }
  if (OFFSCREEN_CLOSE_PROMISE) {
    return OFFSCREEN_CLOSE_PROMISE;
  }

  const operation = (async () => {
    if (!(await hasOffscreenDocument())) {
      return;
    }
    if (ACTIVE_OCR_REQUESTS.size > 0 || OFFSCREEN_CREATE_PROMISE) {
      return;
    }
    await chrome.offscreen.closeDocument();
  })();
  OFFSCREEN_CLOSE_PROMISE = operation;

  try {
    await operation;
  } catch (error) {
    console.error("[OCR] Schliessen des Offscreen-Dokuments fehlgeschlagen:", error);
  } finally {
    if (OFFSCREEN_CLOSE_PROMISE === operation) {
      OFFSCREEN_CLOSE_PROMISE = null;
    }
  }
}

function scheduleOffscreenIdleClose() {
  clearOffscreenIdleTimer();
  if (ACTIVE_OCR_REQUESTS.size > 0) {
    return;
  }
  OFFSCREEN_IDLE_TIMER = setTimeout(() => {
    OFFSCREEN_IDLE_TIMER = null;
    void closeOffscreenDocumentIfIdle();
  }, OFFSCREEN_IDLE_CLOSE_MS);
}

function serializeOcrError(error) {
  return {
    name: (error && error.name) || "Error",
    message:
      error && typeof error.message === "string" && error.message.trim()
        ? error.message
        : String(error || "Unknown error"),
  };
}

function createCancelledResponse() {
  return {
    ok: false,
    aborted: true,
    error: {
      name: "OcrAbortError",
      message: "Text recognition was cancelled.",
    },
  };
}

/**
 * Liest die Nutzereinstellungen.
 * - languages: 1-2 Tesseract-Codes; ohne (gültige) Auswahl Browsersprache + Englisch
 * - autoCopy / historyEnabled: Booleans, Default aus Ocr.Settings.DEFAULTS
 */
async function readSettings() {
  const { Languages, Settings } = self.Ocr;
  const KEYS = Settings.KEYS;
  let stored = {};
  try {
    if (chrome.storage && chrome.storage.local) {
      stored =
        (await chrome.storage.local.get([KEYS.languages, KEYS.autoCopy, KEYS.historyEnabled])) || {};
    }
  } catch (error) {
    console.error("[OCR] Einstellungen konnten nicht gelesen werden:", error);
  }
  const uiLanguage =
    (chrome.i18n && typeof chrome.i18n.getUILanguage === "function"
      ? chrome.i18n.getUILanguage()
      : null) || (self.navigator && self.navigator.language);
  return {
    languages: Languages.normalize(stored[KEYS.languages]) || Languages.defaults(uiLanguage),
    autoCopy:
      typeof stored[KEYS.autoCopy] === "boolean"
        ? stored[KEYS.autoCopy]
        : Settings.DEFAULTS.autoCopy,
    historyEnabled:
      typeof stored[KEYS.historyEnabled] === "boolean"
        ? stored[KEYS.historyEnabled]
        : Settings.DEFAULTS.historyEnabled,
  };
}

// Serialisiert Verlaufs-Schreibzugriffe, damit parallele OCR-Läufe sich
// nicht gegenseitig Einträge überschreiben.
let HISTORY_WRITE_CHAIN = Promise.resolve();
let REVIEW_WRITE_CHAIN = Promise.resolve();

/**
 * Zählt eine erfolgreiche OCR-Erkennung (mit erkanntem Text) und gibt true
 * zurück, sobald der Schwellenwert für den dezenten Bewertungs-Hinweis
 * erreicht ist und der Hinweis noch nicht ausgeblendet wurde.
 */
function recordSuccessfulOcrUsage() {
  const { Settings } = self.Ocr;
  const KEYS = Settings.KEYS;
  if (
    !chrome.storage ||
    !chrome.storage.local ||
    typeof chrome.storage.local.get !== "function" ||
    typeof chrome.storage.local.set !== "function"
  ) {
    return Promise.resolve(false);
  }
  const operation = REVIEW_WRITE_CHAIN.then(async () => {
    const data =
      (await chrome.storage.local.get([KEYS.usageCount, KEYS.reviewDismissed])) || {};
    if (data[KEYS.reviewDismissed] === true) {
      return false;
    }
    const prev =
      Number.isInteger(data[KEYS.usageCount]) && data[KEYS.usageCount] >= 0
        ? data[KEYS.usageCount]
        : 0;
    const next = prev + 1;
    await chrome.storage.local.set({ [KEYS.usageCount]: next });
    return next >= Settings.REVIEW.threshold;
  }).catch((error) => {
    console.error("[OCR] Nutzungszähler konnte nicht gespeichert werden:", error);
    return false;
  });
  REVIEW_WRITE_CHAIN = operation.then(() => undefined);
  return operation;
}

/** Blendet den Bewertungs-Hinweis dauerhaft aus. */
function dismissReviewPrompt() {
  const { Settings } = self.Ocr;
  const KEYS = Settings.KEYS;
  if (
    !chrome.storage ||
    !chrome.storage.local ||
    typeof chrome.storage.local.set !== "function"
  ) {
    return Promise.resolve();
  }
  const operation = REVIEW_WRITE_CHAIN.then(async () => {
    await chrome.storage.local.set({ [KEYS.reviewDismissed]: true });
  }).catch((error) => {
    console.error("[OCR] Review-Status konnte nicht gespeichert werden:", error);
  });
  REVIEW_WRITE_CHAIN = operation.then(() => undefined);
  return operation;
}

/** Hängt ein Ergebnis vorne an den Sitzungsverlauf an (max. HISTORY_MAX). */
function addHistoryEntry(result) {
  const { Settings } = self.Ocr;
  const text = result && typeof result.text === "string" ? result.text.trim() : "";
  if (!text || !chrome.storage || !chrome.storage.session) {
    return HISTORY_WRITE_CHAIN;
  }
  const entry = {
    text,
    languageCode: result.languageCode || null,
    confidence: Math.round(Number(result.confidence) || 0),
    time: Date.now(),
  };
  HISTORY_WRITE_CHAIN = HISTORY_WRITE_CHAIN.then(async () => {
    const data = await chrome.storage.session.get(Settings.HISTORY_KEY);
    const list = Array.isArray(data && data[Settings.HISTORY_KEY])
      ? data[Settings.HISTORY_KEY]
      : [];
    list.unshift(entry);
    await chrome.storage.session.set({
      [Settings.HISTORY_KEY]: list.slice(0, Settings.HISTORY_MAX),
    });
  }).catch((error) => {
    console.error("[OCR] Verlauf konnte nicht gespeichert werden:", error);
  });
  return HISTORY_WRITE_CHAIN;
}

async function handleRunOcrRequest(message, sender) {
  if (!sender || !sender.tab || typeof sender.tab.id !== "number") {
    return {
      ok: false,
      error: { name: "Error", message: "Missing sender tab for OCR request." },
    };
  }
  const requestId = message.requestId;
  if (typeof requestId !== "string" || !requestId) {
    return {
      ok: false,
      error: { name: "Error", message: "Missing OCR requestId." },
    };
  }
  if (
    typeof message.dataUrl !== "string" ||
    !message.dataUrl.startsWith("data:image/")
  ) {
    return {
      ok: false,
      error: { name: "Error", message: "Invalid image data received." },
    };
  }
  if (ACTIVE_OCR_REQUESTS.has(requestId)) {
    return {
      ok: false,
      error: { name: "Error", message: "Duplicate OCR requestId." },
    };
  }

  const entry = { tabId: sender.tab.id, cancelled: false };
  ACTIVE_OCR_REQUESTS.set(requestId, entry);
  clearOffscreenIdleTimer();

  try {
    const [settings] = await Promise.all([
      readSettings(),
      ensureOffscreenDocument(),
    ]);
    const languages = settings.languages;
    if (entry.cancelled) {
      return createCancelledResponse();
    }
    const response = await chrome.runtime.sendMessage({
      target: "offscreen",
      action: "offscreen_run_ocr",
      requestId,
      dataUrl: message.dataUrl,
      languages,
    });
    if (!response || typeof response !== "object") {
      if (entry.cancelled) {
        return createCancelledResponse();
      }
      return {
        ok: false,
        error: { name: "Error", message: "Offscreen OCR document did not respond." },
      };
    }
    const hasText = Boolean(
      response.ok &&
      response.result &&
      typeof response.result.text === "string" &&
      response.result.text.trim()
    );
    if (hasText && settings.historyEnabled) {
      await addHistoryEntry(response.result);
    }
    const showReviewPrompt = hasText ? await recordSuccessfulOcrUsage() : false;
    return { ...response, languages, autoCopy: settings.autoCopy, showReviewPrompt };
  } catch (error) {
    if (entry.cancelled) {
      return createCancelledResponse();
    }
    return {
      ok: false,
      error: serializeOcrError(error),
    };
  } finally {
    if (ACTIVE_OCR_REQUESTS.get(requestId) === entry) {
      ACTIVE_OCR_REQUESTS.delete(requestId);
    }
    if (ACTIVE_OCR_REQUESTS.size === 0) {
      scheduleOffscreenIdleClose();
    }
  }
}

async function cancelOcrRequest(requestId, requesterTabId) {
  if (typeof requestId !== "string" || !requestId) {
    return { ok: false, cancelled: false };
  }
  const entry = ACTIVE_OCR_REQUESTS.get(requestId);
  if (
    typeof requesterTabId === "number" &&
    entry &&
    entry.tabId !== requesterTabId
  ) {
    return { ok: false, cancelled: false };
  }
  if (entry) {
    entry.cancelled = true;
  }

  try {
    if (await hasOffscreenDocument()) {
      const response = await chrome.runtime.sendMessage({
        target: "offscreen",
        action: "offscreen_cancel_ocr",
        requestId,
      });
      return {
        ok: true,
        cancelled: Boolean(
          (entry && entry.cancelled) || (response && response.cancelled)
        ),
      };
    }
  } catch (_error) {
    // Offscreen-Dokument existiert evtl. nicht mehr.
  }

  return { ok: true, cancelled: Boolean(entry) };
}

async function cancelTabOcrRequests(tabId) {
  const requestIds = [];
  for (const [requestId, entry] of ACTIVE_OCR_REQUESTS.entries()) {
    if (entry.tabId === tabId) {
      requestIds.push(requestId);
    }
  }
  await Promise.all(
    requestIds.map((requestId) => cancelOcrRequest(requestId, tabId))
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "background") {
    return false;
  }

  if (message.action === "run_ocr") {
    void handleRunOcrRequest(message, sender).then(sendResponse, (error) => {
      sendResponse({ ok: false, error: serializeOcrError(error) });
    });
    return true;
  }

  if (message.action === "cancel_ocr") {
    const requesterTabId =
      sender && sender.tab && typeof sender.tab.id === "number"
        ? sender.tab.id
        : undefined;
    void cancelOcrRequest(message.requestId, requesterTabId).then(
      sendResponse,
      (error) => {
        sendResponse({
          ok: false,
          cancelled: false,
          error: serializeOcrError(error),
        });
      }
    );
    return true;
  }

  if (message.action === "open_options") {
    void Promise.resolve()
      .then(() => chrome.runtime.openOptionsPage())
      .then(
        () => sendResponse({ ok: true }),
        (error) => sendResponse({ ok: false, error: serializeOcrError(error) })
      );
    return true;
  }

  if (message.action === "open_review") {
    void Promise.resolve()
      .then(async () => {
        await dismissReviewPrompt();
        await chrome.tabs.create({ url: self.Ocr.Settings.REVIEW.url });
      })
      .then(
        () => sendResponse({ ok: true }),
        (error) => sendResponse({ ok: false, error: serializeOcrError(error) })
      );
    return true;
  }

  if (message.action === "dismiss_review") {
    void dismissReviewPrompt().then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: serializeOcrError(error) })
    );
    return true;
  }

  return false;
});

if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void cancelTabOcrRequests(tabId);
  });
}

if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo && changeInfo.status === "loading") {
      void cancelTabOcrRequests(tabId);
    }
  });
}
