// Claude Cloak popup tests.
//
// These load the unpacked extension into a persistent Chromium context so the
// real chrome.* APIs are present, then drive the popup at its extension URL.
// They cover the toggle persistence, the visual states, the accessibility tree,
// and that the extension loads with no manifest or console errors. They do not
// touch https://claude.ai, which needs an authenticated session and is verified
// manually (see README).

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { test, expect, chromium } = require("@playwright/test");

const EXTENSION_PATH = path.resolve(__dirname, "..");
const SCREENSHOT_DIR = path.resolve(__dirname, "..", "test-results");

// Derive the extension id the same way Chrome does, from the manifest "key".
// This keeps the test in sync with the manifest without hardcoding the id.
function extensionIdFromManifest() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(EXTENSION_PATH, "manifest.json"), "utf8")
  );
  const der = Buffer.from(manifest.key, "base64");
  const hash = crypto.createHash("sha256").update(der).digest();
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i] >> 4));
    id += String.fromCharCode(97 + (hash[i] & 0x0f));
  }
  return id;
}

let context;
let extensionId;
const consoleErrors = [];

test.beforeAll(async () => {
  // A throwaway profile directory keeps each run clean.
  const userDataDir = fs.mkdtempSync(
    path.join(require("os").tmpdir(), "claude-cloak-")
  );

  // The "chromium" channel runs the new headless mode, which (unlike the old
  // headless) loads unpacked extensions. Without it --load-extension is ignored.
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });

  context.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  // The manifest carries a fixed "key", so the extension id is deterministic.
  // This build has no background service worker, so deriving the id this way is
  // simpler and more reliable than waiting on a serviceworker event.
  extensionId = extensionIdFromManifest();
});

test.afterAll(async () => {
  if (context) await context.close();
});

function popupUrl() {
  return `chrome-extension://${extensionId}/src/popup.html`;
}

test("extension loads with an id and no console errors", async () => {
  expect(extensionId, "extension id should resolve").toBeTruthy();
  const page = await context.newPage();
  await page.goto(popupUrl());
  await page.waitForLoadState("domcontentloaded");
  await page.close();
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});

test("popup renders the core controls", async () => {
  const page = await context.newPage();
  await page.goto(popupUrl());

  await expect(page.getByRole("heading", { name: "Claude Cloak" })).toBeVisible();
  await expect(page.getByText("Hide project chats")).toBeVisible();
  await expect(page.getByRole("switch")).toBeVisible();
  await expect(page.locator("#status")).toBeVisible();
  await expect(page.getByText(/Reload Claude/i)).toBeVisible();

  await page.close();
});

test("toggle defaults to on and flips the stored flag", async () => {
  const page = await context.newPage();
  await page.goto(popupUrl());

  const sw = page.getByRole("switch");
  await expect(sw).toBeChecked();

  // Turn it off and confirm the synced flag is written false.
  await sw.click();
  await expect(sw).not.toBeChecked();
  await expect(sw).toHaveAttribute("aria-checked", "false");

  const offValue = await page.evaluate(
    () =>
      new Promise((resolve) =>
        chrome.storage.sync.get("cloakEnabled", (r) => resolve(r.cloakEnabled))
      )
  );
  expect(offValue).toBe(false);

  // Turn it back on.
  await sw.click();
  await expect(sw).toBeChecked();
  const onValue = await page.evaluate(
    () =>
      new Promise((resolve) =>
        chrome.storage.sync.get("cloakEnabled", (r) => resolve(r.cloakEnabled))
      )
  );
  expect(onValue).toBe(true);

  await page.close();
});

test("state persists across popup reopens", async () => {
  const page = await context.newPage();
  await page.goto(popupUrl());
  await page.getByRole("switch").click(); // turn off
  await expect(page.getByRole("switch")).not.toBeChecked();
  await page.close();

  const reopened = await context.newPage();
  await reopened.goto(popupUrl());
  await expect(reopened.getByRole("switch")).not.toBeChecked();

  // Restore default for any later runs.
  await reopened.getByRole("switch").click();
  await reopened.close();
});

test("switch is keyboard operable", async () => {
  const page = await context.newPage();
  await page.goto(popupUrl());

  const sw = page.getByRole("switch");
  await expect(sw).toBeChecked();
  await sw.focus();
  await page.keyboard.press("Space");
  await expect(sw).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(sw).toBeChecked();

  await page.close();
});

test("status line has a polite live region", async () => {
  const page = await context.newPage();
  await page.goto(popupUrl());
  await expect(page.locator("#status")).toHaveAttribute("aria-live", "polite");
  await page.close();
});

test("captures popup screenshots for visual review", async () => {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const page = await context.newPage();
  await page.setViewportSize({ width: 320, height: 240 });
  await page.goto(popupUrl());

  // animations: "disabled" fast-forwards the toggle transition so the capture
  // reflects the settled state rather than a mid-transition frame.
  // On state.
  await expect(page.getByRole("switch")).toBeChecked();
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "popup-on.png"),
    animations: "disabled",
  });

  // Off state.
  await page.getByRole("switch").click();
  await expect(page.getByRole("switch")).not.toBeChecked();
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "popup-off.png"),
    animations: "disabled",
  });

  // Restore default.
  await page.getByRole("switch").click();
  await page.close();
});
