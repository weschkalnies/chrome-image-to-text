/**
 * Debug6: chrome://extensions per CDP auslesen, um Ladefehler zu sehen.
 */
const { chromium } = require("playwright");
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
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      "--disable-extensions-except=" + EXT,
      "--load-extension=" + EXT,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  await new Promise((r) => setTimeout(r, 3000));
  const page = await ctx.newPage();
  await page.goto("chrome://extensions", { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 2000));

  // Developer-Mode-Toggle versuchen (falls noetig)
  try {
    const devToggle = page.locator("extensions-manager >> extensions-toolbar #devMode").first();
    if (await devToggle.count()) {
      await devToggle.click();
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (e) {}

  let text = "";
  try {
    const cdp = await ctx.newCDPSession(page);
    const res = await cdp.send("Runtime.evaluate", {
      expression: "document.body ? document.body.innerText : '(no body)'",
      returnByValue: true,
    });
    text = res && res.result && res.result.value ? res.result.value : JSON.stringify(res);
  } catch (e) {
    text = "CDP evaluate fehlgeschlagen: " + e.message;
  }
  console.log("===== chrome://extensions innerText =====");
  console.log(text);

  // Alle Targets nochmal
  const cdp2 = await ctx.newCDPSession(page);
  const { targetInfos } = await cdp2.send("Target.getTargets");
  console.log("===== Targets =====");
  for (const t of targetInfos) console.log(`  [${t.type}] ${t.url}`);

  await ctx.close();
})().catch((e) => { console.error("ERR", e); process.exit(1); });
