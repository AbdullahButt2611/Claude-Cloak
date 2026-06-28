// Claude Cloak popup logic.
//
// Reads and writes the toggle in chrome.storage.sync, asks the active claude.ai
// tab for a live hidden count (falling back to the mirrored count in local
// storage), and keeps the status line truthful about what is happening.

(() => {
  "use strict";

  const ENABLED_KEY = "cloakEnabled";
  const COUNT_KEY = "cloakHiddenCount";
  const ENABLED_DEFAULT = true;

  const toggle = document.getElementById("hide-toggle");
  const status = document.getElementById("status");

  // Reflect the boolean in both the checkbox and its ARIA state.
  function reflectEnabled(enabled) {
    toggle.checked = enabled;
    toggle.setAttribute("aria-checked", String(enabled));
  }

  // Compose the status line from the current count and enabled state. Kept in
  // one place so wording stays consistent.
  function renderStatus(enabled, count) {
    if (count === null) {
      status.textContent = "Open a claude.ai tab to see hidden chats.";
      return;
    }
    if (count === 0) {
      status.textContent = enabled
        ? "No project chats to hide right now."
        : "Hiding is off. No project chats hidden.";
      return;
    }
    const noun = count === 1 ? "project chat" : "project chats";
    status.textContent = enabled
      ? "Hiding " + count + " " + noun + "."
      : count + " " + noun + " will hide when on.";
  }

  // Ask the active claude.ai tab for its live count. Resolve to null if there is
  // no such tab or it does not answer, so the caller can fall back.
  function getCountFromTab() {
    return new Promise((resolve) => {
      chrome.tabs.query(
        { active: true, currentWindow: true },
        (tabs) => {
          const tab = tabs && tabs[0];
          if (!tab || !tab.url || !tab.url.startsWith("https://claude.ai/")) {
            resolve(null);
            return;
          }
          chrome.tabs.sendMessage(tab.id, { type: "get-count" }, (response) => {
            // A missing receiver sets lastError; swallow it and fall back.
            if (chrome.runtime.lastError || !response) {
              resolve(null);
              return;
            }
            resolve(typeof response.count === "number" ? response.count : null);
          });
        }
      );
    });
  }

  async function loadCount(enabled) {
    let count = await getCountFromTab();
    if (count === null) {
      // Fall back to the count the content script mirrored into local storage.
      try {
        const stored = await chrome.storage.local.get(COUNT_KEY);
        if (stored && typeof stored[COUNT_KEY] === "number") {
          count = stored[COUNT_KEY];
        }
      } catch (err) {
        console.debug("[claude-cloak:popup] count fallback failed", err);
      }
    }
    renderStatus(enabled, count);
  }

  async function init() {
    let enabled = ENABLED_DEFAULT;
    try {
      const stored = await chrome.storage.sync.get(ENABLED_KEY);
      enabled =
        stored && ENABLED_KEY in stored
          ? stored[ENABLED_KEY] !== false
          : ENABLED_DEFAULT;
    } catch (err) {
      console.debug("[claude-cloak:popup] read enabled failed", err);
    }
    reflectEnabled(enabled);

    toggle.addEventListener("change", async () => {
      const next = toggle.checked;
      reflectEnabled(next);
      try {
        await chrome.storage.sync.set({ [ENABLED_KEY]: next });
      } catch (err) {
        console.debug("[claude-cloak:popup] write enabled failed", err);
      }
      loadCount(next);
    });

    loadCount(enabled);
  }

  init();
})();
