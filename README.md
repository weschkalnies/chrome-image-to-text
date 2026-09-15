# Local Screen OCR

Eine lokale Chrome-Erweiterung (Manifest V3): Bereich auf dem Bildschirm
auswählen, mit Tesseract.js offline erkennen, Text prüfen oder bearbeiten und
anschließend kopieren. Bilddaten und OCR-Ergebnisse verlassen das Gerät nicht.

![Infografik: Bereich auswählen, lokal per OCR erkennen, Text bearbeiten und kopieren](docs/images/ocr-workflow-v3.png)

## Funktionen

- 100 % lokale OCR mit Tesseract.js und den Sprachmodellen Deutsch/Englisch
- Auswahl per Maus, Abbruch mit `Esc`
- Editierbarer Ergebnisdialog mit Konfidenz, Sprache und explizitem Kopieren
- Hohe-DPI- und Screenshot-Skalierung anhand der tatsächlichen Bildgröße
- Keine dauerhaften Host-Berechtigungen: nur `activeTab` und `scripting`
- Robuste Worker- und Injektionsverwaltung für Manifest V3

## Schnellstart

Voraussetzungen: aktuelles Google Chrome oder Chromium und Node.js.

```bash
npm run build
```

Danach in Chrome:

1. `chrome://extensions/` öffnen.
2. Entwicklermodus aktivieren.
3. **Entpackte Erweiterung laden** wählen.
4. Den Ordner `deploy/` auswählen.

## Nutzung

1. Das Erweiterungs-Icon anklicken.
2. Einen Bereich mit der Maus aufziehen.
3. Den erkannten Text im Dialog prüfen oder bearbeiten.
4. **Kopieren** wählen, um ihn in die Zwischenablage zu schreiben.

`Esc` beendet eine laufende Auswahl, eine OCR oder schließt den Ergebnisdialog.

## Entwicklung

`src/` ist die einzige Quelle. `deploy/` und `tests/deploy-autotest/` werden
generiert und dürfen nicht manuell bearbeitet werden.

```bash
npm run build              # src/ nach deploy/ erzeugen
npm run build:autotest     # zusätzlich die Test-Extension erzeugen
npm run check              # prüft, ob deploy/ aktuell ist
```

Für die Browser-Tests müssen die Testabhängigkeiten einmal installiert werden:

```bash
npm --prefix tests ci
npm run test:background-injection
npm run test:worker-lifecycle
npm run test:e2e
```

`test:e2e` prüft den vollständigen Ablauf einschließlich OCR, Ergebnisdialog
und explizitem Kopieren in die Zwischenablage.

## Projektstruktur

```text
chrome-image-to-text/
├── src/                    # Quellcode der Erweiterung
│   ├── background.js        # Service Worker: Screenshot und Injektion
│   ├── content.js           # Auswahl, Crop und OCR-Orchestrierung
│   ├── content.css          # Auswahl- und Toast-Styles
│   ├── icons/               # Icon-Familie
│   └── lib/                 # OCR-, UI- und lokale Tesseract-Ressourcen
├── deploy/                  # generierte, in Chrome zu ladende Erweiterung
├── tests/                   # Browser- und Regressionstests
├── tools/build.js           # Build- und Drift-Prüfung
├── docs/                    # versionierte Entwicklerdokumentation
└── package.json             # npm-Skripte
```

## Datenschutz und Sicherheit

- Keine Cloud, Telemetrie oder externen OCR-Anfragen.
- Der editierbare Ergebnisdialog liegt in einem geschlossenen Shadow-DOM, damit
  Skripte der besuchten Webseite den erkannten Text nicht auslesen können.
- Das vollständige Audit und weitere Entwicklerdokumentation stehen in
  [docs/](docs/README.md).

## Release-Check

Vor einer Auslieferung:

```bash
npm run build
npm run check
npm run test:e2e
```

Der Projektstand kann anschließend über den Ordner `deploy/` als entpackte
Erweiterung getestet oder für den jeweiligen Distributionskanal paketiert
werden.

## Unterstützung

Wenn Du mich unterstützen möchtest, kannst Du mir gern einen Kaffee spendieren:
[Buy Me a Coffee](https://buymeacoffee.com/weschkalnies).

## Lizenz

Für dieses Repository ist derzeit keine Lizenz festgelegt. Tesseract.js und
die ausgelieferten Tesseract-Ressourcen unterliegen ihren jeweiligen Lizenzen.
