#!/usr/bin/env node
/**
 * Release in einem Schritt: Version erhoehen -> bauen -> testen -> packen ->
 * committen + taggen -> in den Chrome Web Store hochladen.
 *
 * Gepusht wird NICHT. Danach: `git push --follow-tags` (der Tag loest den
 * GitHub-Release-Workflow aus).
 *
 * Nutzung:
 *   npm run release -- <patch|minor|major|X.Y.Z> [Optionen]
 *
 * X.Y.Z darf auch die aktuelle Manifest-Version sein, solange es dafuer noch
 * keinen Tag gibt (z. B. wenn die Version schon von Hand gesetzt wurde).
 *
 * Optionen:
 *   --draft        nur hochladen, nicht zur Pruefung einreichen
 *   --staged       einreichen, nach Freigabe aber selbst veroeffentlichen
 *   --no-upload    nichts hochladen (nur Version, Build, Tests, ZIP, Commit, Tag)
 *   --skip-e2e     Browser-E2E-Test auslassen (schneller, weniger sicher)
 *   --dry-run      nur anzeigen, was passieren wuerde; nichts aendern
 *
 * Keine Abhaengigkeiten, nur Node-Bordmittel (+ git, zip).
 */
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST = path.join(ROOT, "src", "manifest.json");
const PACKAGE = path.join(ROOT, "package.json");
const DEPLOY = path.join(ROOT, "deploy");
const ZIP = path.join(ROOT, "localocr-screen-to-text.zip");

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Berechnet die naechste Version aus der aktuellen und patch|minor|major|X.Y.Z.
 * Eine explizite Version gleich der aktuellen ist erlaubt (noch nicht
 * veroeffentlichte Version releasen); kleinere Versionen nicht.
 */
function nextVersion(current, bump) {
  const cur = VERSION_RE.exec(current);
  if (!cur) throw new Error(`Aktuelle Version "${current}" ist kein X.Y.Z.`);
  const [major, minor, patch] = cur.slice(1).map(Number);
  let next;
  if (bump === "patch") next = `${major}.${minor}.${patch + 1}`;
  else if (bump === "minor") next = `${major}.${minor + 1}.0`;
  else if (bump === "major") next = `${major + 1}.0.0`;
  else if (VERSION_RE.test(bump || "")) next = bump;
  else throw new Error(`Unbekannte Versionsangabe "${bump}". Erwartet: patch, minor, major oder X.Y.Z.`);

  const cmp = compareVersions(next, current);
  if (cmp < 0 || (cmp === 0 && !VERSION_RE.test(bump))) {
    throw new Error(`Neue Version ${next} darf nicht kleiner als ${current} sein.`);
  }
  return next;
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function parseArgs(argv) {
  const options = {
    bump: null,
    mode: "publish",
    upload: true,
    e2e: true,
    dryRun: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--draft") options.mode = "draft";
    else if (arg === "--staged") options.mode = "staged";
    else if (arg === "--no-upload") options.upload = false;
    else if (arg === "--skip-e2e") options.e2e = false;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (!arg.startsWith("-") && !options.bump) options.bump = arg;
    else throw new Error("Unbekanntes Argument: " + arg);
  }
  if (!options.help && !options.bump) {
    throw new Error("Versionsangabe fehlt: patch, minor, major oder X.Y.Z.");
  }
  return options;
}

/** Ersetzt nur das "version"-Feld, damit Formatierung/Reihenfolge erhalten bleiben. */
function setJsonVersion(file, version) {
  const text = fs.readFileSync(file, "utf8");
  const replaced = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (replaced === text && !text.includes(`"version": "${version}"`)) {
    throw new Error("Kein version-Feld gefunden in " + file);
  }
  fs.writeFileSync(file, replaced);
}

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
}

