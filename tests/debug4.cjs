/**
 * Debug4: Zeigt die tatsaechlichen Kommandozeilen-Args der Chrome-Prozesse.
 */
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const EXT = path.join(__dirname, "minimal-ext");
const CHROME = require("./_env.cjs").resolveChrome();
const TMP = path.join(__dirname, ".tmp-profile-min");

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(TMP, {
    executablePath: CHROME,
    headless: false,
    viewport: { width: 1280, height: 720 },
    args: [
      "--disable-extensions-except=" + EXT,
      "--load-extension=" + EXT,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  await new Promise((r) => setTimeout(r, 2500));

  let out = "";
  try {
    out = execSync(
      "powershell -NoProfile -Command \"Get-CimInstance Win32_Process -Filter \\\"name='chrome.exe'\\\" | Select-Object -ExpandProperty CommandLine\"",
      { maxBuffer: 1 << 24 }
    ).toString();
  } catch (e) {
    out = "ERR " + e.message;
  }
  // Nur relevante Flags zeigen
  const lines = out.split("\n");
  const interesting = lines.filter((l) =>
    /--load-extension|--disable-extensions|--enable-automation|--headless|--remote-debugging-port|--user-data-dir/i.test(l)
  );
  console.log("===== Relevante Chrome-Args =====");
  // Nimm die erste (Haupt-)Prozesszeile und zerlege Flags
  const main = lines.find((l) => l.includes("--user-data-dir")) || lines[0] || "";
  const flags = main.match(/--\S+/g) || [];
  const want = flags.filter((f) =>
    /extension|automation|headless|user-data-dir|remote-debugging|no-first-run|no-default-browser/i.test(f)
  );
  console.log(want.join("\n"));

  await ctx.close();
})().catch((e) => { console.error("ERR", e); process.exit(1); });
