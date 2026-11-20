/**
 * LocalOCR – Options page.
 *
 * - OCR languages (1-2), stored in chrome.storage.local. Without a stored
 *   selection the default is browser language + English.
 * - Keyboard shortcut (read-only here; changed on chrome://extensions/shortcuts)
 * - "Copy immediately" (skip the result dialog)
 * - Optional history of the last results in chrome.storage.session
 */
(function () {
  "use strict";

  const { Languages, Settings, t } = self.Ocr;
  const KEYS = Settings.KEYS;
  const locale = self.Ocr.uiLanguage();
  const $ = (id) => document.getElementById(id);

  const fieldset = $("languages");
  const inputs = new Map();
  let selection = [];
  const statusTimers = new Map();

  function setStatus(el, text) {
    el.textContent = text;
    clearTimeout(statusTimers.get(el));
    if (text) statusTimers.set(el, setTimeout(() => { el.textContent = ""; }, 2500));
  }

  function localize() {
    document.documentElement.lang = locale;
    for (const el of document.querySelectorAll("[data-i18n]")) {
      el.textContent = t(el.dataset.i18n);
    }
  }

  /* ---------------- Languages ---------------- */

  /** Reflects the selection in the checkboxes and enforces 1..MAX_SELECTED. */
  function renderLanguages() {
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

  async function saveLanguages() {
    const status = $("languages-status");
    try {
      await chrome.storage.local.set({ [KEYS.languages]: selection });
      const names = selection.map((code) => Languages.displayName(code, locale)).join(" + ");
      setStatus(status, t("optionsSavedLanguages", names));
    } catch (error) {
      console.error("[OCR] Saving languages failed:", error);
      setStatus(status, t("optionsSaveFailed"));
    }
  }

  function onLanguageChange(event) {
    const code = event.target.value;
    if (event.target.checked) {
      if (!selection.includes(code)) selection.push(code);
    } else {
      selection = selection.filter((c) => c !== code);
    }
    const valid = Languages.normalize(selection);
    if (!valid) {
      renderLanguages();
      return;
    }
    selection = valid;
    renderLanguages();
    void saveLanguages();
  }

  function buildLanguages() {
    const items = Languages.SUPPORTED.map((lang) => ({
      lang,
      name: Languages.displayName(lang.code, locale),
    })).sort((a, b) => a.name.localeCompare(b.name, locale));
    for (const { lang, name } of items) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = lang.code;
      input.addEventListener("change", onLanguageChange);
      const nameEl = document.createElement("span");
      nameEl.textContent = name;
      label.append(input, nameEl);
      if (lang.nativeName.toLocaleLowerCase() !== name.toLocaleLowerCase()) {
        const native = document.createElement("span");
        native.className = "native";
        native.textContent = lang.nativeName;
        label.append(native);
      }
      inputs.set(lang.code, input);
      fieldset.appendChild(label);
    }
  }

  /* ---------------- Shortcut ---------------- */

  async function renderShortcut() {
    const target = $("shortcut-current");
    let shortcut = "";
    try {
      const commands = await chrome.commands.getAll();
      const action = commands.find((c) => c.name === "_execute_action");
      shortcut = (action && action.shortcut) || "";
    } catch (_error) {
      // commands API unavailable
    }
    const [before, after] = t("optionsShortcutCurrent", "\u0000").split("\u0000");
    target.textContent = before;
    if (shortcut) {
      const kbd = document.createElement("kbd");
      kbd.textContent = shortcut;
      target.append(kbd);
    } else {
      target.append(t("optionsShortcutNone"));
    }
    if (after) target.append(after);
  }

  /* ---------------- Toggles ---------------- */

  async function saveToggle(key, value) {
    try {
      await chrome.storage.local.set({ [key]: value });
      setStatus($("status"), t("optionsSaved"));
    } catch (error) {
      console.error("[OCR] Saving setting failed:", error);
      setStatus($("status"), t("optionsSaveFailed"));
    }
  }

  /* ---------------- History ---------------- */

  function formatTime(ms) {
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(ms);
    } catch (_error) {
      return new Date(ms).toLocaleString();
    }
  }

  function renderHistory(entries) {
    const list = $("history-list");
    list.textContent = "";
    const items = Array.isArray(entries) ? entries : [];
    for (const entry of items) {
      if (!entry || typeof entry.text !== "string") continue;
      const li = document.createElement("li");
      const meta = document.createElement("div");
      meta.className = "meta";
      const parts = [formatTime(entry.time)];
      if (entry.languageCode) parts.push(Languages.displayName(entry.languageCode, locale));
      if (typeof entry.confidence === "number") parts.push(t("resultConfidence", String(entry.confidence)));
      meta.textContent = parts.join(" · ");
      const text = document.createElement("div");
      text.className = "text";
      text.textContent = entry.text;
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "secondary";
      copy.textContent = t("optionsHistoryCopy");
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(entry.text);
          copy.textContent = t("optionsHistoryCopied");
          setTimeout(() => { copy.textContent = t("optionsHistoryCopy"); }, 1500);
        } catch (error) {
          console.error("[OCR] Copy failed:", error);
        }
      });
      li.append(meta, text, copy);
      list.appendChild(li);
    }
    $("history-empty").hidden = list.children.length > 0;
    $("history-clear").hidden = list.children.length === 0;
  }

  async function loadHistory() {
    try {
      const data = await chrome.storage.session.get(Settings.HISTORY_KEY);
      renderHistory(data[Settings.HISTORY_KEY]);
    } catch (error) {
      console.error("[OCR] Reading history failed:", error);
      renderHistory([]);
    }
  }

  async function clearHistory() {
    try {
      await chrome.storage.session.remove(Settings.HISTORY_KEY);
    } catch (error) {
      console.error("[OCR] Clearing history failed:", error);
    }
  }

  function setHistoryVisible(enabled) {
    $("history").hidden = !enabled;
    if (enabled) void loadHistory();
  }

  /* ---------------- Init ---------------- */

  async function load() {
    let stored = {};
    try {
      stored =
        (await chrome.storage.local.get([KEYS.languages, KEYS.autoCopy, KEYS.historyEnabled])) || {};
    } catch (error) {
      console.error("[OCR] Reading settings failed:", error);
    }
    selection = Languages.normalize(stored[KEYS.languages]) || Languages.defaults(locale);
    renderLanguages();

    const autoCopy = $("auto-copy");
    autoCopy.checked =
      typeof stored[KEYS.autoCopy] === "boolean" ? stored[KEYS.autoCopy] : Settings.DEFAULTS.autoCopy;
    autoCopy.addEventListener("change", () => void saveToggle(KEYS.autoCopy, autoCopy.checked));

    const historyEnabled = $("history-enabled");
    historyEnabled.checked =
      typeof stored[KEYS.historyEnabled] === "boolean"
        ? stored[KEYS.historyEnabled]
        : Settings.DEFAULTS.historyEnabled;
    setHistoryVisible(historyEnabled.checked);
    historyEnabled.addEventListener("change", async () => {
      const enabled = historyEnabled.checked;
      // Turning the history off also deletes what was stored.
      if (!enabled) await clearHistory();
      await saveToggle(KEYS.historyEnabled, enabled);
      setHistoryVisible(enabled);
    });
  }

  localize();
  buildLanguages();
  void renderShortcut();
  $("shortcut-change").addEventListener("click", () => {
    void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  });
  $("history-clear").addEventListener("click", () => void clearHistory());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes[Settings.HISTORY_KEY]) {
      renderHistory(changes[Settings.HISTORY_KEY].newValue);
    }
  });
  window.addEventListener("focus", () => void renderShortcut());
  void load();
})();
