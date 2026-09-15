# Verbesserungsplan – Local Screen OCR

> Stand: 12.09.2026. Basis: Code-Review der Extension.
> **Punkt 1 (Struktur) ist umgesetzt** (siehe ✅); dieser Plan listet die
> verbleibenden Vorschläge mit Begründung und Umsetzungs-Hinweisen.
> Kontext: `docs/project_overview.md` (§7 „offene Hebel“ überschneidet sich
> teils – diese Datei ist die Arbeitsliste).

---

## 1. ✅ Doppelte Wartung eliminieren (UMGESETZT)

- `src/` als Single Source of Truth; `deploy/` generiert via
  `node tools/build.js` (`--check` = Drift-Prüfung).
- Helper `lib/ocr/{config,toast,logger,clipboard}.js` in `content.js`
  verdrahtet (Namespace `self.Ocr`), Doppelcode entfernt.
- `ocr-extension/` gelöscht; Workflows angepasst; E2E grün.

---

## 2. Background-Service-Worker: `INJECTED_TABS` ist unzuverlässig

**Problem:** MV3-Service-Worker werden jederzeit terminiert. Nach einem
Neustart des SW ist das `INJECTED_TABS`-Set leer, obwohl der Tab bereits
injiziert war → erneute Injektion → `chrome.runtime.onMessage` hat dann
MEHRFACHE Listener (doppelte Reaktion auf `start_selection`).

**Lösungsvorschläge:**
- a) **Ping-basierter Check (empfohlen):** Vor der Injektion
  `chrome.tabs.sendMessage(tab.id, {action:"ping"})` senden.
  Antwortet das Content-Script (Content-Scripts überleben SW-Restarts!),
  ist bereits injiziert → nur `start_selection` senden.
  Alternativ: `chrome.scripting.executeScript({func: () => !!window.__ocrInitialized})`.
- b) Zusätzlich: `chrome.tabs.onRemoved`-Listener **einmal global**
  registrieren statt pro Icon-Klick (aktuell wird pro Klick ein neuer
  Listener-Chunk registriert).

**Aufwand:** klein. **Risiko:** niedrig (E2E-Test deckt Injektionspfad ab).

---

## 3. Screenshot-Übergabe optimieren

**Problem:** PNG-DataURL (~+33 % Größe vs. Binary) wird via
`chrome.tabs.sendMessage` serialisiert. Bei 4K-Screenshots merkbar.

**Optionen:**
- `quality`-/Format-Parameter für `captureVisibleTab` konfigurierbar machen
  (PNG ist für OCR ideal, aber ggf. zu groß für reine Vorschau).
- Alternativ Blob + `URL.createObjectURL` – im Content-Script-Kontext
  jedoch mit Vorsicht zu genießen (URL-Lifetime, CSP).
- Status quo (DataURL) ist ok – erst angehen, wenn 4K/HiDPI-Nutzer bemängeln.

**Aufwand:** klein–mittel. **Priorität:** niedrig.

---

## 4. Content-Script weiter modularisieren

`src/content.js` (Orchestrator) ist mit ~340 Zeilen noch handhabbar. Wenn
er weiter wächst (z. B. durch Punkte 5–6), teilen in injizierte Module
nach dem Vorbild `lib/ocr/*`:

- `lib/ui/overlay.js` (Canvas-Auswahl, Zeichnen)
- `lib/ocr/crop.js` (cropImage, DPR-Handling)
- `lib/ocr/engine.js` (recognizeText, Worker-Management)

Dann Injektions-Liste in `background.js` erweitern (Reihenfolge beachten!).
**Aufwand:** mittel. **Nur tun, wenn Funktionswchsel hinzukommt.**

---

## 5. Worker-Cache / Persistenz (größter UX-Hebel)

**Problem:** Tesseract-Worker wird pro OCR neu erzeugt (`createWorker` +
WASM-Init + traineddata-Load ≈ 1–2 s). Folgemessungen sind unnötig langsam.

**Lösung:** Worker pro Tab persistieren:
- Erstnutzung: `createWorker(...)` → in `Ocr.WorkerCache` (neues Helper-
  Modul oder Zustand in `content.js`) halten.
- Folgeselektionen: direkt `worker.recognize(...)` (Dezisekunden-Start).
- **Idle-Terminate:** nach z. B. 60 s ohne Nutzung `worker.terminate()`
  (verhindert Worker-Leak / Speicherdruck).
- Worker-Erstellung wiedereintrittssicher machen (Promise cachen, damit
  parallele OCR-Aufrufe sich einen Worker teilen).

**Aufwand:** mittel. **Risiko:** Lifecycle-Handling (Seiten-Navigation beendet
Content-Script ohnehin → Worker stirbt mit, kein cross-page Leak).

---

