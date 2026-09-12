# Local Screen OCR

> Eine lokale Chrome-Erweiterung (Manifest V3), die einen Bildschirmbereich per Maus auswählt, ihn **100 % offline** mit Tesseract.js (WebAssembly) in Text umwandelt und das Ergebnis direkt in die Zwischenablage kopiert.

Keine Cloud. Keine Server. Keine APIs. Keine Telemetrie. Alle Bilddaten verlassen nie dein Gerät.

---

## ✨ Features

- 🔒 **100 % lokal & offline** – die komplette OCR-Pipeline (WASM-Core + Sprachmodelle) liegt mit in der Erweiterung. Beim Erkennen wird kein einziges Byte ins Netz geschickt.
- 🖱️ **Einfache Bedienung** – Icon-Klick → Bereich mit der Maus aufziehen → erkannter Text landet in der Zwischenablage.
- 🌐 **Mehrsprachig** – erkennt **Englisch** und **Deutsch** (Tesseract 4.0.0 LSTM-Modelle). Weitere Sprachen lassen sich durch zusätzliche `traineddata.gz`-Dateien ergänzen.
- 🖼️ **High-DPI-korrekt** – berücksichtigt `window.devicePixelRatio`, damit Screenshots auf Retina-/4K-Displays scharf und maßstabsgetreu erkannt werden.
- 🛡️ **Least Privilege** – nur die Berechtigungen `activeTab` + `scripting`. Zugriff auf einen Tab erfolgt ausschließlich nach deinem bewussten Klick (*transient activation*), nie automatisch.
- 🔐 **Sicher gehärtet** – IIFE-Guard gegen Mehrfach-Injektion, nur `textContent` (kein `innerHTML` → kein DOM-XSS), Blob-Worker-URL umgeht restriktive Seiten-CSP, Dimensions-Limits als DoS-Schutz, defensives Null-Checking.
- 📋 **Robuste Zwischenablage** – nutzt die asynchrone Clipboard-API mit `execCommand`-Fallback für nicht-sichere Kontexte.
- 🧪 **Automatisiert getestet** – End-to-End-Test mit Playwright (System-Chrome 152) über `chrome.management.Extensions.loadUnpacked`.

---

## 🚀 Installation (in Chrome testen)

Die Erweiterung ist nicht im Chrome Web Store. Zum Testen als **entpackte Erweiterung** laden:

1. Chrome öffnen → `chrome://extensions/` aufrufen.
2. Oben rechts den **Entwicklermodus** einschalten.
3. Auf **Entpackte Erweiterung laden** klicken.
4. Den Ordner [`deploy/`](./deploy) auswählen.

> Die `deploy/`-Version enthält alle Tesseract-Ressourcen bereits lokal in `deploy/lib/` – sie ist sofort einsatzbereit.

---

## 🖱️ Nutzung

1. Auf das **Extension-Icon** in der Toolbar klicken.
2. Den gewünschten Bereich mit gedrückter linker Maustaste aufziehen.
3. Der Text wird lokal erkannt und in die **Zwischenablage** kopiert (ein Toast zeigt den Status).
4. `Esc` bricht die Auswahl jederzeit ab.

Anschließend kannst du den erkannten Text überall mit `Strg`/`Cmd`+`V` einfügen.

---

## 🧩 Funktionsweise

```
Icon-Klick ──► background.js
                 │  Prüfung: Seite injizierbar? (keine chrome://, Web Store …)
                 │  Screenshot via chrome.tabs.captureVisibleTab (PNG)
                 │  Einmalige Injektion von tesseract.min.js + content.js + content.css
                 ▼
              content.js
                 │  Canvas-Overlay zur Bereichsauswahl (Maus)
                 │  Crop inkl. devicePixelRatio
                 │  Tesseract.js createWorker(["eng","deu"], LSTM)  ◄── offline aus lib/
                 │  navigator.clipboard.writeText (+ Fallback)
                 ▼
              Toast: „Text in Zwischenablage kopiert!“
```

---

## 🛠️ Tech-Stack

| Komponente           | Version | Zweck                                    |
|----------------------|---------|------------------------------------------|
| Chrome Extension     | MV3     | Plattform                                |
| Tesseract.js         | 5.1.1   | OCR-Hauptbibliothek                      |
| tesseract.js-core    | 5.1.0   | WASM-Core (SIMD-LSTM)                    |
| eng.traineddata.gz   | 4.0.0   | Englisch-Modell (LSTM)                   |
| deu.traineddata.gz   | 4.0.0   | Deutsch-Modell (LSTM)                    |
| Playwright           | ^1.63   | Automatisierter E2E-Test                 |

---

## 📁 Projektstruktur

