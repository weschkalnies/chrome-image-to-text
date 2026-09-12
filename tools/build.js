/**
 * Build-Skript: src/ -> deploy/ (Single Source of Truth)
 *
 * - `node tools/build.js`           : deploy/ neu erzeugen (clean + copy)
 * - `node tools/build.js --autotest`: zusaetzlich tests/deploy-autotest/
 *                                     erzeugen (= deploy + host_permissions
 *                                     <all_urls> fuer den Playwright-Test)
 * - `node tools/build.js --check`   : nur pruefen, ob deploy/ auf Stand von
 *                                     src/ ist (Exit 1 bei Drift). Fuer CI.
 *
 * Keine Abhaengigkeiten, nur Node-Bordmittel.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const DEPLOY = path.join(ROOT, "deploy");
const AUTOTEST = path.join(ROOT, "tests", "deploy-autotest");
const KNOWLEDGE_SRC = path.join(ROOT, "docs", "project_overview.md");
const KNOWLEDGE_DEST = "PROJECT_KNOWLEDGE.md";

/** Rekursives Kopieren (Dateien + Unterordner). */
function copyDir(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name);
    const d = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Rekursives Löschen (fehlerfrei, wenn nicht vorhanden). */
function rmRf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** deploy/ neu erzeugen. */
function buildDeploy() {
  if (!fs.existsSync(SRC)) {
    throw new Error("src/ nicht gefunden: " + SRC);
  }
  rmRf(DEPLOY);
  copyDir(SRC, DEPLOY);
  // Wissensbasis mitliefern (falls vorhanden), damit deploy/ auch standalone
  // den Projekt-Kontext enthaelt (siehe docs/project_overview.md).
  if (fs.existsSync(KNOWLEDGE_SRC)) {
    fs.copyFileSync(KNOWLEDGE_SRC, path.join(DEPLOY, KNOWLEDGE_DEST));
  }
}

/** tests/deploy-autotest/ = deploy/ + host_permissions <all_urls>. */
function buildAutotest() {
  const manifestPath = path.join(DEPLOY, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.host_permissions = ["<all_urls>"];
  rmRf(AUTOTEST);
  copyDir(DEPLOY, AUTOTEST);
  fs.writeFileSync(
    path.join(AUTOTEST, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );
}

/**
 * Prueft, ob deploy/ exakt dem Build von src/ entspricht.
 * @returns {string[]} Liste der Abweichungen (leer = synchron)
 */
function checkSync() {
  const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "ocr-build-"));
  const diffs = [];
  try {
    // Deploy-Rezept auf Temp-Ordner anwenden
    const savedDeploy = DEPLOY;
    const tmpTarget = path.join(tmp, "deploy");
    rmRf(tmpTarget);
    copyDir(SRC, tmpTarget);
    if (fs.existsSync(KNOWLEDGE_SRC)) {
      fs.copyFileSync(KNOWLEDGE_SRC, path.join(tmpTarget, KNOWLEDGE_DEST));
    }

    /** Rekursives Auflisten relativer Pfade. */
    function listFiles(dir, base) {
      const out = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? base + "/" + entry.name : entry.name;
        if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
        else out.push(rel);
      }
      return out;
    }

    const srcFiles = new Set(listFiles(tmpTarget, ""));
    const dstFiles = new Set(listFiles(savedDeploy, ""));
    for (const f of srcFiles) {
      if (!dstFiles.has(f)) diffs.push("fehlt in deploy/: " + f);
      else if (!fs.readFileSync(path.join(tmpTarget, f)).equals(fs.readFileSync(path.join(savedDeploy, f)))) {
        diffs.push("unterschiedlich: " + f);
      }
    }
    for (const f of dstFiles) {
      if (!srcFiles.has(f)) diffs.push("ueberzaehlig in deploy/: " + f);
    }
  } finally {
    rmRf(tmp);
  }
  return diffs;
}

/* ------------------------------------------------------------------ main */

const args = process.argv.slice(2);
const wantAutotest = args.includes("--autotest");
const checkOnly = args.includes("--check");

if (checkOnly) {
  const diffs = checkSync();
  if (diffs.length === 0) {
    console.log("OK: deploy/ ist auf dem Stand von src/.");
    process.exit(0);
  }
  console.error("DRIFT erkannt – deploy/ ist nicht auf dem Stand von src/:");
  diffs.forEach((d) => console.error("  - " + d));
  console.error("Fix: node tools/build.js");
  process.exit(1);
}

buildDeploy();
console.log("deploy/ neu gebaut (aus src/).");

if (wantAutotest) {
  buildAutotest();
  console.log("tests/deploy-autotest/ neu gebaut (deploy/ + host_permissions).");
}
