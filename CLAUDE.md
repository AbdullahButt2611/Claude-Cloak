# CLAUDE.md

This file is the standing context and rulebook for any Claude session working in this repository. Read it fully before doing anything. It tells you what we are building, the standards you must hold, and the tools you must use. It does not contain the task itself.

## How to start a session

1. Read this entire file first.
2. Look for `Prompt.md` in the repository root. That file holds the actual task, scope, and acceptance criteria for the current piece of work, explained in one go.
3. If `Prompt.md` is present, treat it as the source of truth for what to build, and treat this file as the source of truth for how to build it. If the two ever conflict, follow `Prompt.md` for scope and ask before breaking any rule in this file.
4. If `Prompt.md` is not present yet, do not guess the task. Set up or improve the project structure, tooling, and groundwork described here, and wait for the prompt.

## What we are building

A Chrome extension (Manifest V3) that cleans up the Claude sidebar, starting with hiding chats that belong to Projects, controlled by a simple toggle in the action popup. This is a from-scratch rebuild of an earlier reference extension, done with a better architecture, a better UI, and proper testing. The goal is a small, fast, privacy-clean tool that does not break when Claude updates its interface.

Core behavior, at minimum:
- Detect which chats belong to Projects using the `project_uuid` field from Claude's own API, not by scraping chat titles.
- Hide those chats from the sidebar when the toggle is on, show them when it is off.
- Keep starred chats visible.
- Collect no data, send nothing to any third party.

## Tech stack and constraints

- Manifest V3 only. No deprecated MV2 APIs.
- Plain modern JavaScript by default. Do not add a framework (React, Vue, and so on) for the popup unless `Prompt.md` explicitly calls for it. The popup is tiny and a framework is not justified.
- Keep runtime dependencies at or near zero. A minimal build step is acceptable only if it is needed (for example to bundle fonts or icons), and if added it must be documented in the README.
- Request the minimum permissions required. At present that is `storage` plus a host permission scoped to `https://claude.ai/*`. Do not add permissions speculatively.
- No remote code, no external network calls beyond Claude's own same-origin API. This is a privacy promise, treat it as a hard rule.

## Non-negotiable correctness requirements

These exist because the reference implementation got them wrong. Do not repeat these mistakes.

1. **Interception must run in the main world.** Content scripts run in an isolated JavaScript world and cannot see or wrap the page's own `fetch`. If you need to observe Claude's API requests (for pagination and newly created chats), inject a script registered with `"world": "MAIN"` and pass data back to the content script with `postMessage`. Never assume reassigning `window.fetch` from a normal content script does anything to the page.
2. **Handle more than 100 chats.** Do not rely on a single `limit=100` fetch. Paginate the initial load, and keep the project list updated as the user scrolls and the app loads more pages.
3. **Handle single-page-app navigation.** Claude routes client side. Hook `history.pushState`, `history.replaceState`, and `popstate` (from the main world where needed) so newly created or newly loaded project chats are caught without a full page reload.
4. **Survive sidebar re-mounts.** If the observed sidebar node is replaced by the app, detect that and re-attach the observer. Do not attach once and assume it lives forever.
5. **Debounce DOM work and cache state.** The sidebar mutates constantly. Debounce the `MutationObserver` handler, and cache the enabled flag in memory updated through `chrome.storage.onChanged`, rather than reading storage on every mutation.
6. **Hide via an injected stylesheet, not inline style.** Mark project rows with a class or data attribute and hide them with one injected CSS rule gated on a root class. This removes the flash of visible chats on re-render and makes toggling instant. Strip query strings and fragments before matching chat UUIDs, and use a defensive ancestor selector so a markup change in Claude does not silently break hiding.
7. **Fail loudly in development, quietly in production.** Do not swallow errors with empty catch blocks. Log clearly under a single prefix.

## UI and UX standards

The popup and any in-page UI must look intentional and native to Claude, not like a default browser form.

- **Use the `ui-ux-pro-max` skill** for all visual and interaction design work. Invoke it before designing or refining any UI, and follow its guidance on layout, hierarchy, spacing, states, and polish. Do not hand-roll UI decisions when that skill is available.
- **Typography: Poppins, from Google Fonts.** Use Poppins as the primary typeface across the popup and any injected UI. Best practice for an extension is to self-host the font: download the needed Poppins weights as `woff2`, place them under an `assets/fonts/` directory, and load them with local `@font-face` rules. Do not hotlink `fonts.googleapis.com` at runtime, because remote font loading conflicts with MV3 content security policy and with our no-external-requests privacy stance. Bundle only the weights actually used (for example 400, 500, 600) to keep the package small.
- **Accent and theme.** Match Claude's own visual language rather than generic system colors. Lean on Claude's warm accent (the coral family around `#c96442`) rather than an off-brand blue or green. Support a clean dark interface, and consider respecting the user's `prefers-color-scheme` if `Prompt.md` asks for light mode too.
- **Feedback.** The popup should make it obvious the extension is working, for example a live count of how many chats are currently hidden, and a short hint about reloading Claude if a hidden chat reappears. A hide tool that gives no feedback feels broken even when it works.
- **Accessibility is required, not optional.** Associate labels with controls, provide visible keyboard focus states, use sufficient contrast, add `aria-label` and `aria-live` where appropriate, and make every control reachable and operable by keyboard.
- **Sizing.** The popup should size to its content without dead space, and remain stable (no layout jump) as the status text updates.

## Testing and verification

Verify the UI with Playwright before considering any UI work done.

- **Use the Playwright skill** to drive a Chromium browser for testing.
- For the popup, render `popup.html`, interact with the toggle, and confirm the stored flag flips correctly, the visual states are right, and the accessibility tree is sound. Capture screenshots for visual review.
- To smoke-test the packaged extension, launch a persistent Chromium context with the unpacked extension loaded (`--load-extension` / `--disable-extensions-except`) and confirm it loads with no manifest or console errors.
- Be honest about limits: a full end-to-end test against `https://claude.ai` requires an authenticated session and cannot run unattended in CI. Script what can be scripted, and document the manual verification steps for the logged-in content-script behavior in the README rather than pretending they are automated.
- Keep Playwright scripts out of the shipped extension. They are tooling, not part of the package.

## Code quality and conventions

- Write clear, modern, well-named JavaScript. Small focused functions over large ones. Comment the non-obvious (the isolation boundary, the timing assumptions), not the obvious.
- Keep the content script, the injected main-world script, and the popup logic in separate files with clear responsibilities.
- No magic numbers without a named constant and a one-line reason.
- Keep the manifest minimal and add useful metadata (`homepage_url`, author) where it helps users.
- Include real repo hygiene: a `LICENSE` file, a `README.md` that explains install, usage, how it works, and the manual test steps, and crisp multi-size icons rather than one image scaled three ways.

## Writing style for docs, comments, and commits

- Plain, humble, professional English. No marketing voice, no exaggeration, no AI-sounding filler.
- Do not use em dashes or triple dashes anywhere. Use commas, parentheses, or separate sentences.
- Commit messages should be short and factual, describing what changed and why.

## Definition of done

A piece of work is done when: it meets the scope in `Prompt.md`, it satisfies every non-negotiable correctness requirement above that applies to it, the UI was designed with the `ui-ux-pro-max` skill and verified with Playwright, accessibility holds, the README reflects reality, and nothing in the package makes an external request or collects data. If any of these cannot be met, stop and flag it rather than shipping around it.
