# Projektüberblick – Local Screen OCR

## Komponenten

```text
Nutzerklick
  -> src/background.js: Screenshot, sichere Injektion, Startnachricht
  -> src/content.js: Auswahl, Bild-Crop, OCR-Ablauf
  -> src/lib/ocr/*: Konfiguration, Logging, Toast, Zwischenablage
  -> src/lib/ui/result.js: editierbarer Ergebnisdialog im geschlossenen Shadow-DOM
```

`src/` ist die Quelle. `npm run build` kopiert sie nach `deploy/`; Chrome lädt
nur diesen erzeugten Ordner. `tests/deploy-autotest/` ist ein weiterer,
automatisch erzeugter Build für die Playwright-Tests.

## Datenfluss und Grenzen

- `captureVisibleTab()` liefert den Screenshot der aktiven Seite nach einem
  expliziten Klick auf das Erweiterungs-Icon.
- Der Crop verwendet das Verhältnis von natürlicher Bildgröße zu CSS-Viewport,
  damit unterschiedliche Screenshot- und DPI-Skalierungen korrekt bleiben.
- Ein temporärer Tesseract-Worker verarbeitet den Crop mit lokalen Sprach-
  und Core-Dateien und wird in jedem Fall terminiert.
- Das Ergebnis bleibt bis zum vom Nutzer ausgelösten Kopieren im Dialog.

## Berechtigungen

Die Produktions-Erweiterung beantragt ausschließlich `activeTab` und
`scripting`. Statische OCR-Unterressourcen sind als Web Accessible Resources
freigegeben, damit der lokal gestartete Tesseract-Worker sie laden kann.

## Weiterführende Dokumente

- [Projekt-Wissensbasis](PROJECT_KNOWLEDGE.md)
- [Sicherheits-Audit](SECURITY_AUDIT.md)
- [Implementierungsbericht](IMPLEMENTATION_REPORT.md)
- [Verbesserungsplan](improvements-plan.md)
