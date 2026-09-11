/**
 * Debug8: Chrome direkt mit Logging starten, um Extension-Ladefehler zu sehen.
 * Prueft zunaechst minimale, dann die echte deploy-Extension.
 */
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

const EXT = process.argv[2] || path.join(__dirname, "minimal-ext");
const CHROME = require("./_env").resolveChrome();
const TMP = path.join(__dirname, ".tmp-profile-log");
const PORT = 9334;

fs.rmSync(TMP, { recursive: true, force: true });

const args = [
  "--user-data-dir=" + TMP,
  "--remote-debugging-port=" + PORT,
  "--enable-logging=stderr",
  "--v=1",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions-except=" + EXT,
  "--load-extension=" + EXT,
  "about:blank",
];

const proc = spawn(CHROME, args, { detached: false, stdio: ["ignore", "pipe", "pipe"] });
let logBuf = "";
proc.stdout.on("data", (c) => (logBuf += c.toString()));
proc.stderr.on("data", (c) => (logBuf += c.toString()));

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

(async () => {
  // Warten bis Port da
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try { await fetchJson("http://127.0.0.1:" + PORT + "/json/version"); break; } catch (e) { await new Promise((r) => setTimeout(r, 300)); }
  }
  await new Promise((r) => setTimeout(r, 5000));

  const list = await fetchJson("http://127.0.0.1:" + PORT + "/json/list").catch(() => []);
  console.log("Extension-relevante Targets:");
  list.filter((t) => /chrome-extension:/.test(t.url || "")).forEach((t) => console.log("  ->", t.type, t.url, "|", t.title));

  // Log nach Extension-Fehlern durchsuchen
  const lines = logBuf.split(/\r?\n/);
  const rel = lines.filter((l) => /extension|manifest|unpack|load-extension|Extension|crx|ServiceWorker/i.test(l) && !/ExtensionsBrowserClient|component|hangout|Hangouts|nkeimhogjdpnpccoofpliimaahmaaome/i.test(l));
  console.log("===== Relevante Log-Zeilen (" + rel.length + ") =====");
  console.log(rel.slice(0, 60).join("\n"));

  // Auch nach unserem Pfad suchen
  const mine = lines.filter((l) => /minimal-ext|deploy/i.test(l));
  console.log("===== Log-Zeilen mit unserem Pfad (" + mine.length + ") =====");
  console.log(mine.slice(0, 40).join("\n"));

  try { proc.kill(); } catch (e) {}
  process.exit(0);
})().catch((e) => { console.error("ERR", e); try { proc.kill(); } catch (x) {} process.exit(1); });
