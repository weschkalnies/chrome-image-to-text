# Projekt-Wissensbasis – Local Screen OCR

## Kurzüberblick

Local Screen OCR ist eine lokale Chrome-Erweiterung (Manifest V3): Icon-Klick,
Bereich auswählen, offline mit Tesseract.js erkennen, Ergebnis prüfen und
explizit kopieren. Es gibt keine Cloud-Anbindung, Telemetrie oder dauerhafte
Speicherung der Bild- und Textdaten.

## Verbindliche Projektregeln

- Code wird ausschließlich in `src/` geändert.
- `deploy/` und `tests/deploy-autotest/` sind generierte Artefakte. Nach
  Quellcodeänderungen `npm run build` bzw. `npm run build:autotest` ausführen.
- Vor einem Commit mit Erweiterungsänderungen `npm run check` ausführen.
- Entwicklerdokumentation, Audits, technische Berichte und Release-Hinweise
  gehören nach `docs/`, nicht in die auslieferbare Erweiterung.

## Architektur

`background.js` nimmt nach einem Nutzer-Klick einen Screenshot auf, sorgt pro
Tab für eine einmalige Content-Script-Injektion und startet die Auswahl.
`content.js` koordiniert Auswahl, Crop und OCR. Die Helfer liegen unter
`src/lib/ocr/`; der geschützte Ergebnisdialog unter `src/lib/ui/result.js`.

Die OCR-Ressourcen liegen lokal in `src/lib/`. Ihre Versionen und die
Aktualisierung sind in [TESSERACT_VENDOR.md](TESSERACT_VENDOR.md) dokumentiert.

## Tests

```bash
npm run build
npm run check
npm run test:background-injection
npm run test:worker-lifecycle
npm run test:e2e
```

Der E2E-Test verwendet eine separat erzeugte Test-Extension mit
`host_permissions`, weil `activeTab` nur durch einen echten Nutzer-Klick
vergeben wird. Diese zusätzliche Berechtigung ist nicht Teil von `deploy/`.

## Wichtige Sicherheitsentscheidung

Der OCR-Text wird vor dem Kopieren in einem geschlossenen Shadow-DOM angezeigt.
Dadurch können Skripte der gerade besuchten Webseite den editierbaren Text
nicht auslesen. Details und verbleibende Risiken stehen im
[Sicherheits-Audit](SECURITY_AUDIT.md).
