# Spezifikation & Code-Dokumentation: Lokale Chrome-Erweiterung für Screenshot-OCR

## 1. Übersicht & Zielsetzung
Diese Spezifikation beschreibt die Implementierung einer Google Chrome-Erweiterung auf Basis von **Manifest V3**. Die Erweiterung ermöglicht es Nutzern, per Klick auf das Extension-Icon einen gewählten Bildschirmbereich auszuwählen, diesen lokal via **Tesseract.js (WebAssembly)** in Text umzuwandeln und das Ergebnis direkt in die System-Zwischenablage einzufügen.

### Hauptmerkmale:
* **100% Lokal & Offline:** Keine Nutzung externer Cloud-Dienste, Server oder APIs. Alle Daten verbleiben auf dem Endgerät des Nutzers.
* **Datenschutzkonform:** Keine Erfassung oder Speicherung von Telemetrie- oder Bilddaten.
* **High-DPI Support:** Korrekte Handhabung von Retina- und 4K-Bildschirmen durch Berücksichtigung von `window.devicePixelRatio`.
* **Intuitive Bedienung:** Interaktives Overlay zum Ziehen eines Auswahlrahmens mit der Maus inklusive Status-Feedback (Toast-Notification).

---

## 2. Projektstruktur

Die Erweiterung besteht aus folgenden Dateien:

```text
ocr-extension/
├── manifest.json
├── background.js
├── content.js
├── content.css
└── lib/
    └── tesseract.min.js
```

---

## 3. Dateiinhalte & Quellcode

### 3.1. `manifest.json`
Das Manifest definiert die Berechtigungen, den Background Service Worker sowie die bereitzustellenden lokalen Ressourcen (Web Accessible Resources).

```json
{
  "manifest_version": 3,
  "name": "Local Screen OCR",
  "version": "1.0",
  "description": "Erfasst einen Bereich des Bildschirms und wandelt ihn lokal via Tesseract OCR in Text um.",
  "permissions": [
    "activeTab",
    "scripting"
  ],
  "action": {
    "default_title": "Screenshot OCR starten"
  },
  "background": {
    "service_worker": "background.js"
  },
  "web_accessible_resources": [
    {
      "resources": ["lib/tesseract.min.js"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

---

### 3.2. `background.js` (Service Worker)
Der Background-Prozess fängt den Klick auf das Erweiterungs-Icon ab, nimmt einen Screenshot des aktiven Tabs auf und injiziert die Skripte sowie CSS in die aktuelle Seite.

```javascript
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || tab.url.startsWith("chrome://") || tab.url.startsWith("edge://")) {
    console.error("Kann auf Browser-internen Seiten nicht ausgeführt werden.");
    return;
  }

  try {
    // 1. Screenshot des aktuellen sichtbaren Fensters erstellen
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });

    // 2. Tesseract-Bibliothek und Content-Skript injizieren
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["lib/tesseract.min.js", "content.js"]
    });

    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["content.css"]
    });

    // 3. Bilddaten an das Content-Script übermitteln
    chrome.tabs.sendMessage(tab.id, { action: "start_selection", imageUri: dataUrl });

  } catch (error) {
    console.error("Fehler beim Starten der OCR-Auswahl:", error);
  }
});
```

---

### 3.3. `content.css`
Styles für das transparente Auswahloverlay und die Statusbenachrichtigungen.

```css
#ocr-overlay-canvas {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 99999999;
  cursor: crosshair;
}

