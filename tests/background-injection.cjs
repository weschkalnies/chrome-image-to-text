/**
 * Regressionstest fuer die race-sichere Content-Script-Injektion.
 *
 * Simuliert die Chrome-APIs ohne Browser und prueft:
 * - zwei gleichzeitige Icon-Klicks teilen genau eine Injektion;
 * - nach einem MV3-Service-Worker-Neustart erkennt ocr_ping das noch lebende
 *   Content-Skript, sodass es nicht erneut injiziert wird.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "src", "background.js"), "utf8");
const TAB = { id: 17, windowId: 4, url: "https://example.test/" };

function createHarness({ contentReady = false, holdInjection = false } = {}) {
  const listeners = {};
  const metrics = {
    captures: 0,
    pings: 0,
    executeScripts: 0,
    insertCss: 0,
    starts: 0,
    badges: [],
    badgeColors: [],
  };
  let releaseInjection;
  let signalInjectionStarted;
  const injectionStarted = new Promise((resolve) => { signalInjectionStarted = resolve; });
  const injectionGate = new Promise((resolve) => { releaseInjection = resolve; });

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
    tabs: {
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
      async executeScript() {
        metrics.executeScripts += 1;
        signalInjectionStarted();
        if (holdInjection) await injectionGate;
        contentReady = true;
      },
      async insertCSS() {
        metrics.insertCss += 1;
      },
    },
  };

  vm.runInNewContext(SOURCE, { chrome, console, URL });
  return {
    metrics,
    click: (tab = TAB) => listeners.click(tab),
    injectionStarted,
    releaseInjection,
  };
}

(async () => {
  const concurrent = createHarness({ holdInjection: true });
  const firstClick = concurrent.click();
  const secondClick = concurrent.click();
  await concurrent.injectionStarted;
  assert.strictEqual(concurrent.metrics.executeScripts, 1, "Parallele Klicks dürfen nur eine Skriptinjektion starten.");
  concurrent.releaseInjection();
  await Promise.all([firstClick, secondClick]);
  assert.strictEqual(concurrent.metrics.insertCss, 1, "CSS darf nur einmal injiziert werden.");
  assert.strictEqual(concurrent.metrics.starts, 2, "Beide Klicks müssen nach der geteilten Injektion das Content-Skript erreichen.");

  // Neuer Harness = simuliert einen neu gestarteten, zustandslosen MV3-Worker.
  const restartedServiceWorker = createHarness({ contentReady: true });
  await restartedServiceWorker.click();
  assert.strictEqual(restartedServiceWorker.metrics.executeScripts, 0, "Ein lebendes Content-Skript darf nach Worker-Neustart nicht erneut injiziert werden.");
  assert.strictEqual(restartedServiceWorker.metrics.insertCss, 0, "CSS darf nach erfolgreichem ocr_ping nicht erneut injiziert werden.");
  assert.strictEqual(restartedServiceWorker.metrics.starts, 1, "Der OCR-Start muss den vorhandenen Empfänger erreichen.");

  // Blockierte URLs dürfen keinen Screenshot/Injection auslösen, sondern setzen das "!"-Badge.
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

  // Erlaubte URLs (inkl. file:// und Nicht-Webstore-Seiten auf chrome.google.com) müssen laufen und das Badge löschen.
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

  console.log("OK: Content-Script-Injektion ist gegen Klick-Rennen und MV3-Neustarts abgesichert.");
})().catch((error) => {
  console.error("TEST FEHLER:", error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
