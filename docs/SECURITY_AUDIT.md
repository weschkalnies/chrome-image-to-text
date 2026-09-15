# Sicherheits-Audit – Local Screen OCR

Audit der ursprünglichen Spezifikation
([`chrome_ocr_extension_spec.md`](chrome_ocr_extension_spec.md)) und
Beschreibung der in dieser Implementierung umgesetzten Maßnahmen.

## 1. Bedrohungsmodell

Die Erweiterung verarbeitet **Screenshots beliebiger Webseiten lokal** und
schreibt erkannten Text in die Zwischenablage. Relevante Akteure:

- **Bösartige Webseite** (XSS / manipulierter Seiteninhalt): könnte versuchen,
  injizierte Skripte zu beeinflussen oder Ressourcen der Erweiterung abzufragen.
- **Nutzer**: klickt bewusst auf das Icon (transient activation) → dies ist der
  einzige Trigger. Kein automatisches Auslösen.
- **Lokaler Angreifer / Beobachter**: es werden keine Daten nach außen gesendet.

## 2. Festgestellte Schwachstellen in der Spezifikation und Behebung

### 2.1 `tab.url.startsWith(...)` ohne null-Check → TypeError / Crashes
- **Problem:** Mit nur `activeTab` ist `tab.url` nicht garantiert definiert.
  `tab.url.startsWith("chrome://")` wirft dann und der Handler bricht ab
  statt sauber abzulehnen.
- **Behebung:** `isInjectableUrl()` prüft defensiv auf `undefined`/Typ und
  lehnt unbekannte URLs ab. Zusätzlich werden weitere interne Schemata
  (`chrome-extension://`, `about:`, Web Store) blockiert.

### 2.2 Web Accessible Resources: zu breit & unvollständig
- **Problem:** Spec listet nur `tesseract.min.js` mit `matches: ["<all_urls>"]`.
  Für das reine `executeScript` ist WAR **nicht** nötig; für das tatsächliche
  Offline-OCR (Worker/Core/Lang per fetch aus dem Content-Skript) fehlen die
  Ressourcen aber komplett → die Spec-Variante ist **funktionsunfähig**.
- **Behebung:** WAR wird ausschließlich für die Tesseract-Sub-Ressourcen
  deklariert, die für offline-OCR wirklich nötig sind. `<all_urls>` bleibt
  erforderlich, weil `activeTab` auf jeder Nutzer-seite arbeiten muss.
  `use_dynamic_url` darf hier nicht gesetzt werden: Der Tesseract-Blob-Worker
  lädt den Core über die statische URL aus `chrome.runtime.getURL()`. Die
  statischen Ressourcen sind deshalb bewusst der dokumentierte
  Fingerprinting-Trade-off.
### 2.3 Mehrfach-Injektion bei Icon-Klicks und MV3-Neustarts
- **Problem:** Spec injiziert `tesseract.min.js` + `content.js` bei **jedem**
  Klick neu. Ein prozesslokales `Set` hilft bei parallelen Klicks nicht und
  verliert seinen Zustand, wenn der MV3-Service-Worker neu gestartet wird.
- **Behebung:** `INJECTION_PROMISES` führt gleichzeitige Injektionen pro Tab
  zusammen. Vor jeder neuen Injektion fragt ein `ocr_ping` das lebende
  Content-Skript ab; dadurch bleibt es auch nach einem Service-Worker-Neustart
  bei genau einer Injektion. Der `__ocrInitialized`-Guard bleibt als zweite
  Schutzschicht erhalten.

### 2.4 Toast mit `duration = 0` bleibt dauerhaft sichtbar (Bug)
- **Problem:** `showToast("Erkenne Text …")` ohne Duration → Toast bleibt
  für immer im DOM, selbst nach Erfolg.
- **Behebung:** Jeder Toast hat eine Default-Dauer und wird nach Ablauf
  sauber aus dem DOM entfernt (inkl. Animation-Timeout-Clearing).

### 2.5 DOM-XSS-Risiko durch Toast
- **Problem:** Spec nutzt zwar `textContent` (gut), aber es gibt keinen
  expliziten Schutz und kein Review-Hinweis.
- **Behebung:** Konsistente Verwendung von `textContent` (niemals
  `innerHTML`), kommentiert als Sicherheitsmaßnahme.

### 2.6 Keine Abbruchmöglichkeit (ESC)
- **Problem:** Ein Nutzer, der das Overlay versehentlich aktiviert, kann es
  nicht abbrechen und muss klicken.
- **Behebung:** `Esc` entfernt das Overlay inkl. aller Listener.

### 2.7 Clipboard ohne Fehlerbehandlung/Fallback
- **Problem:** `navigator.clipboard.writeText` schlägt z.B. bei fehlendem
  Fokus oder nicht-secure context leise fehl → Text geht verloren.
