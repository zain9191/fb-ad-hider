// Popup: edits settings (chrome.storage.sync), shows stats for the active tab
// and the TypeSafe AI status (from the background service worker).

(() => {
  type BoolSettingKey = {
    [K in keyof FBAHSettings]: FBAHSettings[K] extends boolean ? K : never;
  }[keyof FBAHSettings];

  const TOGGLES: readonly BoolSettingKey[] = [
    "enabled",
    "hideFeedAds",
    "hideRightRailAds",
    "hideReelsAndMarketplaceAds",
    "hideSuggested",
    "aiEnabled",
    "showAIBadges",
  ];

  function $<T extends HTMLElement>(id: string, ctor: new () => T): T {
    const el = document.getElementById(id);
    if (!(el instanceof ctor)) throw new Error(`#${id} missing or not a ${ctor.name}`);
    return el;
  }

  const statusEl = $("status", HTMLParagraphElement);
  const countsEl = $("counts", HTMLParagraphElement);
  const aiStatusEl = $("ai-status", HTMLParagraphElement);
  const modeEl = $("mode", HTMLSelectElement);
  const rescanBtn = $("rescan", HTMLButtonElement);
  const optionsBtn = $("open-options", HTMLButtonElement);

  let settings: FBAHSettings = { ...FBAH_DEFAULT_SETTINGS };

  /** Posts without a stored verdict are asked about once stable for 0.3 s, plus a TypeSafe answer. */
  const AI_SETTLE_MS = 2_500;

  function openOptions(): void {
    void chrome.runtime.openOptionsPage();
  }

  function showCounts(c: FBAHHiddenCounts): void {
    const n = c.hiddenCount;
    statusEl.textContent = `${n} ad${n === 1 ? "" : "s"} hidden on this page.`;
    countsEl.textContent = `${c.hiddenByRules} by rules · ${c.hiddenByAI} by AI`;
  }

  async function activeFacebookTab(): Promise<chrome.tabs.Tab | undefined> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.url && /^https:\/\/([a-z0-9-]+\.)*facebook\.com\//.test(tab.url) ? tab : undefined;
  }

  async function refreshStats(): Promise<void> {
    const tab = await activeFacebookTab();
    if (tab?.id === undefined) {
      statusEl.textContent = "Open facebook.com to see stats.";
      countsEl.textContent = "";
      return;
    }
    try {
      showCounts(await fbahSendToTab(tab.id, { type: "fbah/getStats" }));
    } catch {
      statusEl.textContent = "Reload the Facebook tab to activate the extension.";
      countsEl.textContent = "";
    }
  }

  function renderAIStatus(tone: "ok" | "warn" | "bad" | "off", text: string, action?: string): void {
    const dot = document.createElement("span");
    dot.className = `dot ${tone}`;
    const label = document.createElement("span");
    label.textContent = text;
    const parts: Node[] = [dot, label];
    if (action) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "link";
      btn.textContent = action;
      btn.addEventListener("click", openOptions);
      parts.push(btn);
    }
    aiStatusEl.replaceChildren(...parts);
  }

  async function refreshAIStatus(): Promise<void> {
    if (!settings.aiEnabled) {
      renderAIStatus("off", "AI detection is off.");
      return;
    }
    let st: FBAHAIStatus;
    try {
      st = await fbahSendToBackground({ type: "fbah/aiStatus" });
      if (typeof st !== "object" || st === null) throw new Error("no answer");
    } catch {
      renderAIStatus("bad", "AI status unavailable.");
      return;
    }
    const usage = `${st.callsToday}/${st.cap} calls today`;
    if (!st.hasKey) renderAIStatus("off", "No key.", "Add TypeSafe API key");
    else if (st.keyValid === false) renderAIStatus("bad", "Invalid key.", "Update key");
    else if (st.callsToday >= st.cap) renderAIStatus("warn", `Daily cap reached (${usage}).`, "Change cap");
    else if (st.keyValid === null) renderAIStatus("ok", `Active, key not verified yet · ${usage}`);
    else renderAIStatus("ok", `Active · ${usage}`);
  }

  async function init(): Promise<void> {
    settings = await fbahLoadSettings();

    for (const key of TOGGLES) {
      const input = $(key, HTMLInputElement);
      input.checked = settings[key];
      input.addEventListener("change", async () => {
        settings = { ...settings, [key]: input.checked };
        await fbahSaveSettings(settings);
        if (key === "aiEnabled") void refreshAIStatus();
        setTimeout(refreshStats, 300); // rules and stored AI verdicts are re-applied at once
        setTimeout(refreshStats, AI_SETTLE_MS); // new AI answers arrive later
      });
    }

    modeEl.value = settings.mode;
    modeEl.addEventListener("change", async () => {
      const mode = modeEl.value;
      if (mode !== "collapse" && mode !== "remove") return;
      settings = { ...settings, mode };
      await fbahSaveSettings(settings);
    });

    rescanBtn.addEventListener("click", async () => {
      const tab = await activeFacebookTab();
      if (tab?.id === undefined) return;
      try {
        showCounts(await fbahSendToTab(tab.id, { type: "fbah/rescan" }));
        setTimeout(refreshStats, AI_SETTLE_MS);
      } catch {
        statusEl.textContent = "Reload the Facebook tab to activate the extension.";
      }
    });

    optionsBtn.addEventListener("click", openOptions);

    await Promise.all([refreshStats(), refreshAIStatus()]);
  }

  void init();
})();
