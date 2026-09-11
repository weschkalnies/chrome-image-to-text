/**
 * Debug7: Chrome DIREKT (ohne Playwright) mit --load-extension starten und
 * ueber /json/list alle Targets abfragen. Isoliert das Problem
 * "Chrome 152 + --load-extension" vs. "Playwright".
 */
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

const EXT = path.join(__dirname, "minimal-ext");
const CHROME = require("./_env").resolveChrome();
const TMP = path.join(__dirname, ".tmp-profile-direct");
const PORT = 9333;

fs.rmSync(TMP, { recursive: true, force: true });

const args = [
  "--user-data-dir=" + TMP,
  "--remote-debugging-port=" + PORT,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions-except=" + EXT,
  "--load-extension=" + EXT,
  "about:blank",
];

const proc = spawn(CHROME, args, { detached: false, stdio: "ignore" });

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function waitForPort(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fetchJson("http://127.0.0.1:" + PORT + "/json/version");
      return v;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error("Port nicht erreichbar");
}

(async () => {
  try {
    const ver = await waitForPort(15000);
    console.log("Chrome-Version:", ver.Browser);

    // Mehrfach pruefen, ob Extension-Target auftaucht
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const list = await fetchJson("http://127.0.0.1:" + PORT + "/json/list");
      const ext = list.filter((t) =>
        /chrome-extension|service_worker|extension/.test(t.type) ||
        /chrome-extension:/.test(t.url || "")
      );
      console.log(`Versuch ${i + 1}: ${list.length} Targets, davon extension-relevant: ${ext.length}`);
      if (ext.length) {
        ext.forEach((t) => console.log("  ->", t.type, t.url, "|", t.title));
        break;
      }
    }
    // Vollstaendige Liste am Ende
    const list = await fetchJson("http://127.0.0.1:" + PORT + "/json/list");
    console.log("===== Alle Targets =====");
    list.forEach((t) => console.log(`  [${t.type}] ${t.url}`));
  } catch (e) {
    console.error("ERR", e.message);
  } finally {
    try { proc.kill(); } catch (e) {}
    // ggf.kind-Prozesse beenden
    try { process.kill(-proc.pid); } catch (e) {}
  }
})();
