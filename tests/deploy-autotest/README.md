# Local Screen OCR – Chrome-Erweiterung

Lokale, **100% offline** arbeitende Chrome-Erweiterung (Manifest V3), die per
Klick auf das Icon einen Bildschirmbereich auswählt, diesen mit **Tesseract.js
(WebAssembly)** in Text umwandelt und das Ergebnis in die Zwischenablage kopiert.

Es werden **keine** Cloud-Dienste, Server oder APIs verwendet. Alle Bilddaten
verbleiben auf dem Endgerät.

## Projektstruktur

```text
chrome-image-to-text/
├── src/                   ← SINGLE SOURCE OF TRUTH (hier entwickeln!)
│   ├── manifest.json
│   ├── background.js      # Service Worker (Icon-Klick, Screenshot, Injection)
│   ├── content.js         # Overlay-Auswahl, Crop, OCR (Orchestrator)
│   ├── content.css        # Styles für Overlay & Toast
│   ├── icons/             # Extension-Icons
│   └── lib/
│       ├── ocr/           # Helper-Module (config, toast, logger, clipboard)
│       ├── tesseract.min.js … # lokale Tesseract.js-Ressourcen (Vendor)
│       └── README.md      # Herkunft & Update-Prozedur der Vendor-Dateien
├── deploy/                ← GENERIERT (npm run build) – in Chrome laden
├── tools/build.js         # Build-Skript (src → deploy, --autotest, --check)
├── tests/                 # Playwright-E2E-Harness (run2.cjs / run3.cjs)
└── package.json           # npm-Skripte (build / check / test:e2e)
```

## Entwicklung & Build

```bash
npm run build        # src/ → deploy/ neu erzeugen
npm run check        # prüfen, ob deploy/ auf dem Stand von src/ ist
npm run test:e2e     # Playwright-E2E-Test (lädt deploy/)
```

**Wichtig:** `deploy/` wird generiert und **niemals von Hand bearbeitet**.
Änderungen immer in `src/` machen und den Build laufen lassen.

## Installation (Test in Chrome)

1. `chrome://extensions/` öffnen.
2. **Entwicklermodus** aktivieren.
3. **Entpackte Erweiterung laden** → Ordner `deploy` wählen.

## Nutzung

1. Auf das Extension-Icon klicken.
2. Den gewünschten Bereich mit gedrückter linker Maustaste aufziehen.
3. Text wird lokal erkannt und in die Zwischenablage kopiert.
4. `Esc` bricht die Auswahl ab.

## Sicherheit

Siehe [`SECURITY_AUDIT.md`](./SECURITY_AUDIT.md).
