// Claude Cloak: main-world interceptor.
//
// This file runs in the page's own JavaScript world ("world": "MAIN") so it can
// actually wrap the page's fetch / XMLHttpRequest and observe history routing.
// A normal content script runs in an isolated world and cannot see or wrap the
// page's real fetch, so that work has to happen here. We never touch the DOM or
// chrome.* APIs from this file; we only read responses we are already making and
// hand the relevant chat UUIDs to content.js through window.postMessage.

(() => {
  "use strict";

  const SOURCE = "claude-cloak";
  const LOG = "[claude-cloak:injected]";

  // Any conversations endpoint carries the project_uuid field we care about.
  const CONVERSATIONS_MARKER = "/chat_conversations";

  // Post the two and only two message shapes this script is allowed to emit.
  function postProjectChats(uuids) {
    if (!uuids.length) return;
    window.postMessage({ source: SOURCE, type: "project-chats", uuids }, "*");
  }

  function postNavigation() {
    window.postMessage({ source: SOURCE, type: "navigation" }, "*");
  }

  // Pull the uuids of project-owned chats out of a chat_conversations payload.
  // Claude returns an array of conversation records; a record belongs to a
  // project when project_uuid is truthy. We stay defensive about the shape so a
  // future API change degrades to "found nothing" rather than throwing.
  function extractProjectUuids(data) {
    const records = Array.isArray(data)
      ? data
      : Array.isArray(data && data.conversations)
        ? data.conversations
        : null;
    if (!records) return [];

    const uuids = [];
    for (const record of records) {
      if (record && record.uuid && record.project_uuid) {
        uuids.push(record.uuid);
      }
    }
    return uuids;
  }

  function isConversationsUrl(url) {
    return typeof url === "string" && url.includes(CONVERSATIONS_MARKER);
  }

  // fetch wrapper
  const realFetch = window.fetch;
  if (typeof realFetch === "function") {
    window.fetch = function (...args) {
      const result = realFetch.apply(this, args);
      try {
        const request = args[0];
        const url =
          typeof request === "string"
            ? request
            : request && typeof request.url === "string"
              ? request.url
              : "";
        if (isConversationsUrl(url)) {
          result
            .then((response) => {
              // Clone so we never consume the body the app is about to read.
              response
                .clone()
                .json()
                .then((data) => postProjectChats(extractProjectUuids(data)))
                .catch((err) =>
                  console.debug(LOG, "fetch body parse skipped", err)
                );
            })
            .catch(() => {
              // Network error: the app handles its own failure, nothing for us.
            });
        }
      } catch (err) {
        console.debug(LOG, "fetch wrapper skipped", err);
      }
      return result;
    };
  } else {
    console.debug(LOG, "window.fetch missing, fetch interception disabled");
  }

  // XMLHttpRequest wrapper
  // Some clients still use XHR. We record the URL at open() time and inspect the
  // response on load. We read responseText only; we never block or alter it.
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const realOpen = XHR.prototype.open;
    const realSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url, ...rest) {
      try {
        this.__claudeCloakUrl = typeof url === "string" ? url : "";
      } catch (err) {
        console.debug(LOG, "xhr open tag skipped", err);
      }
      return realOpen.call(this, method, url, ...rest);
    };

    XHR.prototype.send = function (...sendArgs) {
      try {
        if (isConversationsUrl(this.__claudeCloakUrl)) {
          this.addEventListener("load", () => {
            try {
              const text = this.responseText;
              if (text) postProjectChats(extractProjectUuids(JSON.parse(text)));
            } catch (err) {
              console.debug(LOG, "xhr body parse skipped", err);
            }
          });
        }
      } catch (err) {
        console.debug(LOG, "xhr send tag skipped", err);
      }
      return realSend.apply(this, sendArgs);
    };
  }

  // history / navigation hooks
  // Claude is a single-page app; new project chats appear on client-side routes
  // with no page load. Wrapping pushState / replaceState and listening for
  // popstate lets content.js re-apply hiding after each navigation.
  function wrapHistoryMethod(name) {
    const original = history[name];
    if (typeof original !== "function") return;
    history[name] = function (...historyArgs) {
      const out = original.apply(this, historyArgs);
      try {
        postNavigation();
      } catch (err) {
        console.debug(LOG, "navigation post skipped", err);
      }
      return out;
    };
  }

  wrapHistoryMethod("pushState");
  wrapHistoryMethod("replaceState");
  window.addEventListener("popstate", postNavigation);
})();
