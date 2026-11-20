/**
 * Unit-Test fuer tools/release.js (ohne git, Build oder Netzwerk):
 * - Versionsberechnung patch/minor/major/X.Y.Z und Ablehnung kleinerer Versionen;
 * - Argument-Parsing der Store-Modi;
 * - setJsonVersion aendert nur das version-Feld.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { nextVersion, parseArgs, setJsonVersion } = require("../tools/release.js");

assert.strictEqual(nextVersion("1.3.0", "patch"), "1.3.1");
assert.strictEqual(nextVersion("1.3.4", "minor"), "1.4.0");
assert.strictEqual(nextVersion("1.3.4", "major"), "2.0.0");
assert.strictEqual(nextVersion("1.3.0", "1.10.0"), "1.10.0");
assert.strictEqual(nextVersion("1.3.0", "1.3.0"), "1.3.0", "Aktuelle, ungetaggte Version darf released werden.");
assert.throws(() => nextVersion("1.3.0", "1.2.9"), /nicht kleiner/);
assert.throws(() => nextVersion("1.3.0", "bugfix"), /Unbekannte Versionsangabe/);

assert.deepStrictEqual(
  { ...parseArgs(["minor"]) },
  { bump: "minor", mode: "publish", upload: true, e2e: true, dryRun: false, help: false }
);
assert.strictEqual(parseArgs(["patch", "--draft"]).mode, "draft");
assert.strictEqual(parseArgs(["patch", "--staged"]).mode, "staged");
assert.strictEqual(parseArgs(["patch", "--no-upload"]).upload, false);
assert.strictEqual(parseArgs(["patch", "--skip-e2e"]).e2e, false);
assert.throws(() => parseArgs([]), /Versionsangabe fehlt/);
assert.throws(() => parseArgs(["patch", "--foo"]), /Unbekanntes Argument/);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-test-"));
const file = path.join(dir, "manifest.json");
const original = '{\n  "manifest_version": 3,\n  "name": "X",\n  "version": "1.3.0",\n  "minimum_chrome_version": "116"\n}\n';
fs.writeFileSync(file, original);
setJsonVersion(file, "1.4.0");
assert.strictEqual(fs.readFileSync(file, "utf8"), original.replace('"1.3.0"', '"1.4.0"'));
fs.rmSync(dir, { recursive: true, force: true });

console.log("OK: release.js berechnet Versionen und Optionen korrekt.");
