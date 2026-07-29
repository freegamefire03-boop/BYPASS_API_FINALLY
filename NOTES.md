# Notes

## 1 — Parallel tab processing idea (unresolved)

**Goal:** Instead of cycling tabs sequentially (activate tab 1 → detect input → send → verify → move to tab 2), find a way to "wake up" all tabs in rapid succession so the extension can do the actual work while tabs are backgrounded.

**The blocker (confirmed):** Chrome's `Input.dispatchKeyEvent` (CDP via `chrome.debugger`) only delivers trusted keystrokes to the **active** tab. Background tabs silently drop them. This isn't a bug — it's how Chrome's input pipeline is designed.

**What we already tried that doesn't work:**
- Sending Enter to background tabs via debugger → ignored by Chrome
- Using content scripts to dispatch synthetic events → untrusted, sites ignore them

**The idea:** Maybe we only need the tab to be active during the Enter keystroke (a few ms), not during the full focus-detect + insertText + verify cycle. If `Input.insertText` works on background tabs (it injects text directly into the DOM, not via the input pipeline), we could:
  1. Rapidly flash each tab to the front (just to deliver Enter)
  2. Do everything else (insertText, verification) while backgrounded

**Unknowns / needs investigation:**
- Does `Input.insertText` work on background tabs? (It injects text directly, not via keystrokes — so it might work.)
- Does `chrome.scripting.executeScript` (for focus detection, input marking, content reading) work on background tabs? (It should — it's not input-related.)
- Can we reduce the "active" window to a sub-100ms flash per tab just for the Enter key?

**If this works,** the auto-cycle mode could be: activate tab → wait 0ms → send Enter → deactivate → move on. All the slow parts (waitForFocusedInput, Tab navigation fallback, insertText delay, verifySend) run in the background. This would make auto-cycle nearly as fast as parallel experimental mode.

**Status:** Blurry / not yet investigated. Needs prototyping and testing.

## 2 — Extension must work with Chrome minimized (priority)

**Requirement:** The extension should work correctly when Chrome is minimized. No part of the flow should depend on the window being visible or having focus.

**Current state:** `sendToActivatedTab` calls `chrome.windows.update(tab.windowId, { focused: true })` to bring the window forward. If Chrome is minimized, this call might behave unexpectedly (e.g., the window becomes unminimized but stays behind other apps, or the activation fails silently).

**What needs checking:**
- Does `chrome.windows.update` work when Chrome is minimized? Does it restore the window?
- Does `Page.bringToFront` via debugger work on a minimized window?
- Does focus detection (`document.activeElement` polling via `executeScript`) work on backgrounded tabs? (It should — `executeScript` is not input-related.)
- Does `Input.insertText` work on background tabs? (Direct DOM injection — should work.)
- Does `Input.dispatchKeyEvent` (Enter) require the window to be in focus, or just the tab to be active?

**If `dispatchKeyEvent` requires the window to be focused** (not just the tab active), then we genuinely cannot send Enter while minimized. In that case the minimum requirement is: Chrome just needs to be a normal (not minimized) window — it doesn't need to be the OS foreground window.

**Priority:** High — a core usability requirement.

## 3 — Verification must work on background tabs (status false-positive fix)

**Observed bug:** Sometimes 1-2 tabs show as failed (red dot) even though the prompt was actually sent. The suspected cause is that the extension navigates away from the tab (activates the next tab) *before* `verifySend` finishes polling.

**Current flow in auto-cycle mode:**
1. Activate tab N
2. `sendTextThenEnter(tabId, prompt)` — sends to tab N
3. `verifySend(tabId, url, logger)` — polls URL + input content on tab N for ~3s total
4. Detach debugger, move to tab N+1 → activates tab N+1

**The problem:** When tab N+1 is activated, `chrome.tabs.get(tabId)` in `verifySend` for tab N still works (it's not tab-specific), but `getMarkedInputContent` uses `executeScript` to query `[data-autoprompt-input="true"]` on tab N. If Chrome decides that a background tab's `executeScript` is deprioritized or queued, the polling might get delayed results or fail.

**Potential fixes:**

**Option A — Verify in background** (preferred):
- `chrome.scripting.executeScript` should work on any tab regardless of active state — it's not input. If it does, then verification is already non-dependent on tab focus, and the false failures might be a race condition with the debugger detach or tab navigation.
- Needs testing: does `executeScript` on a background tab return promptly and accurately?

**Option B — Second pass (dedicated verification cycle):**
- After the main send cycle completes, make a second pass over all tabs: activate each one again briefly just to run `verifySend` while it's the active tab.
- This adds ~3s × N tabs to total runtime but eliminates the race condition.

**Option C — Move verification to background mode (only works if Option A is confirmed):**
- Keep the send cycle as-is (rapidly flash tabs for Enter only).
- After all sends are done, run all `verifySend` calls in parallel (they use `executeScript`, which should work on backgrounded tabs).
- This would be the fastest approach if `executeScript` on background tabs works reliably.

**Priority:** High — fixes false failure reports that undermine trust in the tool.

## 4 — Pre-Loaded Retry for Failed Tabs (future optimization idea)

**Context:** When running many tabs in parallel with `skipWait` ON, some sites (e.g. Kimi, Gemini) fail because their input box hasn't rendered yet under CPU contention. The current fix is to run with `skipWait` OFF, which is slower but reliable. This idea saves the time cost by overlapping the retry load with the existing rescue stages.

**The idea:**

1. **Phase 1 — Normal run (unchanged):** Run with `skipWait` ON. All tabs open, prompt sent, Stage 1 verification runs.
2. **Phase 2 — Pre-loading starts immediately:** As soon as Stage 1 results come back, for every failed tab, silently open a **new tab** for the same URL with `skipWait` OFF (full page load). Do not wait for them — continue immediately.
3. **Phase 3 — Normal rescue stages (unchanged):** Stage 2 (targeted re-check) and Stage 3 (Retry Enter) run on the original tabs as they do today. Some may recover.
4. **Phase 4 — Re-evaluate:** Tabs that recovered → discard their pre-loaded tabs. Tabs still failed → their pre-loaded tabs have been loading in the background this entire time.
5. **Phase 5 — Retry with pre-loaded tabs:** Run the full send+verify cycle on the pre-loaded tabs. They are fully loaded by now — no extra wait.
6. **Phase 6 — Final results:** Retry results replace the original failures.

**Why it saves time:** The pre-loaded tabs load *during* Stages 2 and 3, overlapping with work that was going to happen anyway. By the time they're needed, they're ready.

**Status:** Not implemented. Pure concept. Would need careful cleanup (closing discarded tabs, race-condition checks, debugger lifecycle).

