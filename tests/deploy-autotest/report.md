# Report – Local Screen OCR Chrome-Erweiterung

## 1. Auftrag

Entwicklung einer lokalen Chrome-Erweiterung (Manifest V3) auf Basis der
Spezifikation `chrome_ocr_extension_spec.md`: per Klick auf das Extension-Icon
einen Bildschirmbereich auswählen, lokal via **Tesseract.js (WebAssembly)** in
Text umwandeln und in die Zwischenablage kopieren. Anforderung: sauberer,
lesbarer Code und ein Sicherheits-Audit.

## 2. Ergebnis

Implementiert unter `.\ocr-extension\`:

```
ocr-extension/
├── manifest.json        # MV3, nur activeTab + scripting (Least Privilege)
├── background.js        # Service Worker: Icon-Klick, Screenshot, einmalige Injection
├── content.js           # Overlay-Auswahl, Crop (reale Bildskalierung), OCR, Clipboard (+Fallback)
├── content.css          # Overlay- & Toast-Styles
├── README.md            # Installation & Nutzung
├── SECURITY_AUDIT.md    # Vollständiger Sicherheits-Audit
└── lib/README.txt       # Anleitung zum Ablagen der Tesseract-Offline-Dateien
```

Alle Dateien wurden syntaktisch validiert (`node --check` OK,
`manifest.json` JSON-OK).

## 3. Sicherheits-Audit

Die Spezifikation wies mehrere Probleme auf, die in dieser Implementierung
behoben wurden (Detail-Dokumentation in `SECURITY_AUDIT.md`):

| # | Schwachstelle in der Spec                          | Behebung                                                                  |
|---|----------------------------------------------------|---------------------------------------------------------------------------|
| 1 | `tab.url.startsWith()` ohne null-Check → TypeError | `isInjectableUrl()` prüft defensiv, blockiert weitere interne Schemata    |
| 2 | WAR unvollständig → **funktional blockiert** (Worker/Core/Lang fehlen) | WAR nur für die wirklich nötigen Tesseract-Sub-Ressourcen |
| 3 | Skript-Injection bei Klicks/MV3-Neustarts (Speicher/Race) | Promise-Lock pro Tab + `ocr_ping` + `__ocrInitialized`-Guard |
| 4 | Toast `duration=0` bleibt ewig sichtbar (Bug)      | Default-Dauer + sauberes DOM-Removal                                       |
| 5 | DOM-XSS-Risiko                                     | konsequent `textContent`, nie `innerHTML`                                  |
| 6 | Kein Abbruch möglich                               | `Esc` entfernt Overlay + Listener                                          |
| 7 | Clipboard ohne Fallback                            | async Clipboard-API + `execCommand`-Fallback + Nutzer-Feedback             |
| 8 | Keine Größenbegrenzung (DoS)                       | `maxCropPixels`-Limit + Clamping                                           |
| 9 | Worker-Leak bei OCR-Fehler                         | `try/finally` → `terminate()` immer                                        |
| 10| `document.body` nicht geprüft                      | defensive Checks                                                           |
| 11| Parallele Overlays möglich                         | `selectionInProgress`-Flag                                                 |

### Berechtigungen (Least Privilege)

| Permission | Begründung | Risiko |
|------------|-----------|--------|
| `activeTab` | Zugriff nur nach Nutzer-Klick (transient). Erlaubt `captureVisibleTab` + `tab.url`. | Gering, temporär. |
| `scripting` | Injektion von Content-Skript/CSS in den aktiven Tab. | Gering, nur nach Klick. |

Bewusst **nicht** beantragt: `tabs`, `host_permissions`, `clipboardWrite`,
`storage`, jegliche Telemetrie.

## 4. Wichtiger Hinweis für den Betrieb

Damit die Erweiterung **wirklich 100 % offline** bleibt, müssen in `lib/` die
Tesseract.js-Dateien (v5) abgelegt werden:

- `tesseract.min.js`
- `tesseract-worker.min.js`
- `tesseract-core-simd.wasm.js` + `tesseract-core-simd.wasm`
- `eng.traineddata.gz`
- `deu.traineddata.gz`

Ohne diese Dateien schlägt OCR bewusst fehl, statt heimlich Sprachdaten aus
dem CDN zu laden — das ist eine bewusste Datenschutz-Entscheidung, die im
Audit begründet ist. Bezugsquelle und Hinweise stehen in `lib/README.txt`.

## 5. Datenschutz

- Kein Netzwerkzugriff durch die Erweiterung selbst.
- Tesseract.js ist so konfiguriert, dass **alle** Ressourcen lokal geladen
  werden (`workerPath`, `corePath`, `langPath` → `chrome.runtime.getURL`).
- Keine Speicherung von Bildern oder erkanntem Text über den
  Verarbeitungsvorgang hinaus.

## 6. Verbleibende Risiken / Empfehlungen

1. **Tesseract-CSP:** Seiten mit strenger CSP können das Laden des
   Tesseract-Web-Workers blockieren. Inhärent, nicht vollständig lösbar.
2. **WAR `<all_urls>`:** Notwendig für `activeTab`-Einsatz auf jeder Seite;
   bei einsatz auf bestimmten Domains einschränkbar.
3. **Tesseract-Version regelmäßig aktualisieren** (Sicherheits-Releases).
4. **Code-Signing/Verifikation:** Vor Auslieferung SHA-256 der lokalen
   Tesseract-Dateien verifizieren (Supply-Chain-Schutz).

## 7. Fazit

Die Spezifikation war ein guter Entwurf, enthielt aber einen **funktionalen
Blocker** (unvollständige Offline-Ressourcen) und mehrere **Sicherheits-/
Robustheitsmängel**. Die vorliegende Implementierung behebt alle genannten

## 8. Automatisierter Test (Playwright) & gefundene Root Cause

Die Erweiterung wurde automatisiert mit **Playwright** (an ein reales
System-Chrome 152 per CDP angebunden) End-to-End getestet. Da MCP-Server
nicht mitten in einer Session hinzugefuegt werden koennen, wurde Playwright
als Node-Bibliothek genutzt. Test-Setup unter `tests/`:

- `tests/run2.cjs` – vollstaendiger E2E-Test (Chrome starten, Extension via
  CDP `Extensions.loadUnpacked` laden, OCR-Flow ausloesen, Maus-Auswahl
  simulieren, Logs einsammeln)
- `tests/run3.cjs` – isolierter OCR-Kern-Test (Tesseract direkt in der Seite)
- `tests/page.html` – Testseite mit Text
- `tests/deploy-autotest/` – Test-Kopie mit zusaetzlichem `host_permissions`
  (nur fuer die Automatisierung noetig, da `activeTab` nur bei echtem
  Nutzer-Klick greift)

### Wichtige Erkenntnis: Chrome 152 laedt Extensions nicht mehr per `--load-extension`

Der klassische Weg (`--load-extension` + `--disable-extensions-except`) wird
von Chrome 152 **ignoriert** (kein Service-Worker, keine Fehlermeldung).
Abhilfe schafft der moderne CDP-Befehl **`Extensions.loadUnpacked`**, der die
Extension zuverlaessig laedt und die Extension-ID zurueckliefert.

### Root Cause des Nutzer-Fehlers „Fehler bei der Texterkennung"

Der Test offenbarte die exakte Ursache:

```
NetworkError: Failed to execute 'importScripts' on 'WorkerGlobalScope':
The script at '.../lib/tesseract-core-simd-lstm.wasm.js' failed to load.
```

**Ursache:** Die Erweiterung nutzt OEM 1 (LSTM-Modus) mit den 4.0.0-LSTM-
Sprachmodellen, benoetigt also den **LSTM-Core** (`tesseract-core-simd-lstm.*`).
Ausgeliefert war aber nur der **Legacy-Core** (`tesseract-core-simd.*` ohne
LSTM). Tesseract konnte den Worker nicht initialisieren.

**Behebung:** Die Dateien `tesseract-core-simd-lstm.wasm.js` und
`tesseract-core-simd-lstm.wasm` wurden in `deploy/lib/` ergaenzt und in
`manifest.json` (`web_accessible_resources`) aufgenommen. Beide Core-Varianten
liegen jetzt vor; Tesseract waehlt selbst die benoetigte aus.

### Test-Ergebnis nach dem Fix (E2E, aus `tests/run2.out.txt`)

```
[OCR] Overlay wird erstellt 1280x720 DPR=2
trigger result: {"ok":true}
[OCR] Screenshot geladen 2560x1440
[OCR] Crop erzeugt 40494 Zeichen dataURL
[OCR] Tesseract: loading tesseract core 100%
[OCR] Tesseract: loading language traineddata 100%
[OCR] Tesseract: recognizing text 100%
[OCR] recognize() fertig ok -> Worker terminiert
[OCR] OCR fertig, Textlaenge 17 kopiert: true
finaler Toast: Text in Zwischenablage kopiert!
```

Der **komplette Flow** laeuft fehlerfrei: Screenshot -> Injection ->
Overlay -> Maus-Auswahl -> Crop -> Tesseract-OCR -> Zwischenablage ->
Erfolgsmeldung. Erkannter Text „HELLO WORLD 12345" (17 Zeichen), korrekt
in die Zwischenablage kopiert.

### Hinweis zu Test-Artefakten

- `captureVisibleTab` kann eine andere physische Aufloesung als der CSS-Viewport
  liefern. Der Crop skaliert deshalb anhand von `naturalWidth / innerWidth`
  und `naturalHeight / innerHeight`, nicht anhand von `devicePixelRatio`.
- Die zusaetzlichen `host_permissions` im Test-Manifest sind **nur** fuer die
  Automatisierung (da kein echter Icon-Klick = kein `activeTab`). Das
  ausgelieferte `deploy/manifest.json` bleibt bei `activeTab` + `scripting`
  (Least Privilege).
Punkte bei gleichzeitig minimaler Berechtigung und 100 %-Offline-Betrieb.
