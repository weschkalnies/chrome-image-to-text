# LocalOCR: Screen to Text

A local Chrome extension (Manifest V3): select an area on screen, recognize it
offline with Tesseract.js, review or edit the text, then copy it. Image data
and OCR results never leave your device.

![Infographic: select an area, recognize it locally with OCR, edit and copy text](public/ocr-workflow-v3.png)

## Features

- 100% local OCR with Tesseract.js and 14 bundled language models
- Choose one or two OCR languages in the options; default is your browser
  language plus English
- Keyboard shortcut `Alt+Shift+O` (changeable in `chrome://extensions/shortcuts`)
- Mouse-based selection, cancellable with `Esc`
- Editable result dialog with confidence, language and explicit copy action,
  or optionally copy immediately without the dialog
- Optional history of the last 10 results, kept only until the browser closes
- User interface in English and German
- High-DPI and screenshot scaling based on the actual image dimensions
- No persistent host permissions: only `activeTab`, `scripting`, `offscreen`,
  and `storage` (settings and optional session history)
- Robust worker, offscreen OCR, and injection management for Manifest V3

## Quick start

Requirements: a current version of Google Chrome or Chromium and Node.js.

```bash
npm run build
```

Then in Chrome:

1. Open `chrome://extensions/`.
2. Enable Developer mode.
3. Select **Load unpacked**.
4. Select the `deploy/` directory.

## Usage

1. Click the extension icon or press `Alt+Shift+O`.
2. Drag across the area you want to recognize.
3. Review or edit the recognized text in the dialog.
4. Select **Copy** to write it to the clipboard.

`Esc` cancels an active selection or OCR operation, or closes the result dialog.

### Settings

Right-click the extension icon and choose **Options**, or select **Settings**
in the result dialog:

- **OCR languages:** pick one or two (see below)
- **Keyboard shortcut:** shows the current shortcut and links to Chrome's
  shortcut settings
- **Copy text immediately:** skip the result dialog; if copying fails, the
  dialog is shown as a fallback
- **History:** off by default. When enabled, the last 10 recognized texts are
  kept in `chrome.storage.session` (cleared when the browser closes, not
  readable by websites). Turning it off deletes the history.

### OCR languages

Pick one or two languages. With one
language OCR is fastest; with two, both are recognized in parallel and the
result with the higher confidence wins.

Without a saved choice the extension uses the browser language plus English
(English only if the browser language is English or not supported).

Supported: English, German, French, Spanish, Italian, Portuguese, Dutch,
Polish, Czech, Swedish, Danish, Turkish, Russian, Ukrainian.

The UI language follows the browser (English and German, texts in
`src/_locales/`).

To add a language, place `<code>.traineddata.gz` from
[`@tesseract.js-data/<code>/4.0.0_best_int`](https://www.jsdelivr.com/package/npm/@tesseract.js-data/eng)
in `src/lib/` and add an entry to `src/lib/ocr/languages.js`.

## Development

`src/` is the single source of truth. `deploy/` and `tests/deploy-autotest/`
are generated and must not be edited manually.

```bash
npm run build              # generate deploy/ from src/
npm run build:autotest     # also generate the test extension
npm run check              # verify that deploy/ is current
```

Install the test dependencies once before running the browser tests:

```bash
npm --prefix tests ci
npm run test:background-injection
npm run test:worker-lifecycle
npm run test:e2e
```

`test:e2e` covers the complete flow, including OCR, the result dialog and the
explicit copy action.

## Project structure

```text
chrome-image-to-text/
├── src/                    # extension source code
│   ├── background.js        # service worker: screenshot, injection, offscreen routing
│   ├── content.js           # selection, crop and UI orchestration
│   ├── content.css          # selection overlay styles
│   ├── offscreen.html       # isolated MV3 offscreen document for local OCR
│   ├── offscreen.js         # offscreen OCR controller
│   ├── options.html/.js/.css # settings page (languages, shortcut, copy, history)
│   ├── _locales/            # UI texts (en, de)
│   ├── icons/               # icon family
│   └── lib/                 # OCR, UI and local Tesseract resources
├── deploy/                  # generated extension loaded in Chrome
├── tests/                   # browser and regression tests
├── tools/build.js           # build and drift check
└── package.json             # npm scripts
```

## Privacy and security

- No cloud, telemetry or external OCR requests.
- OCR runs inside an isolated MV3 offscreen document (`offscreen.html`) without
  `web_accessible_resources` (`<all_urls>`), keeping local Tesseract assets
  inaccessible to visited websites.
- The editable result dialog uses a closed Shadow DOM, so scripts on the
  visited website cannot read the recognized text.
- **Chrome Web Store Enhanced Safe Browsing notice:** If you have Chrome's
  *Enhanced Safe Browsing* enabled, you may see *"This extension is not trusted
  by Enhanced Safe Browsing"* when installing from the Chrome Web Store. This is
  Google's standard automated notice for newer Chrome Web Store developer
  accounts—not a security finding—and disappears automatically after a few
  months of policy-compliant account history. The full source code is open in
  this repository for inspection or local building (`npm run build`).

## Release

One command builds, tests, packages, commits, tags and uploads to the Chrome
Web Store:

```bash
npm run release -- patch        # or minor / major / 1.4.0
git push --follow-tags          # triggers the GitHub release for the tag
```

Options: `--draft` (upload only, submit later in the dashboard), `--staged`
(publish manually after approval), `--no-upload`, `--skip-e2e`, `--dry-run`.
An explicit version equal to the current manifest version releases it as is,
as long as no tag exists for it yet.

Store credentials are read from `.env.cws` (`CWS_PUBLISHER_ID`,
`CWS_EXTENSION_ID`, `CWS_SERVICE_ACCOUNT_KEY_FILE`). The store description,
screenshots and permission justifications cannot be set via the API; update
them in the developer dashboard when they change.

## Support

If you would like to support the project, you can buy me a coffee:
[Buy Me a Coffee](https://buymeacoffee.com/weschkalnies).

## License

No license has been selected for this repository yet. Tesseract.js and the
bundled Tesseract resources are subject to their respective licenses.
