# LocalOCR: Screen to Text – Installation (Test in Chrome)

This version is **ready to test** – all Tesseract.js files are already
bundled locally in `lib/` (100% offline).

## Steps

1. Open Chrome → go to `chrome://extensions/`.
2. Enable **Developer mode** in the top right.
3. Click **Load unpacked**.
4. Select the `deploy` folder:
   `./deploy`

## Usage

1. Click the extension icon in the toolbar.
2. Drag with the left mouse button to select the desired area.
3. Review or edit the locally recognized text in the result dialog.
4. Select **Copy** to copy the text to the clipboard (toast confirms);
   **Reselect area** reuses the same screenshot.
5. `Esc` cancels the selection or closes the result dialog.

## Notes

- Does not run on browser-internal pages (`chrome://`, Chrome Web Store,
  `about:`, `view-source:`).
- Pages with a strict CSP may block loading the Tesseract web worker →
  an error toast appears.
- On the first OCR run, Tesseract loads the WASM core and language data
  from `lib/` (locally, no network) – this may take 1–2 seconds.