## 6. ✅ Text vor dem Kopieren anzeigen/editeren (UMGESETZT)

**Umsetzung:** `lib/ui/result.js` zeigt den Text in einem editierbaren
`textarea` mit Konfidenz, Sprache sowie den Buttons „Kopieren“, „Schließen“
und „Auswahl wiederholen“. Kopieren erfolgt erst nach Nutzeraktion.

Der Dialog liegt in einem geschlossenen Shadow-DOM, damit Seitenskripte den
erkannten Text nicht aus dem normalen DOM lesen können. Der E2E-Test prüft
Dialog, Privatsphäre und das anschließende explizite Kopieren.

---

## 7. Sprachwahl

**Problem:** `eng + deu` hartkodiert (`Ocr.Config.ocrLanguages`). Zwei
Sprachen = längeres traineddata-Loading + geringere Präzision.

**Lösung:**
- Auswahl im Kontextmenü des Extension-Icons
  (`chrome.contextMenus`, braucht `contextMenus`-Permission) oder
  kleine Options-Seite (braucht `storage`-Permission).
- Persistenz: `chrome.storage.session` (MV3-SW-freundlich) oder `sync`.
- `recognizeText()` liest Sprachen dann aus Storage statt Config.

**Aufwand:** mittel. **Achtung:** neue Permissions = erneut
Sicherheits-Audit-Zeile (`SECURITY_AUDIT.md`) ergänzen.

---

## 8. Hotkey + Kontextmenü-Einstieg

**Lösung:**
- `chrome.commands` (z. B. `Alt+Shift+O`) → gleicher Flow wie Icon-Klick.
  Achtung: `captureVisibleTab` braucht Nutzer-Geste – Commands zählen
  i. d. R. als solche (testen!).
- Kontextmenü auf Bildern: „Bild in Text umwandeln (OCR)“ – spart
  Screenshot+Crop komplett und liefert oft bessere Qualität (Original-
  Pixeldaten statt Screen-Crop). Content-Script braucht dann einen
  `start_ocr_with_image`-Pfad, der direkt `recognizeText` auf der
  Bild-URL aufruft (CORS beachten: ggf. erst via `fetch` im
  Background/Offscreen holen).

**Aufwand:** mittel (Hotkey klein, Bild-Pfad mittel).

---

## 9. OCR-Qualität (Preprocessing)

**Hebel:**
- **Upscaling:** kleine Crops (DPR 1) auf ~2× skalieren, da Tesseract
  ≥ ~300 DPI bevorzugt.
- **Graustufen + binarisieren** (Otsu o. ä.) vor `recognize` – hilft bei
  dunklen Seiten/Themes (dunkel = invertieren!).
- Tesseract-Parameter: `tessedit_pageseg_mode` (z. B. PSM 7 „eine Zeile“)
  und ggf. Whitelist pro Use-Case („nur Ziffern“).

**Umsetzung:** neues Helper-Modul `lib/ocr/preprocess.js` (Canvas-basiert,
offline). Verdrahtung in `cropImage`/`runOcr`.

**Aufwand:** mittel. **Gewinn:** spürbar bei kleinen/kontrastarmen Texten.

---

## 10. Kleinere Robustheit/UX-Punkte

- Doppelklick auf Icon während laufender Auswahl: aktuell stiller Abbruch →
  Toast „Auswahl läuft bereits (Esc zum Abbrechen)“.
- „Kein Text erkannt.“-Toast: optional mit Aktion „Auswahl wiederholen“.
- `isInjectableUrl`: grundsätzlich ok, aber Testfälle für Edge-/Brave-
  interne Seiten und `chrome://new-tab-page` ergänzen (Regressionsschutz).
- Tesseract-Upgrade v6/v7: zuerst `createWorker`-Signatur prüfen (siehe
  project_overview §7 Punkt 6), dann Build + E2E laufen lassen.

**Aufwand:** je klein.

---

## Empfohlene Reihenfolge

1. **Quick Wins:** Punkt 2 (Injektions-Check), Punkt 10 (Kleinigkeiten)
2. **UX-Hebel:** Punkt 5 (Worker-Reuse), Punkt 6 (Result-Overlay)
3. **Danach:** Punkt 8 (Hotkey/Bild-OCR), Punkt 7 (Sprachwahl),
   Punkt 9 (Preprocessing)
4. Punkt 3/4 nur bei Bedarf (3 = niedrige Priorität, 4 = bei Bedarf)

**Validierungs-Standard für jeden Punkt:**
`node --check` auf geänderten Dateien → `npm run build` → `npm run check`
→ E2E (`cd tests && node --experimental-websocket run2.cjs ./deploy-autotest`,
nach `npm run build:autotest`) → `docs/project_overview.md` §10 ergänzen.
