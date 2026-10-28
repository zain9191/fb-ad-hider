// Options page: TypeSafe API key (chrome.storage.local, written directly here,
// never synced), AI threshold and daily cap (chrome.storage.sync settings), and
// "Clear TypeSafe cache" (asks the background worker; answers only, never the key).

(() => {
  function $<T extends HTMLElement>(id: string, ctor: new () => T): T {
    const el = document.getElementById(id);
    if (!(el instanceof ctor)) throw new Error(`#${id} missing or not a ${ctor.name}`);
    return el;
  }

  const keyInput = $("api-key", HTMLInputElement);
  const toggleKeyBtn = $("toggle-key", HTMLButtonElement);
  const saveBtn = $("save-key", HTMLButtonElement);
  const testBtn = $("test-key", HTMLButtonElement);
  const removeBtn = $("remove-key", HTMLButtonElement);
  const keyStatusEl = $("key-status", HTMLParagraphElement);
  const keyMsgEl = $("key-msg", HTMLParagraphElement);
  const aiEnabledEl = $("aiEnabled", HTMLInputElement);
  const thresholdEl = $("threshold", HTMLInputElement);
  const thresholdOut = $("threshold-out", HTMLOutputElement);
  const capEl = $("cap", HTMLInputElement);
  const usageEl = $("usage", HTMLSpanElement);
  const lastErrorEl = $("last-error", HTMLParagraphElement);
  const clearCacheBtn = $("clear-cache", HTMLButtonElement);
  const cacheMsgEl = $("cache-msg", HTMLParagraphElement);

  let settings: FBAHSettings = { ...FBAH_DEFAULT_SETTINGS };

  function say(el: HTMLElement, text: string, tone: "ok" | "warn" | "bad" | "" = ""): void {
    el.textContent = text;
    el.className = `msg ${tone}`.trim();
  }

  async function savedKey(): Promise<string | null> {
    const data = await chrome.storage.local.get(FBAH_API_KEY_STORAGE_KEY);
    const v: unknown = data[FBAH_API_KEY_STORAGE_KEY];
    return typeof v === "string" && v.length > 0 ? v : null;
  }

  function masked(key: string): string {
    return `••••••••${key.slice(-4)}`;
  }

  /** "Test key" result, naming the check the background used (models list, or a classification call). */
  function testKeyText(res: FBAHTestKeyResult): string {
    if (!res.ok) return res.method === undefined ? res.message : `${res.message} (checked with the ${res.method})`;
    if (res.method === "models list") {
      const model = res.model === "" ? "" : `, ${res.model} available`;
      return `Key works (checked with the models list${model}): TypeSafe answered in ${res.latencyMs} ms.`;
    }
    return `Key works (checked with a classification call): ${res.model} answered in ${res.latencyMs} ms.`;
  }

  async function refreshStatus(): Promise<void> {
    const key = await savedKey();
    removeBtn.disabled = key === null;
    testBtn.disabled = key === null && keyInput.value.trim() === "";

    let st: FBAHAIStatus | null = null;
    try {
      const res = await fbahSendToBackground({ type: "fbah/aiStatus" });
      if (typeof res === "object" && res !== null) st = res;
    } catch {
      st = null;
    }

    if (key === null) {
      keyStatusEl.textContent = "No key saved. AI detection is inactive until you add one.";
      keyStatusEl.className = "muted";
    } else {
      const validity =
        st?.keyValid === true ? "verified" : st?.keyValid === false ? "rejected by TypeSafe" : "not verified yet";
      keyStatusEl.textContent = `Saved key ${masked(key)} (${validity}).`;
      keyStatusEl.className = st?.keyValid === false ? "bad" : st?.keyValid === true ? "ok" : "muted";
    }

    if (st) {
      usageEl.textContent = `${st.callsToday} of ${st.cap} used today`;
      say(lastErrorEl, st.lastError ? `Last error: ${st.lastError}` : "", st.lastError ? "warn" : "");
    } else {
      usageEl.textContent = "";
      say(lastErrorEl, "Background worker unavailable; reload the extension.", "bad");
    }
  }

  function renderSettings(): void {
    aiEnabledEl.checked = settings.aiEnabled;
    thresholdEl.value = String(settings.aiThreshold);
    thresholdOut.value = settings.aiThreshold.toFixed(2);
    capEl.value = String(settings.aiDailyCap);
  }

  async function saveSettings(patch: Partial<FBAHSettings>): Promise<void> {
    settings = fbahSanitizeSettings({ ...settings, ...patch });
    await fbahSaveSettings(settings);
    renderSettings();
  }

  /** Writes the key typed in the input, if any. Returns false if it was rejected locally. */
  async function saveTypedKey(): Promise<boolean> {
    const key = keyInput.value.trim();
    if (key === "") return true;
    if (!fbahIsPlausibleApiKey(key)) {
      say(keyMsgEl, "That doesn't look like an API key (8–512 printable characters, no spaces).", "bad");
      return false;
    }
    await chrome.storage.local.set({ [FBAH_API_KEY_STORAGE_KEY]: key });
    keyInput.value = "";
    return true;
  }

  function wire(): void {
    toggleKeyBtn.addEventListener("click", () => {
      const show = keyInput.type === "password";
      keyInput.type = show ? "text" : "password";
      toggleKeyBtn.textContent = show ? "Hide" : "Show";
      toggleKeyBtn.setAttribute("aria-pressed", String(show));
    });

    keyInput.addEventListener("input", () => {
      testBtn.disabled = keyInput.value.trim() === "" && removeBtn.disabled;
    });
    keyInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveBtn.click();
    });

    saveBtn.addEventListener("click", async () => {
      if (keyInput.value.trim() === "") {
        say(keyMsgEl, "Paste a key first.", "warn");
        return;
      }
      if (await saveTypedKey()) say(keyMsgEl, "Key saved. Use “Test key” to check it.", "ok");
      await refreshStatus();
    });

    testBtn.addEventListener("click", async () => {
      if (!(await saveTypedKey())) return;
      testBtn.disabled = true;
      say(keyMsgEl, "Testing…");
      try {
        const res = await fbahSendToBackground({ type: "fbah/testKey" });
        if (typeof res !== "object" || res === null) say(keyMsgEl, "No answer from the background worker.", "bad");
        else say(keyMsgEl, testKeyText(res), res.ok ? "ok" : "bad");
      } catch {
        say(keyMsgEl, "Could not reach the background worker; reload the extension.", "bad");
      } finally {
        testBtn.disabled = false;
        await refreshStatus();
      }
    });

    removeBtn.addEventListener("click", async () => {
      if (!confirm("Remove the saved TypeSafe API key from this browser?")) return;
      await chrome.storage.local.remove(FBAH_API_KEY_STORAGE_KEY);
      say(keyMsgEl, "Key removed. AI detection is inactive.", "ok");
      await refreshStatus();
    });

    clearCacheBtn.addEventListener("click", async () => {
      clearCacheBtn.disabled = true;
      say(cacheMsgEl, "Clearing…");
      try {
        const res = await fbahSendToBackground({ type: "fbah/clearCache" });
        if (typeof res !== "object" || res === null) say(cacheMsgEl, "No answer from the background worker.", "bad");
        else if (!res.ok) say(cacheMsgEl, res.message, "bad");
        else if (res.removed === 0) say(cacheMsgEl, "The cache was already empty.", "ok");
        else say(cacheMsgEl, `Cleared ${res.removed} cached answer${res.removed === 1 ? "" : "s"}.`, "ok");
      } catch {
        say(cacheMsgEl, "Could not reach the background worker; reload the extension.", "bad");
      } finally {
        clearCacheBtn.disabled = false;
      }
    });

    aiEnabledEl.addEventListener("change", () => void saveSettings({ aiEnabled: aiEnabledEl.checked }));
    thresholdEl.addEventListener("input", () => {
      thresholdOut.value = Number(thresholdEl.value).toFixed(2);
    });
    thresholdEl.addEventListener("change", () => void saveSettings({ aiThreshold: Number(thresholdEl.value) }));
    capEl.addEventListener("change", async () => {
      const cap = Number(capEl.value);
      if (!Number.isFinite(cap) || capEl.value.trim() === "") {
        renderSettings();
        return;
      }
      await saveSettings({ aiDailyCap: cap });
      await refreshStatus();
    });

    // Keep in sync with edits made from the popup.
    chrome.storage.sync.onChanged.addListener((changes) => {
      const change = changes[FBAH_STORAGE_KEY];
      if (!change) return;
      settings = fbahSanitizeSettings(change.newValue);
      renderSettings();
    });
  }

  async function init(): Promise<void> {
    settings = await fbahLoadSettings();
    renderSettings();
    wire();
    await refreshStatus();
  }

  void init();
})();
