/**
 * Gemeinsame Test-Hilfe: Chrome- und Extension-Pfade portabel aufloesen.
 *
 * Statt hartcodierter Windows-Pfade pro Skript:
 *  - Chrome wird via Umgebungsvariable CHROME_PATH, sonst ueber
 *    plattformspezifische Standardpfade (Win/macOS/Linux) gesucht.
 *    Letzter Fallback: das von Playwright mitgelieferte Chromium.
 *  - Extension-Pfade werden relativ zum tests/-Verzeichnis aufgeloest.
 *
 * Nutzung in Test-Skripten:
 *   const { resolveChrome, extPath } = require("./_env");
 *   const CHROME = resolveChrome();
 *   const EXT    = extPath("deploy");            // -> <repo>/deploy
 *   const MIN    = extPath("minimal-ext");       // -> <tests>/minimal-ext
 */
const path = require("path");
const fs = require("fs");

/** tests/-Verzeichnis (= Verzeichnis dieser Datei). */
const TESTS_DIR = __dirname;

/**
 * Liefert einen Extension-/Ressourcen-Pfad relativ zum Projekt.
 * "deploy"        -> <repo-root>/deploy
 * "minimal-ext"   -> <tests>/minimal-ext
 * alles ab "tests/" wird relativ zu tests/ aufgeloest, sonst zum Repo-Root.
 *
 * @param {string} sub  relativer Zielordner
 * @returns {string}    absoluter Pfad (plattformunabhaengig)
 */
function extPath(sub) {
  if (sub.startsWith("tests/")) return path.join(TESTS_DIR, sub.slice("tests/".length));
  if (sub === "minimal-ext")   return path.join(TESTS_DIR, "minimal-ext");
  // Repo-Root liegt eine Ebene ueber tests/
  return path.join(TESTS_DIR, "..", sub);
}

/** Plattformspezifische Standard-Installationspfade fuer Google Chrome. */
const CHROME_CANDIDATES = {
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    path.join(process.env.HOME || "", "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ],
};

/**
 * Findet eine ausfuehrbare Chrome-/Chromium-Binary.
 * Reihenfolge: $CHROME_PATH -> plattformspezifische Standardpfade ->
 * Playwright-Bundled-Chromium. Wirft, wenn nichts gefunden wird.
 *
 * @returns {string} Pfad zur Chrome-Executable
 */
function resolveChrome() {
  // 1. Explizite Vorgabe
  const env = process.env.CHROME_PATH;
  if (env && fs.existsSync(env)) return env;

  // 2. Standardpfade der Plattform
  const list = CHROME_CANDIDATES[process.platform] || [];
  for (const c of list) {
    if (c && fs.existsSync(c)) return c;
  }

  // 3. Fallback: Chromium, das Playwright mitbringt
  try {
    const exec = require("playwright").chromium.executablePath();
    if (exec && fs.existsSync(exec)) return exec;
  } catch (e) {
    /* Playwright evtl. nicht installiert -> weiter */
  }

  throw new Error(
    "Chrome/Chromium nicht gefunden. Setze die Umgebungsvariable CHROME_PATH " +
      "auf den Pfad deiner chrome.exe/chrome-Binary."
  );
}

module.exports = { resolveChrome, extPath, TESTS_DIR };
