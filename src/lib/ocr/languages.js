/**
 * OCR module – Supported OCR languages and selection rules.
 *
 * Shared by the background service worker (importScripts), the offscreen
 * document and the options page. Has no dependency on chrome.* APIs so it can
 * be loaded in every context and tested in isolation.
 *
 * Each entry needs a matching `lib/<code>.traineddata.gz` (tesseract.js-data
 * 4.0.0_best_int, LSTM only).
 *
 * Attached to the shared `self.Ocr` namespace.
 */
(function (Ocr) {
  "use strict";

  // code: Tesseract traineddata code, iso: ISO 639-1 browser locale prefix
  const SUPPORTED = Object.freeze([
    { code: "eng", iso: "en", name: "English", nativeName: "English" },
    { code: "deu", iso: "de", name: "German", nativeName: "Deutsch" },
    { code: "fra", iso: "fr", name: "French", nativeName: "Français" },
    { code: "spa", iso: "es", name: "Spanish", nativeName: "Español" },
    { code: "ita", iso: "it", name: "Italian", nativeName: "Italiano" },
    { code: "por", iso: "pt", name: "Portuguese", nativeName: "Português" },
    { code: "nld", iso: "nl", name: "Dutch", nativeName: "Nederlands" },
    { code: "pol", iso: "pl", name: "Polish", nativeName: "Polski" },
    { code: "ces", iso: "cs", name: "Czech", nativeName: "Čeština" },
    { code: "swe", iso: "sv", name: "Swedish", nativeName: "Svenska" },
    { code: "dan", iso: "da", name: "Danish", nativeName: "Dansk" },
    { code: "tur", iso: "tr", name: "Turkish", nativeName: "Türkçe" },
    { code: "rus", iso: "ru", name: "Russian", nativeName: "Русский" },
    { code: "ukr", iso: "uk", name: "Ukrainian", nativeName: "Українська" },
  ].map(Object.freeze));

  const BY_CODE = new Map(SUPPORTED.map((lang) => [lang.code, lang]));
  const MAX_SELECTED = 2;
  const FALLBACK = "eng";
  const STORAGE_KEY = "ocrLanguages";

  /** Human-readable English label for a Tesseract code. */
  function label(code) {
    const lang = BY_CODE.get(code);
    return lang ? lang.name : code;
  }

  /**
   * Validates a stored/received selection. Returns a de-duplicated array of
   * 1..MAX_SELECTED supported codes, or null if the input is unusable.
   */
  function normalize(codes) {
    if (!Array.isArray(codes)) return null;
    const result = [];
    for (const code of codes) {
      if (typeof code === "string" && BY_CODE.has(code) && !result.includes(code)) {
        result.push(code);
      }
    }
    if (result.length === 0 || result.length > MAX_SELECTED) return null;
    return result;
  }

  /**
   * Default selection: browser UI language + English. If the browser language
   * is English or not supported, English only.
   *
   * @param {string|undefined} uiLanguage e.g. "de-DE", "pt_BR", "en"
   */
  function defaults(uiLanguage) {
    const prefix = String(uiLanguage || "").toLowerCase().split(/[-_]/)[0];
    const match = SUPPORTED.find((lang) => lang.iso === prefix);
    if (!match || match.code === FALLBACK) return [FALLBACK];
    return [match.code, FALLBACK];
  }

  Ocr.Languages = Object.freeze({
    SUPPORTED,
    MAX_SELECTED,
    STORAGE_KEY,
    label,
    normalize,
    defaults,
  });
})(self.Ocr = self.Ocr || {});