- **Behebung:** `copyToClipboard()` versucht zuerst die async Clipboard-API
  und fällt bei Fehlern auf `execCommand("copy")` zurück. Der Nutzer erhält
  explizites Feedback, ob das Kopieren geklappt hat.

### 2.8 Keine Größenbegrenzung des Crops (DoS)
- **Problem:** Ein extrem großer Auswahlrahmen erzeugt ein riesiges Canvas
  und kann den UI-Thread blockieren.
- **Behebung:** `maxCropPixels` (16 Mio. Px) Grenze; Quellbereich wird gegen
  die Bildgrenzen geclampt.

### 2.9 Worker-Leak bei OCR-Fehler
- **Problem:** Spec terminiert den Worker nur im Happy-Path. Bei
  `recognize()`-Fehler leakt der Web-Worker.
- **Behebung:** `try/finally` stellt sicher, dass `worker.terminate()`
  immer ausgeführt wird.

### 2.10 `document.body` nicht geprüft
- **Problem:** In seltenen Übergangszuständen kann `document.body` null sein.
- **Behebung:** Defensive Prüfungen vor `appendChild`.

### 2.11 Parallele Overlays
- **Problem:** Mehrfache `start_selection`-Messages könnten mehrere
  Overlays erzeugen.
- **Behebung:** `selectionInProgress`-Flag verhindert parallele Overlays.

### 2.12 OCR-Text im Webseiten-DOM wäre auslesbar
- **Problem:** Ein normales `textarea` im gemeinsamen DOM kann von Skripten
  der besuchten Webseite gelesen werden. Das wäre besonders für OCR von
  vertraulichen Bildschirminhalten ein unnötiges Datenleck.
- **Behebung:** Der editierbare Ergebnisdialog verwendet einen geschlossenen
  Shadow-DOM. Die Webseite kann den Dialog-Host sehen, aber weder den
  erkannten Text noch die Bedienoberfläche auslesen.

## 3. Berechtigungs-Minimierung (Least Privilege)

| Permission | Begründung | Risiko |
|------------|-----------|--------|
| `activeTab` | Zugriff nur nach Nutzer-Klick (transient). Erlaubt `captureVisibleTab` + `tab.url`. | Gering, temporär. |
| `scripting` | Injektion von Content-Skript/CSS in den aktiven Tab. | Gering, nur nach Klick. |

**Bewusst NICHT beantragt:** `tabs`, `host_permissions`, `<all_urls>`-host,
`clipboardWrite` (Clipboard läuft über die Page-API / execCommand-Fallback),
`storage`, jegliche Telemetrie.

## 4. Datenschutz

- Kein Netzwerkzugriff durch die Erweiterung selbst.
- Tesseract.js ist so konfiguriert, dass **alle** Ressourcen lokal geladen
  werden (`workerPath`, `corePath`, `langPath` → `chrome.runtime.getURL`).
  Andernfalls würde Tesseract standardmäßig CDN-Sprachdaten herunterladen
  (Daten verlassen das Gerät!). **Wichtig:** In `lib/` müssen die Dateien
  tatsächlich vorliegen, sonst schlägt OCR fehl statt zu „telefonieren“.
- Keine Speicherung von Bildern oder erkanntem Text über den
  Verarbeitungsvorgang hinaus.

## 5. Verbleibende Risiken / Empfehlungen

1. **Tesseract-CSP:** Seiten mit strenger CSP können das Laden des
   Tesseract-Web-Workern blockieren. Inhärent, nicht vollständig lösbar,
   da OCR im Page-Kontext läuft. Fehler werden dem Nutzer gemeldet.
2. **WAR `<all_urls>`:** Notwendig für `activeTab`-Einsatz auf jeder Seite.
   Bei ausschließlichem Einsatz auf bestimmten Domains kann `matches`
   eingeschränkt werden (Sicherheitsgewinn, Funktionsverlust).
3. **Tesseract-Version regelmäßig aktualisieren**, da die Bibliothek
   Sicherheits-Releases erhält.
4. **Code-Signing/Verifikation:** Vor Auslieferung SHA-256 der lokalen
   Tesseract-Dateien verifizieren, um Supply-Chain-Risiken zu minimieren.

## 6. Zusammenfassung

Die Spezifikation war ein guter Entwurf, enthielt aber einen **funktionalen
Blocker** (unvollständige Offline-Ressourcen) und mehrere **Sicherheits-/
Robustheitsmängel**. Diese Implementierung behebt alle genannten Punkte bei
gleichzeitig minimaler Berechtigung und 100%-Offline-Betrieb.
  **Trade-off:** Jede Seite kann diese statischen Bibliotheksdateien abrufen
  (Fingerprinting-Risiko minimal, da identisch für alle Installationen).
  Dynamic/Daten-Ressourcen sind **nicht** freigegeben.