function capture(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function step(text) {
  console.log(`\n=== ${text} ===`);
}

function printHelp() {
  console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^#!.*\n/, ""));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const current = JSON.parse(fs.readFileSync(MANIFEST, "utf8")).version;
  const version = nextVersion(current, options.bump);
  const tag = "v" + version;

  step("Vorpruefung");
  const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "main") throw new Error(`Release nur von main (aktuell: ${branch}).`);
  const dirty = capture("git", ["status", "--porcelain"]);
  if (dirty) throw new Error("Arbeitsverzeichnis ist nicht sauber:\n" + dirty);
  if (capture("git", ["tag", "-l", tag])) throw new Error(`Tag ${tag} existiert bereits.`);
  console.log(
    version === current
      ? `Version ${version} (unveraendert, Tag ${tag})`
      : `Version ${current} -> ${version} (Tag ${tag})`
  );
  console.log(
    "Store: " +
      (options.upload ? { publish: "hochladen + einreichen", staged: "hochladen + einreichen (staged)", draft: "nur Entwurf hochladen" }[options.mode] : "kein Upload")
  );

  if (options.upload) {
    // Zugangsdaten frueh pruefen, bevor irgendetwas geaendert wird.
    run(process.execPath, ["tools/publish-cws.js", "--mode", "status", "--dry-run"]);
  }

  if (options.dryRun) {
    console.log("\n--dry-run: keine Aenderungen vorgenommen.");
    return;
  }

  step("Version setzen");
  setJsonVersion(MANIFEST, version);
  setJsonVersion(PACKAGE, version);

  try {
    step("Bauen");
    run(process.execPath, ["tools/build.js"]);
    run(process.execPath, ["tools/build.js", "--check"]);

    step("Tests");
    run(process.execPath, ["tests/background-injection.cjs"]);
    run(process.execPath, ["tests/content-worker-lifecycle.cjs"]);
    run(process.execPath, ["tests/publish-cws.cjs"]);
    run(process.execPath, ["tests/release.cjs"]);
    if (options.e2e) {
      run(process.execPath, ["tools/build.js", "--autotest"]);
      run(process.execPath, ["tests/run2.cjs", "tests/deploy-autotest"]);
    }
  } catch (error) {
    // Versionsaenderung zuruecknehmen, damit ein erneuter Versuch sauber startet.
    console.error("\nAbbruch – Versionsaenderung wird zurueckgenommen.");
    execFileSync("git", ["checkout", "--", "src/manifest.json", "package.json", "deploy"], { cwd: ROOT });
    throw error;
  }

  step("ZIP packen");
  fs.rmSync(ZIP, { force: true });
  run("zip", ["-q", "-r", ZIP, ".", "-x", "*.md"], { cwd: DEPLOY });
  console.log(`${path.basename(ZIP)}: ${(fs.statSync(ZIP).size / 1e6).toFixed(1)} MB`);

  step("Commit + Tag");
  run("git", ["add", "-A"]);
  let hasChanges = false;
  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: ROOT });
  } catch (_error) {
    hasChanges = true; // Exit-Code 1 = es gibt gestagte Aenderungen
  }
  if (hasChanges) {
    run("git", ["commit", "-q", "-m", `chore: release ${tag}`]);
  } else {
    console.log("Keine Aenderungen zu committen – Tag wird auf den aktuellen Commit gesetzt.");
  }
  run("git", ["tag", "-a", tag, "-m", `Release ${tag}`]);

  if (options.upload) {
    step("Chrome Web Store");
    try {
      run(process.execPath, ["tools/publish-cws.js", "--mode", options.mode]);
    } catch (error) {
      console.error(
        `\nUpload fehlgeschlagen. Commit und Tag ${tag} sind lokal angelegt.\n` +
          `Erneut versuchen mit: npm run publish:cws -- --mode ${options.mode}`
      );
      throw error;
    }
  }

  console.log(`\nFertig: ${tag}.`);
  if (options.upload && options.mode === "draft") {
    console.log("Entwurf hochgeladen – im Dashboard pruefen und einreichen.");
  }
  console.log("Jetzt pushen: git push --follow-tags");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error("\n[release] FEHLER:", error && error.message ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = { nextVersion, compareVersions, parseArgs, setJsonVersion };
