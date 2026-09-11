/**
 * Diagnose: warum wird die Erweiterung nicht geladen?
 * Nutzt CDP Target.getTargets, um auch Erweiterungs-Targets zu sehen,
 * und liest die Accessibility-Texte von chrome://extensions.
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
  const page = ctx.pages()[0] || (await ctx.newPage());

  const cdp = await ctx.newCDPSession(page);
  const { targetInfos } = await cdp.send("Target.getTargets");
  console.log("===== Targets (" + targetInfos.length + ") =====");
  for (const t of targetInfos) {
    console.log(`  [${t.type}] ${t.url}  | title=${t.title} | attached=${t.attached}`);
  }

  try {
    await page.goto("chrome://extensions", { waitUntil: "load" });
    await new Promise((r) => setTimeout(r, 1500));
    const snap = await page.accessibility.snapshot();
    const texts = [];
    function walk(node) {
      if (!node) return;
      if (node.name) texts.push(node.name);
      if (node.value) texts.push(String(node.value));
      (node.children || []).forEach(walk);
    }
    walk(snap);
    console.log("===== chrome://extensions Text =====");
    console.log(texts.join(" | "));
  } catch (e) {
    console.log("chrome://extensions Lesen fehlgeschlagen:", e.message);
  }

  await ctx.close();
})().catch((e) => { console.error("ERR", e); process.exit(1); });
