/**
 * Debug9: Chrome direkt starten (OHNE --load-extension) und die Extension
 * ueber den CDP-Befehl "Extensions.loadUnpacked" laden. Das ist der moderne,
 * zuverlaessige Weg in neueren Chrome-Versionen.
 */
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

const EXT = path.join(__dirname, "..", "deploy");
const CHROME = require("./_env").resolveChrome();
const TMP = path.join(__dirname, ".tmp-profile-cdp");
const PORT = 9335;

fs.rmSync(TMP, { recursive: true, force: true });

const args = [
  "--user-data-dir=" + TMP,
  "--remote-debugging-port=" + PORT,
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
];

const proc = spawn(CHROME, args, { detached: false, stdio: "ignore" });

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

async function waitForPort(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { return await fetchJson("http://127.0.0.1:" + PORT + "/json/version"); } catch (e) { await new Promise((r) => setTimeout(r, 300)); }
  }
  throw new Error("Port nicht erreichbar");
}

function cdpCall(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e6);
    const onMsg = (ev) => {
      let data;
      try { data = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()); } catch (e) { return; }
      if (data.id === id) {
        ws.removeEventListener("message", onMsg);
        if (data.error) reject(new Error(method + ": " + JSON.stringify(data.error)));
        else resolve(data.result);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

(async () => {
  try {
    const ver = await waitForPort(15000);
    console.log("Chrome:", ver.Browser);
    const wsUrl = ver.webSocketDebuggerUrl;
    console.log("Browser WS:", wsUrl);

    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    console.log("Rufe Extensions.loadUnpacked auf mit Pfad:", EXT);
    try {
      const r = await cdpCall(ws, "Extensions.loadUnpacked", { path: EXT });
      console.log("loadUnpacked OK:", JSON.stringify(r));
    } catch (e) {
      console.log("loadUnpacked FEHLER:", e.message);
    }
    ws.close();

    await new Promise((r) => setTimeout(r, 4000));

    const list = await fetchJson("http://127.0.0.1:" + PORT + "/json/list");
    console.log("===== Targets =====");
    list.forEach((t) => console.log(`  [${t.type}] ${t.url}  | ${t.title}`));
  } catch (e) {
    console.error("ERR", e.message);
  } finally {
    try { proc.kill(); } catch (e) {}
    process.exit(0);
  }
})();