#ocr-status-toast {
  position: fixed;
  bottom: 20px;
  right: 20px;
  background-color: #323232;
  color: #ffffff;
  padding: 12px 20px;
  border-radius: 8px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px;
  z-index: 100000000;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  transition: opacity 0.2s ease-in-out;
}
```

---

### 3.4. `content.js`
Verwaltet das Canvas-Overlay zur Bereichsauswahl, schneidet das Bild exakt zu und führt die Tesseract-OCR-Erkennung durch.

```javascript
(function () {
  if (window.ocrInitialized) return;
  window.ocrInitialized = true;

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "start_selection") {
      initSelection(message.imageUri);
    }
  });

  function initSelection(imageUri) {
    const canvas = document.createElement("canvas");
    canvas.id = "ocr-overlay-canvas";
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    document.body.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    const img = new Image();
    img.src = imageUri;

    let startX = 0, startY = 0, isDragging = false;

    img.onload = () => drawOverlay();

    function drawOverlay(rect = null) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (rect) {
        ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
        ctx.strokeStyle = "#007bff";
        ctx.lineWidth = 2;
        ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
      }
    }

    canvas.addEventListener("mousedown", (e) => {
      startX = e.clientX;
      startY = e.clientY;
      isDragging = true;
    });

    canvas.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const currentX = e.clientX;
      const currentY = e.clientY;

      const rect = {
        x: Math.min(startX, currentX),
        y: Math.min(startY, currentY),
        w: Math.abs(currentX - startX),
        h: Math.abs(currentY - startY)
      };

      drawOverlay(rect);
    });

    canvas.addEventListener("mouseup", async (e) => {
      if (!isDragging) return;
      isDragging = false;

      const endX = e.clientX;
      const endY = e.clientY;

      const cropX = Math.min(startX, endX);
      const cropY = Math.min(startY, endY);
      const cropW = Math.abs(endX - startX);
      const cropH = Math.abs(endY - startY);

      canvas.remove();

      if (cropW > 5 && cropH > 5) {
        showToast("Erkenne Text (lokal)...");
        const croppedDataUrl = cropImage(img, cropX, cropY, cropW, cropH);
        await processOCR(croppedDataUrl);
      }
    });
  }

  function cropImage(img, x, y, w, h) {
    const cropCanvas = document.createElement("canvas");
    const devicePixelRatio = window.devicePixelRatio || 1;

    cropCanvas.width = w * devicePixelRatio;
    cropCanvas.height = h * devicePixelRatio;

    const ctx = cropCanvas.getContext("2d");
    ctx.drawImage(
      img,
      x * devicePixelRatio,
      y * devicePixelRatio,
      w * devicePixelRatio,
      h * devicePixelRatio,
      0,
      0,
      cropCanvas.width,
      cropCanvas.height
    );

    return cropCanvas.toDataURL("image/png");
  }

  async function processOCR(dataUrl) {
    try {
      if (typeof Tesseract === "undefined") {
        throw new Error("Tesseract.js nicht geladen.");
      }

      // Worker für Deutsch und Englisch initialisieren
      const worker = await Tesseract.createWorker("deu+eng");
      const ret = await worker.recognize(dataUrl);
      await worker.terminate();

      const text = ret.data.text.trim();

      if (text) {
        await navigator.clipboard.writeText(text);
        showToast("Text in Zwischenablage kopiert!", 3000);
      } else {
        showToast("Kein Text erkannt.", 3000);
      }
    } catch (err) {
      console.error("OCR Fehler:", err);
      showToast("Fehler bei der Texterkennung.", 3000);
    }
  }

  function showToast(message, duration = 0) {
    let toast = document.getElementById("ocr-status-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "ocr-status-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;

    if (duration > 0) {
      setTimeout(() => {
        if (toast) toast.remove();
      }, duration);
    }
  }
})();
```

---

## 4. Einrichtung & Installation

1. Erstelle den Ordner `ocr-extension` und die gezeigte Dateistruktur.
2. Lade die aktuelle `tesseract.min.js` (z.B. via CDN oder npm) herunter und speichere sie unter `lib/tesseract.min.js`.
3. Öffne Chrome und rufe `chrome://extensions/` auf.
4. Aktiviere oben rechts den **Entwicklermodus**.
5. Klicke auf **Entpackte Erweiterung laden** und wähle den Ordner `ocr-extension` aus.
