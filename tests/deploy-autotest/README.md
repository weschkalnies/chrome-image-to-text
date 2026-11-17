# LocalOCR: Screen to Text – Chrome Extension

A local, **100% offline** Chrome extension (Manifest V3) that lets you select
an area of the screen by clicking the toolbar icon, converts it into text with
**Tesseract.js (WebAssembly)**, and displays an editable result before copying.

**No** cloud services, servers, or external APIs are used. All image data stays
on your device.

## Project Structure

```text
chrome-image-to-text/
├── src/                   ← SINGLE SOURCE OF TRUTH (develop here!)
│   ├── manifest.json
│   ├── background.js      # Service worker (icon click, screenshot, injection)
│   ├── content.js         # Overlay selection, crop, OCR (orchestrator)
│   ├── content.css        # Styles for overlay & toast
│   ├── icons/             # Extension icons
│   └── lib/
│       ├── ocr/           # Helper modules (config, toast, logger, clipboard)
│       ├── ui/result.js   # Protected, editable result dialog
│       ├── tesseract.min.js … # Local Tesseract.js assets (vendor)
├── deploy/                ← GENERATED (npm run build) – load in Chrome
├── tools/build.js         # Build script (src -> deploy, --autotest, --check)
├── tests/                 # Playwright E2E harness (run2.cjs)
└── package.json           # npm scripts (build / check / pack / test:e2e)
```

## Development & Build

```bash
npm run build        # generate deploy/ from src/
npm run check        # verify deploy/ matches src/
npm run pack         # build deploy/ and package localocr-screen-to-text.zip
npm run test:e2e     # build test extension and verify the full OCR flow
```

**Important:** `deploy/` is generated and must **never be edited manually**.
Always edit files in `src/` and run the build script.

## Installation (Test in Chrome)

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked** → select the `deploy` folder.

## Usage

1. Click the extension icon.
2. Drag with the left mouse button to select the desired area.
3. Review or edit the recognized text in the result dialog.
4. Select **Copy**; **Reselect area** reuses the same screenshot.
5. `Esc` cancels an active selection or closes the result dialog.

## Privacy & Security

The extension works 100% locally and only requests `activeTab` and `scripting`.
The full security audit is located in the repository's developer documentation
under `docs/`.
