/**
 * LocalOCR – Options page: choose 1-2 OCR languages.
 *
 * The selection is stored in chrome.storage.local under
 * Ocr.Languages.STORAGE_KEY and read by the background worker per OCR run.
 * Without a stored selection the default is browser language + English.
 */
(function () {
  "use strict";

  const Languages = self.Ocr.Languages;
  const fieldset = document.getElementById("languages");
  const status = document.getElementById("status");
  const inputs = new Map();
  let selection = [];
  let statusTimer = null;

  function setStatus(text) {
    status.textContent = text;
    clearTimeout(statusTimer);
    if (text) statusTimer = setTimeout(() => { status.textContent = ""; }, 2500);
  }

  /** Reflects the selection in the checkboxes and enforces 1..MAX_SELECTED. */
  function render() {
    const full = selection.length >= Languages.MAX_SELECTED;
    for (const [code, input] of inputs) {
      const checked = selection.includes(code);
      input.checked = checked;
      // The last remaining language cannot be unchecked; when the maximum is
      // reached, unchecked languages are disabled.
      input.disabled = checked ? selection.length === 1 : full;
      input.parentElement.classList.toggle("disabled", input.disabled);
    }
  }

  async function save() {
    try {
      await chrome.storage.local.set({ [Languages.STORAGE_KEY]: selection });
      const names = selection.map(Languages.label).join(" + ");
      setStatus("Saved: " + names);
    } catch (error) {
      console.error("[OCR] Saving languages failed:", error);
      setStatus("Saving failed. Please try again.");
    }
  }

  function onChange(event) {
    const code = event.target.value;
    if (event.target.checked) {
      if (!selection.includes(code)) selection.push(code);
    } else {
      selection = selection.filter((c) => c !== code);
    }
    const valid = Languages.normalize(selection);
    if (!valid) {
      render();
      return;
    }
    selection = valid;
    render();
    void save();
  }

  function build() {
    for (const lang of Languages.SUPPORTED) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = lang.code;
      input.addEventListener("change", onChange);
      const name = document.createElement("span");
      name.textContent = lang.name;
      label.append(input, name);
      if (lang.nativeName !== lang.name) {
        const native = document.createElement("span");
        native.className = "native";
        native.textContent = lang.nativeName;
        label.append(native);
      }
      inputs.set(lang.code, input);
      fieldset.appendChild(label);
    }
  }

  async function load() {
    let stored = null;
    try {
      const data = await chrome.storage.local.get(Languages.STORAGE_KEY);
      stored = Languages.normalize(data && data[Languages.STORAGE_KEY]);
    } catch (error) {
      console.error("[OCR] Reading languages failed:", error);
    }
    selection =
      stored || Languages.defaults(chrome.i18n.getUILanguage() || navigator.language);
    render();
  }

  build();
  void load();
})();
