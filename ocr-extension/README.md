# Local Screen OCR – Chrome-Erweiterung

Lokale, **100% offline** arbeitende Chrome-Erweiterung (Manifest V3), die per
Klick auf das Icon einen Bildschirmbereich auswählt, diesen mit **Tesseract.js
(WebAssembly)** in Text umwandelt und das Ergebnis in die Zwischenablage kopiert.

Es werden **keine** Cloud-Dienste, Server oder APIs verwendet. Alle Bilddaten
verbleiben auf dem Endgerät.

## Projektstruktur

```text
ocr-extension/
├── manifest.json
├── background.js          # Service Worker (Icon-Klick, Screenshot, Injection)
├── content.js             # Overlay-Auswahl, Crop, OCR, Clipboard
├── content.css            # Styles für Overlay & Toast
└── lib/                   # lokale Tesseract.js-Ressourcen (selbst ablegen)
    └── README.txt
```

## Installation

1. Tesseract.js-Ressourcen in `lib/` ablegen (siehe `lib/README.txt`).
2. `chrome://extensions/` öffnen.
3. **Entwicklermodus** aktivieren.
4. **Entpackte Erweiterung laden** → Ordner `ocr-extension` wählen.

## Nutzung

1. Auf das Extension-Icon klicken.
2. Den gewünschten Bereich mit gedrückter linker Maustaste aufziehen.
3. Text wird lokal erkannt und in die Zwischenablage kopiert.
4. `Esc` bricht die Auswahl ab.

## Sicherheit

Siehe [`SECURITY_AUDIT.md`](./SECURITY_AUDIT.md).
