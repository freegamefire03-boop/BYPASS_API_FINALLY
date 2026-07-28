# AI Chat Auto-Prompt

> **IMPORTANT — AI agent instruction:** `NOTES.md` contains developer session notes.
> Never read this file unless the user explicitly asks you to write or read a note.

A Chrome extension that opens multiple AI chat sites in parallel tabs,
pastes a prompt into each, and hits Enter — no API calls, no HTTP
requests to any AI provider. Uses tab auto-cycling to deliver trusted
input to each tab.

## Install (unpacked)

1. Unzip this folder somewhere permanent (don't delete it after installing —
   Chrome loads the extension directly from these files).
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `ai-chat-autoprompt` folder.
5. Pin the extension (puzzle-piece icon → pin) so it's easy to click.

## Use

1. Click the extension icon.
2. Paste one or more AI chat URLs, **one per line** (e.g.
   `https://gemini.google.com/app`, `https://claude.ai/new`,
   `https://chat.deepseek.com`, `https://kimi.com`) — you should already be
   logged in to each site in Chrome.
3. Type your prompt (sent to every URL you listed).
4. Optionally flip **"Skip waiting for full page load"** on — see below.
5. Click **Open & Send**.
6. All tabs open in parallel, then the extension automatically cycles
   through each tab (briefly activating it) to paste and send — no manual
   switching needed.

## How it works — auto-cycle mode (default)

Chrome only routes trusted input to the **active** tab. Background tabs
simply can't receive debugger-injected keystrokes — confirmed by Chromium's
own issue tracker. So the extension:

1. Opens every tab in parallel (loading is not blocked, only input delivery).
2. Once all tabs are loaded, it rapidly cycles which tab is "active" —
   briefly bringing each to the front just long enough to paste and send.
3. This mirrors what you were doing manually with Ctrl+1/2/3, but automated
   and near-instant per tab (a few hundred ms).

### Experimental background mode

An optional toggle that keeps all tabs in the background (no cycling).
This uses the old direct approach — expect it to fail on most sites, which
is the known limitation this mode does not work around.

### Debug log

An optional toggle that records a timestamped, per-tab timeline of every
step (tab opened, debugger attach, load-wait, focus detection, keys
dispatched, errors) and downloads it as a `.json` file at the end of the
run.

## The "skip waiting for full page load" toggle

Off (default): the extension waits for the tab to report itself fully
loaded, plus a ~1.2s grace period, before it starts checking for a focused
input box. Safer for slower-loading sites.

On: it skips that wait almost entirely — just a ~1 second settle delay after
opening the tab — and goes straight into the same polling loop that checks
`document.activeElement` over and over until a real `<textarea>`, `<input>`,
or content-editable box is actually focused. It is never a blind, fixed-time
paste either way — the toggle only changes how long it waits *before* it
starts that check, not whether it checks. Turn this on for sites whose input
box exists and grabs focus almost immediately, to shave a few seconds off
the total time when running many tabs at once.

## Why it needs the "debugger" permission (and the yellow banner)

You asked for the "paste + Enter" mechanism specifically, not a fake/JS
version of it — and that distinction matters technically:

A content script can *try* to fake a keypress with `dispatchEvent()`, but
Chrome will never treat that as a real, trusted keystroke. Trusted events are
required to trigger the browser's actual built-in "paste from clipboard"
action — otherwise a page could silently paste your clipboard into anything.
So a plain content-script approach *looks* like it should work and then
silently does nothing, which is almost certainly why your previous attempts
failed.

The one API that can inject genuinely trusted input is the Chrome DevTools
Protocol, exposed to extensions as `chrome.debugger`. This extension attaches
it to the tab it just opened, sends a real Ctrl+V and a real Enter, then
detaches immediately. While it's attached, Chrome shows a yellow bar saying
the extension "is debugging this browser" — that's expected, it's Chrome
telling you the automation is genuinely happening, not a bug. It disappears
automatically a fraction of a second later, right after Enter is sent.

## How the flow is sequenced

1. Prompt is copied to the clipboard immediately (via a hidden offscreen
   page — the extension's background worker has no clipboard access itself).
2. All tabs open in parallel, each with its own `chrome.debugger` attach.
   Each waits for page load + grace period (or just a short settle in
   skip-wait mode).
3. The extension cycles through tabs one at a time: activates each tab,
   polls `document.activeElement` for a real input box (up to ~8s), then
   sends Ctrl+V, waits ~600ms, sends Enter, and detaches the debugger.
4. After sending, each tab is **verified**: the extension checks if the input
   field was cleared (prompt was delivered) and reports success/failure per
   tab. Results appear in the popup as a summary list.

## Known limitations (personal-use tool, not hardened)

- If Chrome DevTools is already open on a tab, `chrome.debugger.attach` will
  fail for that tab (Chrome only allows one debugger client at a time) — the
  extension logs this to its service worker console rather than failing
  silently, and the other tabs are unaffected.
- Sites that put their chat input inside an `<iframe>` aren't handled (none
  of the major AI chat sites currently do this for their main composer).
- If a site takes longer than ~15s to render/focus its input, the extension
  will still attempt the keystrokes as a fallback, but may miss if the box
  truly isn't focused yet — safe to just re-click the input and re-run for
  that one tab.
- Background-tab delivery of keyboard events through `chrome.debugger` is the
  same mechanism headless automation tools (Puppeteer/Playwright) rely on and
  is expected to work without the tab being focused. In the rare case a
  particular site doesn't react while backgrounded, just click that tab once
  to bring it forward — the paste/Enter step will still complete normally.
- Broad `<all_urls>` + `debugger` permissions are intentional here since this
  is for your own personal use across arbitrary AI chat sites; don't publish
  this as-is to the Chrome Web Store without narrowing scope.

## Results summary

After sending, the popup shows a per-URL results list:

- **Green dot**: Send verified — input was cleared after paste+enter
- **Orange dot**: Uncertain — page state unclear, may have worked
- **Red dot**: Failed — error during send or verification

The popup stays open until results arrive (polls for up to 60s) instead of
closing immediately. This lets you see what worked and what didn't.

## Debugging

`chrome://extensions` → this extension → **service worker** (blue link) opens
its console, where `console.error`/`console.warn` messages from
`background.js` show up if something doesn't go as planned.

Enable the **"Save debug log"** toggle before running to get a downloadable
`.json` file with a full per-tab timeline of every step.
