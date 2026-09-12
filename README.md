# Local Screen OCR

> A local Chrome extension (Manifest V3) that lets you select a screen area with the mouse and converts it **100 % offline** into text using Tesseract.js (WebAssembly), copying the result straight to your clipboard.

No cloud. No servers. No APIs. No telemetry. Image data never leaves your device.

---

## ✨ Features

- 🔒 **100 % local & offline** – the entire OCR pipeline (WASM core + language models) ships with the extension. Not a single byte is sent over the network during recognition.
- 🖱️ **Easy to use** – click the icon → drag a selection with the mouse → the recognized text lands on your clipboard.
- 🌐 **Multilingual** – recognizes **English** and **German** (Tesseract 4.0.0 LSTM models). More languages can be added via additional `traineddata.gz` files.
- 🖼️ **High-DPI correct** – respects `window.devicePixelRatio`, so screenshots on Retina/4K displays are recognized sharply and at the correct scale.
- 🛡️ **Least privilege** – only the `activeTab` + `scripting` permissions. Tab access happens exclusively after your deliberate click (*transient activation*), never automatically.
- 🔐 **Security hardened** – IIFE guard against repeated injection, `textContent` only (no `innerHTML` → no DOM XSS), blob worker URL to bypass restrictive page CSP, dimension limits as DoS protection, defensive null checks.
- 📋 **Robust clipboard** – uses the async Clipboard API with an `execCommand` fallback for non-secure contexts.
- 🧪 **Automated testing** – end-to-end tests with Playwright (system Chrome 152) via `chrome.management.Extensions.loadUnpacked`.


---

## 🚀 Installation (testing in Chrome)

The extension is not on the Chrome Web Store. To try it, load it as an **unpacked extension**:

1. Open Chrome → go to `chrome://extensions/`.
2. Toggle **Developer mode** in the top right.
3. Click **Load unpacked**.
4. Select the [`deploy/`](./deploy) folder.

> The `deploy/` version already ships all Tesseract resources locally in `deploy/lib/` – it is ready to use out of the box.

---

## 🖱️ Usage

1. Click the **extension icon** in the toolbar.
2. Drag a rectangle around the desired area while holding the left mouse button.
3. The text is recognized locally and copied to the **clipboard** (a toast shows the status).
4. `Esc` cancels the selection at any time.

You can then paste the recognized text anywhere with `Ctrl`/`Cmd`+`V`.

---

## 🧩 How It Works

```
Icon click ──► background.js
                 │  Check: is the page injectable? (no chrome://, Web Store …)
                 │  Screenshot via chrome.tabs.captureVisibleTab (PNG)
                 │  One-time injection of tesseract.min.js + content.js + content.css
                 ▼
              content.js
                 │  Canvas overlay for area selection (mouse)
                 │  Crop incl. devicePixelRatio
                 │  Tesseract.js createWorker(["eng","deu"], LSTM)  ◄── offline from lib/
                 │  navigator.clipboard.writeText (+ fallback)
                 ▼
              Toast: "Text copied to clipboard!"
```

---

## 🛠️ Tech Stack

| Component            | Version | Purpose                                  |
|----------------------|---------|------------------------------------------|
| Chrome Extension     | MV3     | Platform                                 |
| Tesseract.js         | 5.1.1   | Main OCR library                         |
| tesseract.js-core    | 5.1.0   | WASM core (SIMD-LSTM)                    |
| eng.traineddata.gz   | 4.0.0   | English model (LSTM)                     |
| deu.traineddata.gz   | 4.0.0   | German model (LSTM)                      |
| Playwright           | ^1.63   | Automated E2E testing                    |

---

## 📁 Project Structure

```text
chrome-image-to-text/
├── deploy/                 ← READY-TO-USE, testable version (what Chrome loads)
│   ├── manifest.json       ← MV3, activeTab + scripting, Web Accessible Resources
│   ├── background.js       ← Service worker: icon click, screenshot, one-time injection
│   ├── content.js          ← Overlay/crop/OCR/clipboard + error diagnostics
│   ├── content.css         ← Overlay & toast styles
│   ├── INSTALL.md          ← Chrome installation guide
│   ├── README.md / report.md / SECURITY_AUDIT.md
│   └── lib/                ← Tesseract resources (offline, ~32 MB)
│       ├── tesseract.min.js / worker.min.js
│       ├── tesseract-core-simd-lstm.wasm(.js)
│       ├── tesseract-core-simd.wasm(.js)
│       └── eng.traineddata.gz / deu.traineddata.gz
│
├── ocr-extension/         ← Source/docs version (reference)
├── tests/                 ← Playwright E2E tests
├── chrome_ocr_extension_spec.md   ← Original specification
└── PROJECT_KNOWLEDGE.md   ← Central knowledge base & pitfalls
```

---

## 🧪 Tests

End-to-end tests with Playwright against the system Chrome (loaded via
`Extensions.loadUnpacked`):

```bash
cd tests
npm install
node run2.cjs ./deploy-autotest   # full E2E test
```

Proof outputs: `tests/run2.out.txt` (E2E) and `tests/run3.out.txt` (OCR core).

> Notes:
> - Chrome is detected automatically (`$env:CHROME_PATH` → platform default paths → Playwright-bundled Chromium), see `tests/_env.cjs`.
> - Extension paths are resolved relative to the `tests/` directory – no hardcoded paths.

---

## ⚠️ Limitations

- **Browser-internal pages:** does not work on `chrome://`, `chrome-extension://`, `about:`, or the Chrome Web Store.
- **Strict CSP:** pages with a very restrictive `worker-src` CSP may block the Tesseract web worker. Mitigated via `workerBlobURL: true`, but not always avoidable – an error toast appears.
- **First-run load time:** on the first OCR run per tab, Tesseract loads the WASM core and language data from `lib/` (local, no network) – this can take 1–2 seconds.
- **English & German only** preconfigured – more languages are possible via additional `traineddata.gz` files in `lib/` (plus an entry in `manifest.json`).
- **SIMD assumed:** the bundled cores use SIMD. On CPUs without SIMD, consider also shipping the non-SIMD variants (`tesseract-core(-lstm).wasm*`).

---

## 🔒 Privacy & Security

- **No** image data, recognized texts, telemetry, or usage data is collected or transmitted.
- Tab access happens **only** after your explicit icon click – never automatically or in the background.
- No persistent host permissions; `activeTab` is purely transient.
- Detailed audit with threat model and all fixed vulnerabilities: [`deploy/SECURITY_AUDIT.md`](./deploy/SECURITY_AUDIT.md).

---

## 📜 License

No license file has been added yet. Before publishing, a license should be
chosen (e.g. MIT for maximum openness). Tesseract.js and the language models
are licensed under Apache-2.0 and the respective Tesseract licenses.

---

## 🙏 Acknowledgements

This extension builds on [Tesseract.js](https://github.com/naptha/tesseract.js), the JavaScript/WebAssembly port of Tesseract OCR. Thanks to the entire Tesseract and Tesseract.js team.

The OCR runs entirely in the browser via a **web worker** with Tesseract.js' **SIMD LSTM core**. Language and core files are loaded via `fetch` from the extension itself (`web_accessible_resources`) – never from the network.

---

## ☕ Support me

If this extension helps you, I'd appreciate a coffee:

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-weschkalnies-yellow?logo=buy-me-a-coffee)](https://www.buymeacoffee.com/weschkalnies)
