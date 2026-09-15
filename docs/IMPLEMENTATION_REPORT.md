# Implementierungsbericht – Local Screen OCR

## Zweck

Die Erweiterung ist eine lokale Manifest-V3-Chrome-Erweiterung. Nach einem
Klick auf das Erweiterungs-Icon kann der Nutzer einen sichtbaren Bereich
auswählen. Tesseract.js erkennt den Text vollständig lokal; der Nutzer kann
das Ergebnis vor dem expliziten Kopieren prüfen und bearbeiten.

Die ursprüngliche Anforderung ist in
[`chrome_ocr_extension_spec.md`](chrome_ocr_extension_spec.md) dokumentiert.

## Architektur und Build

- `src/` ist die alleinige Quelle für den Erweiterungscode.
- `npm run build` erzeugt daraus `deploy/`, den in Chrome zu ladenden Ordner.
- `npm run build:autotest` erzeugt zusätzlich `tests/deploy-autotest/` mit
  den ausschließlich für den Browser-Test nötigen Host-Berechtigungen.
- `npm run check` prüft, ob `deploy/` noch exakt dem Build aus `src/`
  entspricht.

Entwicklerdokumentation wird ausschließlich versioniert in `docs/` abgelegt.
Sie wird bewusst nicht in die ausgelieferte Erweiterung kopiert.

## Umgesetzte Sicherheits- und Robustheitsmaßnahmen

| Bereich | Maßnahme |
| --- | --- |
| Berechtigungen | Nur `activeTab` und `scripting`; keine dauerhaften Host-Berechtigungen. |
| Datenfluss | Keine Cloud, Telemetrie oder Speicherung von Screenshots und OCR-Text. |
| Ressourcen | Tesseract-Worker, -Core und Sprachmodelle werden lokal aus der Erweiterung geladen. |
| DOM-Sicherheit | UI-Ausgaben verwenden `textContent`; der editierbare OCR-Text liegt in einem geschlossenen Shadow-DOM. |
| Ressourcenverbrauch | Auswahl-Crops sind begrenzt und werden an Bildgrenzen angepasst. |
| Worker-Lebenszyklus | Bereits erzeugte Worker werden auch bei Teilfehlern oder Abbruch im `finally` terminiert. |
| Parallelität | Während Auswahl/OCR verhindert ein Status weitere gleichzeitige Läufe. |
| Injektion | Pro Tab werden parallele Injektionen zusammengeführt und vorhandene Content-Skripte per Ping erkannt. |
| Zwischenablage | Clipboard-API mit `execCommand`-Fallback und sichtbarer Erfolg-/Fehlermeldung. |

Eine ausführliche Bedrohungsanalyse mit Begründungen steht im
[Sicherheits-Audit](SECURITY_AUDIT.md).

## Verifikation

```bash
npm run build
npm run check
npm run test:background-injection
npm run test:worker-lifecycle
npm run test:e2e
```

Der E2E-Test deckt Screenshot, Injektion, Auswahl, lokale OCR, geschlossenen
Ergebnisdialog und das explizite Kopieren in die Zwischenablage ab.
