# Tesseract.js-Ressourcen (Vendor, 100% offline)

Die Dateien in diesem Ordner sind die lokalen Tesseract.js-Ressourcen.
Sie werden **mit dem Repository geliefert**, damit die Erweiterung
**100 % offline** arbeitet (kein Download zur Laufzeit, keine Cloud).

## Enthaltene Dateien (Tesseract.js v5.1.1 / tesseract.js-core v5.1.0)

| Datei | Quelle | Verwendung |
|-------|--------|------------|
| `tesseract.min.js` | `tesseract.js@5.1.1/dist/tesseract.min.js` | Haupt-Skript (via `executeScript` injiziert) |
| `worker.min.js` | `tesseract.js@5.1.1/dist/worker.min.js` | Web-Worker (via `workerPath` geladen) |
| `tesseract-core-simd.wasm.js` | `tesseract.js-core@5.1.0/` | Legacy-Core, JS-Loader |
| `tesseract-core-simd.wasm` | `tesseract.js-core@5.1.0/` | Legacy-Core, WASM |
| `tesseract-core-simd-lstm.wasm.js` | `tesseract.js-core@5.1.0/` | **LSTM-Core, JS-Loader (erforderlich!)** |
| `tesseract-core-simd-lstm.wasm` | `tesseract.js-core@5.1.0/` | **LSTM-Core, WASM (erforderlich!)** |
| `eng.traineddata.gz` | `@tesseract.js-data/eng@1.0.0/4.0.0/` | Englisch (LSTM-Modell) |
| `deu.traineddata.gz` | `@tesseract.js-data/deu@1.0.0/4.0.0/` | Deutsch (LSTM-Modell) |

> **Wichtig:** Der LSTM-Core (`tesseract-core-simd-lstm.*`) ist zwingend
> nötig – ohne ihn schlägt die Texterkennung fehl (OEM 1 = LSTM only).

Alle Dateien sind in `manifest.json` unter `web_accessible_resources`
eingetragen, damit sie aus dem Content-Skript geladen werden können.

## Update-Prozedur

1. Versionen exakt notieren (siehe Tabelle oben, ABI/API-Risiko).
2. Neue Dateien von jsDelivr/unpkg beziehen und in `src/lib/` ersetzen.
3. `manifest.json` (`web_accessible_resources`) bei Bedarf ergänzen.
4. Build + E2E-Test ausführen (`npm run build && npm run test:e2e`).

Lizenzen: Tesseract.js und Cores (Apache-2.0), traineddata (Apache-2.0).
