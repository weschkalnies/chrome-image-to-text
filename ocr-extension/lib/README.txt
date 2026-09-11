# Tesseract.js Bibliothek (offline)

In diesen Ordner müssen die Tesseract.js-Ressourcen lokal abgelegt werden,
damit die Erweiterung **100% offline** arbeitet.

## Benötigte Dateien

Lade die aktuelle Tesseract.js-Version (≥ v5) von
<https://github.com/naptha/tesseract.js/releases> herunter und kopiere:

| Datei | Verwendung |
|-------|------------|
| `tesseract.min.js`        | Haupt-Skript (wird via `executeScript` injiziert) |
| `tesseract-worker.min.js` | Web-Worker (wird via `workerPath` geladen) |
| `tesseract-core-simd.wasm.js` + `tesseract-core-simd.wasm` | WASM-Core |
| `eng.traineddata.gz`      | Englische Sprachdaten |
| `deu.traineddata.gz`      | Deutsche Sprachdaten |

Alle Dateien sind in `manifest.json` unter `web_accessible_resources`
eingetragen, damit sie aus dem Content-Skript geladen werden können.

> Hinweis: Diese Dateien werden aus Lizenz- und Größengründen nicht im
> Repository mitgeliefert. Siehe `SECURITY_AUDIT.md` bzgl. der
> `<all_urls>`-Entscheidung.
