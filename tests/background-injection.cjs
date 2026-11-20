/**
 * Regressionstest fuer die race-sichere Content-Script-Injektion und das
 * MV3-Offscreen-Lifecycle-/Message-Routing in background.js.
 *
 * Simuliert die Chrome-APIs ohne Browser und prueft:
 * - zwei gleichzeitige Icon-Klicks teilen genau eine Injektion (ohne tesseract.min.js);
 * - nach einem MV3-Service-Worker-Neustart erkennt ocr_ping das noch lebende
 *   Content-Skript, sodass es nicht erneut injiziert wird;
 * - URL-Whitelist und Aktions-Badge-Feedback;
 * - parallele run_ocr-Anfragen teilen genau ein offscreen.createDocument();
 * - vorhandenes Offscreen-Dokument nach Worker-Neustart wird wiederverwendet;
 * - Tab-Pruefung, In-Flight-Abbruch und Tab-Cleanup (onRemoved / onUpdated);
 * - Idle-Timeout schliesst das Offscreen-Dokument erst, wenn keine OCR mehr laeuft;
 * - OCR-Sprachen: Default (Browsersprache + Englisch), gespeicherte Auswahl,
 *   ungueltige Auswahl und open_options.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC_DIR = path.join(__dirname, "..", "src");
const SOURCE = fs.readFileSync(path.join(SRC_DIR, "background.js"), "utf8");
const TAB = { id: 17, windowId: 4, url: "https://example.test/" };

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHarness({
  contentReady = false,
  holdInjection = false,
  offscreenOpen = false,
  holdOffscreenCreate = false,
  holdOffscreenRun = false,
  uiLanguage = "en-US",
  storedLanguages,
  storedSettings = {},
  sessionStore = {},
} = {}) {
  const listeners = {};
  const metrics = {
    captures: 0,
    pings: 0,
    executeScripts: 0,
    executedFiles: [],
    insertCss: 0,
    starts: 0,
    badges: [],
    badgeColors: [],
    offscreenCreates: 0,
    offscreenCloses: 0,
    offscreenPings: 0,
    offscreenRuns: [],
    offscreenCancels: [],
    offscreenLanguages: [],
    optionsOpened: 0,
  };

  let releaseInjection;
  let signalInjectionStarted;
  const injectionStarted = new Promise((resolve) => { signalInjectionStarted = resolve; });
  const injectionGate = new Promise((resolve) => { releaseInjection = resolve; });

  let signalOffscreenCreateStarted;
  const offscreenCreateStarted = new Promise((resolve) => { signalOffscreenCreateStarted = resolve; });
  const offscreenCreateGate = createDeferred();
  const offscreenRunGates = new Map();

  let nextTimerId = 1;
  const pendingTimers = new Map();

  function fakeSetTimeout(fn, delay = 0) {
    const id = nextTimerId++;
    const entry = { fn, delay };
    pendingTimers.set(id, entry);
    if (delay < 1000) {
      setTimeout(() => {
        if (pendingTimers.delete(id)) {
          fn();
        }
      }, 0);
    }
    return id;
  }

  function fakeClearTimeout(id) {
    pendingTimers.delete(id);
  }

  async function runIdleTimers() {
    const entries = Array.from(pendingTimers.entries());
    for (const [id, entry] of entries) {
      pendingTimers.delete(id);
      await entry.fn();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const chrome = {
    action: {
      onClicked: { addListener(listener) { listeners.click = listener; } },
      async setBadgeText(details) {
        metrics.badges.push({ ...details });
      },
      async setBadgeBackgroundColor(details) {
        metrics.badgeColors.push({ ...details });
      },
    },
    offscreen: {
      Reason: { WORKERS: "WORKERS" },
      async createDocument() {
        metrics.offscreenCreates += 1;
        signalOffscreenCreateStarted();
        if (holdOffscreenCreate) {
          await offscreenCreateGate.promise;
        }
        offscreenOpen = true;
      },
      async closeDocument() {
        metrics.offscreenCloses += 1;
        offscreenOpen = false;
      },
    },
    storage: {
      local: {
        async get(keys) {
          const store = { ...storedSettings };
          if (storedLanguages !== undefined) store.ocrLanguages = storedLanguages;
          const out = {};
          for (const key of [].concat(keys)) {
            if (key in store) out[key] = store[key];
          }
          return out;
        },
      },
      session: {
        async get(key) {
          return key in sessionStore ? { [key]: sessionStore[key] } : {};
        },
        async set(items) {
          Object.assign(sessionStore, JSON.parse(JSON.stringify(items)));
        },
      },
    },
    i18n: {
      getUILanguage() {
        return uiLanguage;
      },
    },
    runtime: {
      async openOptionsPage() {
        metrics.optionsOpened += 1;
      },
      getURL(rel) {
        return "chrome-extension://test-id/" + rel;
      },
      async getContexts({ contextTypes, documentUrls } = {}) {
        if (!offscreenOpen) return [];
        const expectedUrl = "chrome-extension://test-id/offscreen.html";
        if (contextTypes && !contextTypes.includes("OFFSCREEN_DOCUMENT")) return [];
        if (documentUrls && !documentUrls.includes(expectedUrl)) return [];
        return [{ contextType: "OFFSCREEN_DOCUMENT", documentUrl: expectedUrl }];
      },
      onMessage: {
        addListener(listener) {
          listeners.runtimeMessage = listener;
        },
      },
      async sendMessage(message) {
        if (message.target !== "offscreen") {
          throw new Error("Unerwartetes runtime.sendMessage target: " + message.target);
        }
        if (!offscreenOpen) {
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }
        if (message.action === "offscreen_ping") {
          metrics.offscreenPings += 1;
          return { ready: true, tesseractLoaded: true };
        }
        if (message.action === "offscreen_run_ocr") {
          metrics.offscreenRuns.push(message.requestId);
          metrics.offscreenLanguages.push(message.languages);
          if (holdOffscreenRun) {
            const gate = createDeferred();
            offscreenRunGates.set(message.requestId, gate);
            return gate.promise;
          }
          return {
            ok: true,
            result: {
              text: "OK " + message.requestId,
              confidence: 95,
              language: "English",
              languageCode: "eng",
            },
          };
        }
        if (message.action === "offscreen_cancel_ocr") {
          metrics.offscreenCancels.push(message.requestId);
          const gate = offscreenRunGates.get(message.requestId);
          if (gate) {
            offscreenRunGates.delete(message.requestId);
            gate.resolve({
              ok: false,
              aborted: true,
              error: { name: "OcrAbortError", message: "Text recognition was cancelled." },
            });
          }
          return { ok: true, cancelled: Boolean(gate) };
        }
        throw new Error("Unerwartete Offscreen-Nachricht: " + message.action);
      },
    },
    tabs: {
      onRemoved: {
        addListener(listener) {
          listeners.tabRemoved = listener;
        },
      },
      onUpdated: {
        addListener(listener) {
          listeners.tabUpdated = listener;
        },
      },
      async captureVisibleTab() {
        metrics.captures += 1;
        return "data:image/png;base64,AA==";
      },
      async sendMessage(_tabId, message) {
        if (message.action === "ocr_ping") {
          metrics.pings += 1;
          if (!contentReady) throw new Error("Could not establish connection. Receiving end does not exist.");
          return { ready: true };
        }
        if (message.action === "start_selection") {
          metrics.starts += 1;
          return undefined;
        }
        throw new Error("Unerwartete Nachricht: " + message.action);
      },
    },
    scripting: {
      async executeScript(details) {
        metrics.executeScripts += 1;
        metrics.executedFiles.push(details && details.files ? details.files.slice() : []);
        signalInjectionStarted();
        if (holdInjection) await injectionGate;
        contentReady = true;
      },
      async insertCSS() {
        metrics.insertCss += 1;
      },
    },
  };

  const context = vm.createContext({
    chrome,
    console,
    URL,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
  });
  context.self = context;
  context.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(fs.readFileSync(path.join(SRC_DIR, file), "utf8"), context);
    }
  };
  vm.runInContext(SOURCE, context);

  function sendRuntimeMessage(message, sender = { tab: { id: TAB.id } }) {
    return new Promise((resolve) => {
      let settled = false;
      const sendResponse = (response) => {
        if (!settled) {
          settled = true;
          resolve(response);
        }
      };
      const keepOpen = listeners.runtimeMessage(message, sender, sendResponse);
      if (keepOpen !== true && !settled) {
        settled = true;
        resolve(undefined);
      }
    });
  }

  return {
    metrics,
    sessionStore,
    pendingTimers,
    click: (tab = TAB) => listeners.click(tab),
    sendRuntimeMessage,
    triggerTabRemoved: (tabId) => listeners.tabRemoved(tabId),
    triggerTabUpdated: (tabId, changeInfo) => listeners.tabUpdated(tabId, changeInfo),
    injectionStarted,
    releaseInjection,
    offscreenCreateStarted,
    releaseOffscreenCreate: () => offscreenCreateGate.resolve(),
    resolveOffscreenRun(requestId, response) {
      const gate = offscreenRunGates.get(requestId);
      if (gate) {
        offscreenRunGates.delete(requestId);
        gate.resolve(response);
      }
    },
    runIdleTimers,
  };
}

(async () => {
  // 1. Parallele Icon-Klicks teilen sich exakt eine Content-Script-Injektion (ohne tesseract.min.js).
  const concurrent = createHarness({ holdInjection: true });
  const firstClick = concurrent.click();
  const secondClick = concurrent.click();
  await concurrent.injectionStarted;
  assert.strictEqual(concurrent.metrics.executeScripts, 1, "Parallele Klicks dürfen nur eine Skriptinjektion starten.");
  assert(
    !concurrent.metrics.executedFiles[0].includes("lib/tesseract.min.js"),
    "lib/tesseract.min.js darf nicht mehr in Tabs injiziert werden."
  );
  concurrent.releaseInjection();
  await Promise.all([firstClick, secondClick]);
  assert.strictEqual(concurrent.metrics.insertCss, 1, "CSS darf nur einmal injiziert werden.");
  assert.strictEqual(concurrent.metrics.starts, 2, "Beide Klicks müssen nach der geteilten Injektion das Content-Skript erreichen.");

  // 2. Neuer Harness = simuliert einen neu gestarteten, zustandslosen MV3-Worker.
  const restartedServiceWorker = createHarness({ contentReady: true });
  await restartedServiceWorker.click();
  assert.strictEqual(restartedServiceWorker.metrics.executeScripts, 0, "Ein lebendes Content-Skript darf nach Worker-Neustart nicht erneut injiziert werden.");
  assert.strictEqual(restartedServiceWorker.metrics.insertCss, 0, "CSS darf nach erfolgreichem ocr_ping nicht erneut injiziert werden.");
  assert.strictEqual(restartedServiceWorker.metrics.starts, 1, "Der OCR-Start muss den vorhandenen Empfänger erreichen.");

  // 3. Blockierte URLs dürfen keinen Screenshot/Injection auslösen, sondern setzen das "!"-Badge.
  const blockedUrls = [
    "https://chromewebstore.google.com/detail/local-screen-ocr/abcdefghijklmnop",
    "https://chrome.google.com/webstore/detail/local-screen-ocr/abcdefghijklmnop",
    "chrome://new-tab-page",
    "view-source:https://example.test/",
    "about:blank",
    undefined,
  ];
  for (const url of blockedUrls) {
    const blockedHarness = createHarness();
    await blockedHarness.click({ id: 17, windowId: 4, url });
    assert.strictEqual(blockedHarness.metrics.captures, 0, `Blockierte URL darf keinen Screenshot auslösen: ${url}`);
    assert.strictEqual(blockedHarness.metrics.executeScripts, 0, `Blockierte URL darf kein Skript injizieren: ${url}`);
    assert.strictEqual(blockedHarness.metrics.starts, 0, `Blockierte URL darf kein start_selection senden: ${url}`);
    assert.deepStrictEqual(
      blockedHarness.metrics.badges,
      [{ tabId: 17, text: "!" }],
      `Blockierte URL muss "!"-Badge setzen: ${url}`
    );
  }

  // 4. Erlaubte URLs (inkl. file:// und Nicht-Webstore-Seiten auf chrome.google.com) müssen laufen und das Badge löschen.
  for (const url of ["file:///tmp/local-document.html", "https://chrome.google.com/other-page"]) {
    const allowedHarness = createHarness();
    await allowedHarness.click({ id: 17, windowId: 4, url });
    assert.strictEqual(allowedHarness.metrics.captures, 1, `Erlaubte URL muss Screenshot erstellen: ${url}`);
    assert.strictEqual(allowedHarness.metrics.executeScripts, 1, `Erlaubte URL muss Skript injizieren: ${url}`);
    assert.strictEqual(allowedHarness.metrics.starts, 1, `Erlaubte URL muss start_selection senden: ${url}`);
    assert.deepStrictEqual(
      allowedHarness.metrics.badges,
      [{ tabId: 17, text: "" }],
      `Erlaubte URL muss vorheriges Badge löschen: ${url}`
    );
  }

  // 5. Parallele run_ocr-Anfragen teilen genau ein chrome.offscreen.createDocument().
  const concurrentOffscreen = createHarness({ holdOffscreenCreate: true });
  const ocrReq1 = concurrentOffscreen.sendRuntimeMessage(
    { target: "background", action: "run_ocr", requestId: "req-1", dataUrl: "data:image/png;base64,AA==" },
    { tab: { id: 17 } }
  );
  const ocrReq2 = concurrentOffscreen.sendRuntimeMessage(
    { target: "background", action: "run_ocr", requestId: "req-2", dataUrl: "data:image/png;base64,BB==" },
    { tab: { id: 18 } }
  );
  await concurrentOffscreen.offscreenCreateStarted;
  assert.strictEqual(concurrentOffscreen.metrics.offscreenCreates, 1, "Parallele OCR-Anfragen dürfen nur ein Offscreen-Dokument erzeugen.");
  concurrentOffscreen.releaseOffscreenCreate();
  const [ocrResp1, ocrResp2] = await Promise.all([ocrReq1, ocrReq2]);
  assert.strictEqual(ocrResp1.ok, true);
  assert.strictEqual(ocrResp2.ok, true);
  assert.deepStrictEqual(concurrentOffscreen.metrics.offscreenRuns.sort(), ["req-1", "req-2"]);

  // 6. Idle-Close: nach Abschluss aller OCR-Anfragen schliesst der Idle-Timer das Offscreen-Dokument.
  assert.strictEqual(concurrentOffscreen.metrics.offscreenCloses, 0, "Offscreen-Dokument darf nicht sofort geschlossen werden.");
  assert.strictEqual(concurrentOffscreen.pendingTimers.size, 1, "Idle-Close-Timer muss geplant sein.");
  await concurrentOffscreen.runIdleTimers();
  assert.strictEqual(concurrentOffscreen.metrics.offscreenCloses, 1, "Idle-Close-Timer muss closeDocument() aufrufen.");

  // 7. Service-Worker-Neustart mit bereits offenem Offscreen-Dokument erzeugt kein zweites.
  const existingOffscreen = createHarness({ offscreenOpen: true });
  const reuseResp = await existingOffscreen.sendRuntimeMessage(
    { target: "background", action: "run_ocr", requestId: "req-reuse", dataUrl: "data:image/png;base64,AA==" },
    { tab: { id: 17 } }
  );
  assert.strictEqual(reuseResp.ok, true);
  assert.strictEqual(existingOffscreen.metrics.offscreenCreates, 0, "Vorhandenes Offscreen-Dokument muss wiederverwendet werden.");

  // 8. cancel_ocr prueft die Tab-Zugehoerigkeit und leitet nur fuer den Besitzer-Tab weiter.
  const cancelHarness = createHarness({ offscreenOpen: true, holdOffscreenRun: true });
  const ownedRun = cancelHarness.sendRuntimeMessage(
    { target: "background", action: "run_ocr", requestId: "req-owned", dataUrl: "data:image/png;base64,AA==" },
    { tab: { id: 17 } }
  );
  await new Promise((r) => setTimeout(r, 10));
  const foreignCancel = await cancelHarness.sendRuntimeMessage(
    { target: "background", action: "cancel_ocr", requestId: "req-owned" },
    { tab: { id: 99 } }
  );
  assert.deepStrictEqual({ ...foreignCancel }, { ok: false, cancelled: false }, "Fremder Tab darf OCR eines anderen Tabs nicht abbrechen.");
  assert.strictEqual(cancelHarness.metrics.offscreenCancels.length, 0);

  const validCancel = await cancelHarness.sendRuntimeMessage(
    { target: "background", action: "cancel_ocr", requestId: "req-owned" },
    { tab: { id: 17 } }
  );
  assert.deepStrictEqual({ ...validCancel }, { ok: true, cancelled: true });
  assert.deepStrictEqual(cancelHarness.metrics.offscreenCancels, ["req-owned"]);
  const cancelledRunResp = await ownedRun;
  assert.strictEqual(cancelledRunResp.ok, false);
  assert.strictEqual(cancelledRunResp.aborted, true);

  // 9. Abbruch waehrend createDocument() noch laeuft startet kein offscreen_run_ocr.
  const preCreateCancel = createHarness({ holdOffscreenCreate: true });
  const pendingRun = preCreateCancel.sendRuntimeMessage(
    { target: "background", action: "run_ocr", requestId: "req-pre", dataUrl: "data:image/png;base64,AA==" },
    { tab: { id: 17 } }
  );
  await preCreateCancel.offscreenCreateStarted;
  const preCancelResp = await preCreateCancel.sendRuntimeMessage(
    { target: "background", action: "cancel_ocr", requestId: "req-pre" },
    { tab: { id: 17 } }
  );
  assert.deepStrictEqual({ ...preCancelResp }, { ok: true, cancelled: true });
  preCreateCancel.releaseOffscreenCreate();
  const abortedBeforeRun = await pendingRun;
  assert.strictEqual(abortedBeforeRun.ok, false);
  assert.strictEqual(abortedBeforeRun.aborted, true);
  assert.strictEqual(preCreateCancel.metrics.offscreenRuns.length, 0, "Abgebrochener Request darf kein offscreen_run_ocr mehr senden.");

  // 10. Tab-Cleanup (onRemoved / onUpdated loading) bricht nur Requests des betroffenen Tabs ab.
  const tabLifecycle = createHarness({ offscreenOpen: true, holdOffscreenRun: true });
  const tab17Req = tabLifecycle.sendRuntimeMessage(
    { target: "background", action: "run_ocr", requestId: "req-tab17", dataUrl: "data:image/png;base64,AA==" },
    { tab: { id: 17 } }
  );
  const tab18Req = tabLifecycle.sendRuntimeMessage(
    { target: "background", action: "run_ocr", requestId: "req-tab18", dataUrl: "data:image/png;base64,BB==" },
    { tab: { id: 18 } }
  );
  await new Promise((r) => setTimeout(r, 10));
  tabLifecycle.triggerTabUpdated(17, { status: "complete" });
  assert.strictEqual(tabLifecycle.metrics.offscreenCancels.length, 0, "status: complete darf OCR nicht abbrechen.");
  tabLifecycle.triggerTabUpdated(17, { status: "loading" });
  const tab17Resp = await tab17Req;
  assert.strictEqual(tab17Resp.aborted, true, "Reload (status: loading) muss laufende OCR des Tabs abbrechen.");
  assert.deepStrictEqual(tabLifecycle.metrics.offscreenCancels, ["req-tab17"]);

  // Idle-Timer darf noch nicht geplant/geschlossen sein, solange tab18Req noch aktiv ist.
  await tabLifecycle.runIdleTimers();
  assert.strictEqual(tabLifecycle.metrics.offscreenCloses, 0, "Offscreen darf bei aktivem Request in Tab 18 nicht geschlossen werden.");

  tabLifecycle.triggerTabRemoved(18);
  const tab18Resp = await tab18Req;
  assert.strictEqual(tab18Resp.aborted, true, "Tab-Close muss laufende OCR des Tabs abbrechen.");
  await tabLifecycle.runIdleTimers();
  assert.strictEqual(tabLifecycle.metrics.offscreenCloses, 1, "Nach Abbruch des letzten aktiven Requests muss Idle-Close greifen.");

  // 11. OCR-Sprachen werden aus storage/Browsersprache an das Offscreen-Dokument gereicht.
  async function runOcrLanguages(options) {
    const harness = createHarness(options);
    const response = await harness.sendRuntimeMessage(
      { target: "background", action: "run_ocr", requestId: "req-lang", dataUrl: "data:image/png;base64,AA==" },
      { tab: { id: 17 } }
    );
    assert.strictEqual(response.ok, true);
    assert.deepStrictEqual(
      Array.from(response.languages),
      Array.from(harness.metrics.offscreenLanguages[0]),
      "Antwort muss die verwendeten Sprachen enthalten."
    );
    // Array stammt aus dem VM-Kontext -> in ein Array dieses Realms umwandeln.
    return Array.from(harness.metrics.offscreenLanguages[0]);
  }
  assert.deepStrictEqual(await runOcrLanguages({ uiLanguage: "de-DE" }), ["deu", "eng"], "Default: Browsersprache + Englisch.");
  assert.deepStrictEqual(await runOcrLanguages({ uiLanguage: "en-GB" }), ["eng"], "Englischer Browser: nur Englisch.");
  assert.deepStrictEqual(await runOcrLanguages({ uiLanguage: "ja" }), ["eng"], "Nicht unterstuetzte Browsersprache: nur Englisch.");
  assert.deepStrictEqual(await runOcrLanguages({ uiLanguage: "pt-BR" }), ["por", "eng"], "Regionalvariante muss auf die Sprache abgebildet werden.");
  assert.deepStrictEqual(await runOcrLanguages({ uiLanguage: "de-DE", storedLanguages: ["fra"] }), ["fra"], "Gespeicherte Auswahl hat Vorrang.");
  assert.deepStrictEqual(
    await runOcrLanguages({ uiLanguage: "de-DE", storedLanguages: ["fra", "spa", "ita"] }),
    ["deu", "eng"],
    "Mehr als 2 Sprachen sind ungueltig -> Default."
  );
  assert.deepStrictEqual(
    await runOcrLanguages({ uiLanguage: "de-DE", storedLanguages: ["xxx", "fra", "fra"] }),
    ["fra"],
    "Unbekannte Codes und Duplikate werden verworfen."
  );

  // 12. autoCopy wird an das Content-Skript durchgereicht; Verlauf nur wenn aktiviert.
  const plain = createHarness();
  const plainResp = await plain.sendRuntimeMessage(
    { target: "background", action: "run_ocr", requestId: "req-plain", dataUrl: "data:image/png;base64,AA==" },
    { tab: { id: 17 } }
  );
  assert.strictEqual(plainResp.autoCopy, false, "autoCopy ist standardmaessig aus.");
  assert.strictEqual(plain.sessionStore.ocrHistory, undefined, "Verlauf ist standardmaessig aus.");

  const withHistory = createHarness({ storedSettings: { autoCopy: true, historyEnabled: true } });
  for (let i = 1; i <= 12; i += 1) {
    const resp = await withHistory.sendRuntimeMessage(
      { target: "background", action: "run_ocr", requestId: "req-h" + i, dataUrl: "data:image/png;base64,AA==" },
      { tab: { id: 17 } }
    );
    assert.strictEqual(resp.autoCopy, true, "Gespeichertes autoCopy muss ankommen.");
  }
  const history = withHistory.sessionStore.ocrHistory;
  assert.strictEqual(history.length, 10, "Verlauf ist auf 10 Eintraege begrenzt.");
  assert.strictEqual(history[0].text, "OK req-h12", "Neuester Eintrag steht vorne.");
  assert.strictEqual(history[9].text, "OK req-h3", "Aelteste Eintraege fallen heraus.");
  assert.strictEqual(history[0].languageCode, "eng");
  assert.strictEqual(history[0].confidence, 95);

  // 13. open_options oeffnet die Optionsseite.
  const optionsHarness = createHarness();
  const optionsResp = await optionsHarness.sendRuntimeMessage({ target: "background", action: "open_options" });
  assert.strictEqual(optionsResp.ok, true);
  assert.strictEqual(optionsHarness.metrics.optionsOpened, 1);

  console.log("OK: Content-Script-Injektion und Offscreen-Routing sind race-sicher abgesichert.");
})().catch((error) => {
  console.error("TEST FEHLER:", error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
