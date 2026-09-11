/**
 * Debug5: Voller Dump aller Chrome-Prozess-Kommandozeilen.
 */
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const EXT = path.join(__dirname, "minimal-ext");
const CHROME = require("./_env").resolveChrome();
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
      "powershell -NoProfile -Command \"Get-CimInstance Win32_Process -Filter \\\"name='chrome.exe'\\\" | ForEach-Object { $_.CommandLine }\"",
      { maxBuffer: 1 << 24 }
    ).toString();
  } catch (e) {
    out = "ERR " + e.message;
  }
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  console.log("Anzahl chrome.exe Prozesse:", lines.length);
  lines.forEach((l, i) => {
    const flags = l.match(/--\S+(?:=\S+)?/g) || [];
    const interestingFlags = flags.filter((f) =>
      /extension|automation|headless|user-data-dir|remote-debugging|first-run|default-browser|load-extension/i.test(f)
    );
    console.log(`--- P${i} ---`);
    if (interestingFlags.length) console.log(interestingFlags.join(" "));
    else console.log("(keine relevanten Flags)  | hat load-extension:", /--load-extension/.test(l), "| hat disable-extensions:", /--disable-extensions/.test(l));
  });

  await ctx.close();
})().catch((e) => { console.error("ERR", e); process.exit(1); });
