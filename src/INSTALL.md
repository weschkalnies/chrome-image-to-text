# Local Screen OCR – Installation (Test in Chrome)

Diese Version ist **fertig zum Testen** – alle Tesseract.js-Dateien liegen
bereits lokal in `lib/` (100% offline).

## Schritte

1. Chrome öffnen → `chrome://extensions/` aufrufen.
2. Oben rechts den **Entwicklermodus** einschalten.
3. Auf **Entpackte Erweiterung laden** klicken.
4. Den Ordner `deploy` auswählen:
   `.\deploy`

## Nutzung

1. Auf das Extension-Icon in der Toolbar klicken.
2. Gewünschten Bereich mit gedrückter linker Maustaste aufziehen.
3. Text wird lokal erkannt und in die Zwischenablage kopiert
   (Toast zeigt den Status).
4. `Esc` bricht die Auswahl ab.

## Hinweise

- Funktioniert nicht auf Browser-internen Seiten
  (`chrome://`, Web Store, `about:`).
- Seiten mit sehr strenger CSP können das Laden des Tesseract-Web-Workers
  blockieren → Fehler-Toast erscheint.
- Beim ersten OCR-Lauf lädt Tesseract die WASM-Core- und Sprachdaten aus
  `lib/` (lokal, kein Netzwerk) – das kann 1–2 Sekunden dauern.
