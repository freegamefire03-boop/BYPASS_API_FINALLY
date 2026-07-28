# Changelog

All notable changes to this project are logged here, newest first.

## 2026-07-28
- Changed: Verification now checks URL change instead of DOM/input state — compares tab URL before vs after send; if different, prompt was delivered
- Removed: Old `verifySend` that used `executeScript` to check `document.activeElement` and input value (fragile, site-dependent)
- Added: Post-send verification — after pasting + Enter, the extension checks if the input was cleared (prompt sent) and reports per-tab success/failure
- Added: Results summary in popup — shows each URL with status (green=success, orange=uncertain, red=failed) and reason
- Added: Popup now polls for results instead of closing immediately after sending
- Changed: `sendToActivatedTab` now returns a result object with `status` and `reason`
- Changed: Both auto-cycle and experimental modes collect and store results in `chrome.storage.local`
- Changed: Default mode now uses tab auto-cycling (opens all tabs in parallel, then sequentially activates each to paste+send) — fixes the core issue where background tabs couldn't receive trusted input
- Added: `experimentalBackground` option to keep legacy direct-background behavior
- Added: `debugLog` option — records per-tab timeline of every step and downloads as `.json`
- Added: New toggle options in popup UI (experimental background mode, debug log)
- Added: `makeLogger()` debug logging system with timestamped entries
- Changed: `runAutomation()` now accepts options object `{skipWait, experimentalBackground, debugLog}` instead of just `skipWait`
- Changed: README updated to document new modes and debugging features
