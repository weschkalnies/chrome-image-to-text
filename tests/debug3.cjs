/**
 * Diagnose3: minimale Extension laden, um --load-extension Grundfunktion zu pruefen.
 * Prueft auch, ob Playwright --disable-extensions per Default setzt.
 */
const { chromium } = require("playwright");
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

  // Standard-Args von Playwright anzeigen (ueber device-registry nicht direkt verfuegbar)
  console.log("Teste Target-Liste ...");

  await new Promise((r) => setTimeout(r, 3000));
  const page = ctx.pages()[0] || (await ctx.newPage());
  const cdp = await ctx.newCDPSession(page);
  const { targetInfos } = await cdp.send("Target.getTargets");
  console.log("===== Targets (" + targetInfos.length + ") =====");
  for (const t of targetInfos) {
    if (/extension|service_worker|chrome-extension/.test(t.url) || /extension/i.test(t.type))
      console.log(`  [${t.type}] ${t.url}`);
  }
  console.log("serviceWorkers (Playwright):", ctx.serviceWorkers().length);
  for (const sw of ctx.serviceWorkers()) console.log("  sw:", sw.url());

  await ctx.close();
})().catch((e) => { console.error("ERR", e); process.exit(1); });
