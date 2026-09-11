/**
 * Diagnose: warum wird die Erweiterung nicht geladen?
 * Listet alle Targets und screenshotet chrome://extensions.
 */
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const EXT = path.join(__dirname, "..", "deploy");
const CHROME = require("./_env").resolveChrome();
const TMP = path.join(__dirname, ".tmp-profile");

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

  await new Promise((r) => setTimeout(r, 3000));
  console.log("pages:", ctx.pages().length);
  for (const p of ctx.pages()) console.log("  page url:", p.url());
  console.log("serviceWorkers:", ctx.serviceWorkers().length);
  for (const sw of ctx.serviceWorkers()) console.log("  sw url:", sw.url());

  const page = ctx.pages()[0] || (await ctx.newPage());
  try {
    await page.goto("chrome://extensions", { waitUntil: "load" });
    await new Promise((r) => setTimeout(r, 1500));
    await page.screenshot({ path: path.join(__dirname, "extensions.png") });
    console.log("screenshot saved: extensions.png");
  } catch (e) {
    console.log("goto chrome://extensions failed:", e.message);
  }

  await ctx.close();
})().catch((e) => { console.error("ERR", e); process.exit(1); });