```text
chrome-image-to-text/
├── deploy/                 ← FERTIGE, testbare Version (Chrome lädt diese)
│   ├── manifest.json       ← MV3, activeTab + scripting, Web Accessible Resources
│   ├── background.js       ← Service Worker: Icon-Klick, Screenshot, einmalige Injektion
│   ├── content.js          ← Overlay/Crop/OCR/Clipboard + Fehlerdiagnose
│   ├── content.css         ← Overlay- & Toast-Styles
│   ├── INSTALL.md          ← Chrome-Installationsanleitung
│   ├── README.md / report.md / SECURITY_AUDIT.md
│   └── lib/                ← Tesseract-Ressourcen (offline, ~32 MB)
│       ├── tesseract.min.js / worker.min.js
│       ├── tesseract-core-simd-lstm.wasm(.js)
│       ├── tesseract-core-simd.wasm(.js)
│       └── eng.traineddata.gz / deu.traineddata.gz
│
├── ocr-extension/         ← Quelltext-/Doku-Version (Referenz)
├── tests/                 ← Playwright-E2E-Tests
├── chrome_ocr_extension_spec.md   ← Ursprüngliche Spezifikation
└── PROJECT_KNOWLEDGE.md   ← Zentrale Wissensbasis & Fallstricke
```

---

## 🧪 Tests

End-to-End-Tests mit Playwright gegen den System-Chrome (geladen via
`Extensions.loadUnpacked`):

```bash
cd tests
npm install
node run2.cjs ./deploy-autotest   # vollständiger E2E-Test
```

Beweis-Outputs: `tests/run2.out.txt` (E2E) und `tests/run3.out.txt` (OCR-Kern).

> Hinweise:
> - Chrome wird automatisch gesucht (`$env:CHROME_PATH` → Plattform-Standardpfad → Playwright-Bundled-Chromium), siehe `tests/_env.cjs`.
> - Extension-Pfade werden relativ zum `tests/`-Verzeichnis aufgelöst – keine hartcodierten Pfade.

---

## ⚠️ Limitierungen

- **Keine Browser-internen Seiten:** funktioniert nicht auf `chrome://`, `chrome-extension://`, `about:` oder im Chrome Web Store.
- **Strikte CSP:** Seiten mit sehr restriktiver `worker-src`-CSP können den Tesseract-Web-Worker blockieren. Abgemildert via `workerBlobURL: true`, aber nicht in jedem Fall vermeidbar – ein Fehler-Toast erscheint.
- **Erstlauf-Ladezeit:** beim ersten OCR-Lauf pro Tab lädt Tesseract die WASM-Core- und Sprachdaten aus `lib/` (lokal, kein Netzwerk) – das kann 1–2 Sekunden dauern.
- **Nur Englisch & Deutsch** vorkonfiguriert – weitere Sprachen durch zusätzliche `traineddata.gz`-Dateien in `lib/` (und Eintrag im `manifest.json`) möglich.
- **SIMD vorausgesetzt:** die mitgelieferten Cores nutzen SIMD. Auf CPUs ohne SIMD ggf. die non-SIMD-Varianten (`tesseract-core(-lstm).wasm*`) zusätzlich liefern.

---

## 🔒 Datenschutz & Sicherheit

- Es werden **keine** Bilddaten, erkannten Texte, Telemetrie- oder Nutzungsdaten erfasst oder übertragen.
- Zugriff auf einen Tab erfolgt **nur** nach deinem expliziten Icon-Klick – nie automatisch oder im Hintergrund.
- Keine dauerhaften Host-Permissions; `activeTab` ist rein transient.
- Ausführliches Audit mit Bedrohungsmodell und allen behobenen Schwachstellen: [`deploy/SECURITY_AUDIT.md`](./deploy/SECURITY_AUDIT.md).

---

## 📜 Lizenz

Bisher ist keine Lizenzdatei hinterlegt. Vor einer Veröffentlichung sollte eine
Lizenz gewählt werden (z. B. MIT für maximale Offenheit). Tesseract.js und die
Sprachmodelle stehen unter Apache-2.0 bzw. den jeweiligen Tesseract-Lizenzen.

---

## 🙏 Danksagung

Diese Erweiterung baut auf [Tesseract.js](https://github.com/naptha/tesseract.js) auf, der JavaScript-/WebAssembly-Port von Tesseract OCR. Danke an das gesamte Tesseract- und Tesseract.js-Team.

Die OCR läuft vollständig im Browser über einen **Web-Worker** mit **SIMD-LSTM-Core** von Tesseract.js. Sprach- und Core-Dateien werden per `fetch` aus der Erweiterung selbst geladen (`web_accessible_resources`) – niemals aus dem Netz.

---

## ☕ Support me

Wenn dir diese Erweiterung hilft, freue ich mich über einen Kaffee:

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-weschkalnies-yellow?logo=buy-me-a-coffee)](https://www.buymeacoffee.com/weschkalnies)
