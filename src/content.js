// Claude Cloak: isolated-world content script.
//
// This runs in the default content-script world, so it has chrome.* APIs and
// DOM access but cannot see the page's real fetch (that is injected.js's job in
// the main world). Responsibilities here:
// - own the Set of project chat UUIDs (seeded by a direct paginated fetch and
// topped up by messages from injected.js),
// - hide matching sidebar rows via one injected stylesheet,
// - keep a debounced MutationObserver attached to the (re-mountable) sidebar,
// - cache the enabled flag in memory and report the hidden count to the popup.

(() => {
  "use strict";

  const LOG = "[claude-cloak]";
  const SOURCE = "claude-cloak";

  // Storage keys. The toggle is synced across devices; the count is a local
  // fallback the popup can read if the tab does not answer in time.
  const ENABLED_KEY = "cloakEnabled";
  const COUNT_KEY = "cloakHiddenCount";
  const ENABLED_DEFAULT = true;

  // Tuning constants (named so the intent is visible, not magic numbers).
  const HIDE_DEBOUNCE_MS = 150; // collapse mutation bursts into one hide pass
  const PAGE_LIMIT = 100; // Claude's max page size for chat_conversations
  const MAX_RECORDS = 1000; // hard cap on the seed loop to avoid runaway fetches
  const SIDEBAR_POLL_MS = 500; // how often to look for the sidebar before it mounts
  const SIDEBAR_POLL_MAX = 60; // give up looking after ~30s (60 * 500ms)
  const REATTACH_CHECK_MS = 2000; // how often to confirm the observer is still live
  const ROOT_CLASS = "claude-cloak-on"; // gates the hide rule on <html>
  const HIDDEN_ATTR = "data-claude-cloak"; // marks rows we want hidden

  // Module state.
  const projectUuids = new Set();
  // Chats we have already checked directly, so the navigation safety net does
  // not refetch the same conversation on every route change.
  const checkedChatUuids = new Set();
  let enabled = ENABLED_DEFAULT;
  let hiddenCount = 0;
  let orgId = null;
  let observer = null;
  let observedSidebar = null;
  let hideTimer = null;

  // styling
  // One rule, gated on a root class, so toggling is instant and there is no
  // flash of visible project chats on re-render. Using !important keeps Claude's
  // own styles from overriding us if a row is normally display:flex.
  function injectStylesheet() {
    const id = "claude-cloak-style";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent =
      "html." + ROOT_CLASS + " [" + HIDDEN_ATTR + '="hidden"]{display:none !important;}';
    (document.head || document.documentElement).appendChild(style);
  }

  // UUID parsing
  // Sidebar links look like /chat/<uuid>?maybe=query#maybe-fragment. Strip the
  // query and fragment before reading the uuid so matching is exact.
  function uuidFromHref(href) {
    if (!href) return null;
    let path = href;
    const hash = path.indexOf("#");
    if (hash !== -1) path = path.slice(0, hash);
    const query = path.indexOf("?");
    if (query !== -1) path = path.slice(0, query);
    const match = path.match(/\/chat\/([^/]+)/);
    return match ? match[1] : null;
  }

  // hiding
  // Toggle the root class from the cached flag, then walk the chat links and
  // mark the project-owned ones. Starred chats never enter projectUuids (the
  // seed fetch uses starred=false and the API only tags real project chats), so
  // they are never marked here.
  //
  // The scan is scoped to the sidebar only. The project page lists its own chats
  // in the main content area, and those should stay visible; we only want to
  // tidy the sidebar. Scoping the marking here (not just the CSS) keeps those
  // main-content rows untouched.
  function applyHide() {
    const root = document.documentElement;
    if (enabled) root.classList.add(ROOT_CLASS);
    else root.classList.remove(ROOT_CLASS);

    const scope =
      observedSidebar && observedSidebar.isConnected
        ? observedSidebar
        : findSidebar();
    if (!scope) {
      hiddenCount = 0;
      return;
    }

    let count = 0;
    const links = scope.querySelectorAll('a[href^="/chat/"]');
    for (const link of links) {
      const uuid = uuidFromHref(link.getAttribute("href"));
      if (!uuid) continue;

      // Prefer the list row; fall back to the link itself if Claude changes the
      // markup so a missing <li> does not silently break hiding.
      const row = link.closest("li") || link.closest('[role="listitem"]') || link;
      const isProject = projectUuids.has(uuid);

      if (isProject) {
        row.setAttribute(HIDDEN_ATTR, "hidden");
        count += 1;
      } else if (row.getAttribute(HIDDEN_ATTR) === "hidden") {
        row.removeAttribute(HIDDEN_ATTR);
      }
    }

    hiddenCount = count;
    // Mirror the count so the popup has a fallback if the tab is busy.
    try {
      chrome.storage.local.set({ [COUNT_KEY]: count });
    } catch (err) {
      console.debug(LOG, "count mirror skipped", err);
    }
  }

  function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = null;
      applyHide();
    }, HIDE_DEBOUNCE_MS);
  }

  // API seed
  // Resolve the organization id, first from the URL, then from the orgs list.
  async function resolveOrgId() {
    const fromUrl = location.href.match(
      /\/organizations\/([0-9a-f-]{36})/i
    );
    if (fromUrl) return fromUrl[1];

    try {
      const res = await fetch("https://claude.ai/api/organizations", {
        credentials: "include",
      });
      if (!res.ok) {
        console.warn(LOG, "organizations request failed", res.status);
        return null;
      }
      const orgs = await res.json();
      if (Array.isArray(orgs) && orgs[0] && orgs[0].uuid) return orgs[0].uuid;
    } catch (err) {
      console.warn(LOG, "could not resolve organization id", err);
    }
    return null;
  }

  // Page through chat_conversations and seed the project UUID set. This covers
  // chats already loaded before injected.js had anything to intercept. We ask
  // for starred=false so starred chats never enter the set.
  async function seedProjectUuids() {
    if (!orgId) orgId = await resolveOrgId();
    if (!orgId) {
      console.warn(LOG, "no organization id; project seeding stopped");
      return;
    }

    let offset = 0;
    let added = 0;
    while (offset < MAX_RECORDS) {
      const url =
        "https://claude.ai/api/organizations/" +
        orgId +
        "/chat_conversations?limit=" +
        PAGE_LIMIT +
        "&offset=" +
        offset +
        "&starred=false";

      let page;
      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) {
          console.warn(LOG, "chat_conversations page failed", res.status);
          break;
        }
        page = await res.json();
      } catch (err) {
        console.warn(LOG, "chat_conversations fetch failed", err);
        break;
      }

      const records = Array.isArray(page)
        ? page
        : Array.isArray(page && page.conversations)
          ? page.conversations
          : [];
      for (const record of records) {
        if (record && record.uuid && record.project_uuid) {
          if (!projectUuids.has(record.uuid)) added += 1;
          projectUuids.add(record.uuid);
        }
      }

      if (records.length < PAGE_LIMIT) break; // last page reached
      offset += PAGE_LIMIT;
    }

    if (added) {
      console.debug(LOG, "seeded project chats:", added);
      scheduleHide();
    }
  }

  // Read the chat uuid from the current path, if we are on a chat route.
  function currentChatUuid() {
    const match = location.pathname.match(/\/chat\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  // Safety net for a freshly created or freshly opened chat. The main path is
  // injected.js reading the create/open response, but if that response is ever
  // missed (timing, a cached client-side navigation with no network), this
  // checks the open chat directly so a project chat does not linger visible
  // until a reload. Each chat is checked at most once.
  async function verifyCurrentChat() {
    const uuid = currentChatUuid();
    if (!uuid || projectUuids.has(uuid) || checkedChatUuids.has(uuid)) return;
    checkedChatUuids.add(uuid);

    if (!orgId) orgId = await resolveOrgId();
    if (!orgId) return;

    try {
      const res = await fetch(
        "https://claude.ai/api/organizations/" +
          orgId +
          "/chat_conversations/" +
          uuid,
        { credentials: "include" }
      );
      if (!res.ok) return;
      const convo = await res.json();
      if (convo && convo.project_uuid) {
        projectUuids.add(uuid);
        scheduleHide();
      }
    } catch (err) {
      console.debug(LOG, "verify current chat failed", err);
    }
  }

  // messaging from injected.js
  // Accept only same-window messages tagged with our source. injected.js sends
  // exactly two shapes: project-chats (uuids) and navigation.
  function onWindowMessage(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE) return;

    if (data.type === "project-chats" && Array.isArray(data.uuids)) {
      let added = 0;
      for (const uuid of data.uuids) {
        if (uuid && !projectUuids.has(uuid)) {
          projectUuids.add(uuid);
          added += 1;
        }
      }
      if (added) scheduleHide();
    } else if (data.type === "navigation") {
      // A client-side route changed (for example a new chat created inside a
      // project). Re-apply hiding, verify the chat we landed on, and re-seed if
      // the set looks empty (we may have switched into a fresh org).
      scheduleHide();
      verifyCurrentChat();
      if (projectUuids.size === 0) seedProjectUuids();
    }
  }

  // sidebar observer
  // Find the sidebar defensively. Claude does not give us a stable hook, so we
  // try the most specific landmark first and fall back to broader ones.
  function findSidebar() {
    return (
      document.querySelector('[role="complementary"]') ||
      document.querySelector("aside") ||
      document.querySelector("nav")
    );
  }

  function attachObserver(sidebar) {
    if (observer) observer.disconnect();
    observer = new MutationObserver(scheduleHide);
    observer.observe(sidebar, { childList: true, subtree: true });
    observedSidebar = sidebar;
    scheduleHide();
    console.debug(LOG, "observer attached to sidebar");
  }

  // Poll until the sidebar exists, then attach. Returns once attached or after
  // the poll budget runs out.
  function waitForSidebarAndAttach() {
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      const sidebar = findSidebar();
      if (sidebar) {
        clearInterval(timer);
        attachObserver(sidebar);
      } else if (tries >= SIDEBAR_POLL_MAX) {
        clearInterval(timer);
        console.warn(LOG, "sidebar not found; observer not attached");
      }
    }, SIDEBAR_POLL_MS);
  }

  // Claude can replace the sidebar node wholesale on navigation. Periodically
  // confirm the observed node is still in the document and re-attach if not.
  function watchForReattach() {
    setInterval(() => {
      if (!observedSidebar || !observedSidebar.isConnected) {
        const sidebar = findSidebar();
        if (sidebar && sidebar !== observedSidebar) {
          console.debug(LOG, "sidebar re-mounted; re-attaching observer");
          attachObserver(sidebar);
        }
      }
    }, REATTACH_CHECK_MS);
  }

  // popup messaging
  function onRuntimeMessage(message, _sender, sendResponse) {
    if (message && message.type === "get-count") {
      sendResponse({ count: hiddenCount, enabled });
      return true; // keep the channel open for the synchronous response
    }
    return false;
  }

  // enabled flag cache
  function watchEnabledFlag() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes[ENABLED_KEY]) {
        enabled = changes[ENABLED_KEY].newValue !== false;
        applyHide(); // immediate, not debounced: toggling should feel instant
      }
    });
  }

  // bootstrap
  async function init() {
    injectStylesheet();

    try {
      const stored = await chrome.storage.sync.get(ENABLED_KEY);
      enabled =
        stored && ENABLED_KEY in stored
          ? stored[ENABLED_KEY] !== false
          : ENABLED_DEFAULT;
    } catch (err) {
      console.warn(LOG, "could not read enabled flag; defaulting on", err);
      enabled = ENABLED_DEFAULT;
    }

    window.addEventListener("message", onWindowMessage);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    watchEnabledFlag();

    waitForSidebarAndAttach();
    watchForReattach();
    seedProjectUuids();
    verifyCurrentChat();
  }

  init();
})();
